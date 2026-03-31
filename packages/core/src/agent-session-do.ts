/**
 * AgentSessionDO — Durable Object that owns one live piccolo session.
 *
 * Implements ISession directly — no SessionImpl wrapper needed. The DO
 * itself is the RpcTarget returned to gateways and tools.
 *
 * One DO instance per session. This is where all live session logic runs:
 *   - Agent loop (inlined: #runStream, #startTurn)
 *   - Persistence (D1 via session/persistence.ts)
 *   - Context compaction (via compact.ts)
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
  AnyEntry as ApiAnyEntry,
  Attachment,
  BeforeAgentStartResult,
  ContextUsage,
  IDisposable,
  IGatewayCallback,
  IMessage,
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
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { toAiSdkTools } from "./agent-tools.ts";
import { compact as compactImpl } from "./compact.ts";
import type {
  AnyEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionInfoEntry,
} from "./db/entry-types.ts";
import { generateEntryId, parseEntry } from "./db/entry-types.ts";
import { getEntries as getEntryRows, getSession, updateSessionModel } from "./db/schema.ts";
import { ExtensionRunner } from "./extension-runner.ts";
import { ObservableImpl } from "./observable-impl.ts";
import { buildSessionContextFromDb, estimateTokens, walkToRoot } from "./session/context.ts";
import {
  commitSession,
  deleteSession,
  forkSession,
  appendEntry as persistEntry,
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
  getEntries(): Promise<ApiAnyEntry[]> {
    return this.#do.getEntries();
  }
  subscribe(observer: IObserver<AgentEvent>): Promise<IDisposable> {
    return this.#do.subscribe(observer);
  }
  getContextUsage(): Promise<ContextUsage> {
    return this.#do.getContextUsage();
  }
  compact(): Promise<void> {
    return this.#do.compact();
  }
  getSystemPrompt(): Promise<string> {
    return this.#do.getSystemPrompt();
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

interface CompactOptions {
  keepRecentTokens?: number;
}

export class AgentSessionDO extends DurableObject<Env> implements ISession {
  // ─── Session identity ─────────────────────────────────────────────────────
  #sessionId = "";
  #userId = "";
  #modelId = "";
  #leafId: string | null = null;
  #name: string | undefined = undefined;
  #createdAt = 0;
  #updatedAt = 0;

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
  #steeringQueue: IMessage[] = [];
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
  #activeTurnInputTokens = 0;

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
      }
    }

    // 3. Initialize session-level observable (lives for the session lifetime)
    this.#observable = new ObservableImpl<AgentEvent>();

    // 4. Build the language model directly — no Agent wrapper.
    this.#model = createModel(this.env, this.#modelId);

    // 5. Set up extension runner and system prompt infrastructure.
    // initialize() only discovers extension bindings and builds worker stubs — it does
    // NOT call getTools/getCommands/getSystemPromptAdditions, which would make
    // reverse RPC calls back into this DO and deadlock inside blockConcurrencyWhile.
    this.#extensionRunner = new ExtensionRunner();
    this.#assembler = new SystemPromptAssembler();
    this.#rpcCtx = new SessionTarget(this);

    await this.#extensionRunner.initialize(
      this.env as unknown as Record<string, unknown>,
      this.#rpcCtx,
    );
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
    await this.#appendEntry(entry);
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
      throw new Error(
        "A turn is already in progress. Call getCurrentTurn() and abort() that turn before starting a new turn.",
      );
    }
    const turn = new TurnImpl(callback, () => this.#abortCurrentTurn());
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
      const userEntryId = generateEntryId();
      const userMessage: IMessage =
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
              id: userEntryId,
            }
          : { role: "user", content: effectiveText, id: userEntryId };

      const userEntry: MessageEntry = {
        id: userEntryId,
        sessionId: this.#sessionId,
        parentId: this.#leafId,
        type: "message",
        timestamp: new Date().toISOString(),
        data: userMessage,
      };
      await this.#appendEntry(userEntry);

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
      this.#assembledSystemPrompt = beforeStart.systemPrompt ?? this.#assembledSystemPrompt;

      let turnMessages = await this.#loadContextMessages(this.#compactTokens());
      if (estimateTokens(turnMessages) > this.#compactTokens()) {
        await this.compact();
        turnMessages = await this.#loadContextMessages(this.#compactTokens());
      }
      if (beforeStart.contextMessages && beforeStart.contextMessages.length > 0) {
        turnMessages.push(...beforeStart.contextMessages);
      }

      // Start the agent turn — events flow via #runStream, which calls #onTurnEvent.
      this.#startTurn(turnMessages);
    } catch (e) {
      // If anything above throws, release the turn reservation so the caller
      // can retry rather than being permanently locked out.
      this.#currentTurn = null;
      throw e;
    }

    return turn;
  }

  async sendUserMessage(content: string): Promise<void> {
    this.#steeringQueue.push({ role: "user", content, id: generateEntryId() });
  }

  async steer(text: string): Promise<void> {
    this.#steeringQueue.push({ role: "user", content: text, id: generateEntryId() });
  }

  async followUp(text: string): Promise<void> {
    this.#followUpQueue.push(text);
  }

  async #abortCurrentTurn(): Promise<void> {
    this.#agentAbortController?.abort();
  }

  async getCurrentTurn(): Promise<ITurn | undefined> {
    return this.#currentTurn ?? undefined;
  }

  // ─── ISession: History & live subscription ────────────────────────────────

  async getEntries(): Promise<ApiAnyEntry[]> {
    const rows = await getEntryRows(this.env.SESSIONS_DB, this.#sessionId);
    const all = rows.map(parseEntry);
    return walkToRoot(all, this.#leafId);
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
    await this.ctx.storage.put("modelId", modelId);
    const entry: ModelChangeEntry = {
      id: generateEntryId(),
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      type: "model_change",
      timestamp: new Date().toISOString(),
      data: { modelId },
    };
    await this.#appendEntry(entry);
    await updateSessionModel(this.env.SESSIONS_DB, this.#sessionId, modelId, Date.now());
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

  // ─── ISession: Context usage ──────────────────────────────────────────────

  async getContextUsage(): Promise<ContextUsage> {
    return { inputTokens: estimateTokens(await this.#loadContextMessages(this.#compactTokens())) };
  }

  async compact(options?: CompactOptions): Promise<void> {
    const messages = await this.#loadContextMessages();
    const result = await compactImpl({
      keepRecentTokens: options?.keepRecentTokens ?? 20_000,
      messages,
      extensionRunner: this.#extensionRunner,
      ctx: this.#rpcCtx,
      model: this.#model,
      sessionId: this.#sessionId,
      parentId: this.#leafId,
      tokensBefore: this.#lastInputTokens,
    });

    if (!result) {
      return;
    }

    const { compactionEntry } = result;
    await this.#appendEntry(compactionEntry);
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

  /** Start a new agent turn from provided messages. */
  #startTurn(turnMessages: IMessage[]): void {
    this.#activeTurnInputTokens = estimateTokens(turnMessages);
    const ac = new AbortController();
    this.#agentAbortController = ac;
    this.ctx.waitUntil(this.#runStream(ac.signal, turnMessages));
  }

  /**
   * Core LLM streaming loop — previously Agent._runStream.
   *
   * Runs streamText, handles all AI SDK callbacks, emits AgentEvents
   * directly to #observable via #emitTurnEvent.
   *
   * Spec ref: specs/core.md §AgentSessionDO §Agent Loop
   */
  async #runStream(signal: AbortSignal, turnMessages: IMessage[]): Promise<void> {
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

    let persistGeneratedPromise: Promise<void> | undefined;

    try {
      const result = streamText({
        model: this.#model,
        system: this.#assembledSystemPrompt,
        messages: turnMessages,
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
          persistGeneratedPromise = this.#persistGeneratedMessages(response.messages);
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
      await persistGeneratedPromise;
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
  #dequeueSteer(): IMessage[] {
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
   *   1. In-flight history tracking (for subscribe() mid-turn)
   *   2. Token count updates (for getContextUsage() and compaction threshold)
   *   3. Extension dispatch (fire-and-forget)
   *
   * Spec ref: specs/core.md §AgentSessionDO §#onTurnEvent
   */
  #onTurnEvent(event: AgentEvent): void {
    // 1. In-flight streaming bookkeeping
    switch (event.type) {
      case "start":
        break;
      case "text-delta":
        break;
      case "tool-call":
      case "tool-result":
        break;
      case "step-finish":
        // 2. Token count from per-step usage
        this.#lastInputTokens = event.usage.inputTokens ?? this.#lastInputTokens;
        this.#observable.emit({
          type: "usage",
          inputTokens:
            this.#lastInputTokens === 0 ? this.#activeTurnInputTokens : this.#lastInputTokens,
        });
        break;
      case "finish":
        // 2. Token count from total usage
        this.#lastInputTokens = event.totalUsage.inputTokens ?? this.#lastInputTokens;
        this.#observable.emit({
          type: "usage",
          inputTokens:
            this.#lastInputTokens === 0 ? this.#activeTurnInputTokens : this.#lastInputTokens,
        });
        break;
      case "error":
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
    if (this.#followUpQueue.length > 0) {
      const followUpText = this.#followUpQueue.shift() ?? "";
      const followUpId = generateEntryId();
      const followUpEntry: MessageEntry = {
        id: followUpId,
        sessionId: this.#sessionId,
        parentId: this.#leafId,
        type: "message",
        timestamp: new Date().toISOString(),
        data: { role: "user", content: followUpText, id: followUpId },
      };
      await this.#appendEntry(followUpEntry);
      const followUpContext = await this.#loadContextMessages(this.#compactTokens());
      this.#startTurn(followUpContext);
      return;
    }

    this.#currentTurn = null;
    this.#notifyListeners({ type: "turn_flushed" });
  }

  async #appendEntry(entry: AnyEntry): Promise<void> {
    this.#leafId = entry.id;
    await this.#ensureSessionCommitted();
    await persistEntry(entry, this.env.SESSIONS_DB);
    this.#updatedAt = Date.now();
  }

  #compactTokens(): number {
    const val = parseInt(this.env.COMPACT_TOKENS, 10);
    return Number.isFinite(val) && val > 0 ? val : 100_000;
  }

  async #persistGeneratedMessages(messages: ModelMessage[]): Promise<void> {
    for (const message of messages) {
      const entryId = generateEntryId();
      const entry: MessageEntry = {
        id: entryId,
        sessionId: this.#sessionId,
        parentId: this.#leafId,
        type: "message",
        timestamp: new Date().toISOString(),
        data: {
          ...message,
          id: entryId,
        },
      };
      await this.#appendEntry(entry);
    }
  }

  async #loadContextMessages(contextTokenLimit?: number): Promise<IMessage[]> {
    const context = await buildSessionContextFromDb({
      db: this.env.SESSIONS_DB,
      sessionId: this.#sessionId,
      leafId: this.#leafId,
      ...(contextTokenLimit !== undefined ? { contextTokenLimit } : {}),
    });
    return context.messages;
  }

  async #ensureSessionCommitted(): Promise<void> {
    if (this.#createdAt !== 0 || this.#sessionId === "") {
      return;
    }
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
}

// ─── TurnImpl ─────────────────────────────────────────────────────────────────

export class TurnImpl extends RpcTarget implements ITurn {
  readonly #callback: IGatewayCallback | undefined;
  readonly #abort: () => Promise<void>;

  constructor(callback: IGatewayCallback | undefined, abort: () => Promise<void>) {
    super();
    this.#callback = callback;
    this.#abort = abort;
  }

  async getCallback(): Promise<IGatewayCallback | undefined> {
    return this.#callback;
  }

  async abort(): Promise<void> {
    await this.#abort();
  }
}

function createModel(env: Env, modelId: string): LanguageModel {
  const gateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AI_GATEWAY_NAME,
    apiKey: env.CF_AI_GATEWAY_TOKEN,
  });
  return gateway(createUnified()(modelId)) as LanguageModel;
}
