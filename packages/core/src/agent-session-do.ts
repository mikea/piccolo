/**
 * AgentSessionDO — Durable Object that owns one live piccolo session.
 *
 * Implements ISession directly — no SessionImpl wrapper needed. The DO
 * itself is the RpcTarget returned to gateways and tools.
 *
 * One DO instance per session. This is where all live session logic runs:
 *   - Agent loop (inlined: #runStream, #startTurn)
 *   - Persistence (D1 via session/persistence.ts)
 *   - Context compaction (inlined: #compact)
 *   - Extension dispatch (ExtensionRunner)
 *   - System prompt assembly (SystemPromptAssembler)
 *
 * The DO is addressed by sessionId via `env.AGENT_SESSION.idFromName(sessionId)`.
 *
 * Spec refs:
 *   specs/core.md §AgentSessionDO
 *   specs/api.md  §ISession
 */

import { DurableObject, RpcTarget } from "cloudflare:workers";
import type {
  AgentEvent,
  Attachment,
  BeforeAgentStartResult,
  BeforeCompactResult,
  CompactOptions,
  ContextUsage,
  CustomEntry as CustomEntryType,
  ExtensionEvent,
  HistoryEntry,
  IDisposable,
  IGatewayCallback,
  InputResult,
  IObserver,
  ISession,
  ISessionListener,
  ITool,
  ITurn,
  NewSessionOptions,
  SessionEvent,
  ToolDescriptor,
} from "@piccolo/api";
import type { FinishReason, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";
import { stepCountIs, streamText } from "ai";
import { agentCompact, splitForCompaction } from "./agent-compact.ts";
import { toAiSdkTools } from "./agent-tools.ts";
import type {
  AnyEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionInfoEntry,
} from "./db/entry-types.ts";
import { generateEntryId, parseEntry } from "./db/entry-types.ts";
import { getEntries, getSession } from "./db/schema.ts";
import { ExtensionRunner } from "./extension-runner.ts";
import { createModel } from "./gateway.ts";
import { Messages } from "./messages.ts";
import { ObservableImpl } from "./observable-impl.ts";
import { buildSessionContext, walkToRoot } from "./session/context.ts";
import {
  commitSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
} from "./session/persistence.ts";
import { buildBasePrompt } from "./system-prompt.ts";
import { SystemPromptAssembler } from "./system-prompt-assembler.ts";
import { defaultModelId, parseModels } from "./types-internal.ts";

// ─── SessionTarget ────────────────────────────────────────────────────────────

/**
 * The JSRPC-serialisable RpcTarget for a session.
 *
 * `DurableObject` instances cannot be used as `this` in JSRPC calls — capnpweb
 * requires a proper `RpcTarget` subclass. This class holds a reference to the
 * owning `AgentSessionDO` and delegates every `ISession` method to it.
 *
 * One instance is created per `AgentSessionDO` and cached in
 * `AgentSessionDO.ctx` so that the same `RpcTarget` identity is reused
 * for every extension call and compaction context throughout the DO's lifetime.
 */
export class SessionTarget extends RpcTarget implements ISession {
  readonly #do: AgentSessionDO;

  constructor(do_: AgentSessionDO) {
    super();
    this.#do = do_;
  }

  sessionId(): Promise<string> {
    return this.#do.sessionId();
  }
  getUpdatedAt(): Promise<number> {
    return this.#do.getUpdatedAt();
  }
  userId(): Promise<string> {
    return this.#do.userId();
  }
  getName(): Promise<string | undefined> {
    return this.#do.getName();
  }
  setName(name: string): Promise<void> {
    return this.#do.setName(name);
  }
  prompt(text: string, attachments?: Attachment[], callback?: IGatewayCallback): Promise<ITurn> {
    return this.#do.prompt(text, attachments, callback);
  }
  sendUserMessage(content: string): Promise<void> {
    return this.#do.sendUserMessage(content);
  }
  steer(text: string): Promise<void> {
    return this.#do.steer(text);
  }
  followUp(text: string): Promise<void> {
    return this.#do.followUp(text);
  }
  abort(): Promise<void> {
    return this.#do.abort();
  }
  getCurrentTurn(): Promise<ITurn | undefined> {
    return this.#do.getCurrentTurn();
  }
  getModel(): Promise<string> {
    return this.#do.getModel();
  }
  setModel(modelId: string): Promise<void> {
    return this.#do.setModel(modelId);
  }
  listModels(): Promise<string[]> {
    return this.#do.listModels();
  }
  getActiveTools(): Promise<ToolDescriptor[]> {
    return this.#do.getActiveTools();
  }
  appendCustomMessage(customType: string, content: string, display: boolean): Promise<void> {
    return this.#do.appendCustomMessage(customType, content, display);
  }
  appendCustomEntry(customType: string, data?: unknown): Promise<void> {
    return this.#do.appendCustomEntry(customType, data);
  }
  getEntries(customType?: string): Promise<CustomEntryType[]> {
    return this.#do.getEntries(customType);
  }
  getHistory(): Promise<HistoryEntry[]> {
    return this.#do.getHistory();
  }
  subscribe(observer: IObserver<AgentEvent>): Promise<IDisposable> {
    return this.#do.subscribe(observer);
  }
  getContextUsage(): Promise<ContextUsage> {
    return this.#do.getContextUsage();
  }
  compact(options?: CompactOptions): Promise<void> {
    return this.#do.compact(options);
  }
  getSystemPrompt(): Promise<string> {
    return this.#do.getSystemPrompt();
  }
  branch(entryId: string): Promise<void> {
    return this.#do.branch(entryId);
  }
  fork(fromEntryId?: string): Promise<string> {
    return this.#do.fork(fromEntryId);
  }
  delete(): Promise<void> {
    return this.#do.delete();
  }
}

// ─── AgentSessionDO ───────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 20;

export class AgentSessionDO extends DurableObject<Env> implements ISession {
  // ─── Session identity ─────────────────────────────────────────────────────
  #sessionId = "";
  #userId = "";
  #modelId = "";
  #leafId: string | null = null;
  #name: string | undefined = undefined;
  #createdAt = 0;
  #updatedAt = 0;

  // ─── In-memory session state ──────────────────────────────────────────────
  #messages = new Messages("");
  #pendingEntries: AnyEntry[] = [];
  #branchEntries: AnyEntry[] = [];

  // ─── Listeners ────────────────────────────────────────────────────────────
  #listeners = new Set<ISessionListener>();

  addListener(listener: ISessionListener): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: ISessionListener): void {
    this.#listeners.delete(listener);
  }

  #notifyListeners(event: SessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener.onEvent(event);
      } catch {
        // a broken listener must never interrupt the DO
      }
    }
  }

  // ─── Inlined agent state ──────────────────────────────────────────────────
  // Previously lived in Agent class. Now owned directly by the DO.
  #model!: LanguageModel;
  #error: string | undefined = undefined;
  #steeringQueue: ModelMessage[] = [];
  #agentAbortController: AbortController | null = null;

  // ─── Infrastructure ───────────────────────────────────────────────────────
  #extensionRunner!: ExtensionRunner;
  #assembler!: SystemPromptAssembler;
  #assembledSystemPrompt = "";
  #tools: ITool[] | undefined;
  // The JSRPC-serialisable RpcTarget for this DO. Created once and reused for
  // every emit() call so extension workers always receive the same capability.
  // DurableObject instances cannot be used as `this` in JSRPC calls — a proper
  // RpcTarget subclass (SessionTarget) is required.
  // Private to keep the public surface clean; accessed externally via getSession().
  #rpcCtx!: SessionTarget;

  // ─── Session-level observable ─────────────────────────────────────────────
  // All AgentEvents from all turns flow through this single observable.
  // Subscribers (gateways) call ISession.subscribe() to receive them.
  #observable!: ObservableImpl<AgentEvent>;

  // ─── Turn state ───────────────────────────────────────────────────────────
  #currentTurn: TurnImpl | null = null;
  #followUpQueue: string[] = [];
  #lastInputTokens = 0;
  #messagesAtTurnStart = 0;

  // ─── Live streaming state (for getHistory / subscribe) ────────────────────
  // Tracks in-flight assistant content so getHistory() can return it before
  // the turn completes and commits to D1. Cleared on finish / error.
  #streamingAssistantText = "";
  #streamingToolCalls: Map<string, { toolName: string; input: unknown }> = new Map();

  // ─── Test helpers ─────────────────────────────────────────────────────────
  #modelOverridden = false;

  // ─── Initialisation ───────────────────────────────────────────────────────

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await this.#initialize();
    });
  }

  async #initialize(): Promise<void> {
    // 1. Read sessionId and modelId from DO storage
    const sessionId = (await this.ctx.storage.get<string>("sessionId")) ?? "";
    const storedModelId = await this.ctx.storage.get<string>("modelId");
    const storedName = await this.ctx.storage.get<string>("name");

    this.#sessionId = sessionId;
    this.#messages = new Messages(this.#sessionId);
    this.#modelId = storedModelId ?? defaultModelId(this.env.MODELS);
    this.#name = storedName ?? (sessionId !== "" ? sessionId : undefined);

    // 2. If session exists in D1, rehydrate
    if (sessionId !== "") {
      const db = this.env.SESSIONS_DB;
      const sessionRow = await getSession(db, sessionId);
      if (sessionRow !== null) {
        this.#userId = sessionRow.user_id;
        this.#modelId = sessionRow.model_id;
        this.#leafId = sessionRow.leaf_id;
        this.#name = sessionRow.name ?? this.#sessionId;
        this.#createdAt = sessionRow.created_at;
        this.#updatedAt = sessionRow.updated_at;

        const rawRows = await getEntries(db, sessionId);
        const allEntries = rawRows.map(parseEntry);
        const context = buildSessionContext(allEntries, this.#leafId);
        this.#messages.replace(context.messages, "D1 rehydration");
        if (allEntries.some((e) => e.type === "model_change")) {
          this.#modelId = context.modelId;
        }
        for (const entry of allEntries) {
          if (entry.type === "message") {
            this.#messages.setEntryId((entry as MessageEntry).data, entry.id);
          }
        }
        this.#branchEntries = walkToRoot(allEntries, this.#leafId);
      }
    }

    // 3. Initialize session-level observable (lives for the session lifetime)
    this.#observable = new ObservableImpl<AgentEvent>();

    // 4. Build the language model directly — no Agent wrapper.
    this.#model = createModel(this.env, this.#modelId);

    // 5. Set up extension runner and system prompt infrastructure.
    // initialize() only reads the registry and builds worker stubs — it does
    // NOT call getTools/getCommands/getSystemPromptAdditions, which would make
    // reverse RPC calls back into this DO and deadlock inside blockConcurrencyWhile.
    this.#extensionRunner = new ExtensionRunner();
    this.#assembler = new SystemPromptAssembler();
    this.#rpcCtx = new SessionTarget(this);

    await this.#extensionRunner.initialize(this.env.CONFIG, this.env.EXTENSIONS, this.#rpcCtx);
  }

  // ─── Test-only helpers ────────────────────────────────────────────────────

  _setModelForTest(model: LanguageModel): void {
    this.#model = model;
    this.#modelId = "test-mock";
    this.#modelOverridden = true;
  }

  async _getAssembledSystemPrompt(): Promise<string> {
    return this.getSystemPrompt();
  }

  // ─── ISession: Identity ───────────────────────────────────────────────────

  async sessionId(): Promise<string> {
    return this.#sessionId;
  }

  async userId(): Promise<string> {
    return this.#userId;
  }

  async getUpdatedAt(): Promise<number> {
    return this.#updatedAt;
  }

  // ─── ISession: Metadata ───────────────────────────────────────────────────

  async getName(): Promise<string | undefined> {
    return this.#name;
  }

  async setName(name: string): Promise<void> {
    this.#name = name;
    await this.ctx.storage.put("name", name);
    const entry: SessionInfoEntry = {
      id: generateEntryId(),
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      type: "session_info",
      timestamp: new Date().toISOString(),
      data: { name },
    };
    this.#appendEntry(entry);
    if (this.#createdAt !== 0) {
      await flushPendingEntries(
        this.#pendingEntries,
        this.#sessionId,
        this.#requireLeafId(),
        this.env.SESSIONS_DB,
      );
      this.#pendingEntries = [];
    }
  }

  // ─── ISession: Conversation ───────────────────────────────────────────────

  async prompt(
    text: string,
    attachments?: Attachment[],
    callback?: IGatewayCallback,
  ): Promise<ITurn> {
    // Reserve the turn slot synchronously before any await, so that any
    // concurrent caller that runs before the microtask queue yields will
    // immediately see #currentTurn !== null and throw.
    if (this.#currentTurn !== null) {
      throw new Error("A turn is already in progress. Call abort() before starting a new turn.");
    }
    const turn = new TurnImpl(callback);
    this.#currentTurn = turn;

    try {
      // Ensure the system prompt (and extension tools) are set before the first
      // turn. getSystemPrompt() is a no-op after the first call. Called here
      // rather than in blockConcurrencyWhile so that reverse RPC calls from
      // extensions back into ctx are not deadlocked.
      await this.getSystemPrompt();
      const ctx = this.#rpcCtx;

      // emitInput
      const inputResult = (await this.#extensionRunner.emit(
        { type: "input", text, attachments: attachments ?? [], source: "user" },
        ctx,
      )) as InputResult;
      if (inputResult.action === "handled") {
        // Extension handled the input fully — no agent turn needed.
        // Clear the reservation and return.
        this.#currentTurn = null;
        return turn;
      }
      const effectiveText = inputResult.action === "transform" ? (inputResult.text ?? text) : text;

      // Build user message and entry
      const userMessage: ModelMessage =
        attachments && attachments.length > 0
          ? {
              role: "user",
              content: [
                { type: "text", text: effectiveText },
                ...attachments.map((a) => ({
                  type: "file" as const,
                  data: a.data,
                  mediaType: a.mimeType,
                })),
              ],
            }
          : { role: "user", content: effectiveText };

      const userEntryId = generateEntryId();
      const userEntry: MessageEntry = {
        id: userEntryId,
        sessionId: this.#sessionId,
        parentId: this.#leafId,
        type: "message",
        timestamp: new Date().toISOString(),
        data: userMessage,
      };
      this.#pendingEntries.push(userEntry);
      this.#leafId = userEntryId;
      this.#messages.setEntryId(userMessage, userEntryId);

      // emitBeforeStart
      const beforeStart = (await this.#extensionRunner.emit(
        {
          type: "before_start",
          text: effectiveText,
          attachments: attachments ?? [],
          systemPrompt: this.#assembledSystemPrompt,
        },
        ctx,
      )) as BeforeAgentStartResult;
      if (beforeStart.contextMessages && beforeStart.contextMessages.length > 0) {
        this.#messages.push(beforeStart.contextMessages, "before_start contextMessages");
      }
      this.#assembledSystemPrompt = beforeStart.systemPrompt ?? this.#assembledSystemPrompt;

      if (this.#computeContextUsage().inputTokens > this.#compactTokens()) {
        await this.#compact({});
      }

      this.#messagesAtTurnStart = this.#messages.size();

      // Start the agent turn — events flow via #runStream, which calls #onTurnEvent.
      this.#startTurn([userMessage]);
    } catch (e) {
      // If anything above throws, release the turn reservation so the caller
      // can retry rather than being permanently locked out.
      this.#currentTurn = null;
      throw e;
    }

    return turn;
  }

  async sendUserMessage(content: string): Promise<void> {
    this.#steeringQueue.push({ role: "user", content });
  }

  async steer(text: string): Promise<void> {
    this.#steeringQueue.push({ role: "user", content: text });
  }

  async followUp(text: string): Promise<void> {
    this.#followUpQueue.push(text);
  }

  async abort(): Promise<void> {
    this.#agentAbortController?.abort();
  }

  async getCurrentTurn(): Promise<ITurn | undefined> {
    return this.#currentTurn ?? undefined;
  }

  // ─── ISession: History & live subscription ────────────────────────────────

  async getHistory(): Promise<HistoryEntry[]> {
    return Messages.toHistory(this.#messages.list(), this.#messages.entryMap(), {
      isStreaming: this.#currentTurn !== null,
      assistantText: this.#streamingAssistantText,
      toolCalls: this.#streamingToolCalls,
    });
  }

  async subscribe(observer: IObserver<AgentEvent>): Promise<IDisposable> {
    return this.#observable.subscribe(observer);
  }

  // ─── ISession: Model management ───────────────────────────────────────────

  async getModel(): Promise<string> {
    const stored = this.#modelId;
    const allowed = parseModels(this.env.MODELS);
    return allowed.includes(stored) ? stored : (allowed[0] ?? stored);
  }

  async setModel(modelId: string): Promise<void> {
    this.#modelId = modelId;
    this.#model = createModel(this.env, modelId);
    const entry: ModelChangeEntry = {
      id: generateEntryId(),
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      type: "model_change",
      timestamp: new Date().toISOString(),
      data: { modelId },
    };
    this.#appendEntry(entry);
    if (this.#createdAt !== 0) {
      await flushPendingEntries(
        this.#pendingEntries,
        this.#sessionId,
        this.#requireLeafId(),
        this.env.SESSIONS_DB,
      );
      this.#pendingEntries = [];
    }
  }

  async listModels(): Promise<string[]> {
    return parseModels(this.env.MODELS);
  }

  // ─── ISession: Tools ──────────────────────────────────────────────────────

  async getActiveTools(): Promise<ToolDescriptor[]> {
    if (!this.#tools) {
      this.#tools = await this.#extensionRunner.getTools(this.#rpcCtx);
    }
    return Promise.all(this.#tools.map((t) => t.getDescriptor()));
  }

  // ─── ISession: Custom entries ─────────────────────────────────────────────

  async appendCustomMessage(customType: string, content: string, display: boolean): Promise<void> {
    const entry: CustomMessageEntry = {
      id: generateEntryId(),
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      type: "custom_message",
      timestamp: new Date().toISOString(),
      data: { customType, content, display },
    };
    this.#appendEntry(entry);
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<void> {
    const entry: CustomEntry = {
      id: generateEntryId(),
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      type: "custom",
      timestamp: new Date().toISOString(),
      data: { customType, payload: data },
    };
    this.#appendEntry(entry);
  }

  async getEntries(customType?: string): Promise<CustomEntryType[]> {
    return this.#branchEntries
      .filter((e): e is CustomEntry => {
        if (e.type !== "custom") return false;
        if (customType === undefined) return true;
        return (e.data as { customType: string }).customType === customType;
      })
      .map((e) => {
        const d = e.data as { customType: string; payload?: unknown };
        return { id: e.id, customType: d.customType, data: d.payload, timestamp: e.timestamp };
      });
  }

  // ─── ISession: Context usage ──────────────────────────────────────────────

  async getContextUsage(): Promise<ContextUsage> {
    return this.#computeContextUsage();
  }

  async compact(options?: CompactOptions): Promise<void> {
    await this.#compact(options ?? {});
    if (this.#createdAt !== 0 && this.#leafId !== null) {
      await flushPendingEntries(
        this.#pendingEntries,
        this.#sessionId,
        this.#leafId,
        this.env.SESSIONS_DB,
      );
      this.#pendingEntries = [];
    }
  }

  // ─── ISession: System prompt ──────────────────────────────────────────────

  async getSystemPrompt(): Promise<string> {
    if (!this.#assembledSystemPrompt) {
      if (!this.#tools) {
        this.#tools = await this.#extensionRunner.getTools(this.#rpcCtx);
      }
      const additions = await this.#extensionRunner.getSystemPromptAdditions(this.#rpcCtx);
      this.#assembledSystemPrompt = await this.#assembler.assemble(
        buildBasePrompt(this.env.AGENT_NAME),
        additions,
        this.#tools,
      );
    }
    return this.#assembledSystemPrompt;
  }

  // ─── ISession: Session tree ───────────────────────────────────────────────

  async branch(entryId: string): Promise<void> {
    this.#leafId = entryId;
    const rawRows = await getEntries(this.env.SESSIONS_DB, this.#sessionId);
    const allEntries = rawRows.map(parseEntry);
    const context = buildSessionContext(allEntries, entryId);
    this.#messages.replace(context.messages, "D1 branch");
    if (context.modelId !== this.#modelId) {
      this.#modelId = context.modelId;
      this.#model = createModel(this.env, context.modelId);
    }
  }

  async fork(fromEntryId?: string): Promise<string> {
    const newSessionId = await forkSession(
      this.#sessionId,
      fromEntryId,
      this.#leafId,
      this.#userId,
      this.#modelId,
      this.env.SESSIONS_DB,
    );
    // Seed the new DO's storage so it can cold-start correctly.
    const newStub = this.env.AGENT_SESSION.get(this.env.AGENT_SESSION.idFromName(newSessionId));
    await newStub._init(newSessionId, this.#userId, { modelId: this.#modelId });
    return newSessionId;
  }

  async delete(): Promise<void> {
    if (this.#sessionId !== "" && this.#createdAt !== 0) {
      await deleteSession(this.#sessionId, this.env.SESSIONS_DB);
    }
    this.#agentAbortController?.abort();
    this.#pendingEntries = [];
    this.#messages.clear();
    this.#leafId = null;
  }

  // ─── Internal bootstrap (called only by UserImpl via DO stub) ────────────
  // Prefixed with _ to signal it is not part of any public interface.
  // IUser.newSession() is the only public newSession.

  async _init(sessionId: string, userId: string, options?: NewSessionOptions): Promise<void> {
    await this.#initSession(sessionId, userId, options);
  }

  /**
   * Return the JSRPC-serialisable `SessionTarget` (`RpcTarget`) for this DO.
   *
   * Not part of `ISession` — called by `piccolo-core` after obtaining the DO
   * stub via `asRpcStub()`, so that gateways always receive a proper `RpcTarget`
   * rather than the `DurableObject` instance directly.
   */
  getSession(): SessionTarget {
    return this.#rpcCtx;
  }

  async #initSession(
    sessionId: string,
    userId: string,
    options?: { name?: string; modelId?: string },
  ): Promise<void> {
    if (this.#sessionId !== "") return; // already initialized
    const modelId = options?.modelId ?? defaultModelId(this.env.MODELS);
    this.#sessionId = sessionId;
    this.#messages = new Messages(this.#sessionId);
    this.#userId = userId;
    this.#modelId = modelId;
    this.#name = options?.name ?? sessionId;
    await this.ctx.storage.put("sessionId", sessionId);
    await this.ctx.storage.put("modelId", modelId);
    await this.ctx.storage.put("name", this.#name);
    if (!this.#modelOverridden) {
      this.#model = createModel(this.env, modelId);
    }
  }

  // ─── Inlined agent loop ───────────────────────────────────────────────────

  /**
   * Start a new agent turn. Pushes initialMessages onto #messages, creates an
   * AbortController, and runs #runStream via ctx.waitUntil so the Workers
   * runtime keeps the isolate alive until the stream completes.
   *
   * Spec ref: specs/core.md §AgentSessionDO §Agent Loop
   */
  #startTurn(initialMessages: ModelMessage[]): void {
    if (initialMessages.length > 0) {
      // initialMessages are built by the DO itself (user message, follow-up text)
      // — validate them to catch any schema drift at the source.
      this.#messages.push(initialMessages, "#startTurn");
    }
    const ac = new AbortController();
    this.#agentAbortController = ac;
    this.ctx.waitUntil(this.#runStream(ac.signal));
  }

  /**
   * Core LLM streaming loop — previously Agent._runStream.
   *
   * Runs streamText, handles all AI SDK callbacks, emits AgentEvents
   * directly to #observable via #emitTurnEvent.
   *
   * Spec ref: specs/core.md §AgentSessionDO §Agent Loop
   */
  async #runStream(signal: AbortSignal): Promise<void> {
    this.#error = undefined;

    this.#emitTurnEvent({ type: "start" });

    const toolSet = await toAiSdkTools(this.#tools ?? [], this.#rpcCtx);
    let aborted = false;
    let finalUsage: LanguageModelUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
    };

    try {
      const result = streamText({
        model: this.#model,
        system: this.#assembledSystemPrompt,
        messages: this.#messages.list(),
        tools: toolSet,
        stopWhen: stepCountIs(DEFAULT_MAX_STEPS),
        abortSignal: signal,

        prepareStep: ({ stepNumber, messages }) => {
          this.#emitTurnEvent({ type: "step-start", stepNumber });
          if (stepNumber > 0 && this.#steeringQueue.length > 0) {
            const steering = this.#dequeueSteer();
            return Promise.resolve({ messages: [...messages, ...steering] });
          }
          return Promise.resolve(undefined);
        },

        onChunk: ({ chunk }) => {
          switch (chunk.type) {
            case "text-delta":
              this.#emitTurnEvent({ type: "text-delta", delta: chunk.text });
              break;
            case "reasoning-delta":
              this.#emitTurnEvent({ type: "reasoning-delta", delta: chunk.text });
              break;
            case "tool-call":
              this.#emitTurnEvent({
                type: "tool-call",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              });
              break;
            case "tool-result":
              this.#emitTurnEvent({
                type: "tool-result",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                output: chunk.output,
                isError: false,
              });
              break;
          }
        },

        onStepFinish: ({ stepNumber, finishReason, usage, content }) => {
          for (const part of content) {
            if (part.type === "tool-error") {
              const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
              this.#emitTurnEvent({
                type: "tool-result",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                output: errMsg,
                isError: true,
              });
            }
          }
          this.#emitTurnEvent({
            type: "step-finish",
            stepNumber,
            finishReason: finishReason as FinishReason,
            usage,
          });
        },

        onFinish: ({ totalUsage, response }) => {
          finalUsage = totalUsage;
          this.#messages.push(response.messages, "streamText onFinish");
        },

        onError: ({ error }) => {
          const message = error instanceof Error ? error.message : String(error);
          this.#error = message;
          this.#agentAbortController = null;
          this.#emitTurnEvent({ type: "error", message });
        },

        onAbort: () => {
          aborted = true;
        },
      });

      await result.consumeStream();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!aborted) {
        this.#error = message;
        this.#agentAbortController = null;
        this.#emitTurnEvent({ type: "error", message });
      }
    } finally {
      this.#agentAbortController = null;
      if (!aborted) {
        this.#emitTurnEvent({ type: "finish", totalUsage: finalUsage });
        this.ctx.waitUntil(this.#onAgentEnd());
      }
    }
  }

  /**
   * Emit a turn event: apply in-flight side effects, forward to observable.
   * Replaces the Agent subscription callback that used to sit in #initialize().
   */
  #emitTurnEvent(event: AgentEvent): void {
    this.#onTurnEvent(event);
    this.#observable.emit(event);
  }

  /** Dequeue one (or all, if steeringMode were "all") steering messages. */
  #dequeueSteer(): ModelMessage[] {
    // Default steering mode is "one-at-a-time".
    const msg = this.#steeringQueue.shift();
    return msg !== undefined ? [msg] : [];
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Called for every AgentEvent as it passes through the turn loop.
   * All event-driven side effects for the DO live here.
   *
   * Handles:
   *   1. In-flight history tracking (for getHistory() mid-turn)
   *   2. Token count updates (for getContextUsage() and compaction threshold)
   *   3. Extension dispatch (fire-and-forget)
   *
   * Spec ref: specs/core.md §AgentSessionDO §#onTurnEvent
   */
  #onTurnEvent(event: AgentEvent): void {
    // 1. In-flight history tracking
    switch (event.type) {
      case "start":
        this.#streamingAssistantText = "";
        this.#streamingToolCalls.clear();
        break;
      case "text-delta":
        this.#streamingAssistantText += event.delta;
        break;
      case "tool-call":
        this.#streamingToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          input: event.input,
        });
        break;
      case "tool-result":
        this.#streamingToolCalls.delete(event.toolCallId);
        break;
      case "step-finish":
        // 2. Token count from per-step usage
        this.#lastInputTokens = event.usage.inputTokens ?? this.#lastInputTokens;
        this.#streamingAssistantText = "";
        this.#observable.emit({
          type: "usage",
          inputTokens: this.#computeContextUsage().inputTokens,
        });
        break;
      case "finish":
        // 2. Token count from total usage
        this.#lastInputTokens = event.totalUsage.inputTokens ?? this.#lastInputTokens;
        this.#streamingAssistantText = "";
        this.#streamingToolCalls.clear();
        this.#observable.emit({
          type: "usage",
          inputTokens: this.#computeContextUsage().inputTokens,
        });
        break;
      case "error":
        this.#streamingAssistantText = "";
        this.#streamingToolCalls.clear();
        break;
    }

    // 3. Notify all listeners (extension runner is one of them).
    this.#notifyListeners(event);
  }

  /**
   * Called via ctx.waitUntil when finish fires in #runStream.
   * Persists messages, runs any queued follow-up turns, then fires turn_flushed.
   * Follow-up turns also run through #runStream — they trigger #onAgentEnd
   * again when they finish, processing the queue recursively.
   */
  async #onAgentEnd(): Promise<void> {
    await this.#persistNewMessages().catch((err) => {
      console.error(`[session:${this.#sessionId}] persistNewMessages error`, err);
    });

    if (this.#followUpQueue.length > 0) {
      // Start the next follow-up turn — it will emit through #runStream
      // and trigger #onAgentEnd again when it finishes.
      const followUpText = this.#followUpQueue.shift() ?? "";
      this.#messagesAtTurnStart = this.#messages.size();
      this.#startTurn([{ role: "user", content: followUpText }]);
      return; // don't clear #currentTurn or notify yet
    }

    this.#currentTurn = null;
    this.#notifyListeners({ type: "turn_flushed" });
  }

  #appendEntry(entry: AnyEntry): void {
    this.#pendingEntries.push(entry);
    this.#branchEntries.push(entry);
    this.#leafId = entry.id;
  }

  #compactTokens(): number {
    const val = parseInt(this.env.COMPACT_TOKENS, 10);
    return Number.isFinite(val) && val > 0 ? val : 100_000;
  }

  #computeContextUsage(): ContextUsage {
    const extra = estimateTokens(
      this.#messages.slice(this.#lastInputTokens === 0 ? 0 : undefined),
    );
    return { inputTokens: this.#lastInputTokens + extra };
  }

  /**
   * Run context compaction on the current message history.
   *
   * Lets extensions cancel or supply a pre-built summary, otherwise calls
   * agentCompact() to summarise old messages. Appends a CompactionEntry to
   * #pendingEntries and replaces #messages with the compacted list.
   * Does NOT flush to D1 — the caller flushes after the turn ends.
   *
   * Spec ref: specs/core.md §Compaction algorithm
   */
  async #compact(options: CompactOptions): Promise<void> {
    const keepRecentTokens = options.keepRecentTokens ?? 20_000;

    // 1. Let extensions cancel or supply a pre-built summary.
    const beforeCompactEvent: Extract<ExtensionEvent, { type: "before_compact" }> = {
      type: "before_compact",
      messages: this.#messages.list(),
      keepRecentTokens,
    };
    const extResult = (await this.#extensionRunner.emit(
      beforeCompactEvent,
      this.#rpcCtx,
    )) as BeforeCompactResult;
    if (extResult.cancel) return;

    let summary: string;
    let keptMessages: ModelMessage[];

    if (extResult.summary) {
      // Extension provided a ready-made summary — skip the LLM call.
      summary = extResult.summary;
      keptMessages = splitForCompaction(this.#messages.list(), keepRecentTokens).toKeep;
    } else {
      // Call agentCompact() (calls generateText internally).
      ({ summary, keptMessages } = await agentCompact(
        this.#messages.list(),
        keepRecentTokens,
        this.#model,
      ));
    }

    // 2. If nothing was summarised, skip writing a CompactionEntry.
    if (summary === "" && !extResult.summary) return;

    const compacted = Messages.compact(this.#sessionId, this.#messages, summary, keptMessages);

    // 4. Build and queue the CompactionEntry.
    const compactionEntry: CompactionEntry = {
      id: generateEntryId(),
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      type: "compaction",
      timestamp: new Date().toISOString(),
      data: {
        summary,
        firstKeptEntryId: compacted.firstKeptEntryId,
        tokensBefore: this.#lastInputTokens,
      },
    };
    this.#pendingEntries.push(compactionEntry);
    this.#leafId = compactionEntry.id;

    this.#messages = compacted.messages;
  }

  #requireLeafId(): string {
    if (this.#leafId === null) {
      throw new Error("Session leafId is not initialized");
    }
    return this.#leafId;
  }

  /** Persist all new agent messages to D1 since the last flush point. */
  async #persistNewMessages(): Promise<void> {
    const newMessages = this.#messages.slice(this.#messagesAtTurnStart);
    for (const msg of newMessages) {
      if (this.#messages.hasEntryId(msg)) continue; // already tracked (e.g. user message)
      const entryId = generateEntryId();
      const entry: MessageEntry = {
        id: entryId,
        sessionId: this.#sessionId,
        parentId: this.#leafId,
        type: "message",
        timestamp: new Date().toISOString(),
        data: msg,
      };
      this.#pendingEntries.push(entry);
      this.#leafId = entryId;
      this.#messages.setEntryId(msg, entryId);
    }
    // Advance the start index so the next call only picks up genuinely new messages
    this.#messagesAtTurnStart = this.#messages.size();

    if (this.#createdAt === 0 && this.#sessionId !== "") {
      const now = Date.now();
      this.#createdAt = now;
      this.#updatedAt = now;
      await commitSession(
        this.#sessionId,
        this.#userId,
        { ...(this.#name !== undefined ? { name: this.#name } : {}), modelId: this.#modelId },
        this.env.SESSIONS_DB,
      );
    }

    if (this.#pendingEntries.length > 0 && this.#leafId !== null) {
      await flushPendingEntries(
        this.#pendingEntries,
        this.#sessionId,
        this.#leafId,
        this.env.SESSIONS_DB,
      );
      this.#pendingEntries = [];
      this.#updatedAt = Date.now();
    }
  }
}

// ─── TurnImpl ─────────────────────────────────────────────────────────────────

export class TurnImpl extends RpcTarget implements ITurn {
  readonly #callback: IGatewayCallback | undefined;

  constructor(callback: IGatewayCallback | undefined) {
    super();
    this.#callback = callback;
  }

  async getCallback(): Promise<IGatewayCallback | undefined> {
    return this.#callback;
  }
}

// ─── Token estimation ─────────────────────────────────────────────────────────

function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part
        ) {
          chars += String(part.text).length;
        } else {
          chars += 50;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
