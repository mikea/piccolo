/**
 * AgentSessionDO — Durable Object that owns one live piccolo session.
 *
 * Implements ISession directly — no SessionImpl wrapper needed. The DO
 * itself is the RpcTarget returned to gateways and tools.
 *
 * One DO instance per session. This is where all live session logic runs:
 *   - Agent loop (via @piccolo/agent)
 *   - Persistence (D1 via session/persistence.ts)
 *   - Context compaction (compaction.ts)
 *   - Auto-retry (retry.ts)
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
import type { Agent, AgentEvent, LanguageModel, ModelMessage } from "@piccolo/agent";
import { Agent as AgentClass } from "@piccolo/agent";
import type { CompactionState } from "./compaction.ts";
import { compact } from "./compaction.ts";
import type { AnyEntry, MessageEntry, ModelChangeEntry, SessionInfoEntry } from "./db/entry-types.ts";
import { generateEntryId, parseEntry } from "./db/entry-types.ts";
import { getEntries, getSession } from "./db/schema.ts";
import { ExtensionRunner } from "./extension-runner.ts";
import { createModel } from "./gateway.ts";
import { checkRetry } from "./retry.ts";
import { buildSessionContext, walkToRoot } from "./session/context.ts";
import { defaultModelId, parseModels } from "./types-internal.ts";
import {
  commitSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
} from "./session/persistence.ts";
import { buildBasePrompt } from "./system-prompt.ts";
import { SystemPromptAssembler } from "./system-prompt-assembler.ts";
import type {
  Attachment,
  CompactOptions,
  ContextUsage,
  CustomEntry as CustomEntryType,
  IAgentTool,
  IGatewayCallback,
  ISession,
  ITurn,
  NewSessionOptions,
  ToolDescriptor,
} from "./types.ts";
import type { CustomEntry, CustomMessageEntry } from "./db/entry-types.ts";

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
  #abortController: AbortController | null = null;
  #followUpQueue: string[] = [];
  #callback: IGatewayCallback | undefined = undefined;
  #lastInputTokens = 0;
  #messagesAtTurnStart = 0;

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
    // 1. Read sessionId and modelId from DO storage
    const sessionId = (await this.ctx.storage.get<string>("sessionId")) ?? "";
    const storedModelId = await this.ctx.storage.get<string>("modelId");

    this.#sessionId = sessionId;
    this.#modelId = storedModelId ?? defaultModelId(this.env.MODELS);

    // 2. If session exists in D1, rehydrate
    if (sessionId !== "") {
      const db = this.env.SESSIONS_DB;
      const sessionRow = await getSession(db, sessionId);
      if (sessionRow !== null) {
        this.#userId = sessionRow.user_id;
        this.#modelId = sessionRow.model_id;
        this.#leafId = sessionRow.leaf_id;
        this.#name = sessionRow.name ?? undefined;
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

    // 3. Build agent
    const model = createModel(this.env, this.#modelId);
    this.#agent = new AgentClass({ model, systemPrompt: "" });
    this.#agent.replaceMessages(this.#messages);

    // 4. Set up extension runner and system prompt
    this.#extensionRunner = new ExtensionRunner();
    this.#assembler = new SystemPromptAssembler();
    await this.#extensionRunner.initialize(this, this.env.CONFIG, this.env.EXTENSIONS, this.#modelId);

    const basePrompt = buildBasePrompt(this.env.AGENT_NAME);
    this.#assembledSystemPrompt = this.#assembler.assemble(
      basePrompt,
      this.#extensionRunner.getSystemPromptAdditions(),
      this.#extensionRunner.getToolDescriptors(),
    );
    this.#agent.setSystemPrompt(this.#assembledSystemPrompt);
    this.#agent.setTools(
      this.#extensionRunner.getToolsByNames(
        this.#extensionRunner.getToolDescriptors().map((d) => d.name),
      ),
    );
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
    console.debug("[session] getName sessionId=%s →", this.#sessionId, this.#name);
    return this.#name;
  }

  async setName(name: string): Promise<void> {
    console.debug("[session] setName sessionId=%s name=%s", this.#sessionId, name);
    this.#name = name;
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
      await flushPendingEntries(this.#pendingEntries, this.#sessionId, this.#leafId!, this.env.SESSIONS_DB);
      this.#pendingEntries = [];
    }
  }

  // ─── ISession: Conversation ───────────────────────────────────────────────

  async prompt(
    text: string,
    attachments?: Attachment[],
    callback?: IGatewayCallback,
  ): Promise<ReadableStream<AgentEvent>> {
    console.debug("[session] prompt sessionId=%s text=%s", this.#sessionId, text.slice(0, 80));
    this.#callback = callback;
    this.#agent.setContext(this);

    // emitInput
    const inputResult = await this.#extensionRunner.emitInput(
      { text, attachments: attachments ?? [], source: "user" },
      this,
    );
    if (inputResult.action === "handled") {
      return new ReadableStream<AgentEvent>({ start(c) { c.close(); } });
    }
    const effectiveText = inputResult.action === "transform" ? (inputResult.text ?? text) : text;

    // Build user message and entry
    const userMessage: ModelMessage =
      attachments && attachments.length > 0
        ? { role: "user", content: [{ type: "text", text: effectiveText }, ...attachments.map((a) => ({ type: "file" as const, data: a.data, mediaType: a.mimeType }))] }
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
      { text: effectiveText, attachments: attachments ?? [], systemPrompt: this.#assembledSystemPrompt },
      this,
    );
    if (beforeStart.contextMessages && beforeStart.contextMessages.length > 0) {
      this.#agent.appendMessages(beforeStart.contextMessages);
    }
    this.#agent.setSystemPrompt(beforeStart.systemPrompt ?? this.#assembledSystemPrompt);

    if (this.#computeContextUsage().inputTokens > this.#compactTokens()) {
      await this.#compact({});
    }

    // Set up stream and abort
    const { readable, writable } = new TransformStream<AgentEvent, AgentEvent>();
    const writer = writable.getWriter();
    this.#messagesAtTurnStart = this.#agent.state.messages.length;
    const abortController = new AbortController();
    this.#abortController = abortController;

    const unsub = this.#agent.subscribe((event: AgentEvent) => {
      writer.write(event).catch(() => {});
      if (event.type === "turn_end") {
        this.#lastInputTokens = event.usage.inputTokens ?? this.#lastInputTokens;
      }
      this.#extensionRunner.emit(event.type, event, this).catch(() => {});
      if (event.type === "agent_end") {
        this.#lastInputTokens = event.totalUsage.inputTokens ?? this.#lastInputTokens;
        this.#flushPromise = this.#handleAgentEnd(abortController.signal);
        this.#flushPromise.catch((err) => {
          console.error("AgentSessionDO: _handleAgentEnd error", err);
        });
      }
    });

    this.#agent
      .prompt([userMessage])
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        writer.write({ type: "error", message: msg }).catch(() => {});
      })
      .finally(() => {
        unsub();
        this.#abortController = null;
        this.#callback = undefined;
        writer.close().catch(() => {});
      });

    return readable;
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
    this.#abortController?.abort();
  }

  async getCurrentTurn(): Promise<ITurn | undefined> {
    if (this.#callback === undefined && this.#abortController === null) return undefined;
    return new TurnImpl(this.#callback);
  }

  // ─── ISession: Model management ───────────────────────────────────────────

  async getModel(): Promise<string> {
    const stored = this.#modelId;
    const allowed = parseModels(this.env.MODELS);
    const result = allowed.includes(stored) ? stored : (allowed[0] ?? stored);
    console.debug("[session] getModel sessionId=%s stored=%s → %s", this.#sessionId, stored, result);
    return result;
  }

  async setModel(modelId: string): Promise<void> {
    console.debug("[session] setModel sessionId=%s modelId=%s", this.#sessionId, modelId);
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
      await flushPendingEntries(this.#pendingEntries, this.#sessionId, this.#leafId!, this.env.SESSIONS_DB);
      this.#pendingEntries = [];
    }
  }

  async listModels(): Promise<string[]> {
    const models = parseModels(this.env.MODELS);
    console.debug("[session] listModels sessionId=%s →", this.#sessionId, models);
    return models;
  }

  // ─── ISession: Tools ──────────────────────────────────────────────────────

  async getActiveTools(): Promise<ToolDescriptor[]> {
    return this.#agent.state.tools.map((t) => t.descriptor as ToolDescriptor);
  }

  async setActiveTools(tools: IAgentTool[]): Promise<void> {
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
      await flushPendingEntries(this.#pendingEntries, this.#sessionId, this.#leafId, this.env.SESSIONS_DB);
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
    this.#name = options?.name;
    await this.ctx.storage.put("sessionId", sessionId);
    await this.ctx.storage.put("modelId", modelId);
    if (!this.#modelOverridden) {
      this.#agent.setModel(createModel(this.env, modelId));
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

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
    const extra = estimateTokens(this.#agent.state.messages.slice(this.#lastInputTokens === 0 ? 0 : undefined));
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
    await compact(compactionState, this, options);
    this.#leafId = compactionState.leafId;
  }

  async #handleAgentEnd(signal: AbortSignal): Promise<void> {
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
      await flushPendingEntries(this.#pendingEntries, this.#sessionId, this.#leafId, this.env.SESSIONS_DB);
      this.#pendingEntries = [];
      this.#updatedAt = Date.now();
    }

    if (this.#agent.state.error) {
      await checkRetry(this.#agent.state.error, this.#agent, signal, async () => {
        await this.#compact({});
        if (this.#sessionId !== "" && this.#leafId !== null) {
          await flushPendingEntries(this.#pendingEntries, this.#sessionId, this.#leafId, this.env.SESSIONS_DB);
          this.#pendingEntries = [];
        }
        await this.#agent.continue();
      });
    }
  }
}

// ─── TurnImpl ─────────────────────────────────────────────────────────────────

export class TurnImpl extends RpcTarget implements ITurn {
  constructor(private readonly callback: IGatewayCallback | undefined) {
    super();
  }

  async getCallback(): Promise<IGatewayCallback | undefined> {
    return this.callback;
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
        if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
          chars += String(part.text).length;
        } else {
          chars += 50;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
