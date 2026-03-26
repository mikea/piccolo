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
  BeforeAgentStartResult,
  CompactOptions,
  ContextUsage,
  CustomEntry as CustomEntryType,
  HistoryEntry,
  IGatewayCallback,
  InputResult,
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

import { buildSessionContext, walkToRoot } from "./session/context.ts";
import {
  commitSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
} from "./session/persistence.ts";
import { StreamBroadcaster } from "./stream-broadcaster.ts";
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

  // ─── Turn state ───────────────────────────────────────────────────────────
  #currentTurn: TurnImpl | null = null;
  #followUpQueue: string[] = [];
  #lastInputTokens = 0;
  #messagesAtTurnStart = 0;

  // ─── Live streaming state (for getHistory / subscribe) ────────────────────
  // Tracks in-flight assistant content so getHistory() can return it before
  // the turn completes and commits to D1. Cleared on agent_end / error.
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
    console.debug("[session] initialize start");

    // 1. Read sessionId and modelId from DO storage
    const sessionId = (await this.ctx.storage.get<string>("sessionId")) ?? "";
    const storedModelId = await this.ctx.storage.get<string>("modelId");
    const storedName = await this.ctx.storage.get<string>("name");
    console.debug(`[session:${sessionId}] initialize storage read done dt=${Date.now() - t0}ms`);

    this.#sessionId = sessionId;
    this.#modelId = storedModelId ?? defaultModelId(this.env.MODELS);
    this.#name = storedName ?? (sessionId !== "" ? sessionId : undefined);

    // 2. If session exists in D1, rehydrate
    if (sessionId !== "") {
      const db = this.env.SESSIONS_DB;
      const sessionRow = await getSession(db, sessionId);
      console.debug(`[session:${sessionId}] initialize getSession done dt=${Date.now() - t0}ms`);
      if (sessionRow !== null) {
        this.#userId = sessionRow.user_id;
        this.#modelId = sessionRow.model_id;
        this.#leafId = sessionRow.leaf_id;
        this.#name = sessionRow.name ?? this.#sessionId;
        this.#createdAt = sessionRow.created_at;
        this.#updatedAt = sessionRow.updated_at;

        const rawRows = await getEntries(db, sessionId);
        console.debug(
          `[session:${sessionId}] initialize getEntries done entries=${rawRows.length} dt=${Date.now() - t0}ms`,
        );
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
        console.debug(
          `[session:${sessionId}] initialize rehydrate done messages=${this.#messages.length} dt=${Date.now() - t0}ms`,
        );
      }
    }

    // 3. Build agent
    const model = createModel(this.env, this.#modelId);
    this.#agent = new Agent({ model, systemPrompt: "" });
    this.#agent.replaceMessages(this.#messages);

    // 4. Set up extension runner and system prompt
    this.#extensionRunner = new ExtensionRunner();
    this.#assembler = new SystemPromptAssembler();
    this.#rpcCtx = new SessionTarget(this);
    // Register extension runner as a permanent listener.
    const rpcCtx = this.#rpcCtx;
    const extensionRunner = this.#extensionRunner;
    this.addListener({
      onEvent: (event) => {
        if (event.type === "turn_flushed") return;
        extensionRunner.emit(event, rpcCtx).catch(() => {});
      },
    });
    await this.#extensionRunner.initialize(
      this.#rpcCtx,
      this.env.CONFIG,
      this.env.EXTENSIONS,
      this.#modelId,
    );
    console.debug(`[session:${sessionId}] initialize extensionRunner done dt=${Date.now() - t0}ms`);

    const basePrompt = buildBasePrompt(this.env.AGENT_NAME);
    const extensionTools = this.#extensionRunner.getTools();
    this.#assembledSystemPrompt = this.#assembler.assemble(
      basePrompt,
      this.#extensionRunner.getSystemPromptAdditions(),
      extensionTools,
    );
    this.#agent.setSystemPrompt(this.#assembledSystemPrompt);
    this.#agent.setTools(extensionTools);

    console.debug(`[session:${sessionId}] initialize done dt=${Date.now() - t0}ms`);
  }

  // ─── Test-only helpers ────────────────────────────────────────────────────

  _setModelForTest(model: LanguageModel): void {
    this.#agent.setModel(model);
    this.#modelId = "test-mock";
    this.#modelOverridden = true;
  }

  _getAssembledSystemPrompt(): string {
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
    console.debug(`[session:${this.#sessionId}] getName → ${this.#name}`);
    return this.#name;
  }

  async setName(name: string): Promise<void> {
    console.debug(`[session:${this.#sessionId}] setName name=${name}`);
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
    console.debug(`[session:${this.#sessionId}] prompt text=${text.slice(0, 80)}`);
    if (this.#currentTurn !== null) {
      throw new Error("A turn is already in progress. Call abort() before starting a new turn.");
    }
    this.#agent.setContext(this);
    const ctx = this.#rpcCtx;

    // emitInput
    const inputResult = (await this.#extensionRunner.emit(
      { type: "input", text, attachments: attachments ?? [], source: "user" },
      ctx,
    )) as InputResult;
    if (inputResult.action === "handled") {
      const broadcaster = new StreamBroadcaster<AgentEvent>();
      broadcaster.closed = true; // already done — connect() returns immediately-closed streams
      const turn = new TurnImpl(broadcaster, callback);
      console.debug(`[session:${this.#sessionId}] #currentTurn null → turn (handled-input)`);
      this.#currentTurn = turn;
      // No stream to drain — clear the turn right away
      void Promise.resolve().then(() => {
        console.debug(`[session:${this.#sessionId}] #currentTurn turn → null (handled-input)`);
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

    // emitBeforeAgentStart
    const beforeStart = (await this.#extensionRunner.emit(
      {
        type: "before_agent_start",
        text: effectiveText,
        attachments: attachments ?? [],
        systemPrompt: this.#assembledSystemPrompt,
      },
      ctx,
    )) as BeforeAgentStartResult;
    if (beforeStart.contextMessages && beforeStart.contextMessages.length > 0) {
      this.#agent.appendMessages(beforeStart.contextMessages);
    }
    this.#agent.setSystemPrompt(beforeStart.systemPrompt ?? this.#assembledSystemPrompt);

    if (this.#computeContextUsage().inputTokens > this.#compactTokens()) {
      await this.#compact({});
    }

    this.#messagesAtTurnStart = this.#agent.state.messages.length;

    // Start the agent turn — returns AgentTurn synchronously
    const agentTurn = this.#agent.prompt([userMessage]);

    // The broadcaster fans out to any number of connect() subscribers.
    // The DO pipes agentTurn.stream through it — bc.readable is the primary
    // drain that drives backpressure; each connect() call gets an independent
    // copy of every event from that point forward.
    const broadcaster = new StreamBroadcaster<AgentEvent>();
    const turn = new TurnImpl(broadcaster, callback);
    console.debug(`[session:${this.#sessionId}] #currentTurn null → turn`);
    this.#currentTurn = turn;

    // Pipe the agent stream through the broadcaster and drain bc.readable.
    // Peek at each event for DO side-effects; call #onTurnClose when done.
    this.ctx.waitUntil(this.#drainTurnStream(agentTurn.stream, broadcaster));

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
    const isStreaming = this.#agent.state.isStreaming;

    // Walk committed messages to build history entries.
    // #messages are the ModelMessage[] currently held in the agent (committed after agent_end).
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

  // ─── ISession: Model management ───────────────────────────────────────────

  async getModel(): Promise<string> {
    const stored = this.#modelId;
    const allowed = parseModels(this.env.MODELS);
    const result = allowed.includes(stored) ? stored : (allowed[0] ?? stored);
    console.debug(`[session:${this.#sessionId}] getModel stored=${stored} → ${result}`);
    return result;
  }

  async setModel(modelId: string): Promise<void> {
    console.debug(`[session:${this.#sessionId}] setModel modelId=${modelId}`);
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
    const models = parseModels(this.env.MODELS);
    console.debug(`[session:${this.#sessionId}] listModels → ${JSON.stringify(models)}`);
    return models;
  }

  // ─── ISession: Tools ──────────────────────────────────────────────────────

  async getActiveTools(): Promise<ToolDescriptor[]> {
    return this.#agent.state.tools.map((t) => t.descriptor as ToolDescriptor);
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

  async getSystemPrompt(): Promise<string> {
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
      case "agent_start":
        this.#streamingAssistantText = "";
        this.#streamingToolCalls.clear();
        break;
      case "text_delta":
        this.#streamingAssistantText += event.delta;
        break;
      case "tool_start":
        this.#streamingToolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          input: event.input,
        });
        break;
      case "tool_end":
        this.#streamingToolCalls.delete(event.toolCallId);
        break;
      case "turn_end":
        // 2. Token count from per-step usage
        this.#lastInputTokens = event.usage.inputTokens ?? this.#lastInputTokens;
        this.#streamingAssistantText = "";
        break;
      case "agent_end":
        // 2. Token count from total usage
        this.#lastInputTokens = event.totalUsage.inputTokens ?? this.#lastInputTokens;
        this.#streamingAssistantText = "";
        this.#streamingToolCalls.clear();
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
   * Pipe agentStream through the broadcaster and drain bc.readable (the primary
   * drain that drives backpressure). Calls #onTurnEvent per chunk.
   * On stream error, aborts the broadcaster so subscribers receive the error.
   *
   * After the stream closes, schedules #handleAgentEnd via this.ctx.waitUntil()
   * so D1 writes are protected from DO eviction. Fires turn_flushed to all
   * listeners once #handleAgentEnd completes.
   */
  async #drainTurnStream(
    agentStream: ReadableStream<AgentEvent>,
    broadcaster: StreamBroadcaster<AgentEvent>,
  ): Promise<void> {
    const reader = agentStream.pipeThrough(broadcaster).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#onTurnEvent(value);
      }
    } catch (err) {
      broadcaster.abort(err);
    } finally {
      reader.releaseLock();
    }

    // Use this.ctx.waitUntil so the DO runtime keeps this DO alive until
    // D1 writes complete — even if the RPC connection drops beforehand.
    const flush = this.#handleAgentEnd()
      .catch((err) => {
        console.error(`[session:${this.#sessionId}] handleAgentEnd error`, err);
      })
      .finally(() => {
        console.debug(`[session:${this.#sessionId}] #currentTurn turn → null`);
        this.#currentTurn = null;
        this.#notifyListeners({ type: "turn_flushed" });
      });
    this.ctx.waitUntil(flush);
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

  async #handleAgentEnd(): Promise<void> {
    await this.#persistNewMessages();

    // Process follow-up queue: each follow-up starts a new agent turn.
    // These are internal turns — no gateway consumer listens to them.
    while (this.#followUpQueue.length > 0) {
      const followUpText = this.#followUpQueue.shift() ?? "";
      this.#messagesAtTurnStart = this.#agent.state.messages.length;
      const followUpTurn = this.#agent.prompt(followUpText);

      // Drain the follow-up stream, calling #onTurnEvent per chunk.
      // No broadcaster needed — no gateway listens to follow-up turns.
      const reader = followUpTurn.stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.#onTurnEvent(value);
        }
      } finally {
        reader.releaseLock();
      }

      await this.#persistNewMessages();
    }
  }

  /** Persist all new agent messages to D1 since the last flush point. */
  async #persistNewMessages(): Promise<void> {
    const newMessages = this.#agent.state.messages.slice(this.#messagesAtTurnStart);
    for (const msg of newMessages) {
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
  readonly #broadcaster: StreamBroadcaster<AgentEvent>;
  readonly #callback: IGatewayCallback | undefined;
  // Pre-connect one subscriber immediately so the first getStream() caller
  // never misses events that were emitted before getStream() was called.
  readonly #firstStream: ReadableStream<AgentEvent>;
  #firstStreamConsumed = false;

  constructor(broadcaster: StreamBroadcaster<AgentEvent>, callback: IGatewayCallback | undefined) {
    super();
    this.#broadcaster = broadcaster;
    this.#callback = callback;
    this.#firstStream = broadcaster.connect();
  }

  async getStream(): Promise<ReadableStream<AgentEvent>> {
    if (!this.#firstStreamConsumed) {
      this.#firstStreamConsumed = true;
      return this.#firstStream;
    }
    return this.#broadcaster.connect();
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
