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
import { asRpcTarget } from "./rpc-util.ts";
import { buildSessionContext, walkToRoot } from "./session/context.ts";
import {
  commitSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
} from "./session/persistence.ts";
import { SessionTransformStream } from "./session-transform.ts";
import { buildBasePrompt } from "./system-prompt.ts";
import { SystemPromptAssembler } from "./system-prompt-assembler.ts";
import type {
  AgentEvent,
  AgentTurn,
  Attachment,
  CompactOptions,
  ContextUsage,
  CustomEntry as CustomEntryType,
  HistoryEntry,
  IGatewayCallback,
  ISession,
  ITool,
  ITurn,
  NewSessionOptions,
  SessionStatus,
  ToolDescriptor,
} from "./types.ts";
import { defaultModelId, parseModels } from "./types-internal.ts";

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

  // ─── Agent and infrastructure ─────────────────────────────────────────────
  #agent!: Agent;
  #extensionRunner!: ExtensionRunner;
  #assembler!: SystemPromptAssembler;
  #assembledSystemPrompt = "";

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
  #flushPromise: Promise<void> | null = null;

  // ─── Initialisation ───────────────────────────────────────────────────────

  readonly userId: string = ""; // ISession requires this; updated after #initialize

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
    const extensionCtx = this.#asSessionStub();
    await this.#extensionRunner.initialize(
      extensionCtx,
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

  async waitForFlush(): Promise<void> {
    if (this.#flushPromise !== null) await this.#flushPromise;
  }

  // ─── ISession: Identity ───────────────────────────────────────────────────

  async sessionId(): Promise<string> {
    return this.#sessionId;
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
    const extensionCtx = this.#asSessionStub();

    // emitInput
    const inputResult = await this.#extensionRunner.emitInput(
      { text, attachments: attachments ?? [], source: "user" },
      extensionCtx,
    );
    if (inputResult.action === "handled") {
      const emptyStream = new ReadableStream<AgentEvent>({
        start(c) {
          c.close();
        },
      });
      const turn = new TurnImpl(emptyStream, callback);
      this.#currentTurn = turn;
      // emptyStream closes immediately — clear the turn right away
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

    // emitBeforeAgentStart
    const beforeStart = await this.#extensionRunner.emitBeforeAgentStart(
      {
        text: effectiveText,
        attachments: attachments ?? [],
        systemPrompt: this.#assembledSystemPrompt,
      },
      extensionCtx,
    );
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

    // Wire the SessionTransformStream: peeks at events for DO side-effects,
    // forwards each event unchanged to the gateway.
    const transform = new SessionTransformStream(
      `session:${this.#sessionId}`,
      (event) => this.#onTurnEvent(event, extensionCtx),
      () => this.#onTurnClose(),
    );

    const outStream = agentTurn.stream.pipeThrough(transform);
    const turn = new TurnImpl(outStream, callback);
    // Assigned once — same RpcTarget instance for the duration of this logical turn
    // (including any follow-up turns). Cleared in #onTurnClose() finally.
    this.#currentTurn = turn;
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

  async getStatus(): Promise<SessionStatus> {
    return {
      isStreaming: this.#agent.state.isStreaming,
      model: this.#modelId,
      name: this.#name,
    };
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
  #onTurnEvent(event: AgentEvent, extensionCtx: ISession): void {
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

    // 3. Extension dispatch (fire-and-forget)
    this.#extensionRunner.emit(event.type, event, extensionCtx).catch(() => {});
  }

  /**
   * Called by SessionTransformStream's flush() when the Agent's stream closes.
   * Schedules #handleAgentEnd() via ctx.waitUntil() and clears #currentTurn in
   * the finally block — after all follow-up processing completes.
   *
   * Spec ref: specs/core.md §AgentSessionDO §#onTurnClose
   */
  #onTurnClose(): void {
    this.#flushPromise = this.#handleAgentEnd().finally(() => {
      this.#currentTurn = null;
    });
    this.#flushPromise.catch((err) => {
      console.error(`[session:${this.#sessionId}] handleAgentEnd error`, err);
    });
    this.ctx.waitUntil(this.#flushPromise);
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
    await compact(compactionState, this.#asSessionStub(), options);
    this.#leafId = compactionState.leafId;
  }

  #asSessionStub(): ISession {
    return asRpcTarget(this);
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
    // The same extensionCtx is used so extensions receive follow-up events too.
    const extensionCtx = this.#asSessionStub();
    while (this.#followUpQueue.length > 0) {
      const followUpText = this.#followUpQueue.shift()!;
      this.#messagesAtTurnStart = this.#agent.state.messages.length;
      const followUpTurn = this.#agent.prompt(followUpText);

      // Consume follow-up stream through the same event processing pipeline.
      // No gateway receives this stream — pipe to a discard WritableStream.
      const followUpTransform = new SessionTransformStream(
        `session:${this.#sessionId}:followup`,
        (event) => this.#onTurnEvent(event, extensionCtx),
        () => {}, // no nested close handler — persistence done below via await
      );

      await followUpTurn.stream.pipeThrough(followUpTransform).pipeTo(new WritableStream());

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
  readonly #stream: ReadableStream<AgentEvent>;
  readonly #callback: IGatewayCallback | undefined;

  constructor(stream: ReadableStream<AgentEvent>, callback: IGatewayCallback | undefined) {
    super();
    this.#stream = stream;
    this.#callback = callback;
  }

  async getStream(): Promise<ReadableStream<AgentEvent>> {
    return this.#stream;
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
