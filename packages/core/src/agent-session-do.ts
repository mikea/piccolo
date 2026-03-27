/**
 * AgentSessionDO — Durable Object that owns one live piccolo session.
 *
 * Implements ISession directly — no SessionImpl wrapper needed. The DO
 * itself is the RpcTarget returned to gateways and tools.
 *
 * One DO instance per session. This is where all live session logic runs:
 *   - Agent loop (agent.ts)
 *   - Persistence (D1 via session/persistence.ts)
 *   - Context compaction (compaction.ts)
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
  BeforeStartResult,
  CompactOptions,
  ContextUsage,
  CustomEntry as CustomEntryType,
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
import type { LanguageModel, ModelMessage } from "ai";
import { Agent } from "./agent.ts";
import type { CompactionState } from "./compaction.ts";
import { compact } from "./compaction.ts";
import type {
  AnyEntry,
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
  setActiveTools(tools: ITool[]): Promise<void> {
    return this.#do.setActiveTools(tools);
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
  #messages: ModelMessage[] = [];
  #pendingEntries: AnyEntry[] = [];
  #branchEntries: AnyEntry[] = [];
  #messageToEntryId = new Map<ModelMessage, string>();

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

  // ─── Agent and infrastructure ─────────────────────────────────────────────
  #agent!: Agent;
  #extensionRunner!: ExtensionRunner;
  #assembler!: SystemPromptAssembler;
  #assembledSystemPrompt = "";
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
    const t0 = Date.now();
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

        const rawRows = await getEntries(db, sessionId);
        const allEntries = rawRows.map(parseEntry);
        const context = buildSessionContext(allEntries, this.#leafId);
        this.#messages = context.messages;
        if (allEntries.some((e) => e.type === "model_change")) {
          this.#modelId = context.modelId;
        }
        for (const entry of allEntries) {
          if (entry.type === "message") {
            this.#messageToEntryId.set((entry as MessageEntry).data, entry.id);
          }
        }
        this.#branchEntries = walkToRoot(allEntries, this.#leafId);
      }
    }

    // 3. Initialize session-level observable (lives for the session lifetime)
    this.#observable = new ObservableImpl<AgentEvent>();

    // 4. Build agent — Agent extends ObservableImpl<AgentEvent>, so we subscribe
    // to it once here and forward every event to the session observable.
    const model = createModel(this.env, this.#modelId);
    this.#agent = new Agent({ model, systemPrompt: "" });
    this.#agent.replaceMessages(this.#messages);
    void this.#agent.subscribe({
      onNext: async (event) => {
        this.#onTurnEvent(event);
        this.#observable.emit(event);
        if (event.type === "finish") {
          this.ctx.waitUntil(this.#onAgentEnd());
        }
      },
      onError: async (err) => {
        console.error(`[session:${this.#sessionId}] agent error`, err);
      },
      onComplete: async () => {},
    });

    // 4. Set up extension runner and system prompt infrastructure.
    // Extensions are initialised here (inside blockConcurrencyWhile) since
    // getTools/getCommands/getSystemPromptAdditions do not call back into ctx.
    // The system prompt assembly is deferred to #ensureSystemPrompt() (called
    // from prompt()) so that any reverse RPC into ctx from extensions happens
    // outside the concurrency block.
    this.#extensionRunner = new ExtensionRunner();
    this.#assembler = new SystemPromptAssembler();
    this.#rpcCtx = new SessionTarget(this);

    await this.#extensionRunner.initialize(
      this.#rpcCtx,
      this.env.CONFIG,
      this.env.EXTENSIONS,
      this.#modelId,
    );
    this.#agent.setTools(this.#extensionRunner.getTools());

    void t0; // suppress unused-variable warning
  }

  // ─── Test-only helpers ────────────────────────────────────────────────────

  _setModelForTest(model: LanguageModel): void {
    this.#agent.setModel(model);
    this.#modelId = "test-mock";
    this.#modelOverridden = true;
  }

  async _getAssembledSystemPrompt(): Promise<string> {
    await this.#ensureSystemPrompt();
    return this.#assembledSystemPrompt;
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
    // Ensure the system prompt (and extension tools) are set before the first
    // turn. #ensureSystemPrompt() is a no-op after the first call. Called here
    // rather than in blockConcurrencyWhile so that reverse RPC calls from
    // extensions back into ctx are not deadlocked.
    await this.#ensureSystemPrompt();
    if (this.#currentTurn !== null) {
      throw new Error("A turn is already in progress. Call abort() before starting a new turn.");
    }
    this.#agent.setContext(this.#rpcCtx);
    const ctx = this.#rpcCtx;

    // emitInput
    const inputResult = (await this.#extensionRunner.emit(
      { type: "input", text, attachments: attachments ?? [], source: "user" },
      ctx,
    )) as InputResult;
    if (inputResult.action === "handled") {
      const turn = new TurnImpl(callback);
      this.#currentTurn = turn;
      // No events to emit — clear the turn right away.
      void Promise.resolve().then(() => {
        this.#currentTurn = null;
      });
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
    this.#messageToEntryId.set(userMessage, userEntryId);

    // emitBeforeStart
    const beforeStart = (await this.#extensionRunner.emit(
      {
        type: "before_start",
        text: effectiveText,
        attachments: attachments ?? [],
        systemPrompt: this.#assembledSystemPrompt,
      },
      ctx,
    )) as BeforeStartResult;
    if (beforeStart.contextMessages && beforeStart.contextMessages.length > 0) {
      this.#agent.appendMessages(beforeStart.contextMessages);
    }
    this.#agent.setSystemPrompt(beforeStart.systemPrompt ?? this.#assembledSystemPrompt);

    if (this.#computeContextUsage().inputTokens > this.#compactTokens()) {
      await this.#compact({});
    }

    this.#messagesAtTurnStart = this.#agent.state.messages.length;

    const turn = new TurnImpl(callback);
    this.#currentTurn = turn;

    // Start the agent turn — events flow via the agent subscription registered in _init.
    this.#agent.prompt([userMessage]);

    return turn;
  }

  async sendUserMessage(content: string): Promise<void> {
    this.#agent.steer({ role: "user", content });
  }

  async steer(text: string): Promise<void> {
    this.#agent.steer({ role: "user", content: text });
  }

  async followUp(text: string): Promise<void> {
    this.#followUpQueue.push(text);
  }

  async abort(): Promise<void> {
    this.#agent.abort();
  }

  async getCurrentTurn(): Promise<ITurn | undefined> {
    return this.#currentTurn ?? undefined;
  }

  // ─── ISession: History & live subscription ────────────────────────────────

  async getHistory(): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];
    const isStreaming = this.#currentTurn !== null;

    // Walk committed messages to build history entries.
    // #messages are the ModelMessage[] currently held in the agent (committed after finish).
    // We also need a map from toolCallId → entry index to fill in tool results.
    const toolEntryIndex = new Map<string, number>();

    for (const msg of this.#messages) {
      const id = this.#messageToEntryId.get(msg) ?? Math.random().toString(36).slice(2);
      if (msg.role === "user") {
        const content = typeof msg.content === "string" ? msg.content : "[attachment]";
        entries.push({ type: "user", id, content });
      } else if (msg.role === "assistant") {
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part === "object" && part !== null && "type" in part) {
              if (part.type === "text" && "text" in part) {
                text += String(part.text);
              } else if (
                part.type === "tool-call" &&
                "toolName" in part &&
                "input" in part &&
                "toolCallId" in part
              ) {
                const toolCallId = String(part.toolCallId);
                const toolIdx = entries.length;
                toolEntryIndex.set(toolCallId, toolIdx);
                entries.push({
                  type: "tool",
                  id: toolCallId,
                  toolName: String(part.toolName),
                  input: part.input,
                  output: undefined,
                  isError: false,
                  isStreaming: false,
                });
              }
            }
          }
        }
        if (text.length > 0) {
          entries.push({ type: "assistant", id, content: text, isStreaming: false });
        }
      } else if (msg.role === "tool") {
        // tool role messages carry tool results — fill in the matching tool entry.
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "tool-result" &&
              "toolCallId" in part
            ) {
              const toolCallId = String(part.toolCallId);
              const idx = toolEntryIndex.get(toolCallId);
              if (idx !== undefined) {
                const existing = entries[idx];
                if (existing?.type === "tool") {
                  const isError = "isError" in part ? Boolean(part.isError) : false;
                  const output = "result" in part ? part.result : undefined;
                  entries[idx] = { ...existing, output, isError };
                }
              }
            }
          }
        }
      }
    }

    // Append in-flight streaming content if a turn is active.
    if (isStreaming) {
      for (const [toolCallId, tc] of this.#streamingToolCalls) {
        entries.push({
          type: "tool",
          id: toolCallId,
          toolName: tc.toolName,
          input: tc.input,
          output: undefined,
          isError: false,
          isStreaming: true,
        });
      }
      if (this.#streamingAssistantText.length > 0) {
        entries.push({
          type: "assistant",
          id: "streaming",
          content: this.#streamingAssistantText,
          isStreaming: true,
        });
      }
    }

    return entries;
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
    this.#agent.setModel(createModel(this.env, modelId));
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
    return Promise.all(this.#agent.state.tools.map((t) => t.getDescriptor()));
  }

  async setActiveTools(tools: ITool[]): Promise<void> {
    this.#agent.setTools(tools);
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

  async #ensureSystemPrompt(): Promise<void> {
    if (!this.#assembledSystemPrompt) {
      const basePrompt = buildBasePrompt(this.env.AGENT_NAME);
      const extensionTools = this.#extensionRunner.getTools();
      this.#assembledSystemPrompt = await this.#assembler.assemble(
        basePrompt,
        this.#extensionRunner.getSystemPromptAdditions(),
        extensionTools,
      );
      this.#agent.setSystemPrompt(this.#assembledSystemPrompt);
    }
  }

  async getSystemPrompt(): Promise<string> {
    await this.#ensureSystemPrompt();
    return this.#assembledSystemPrompt;
  }

  // ─── ISession: Session tree ───────────────────────────────────────────────

  async branch(entryId: string): Promise<void> {
    this.#leafId = entryId;
    const rawRows = await getEntries(this.env.SESSIONS_DB, this.#sessionId);
    const allEntries = rawRows.map(parseEntry);
    const context = buildSessionContext(allEntries, entryId);
    this.#agent.replaceMessages(context.messages);
    this.#messages = context.messages;
    if (context.modelId !== this.#modelId) {
      this.#modelId = context.modelId;
      this.#agent.setModel(createModel(this.env, context.modelId));
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
    this.#agent.abort();
    this.#pendingEntries = [];
    this.#messages = [];
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
      this.#agent.setModel(createModel(this.env, modelId));
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Called by SessionTransformStream for every AgentEvent as it passes through.
   * All event-driven side effects for the DO live here — no logic in the stream
   * callbacks themselves.
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
   * Called via ctx.waitUntil when finish fires on the agent subscription.
   * Persists messages, runs any queued follow-up turns, then fires turn_flushed.
   * Follow-up turns also emit through the agent subscription — they trigger
   * #onAgentEnd again when they finish, processing the queue recursively.
   */
  async #onAgentEnd(): Promise<void> {
    await this.#persistNewMessages().catch((err) => {
      console.error(`[session:${this.#sessionId}] persistNewMessages error`, err);
    });

    if (this.#followUpQueue.length > 0) {
      // Start the next follow-up turn — it will emit through the agent subscription
      // and trigger #onAgentEnd again when it finishes.
      const followUpText = this.#followUpQueue.shift() ?? "";
      this.#messagesAtTurnStart = this.#agent.state.messages.length;
      this.#agent.prompt(followUpText);
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
      this.#agent.state.messages.slice(this.#lastInputTokens === 0 ? 0 : undefined),
    );
    return { inputTokens: this.#lastInputTokens + extra };
  }

  async #compact(options: CompactOptions): Promise<void> {
    const compactionState: CompactionState = {
      sessionId: this.#sessionId,
      leafId: this.#leafId,
      agent: this.#agent,
      extensionRunner: this.#extensionRunner,
      messageToEntryId: this.#messageToEntryId,
      pendingEntries: this.#pendingEntries,
      lastInputTokens: this.#lastInputTokens,
    };
    await compact(compactionState, this.#rpcCtx, options);
    this.#leafId = compactionState.leafId;
  }

  #requireLeafId(): string {
    if (this.#leafId === null) {
      throw new Error("Session leafId is not initialized");
    }
    return this.#leafId;
  }

  /** Persist all new agent messages to D1 since the last flush point. */
  async #persistNewMessages(): Promise<void> {
    const newMessages = this.#agent.state.messages.slice(this.#messagesAtTurnStart);
    for (const msg of newMessages) {
      if (this.#messageToEntryId.has(msg)) continue; // already tracked (e.g. user message)
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
      this.#messageToEntryId.set(msg, entryId);
    }
    // Advance the start index so the next call only picks up genuinely new messages
    this.#messagesAtTurnStart = this.#agent.state.messages.length;

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
