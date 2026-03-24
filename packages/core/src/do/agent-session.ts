/**
 * AgentSessionDO — Durable Object that owns one live piccolo session.
 *
 * One DO instance per session. This is where all live session logic runs:
 *   - Agent loop (via @piccolo/agent)
 *   - Persistence (D1 via session/persistence.ts)
 *   - Context compaction (compaction.ts)
 *   - Auto-retry (retry.ts)
 *   - Extension dispatch (real ExtensionRunner from step 6)
 *   - System prompt assembly (SystemPromptAssembler)
 *
 * The DO is addressed by sessionId via `env.AGENT_SESSION.idFromName(sessionId)`.
 *
 * Spec refs:
 *   specs/core.md §AgentSessionDO
 *   specs/api.md  §4 IAgentSessionDO
 */

import { DurableObject } from "cloudflare:workers";
import type { AgentEvent, ModelMessage } from "@piccolo/agent";
import { Agent } from "@piccolo/agent";
import type {
  AnyEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionInfoEntry,
} from "../db/entry-types.ts";
import { generateEntryId, parseEntry } from "../db/entry-types.ts";
import { getEntries, getSession } from "../db/schema.ts";
import { buildSessionContext, DEFAULT_MODEL_ID, walkToRoot } from "../session/context.ts";
import {
  commitSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
} from "../session/persistence.ts";
import type {
  Attachment,
  CompactOptions,
  ContextUsage,
  ModelInfo,
  SessionRecord,
} from "../types.ts";
import type { CompactionState } from "./compaction.ts";
import { compact } from "./compaction.ts";
import type { DOState } from "./do-state.ts";
import { ExtensionRunner } from "./extension-runner.ts";
import { createModel } from "./gateway.ts";
import { checkRetry } from "./retry.ts";
import { SessionImpl } from "./session-impl.ts";
import { buildBasePrompt } from "./system-prompt.ts";
import { SystemPromptAssembler } from "./system-prompt-assembler.ts";
import { resolveModel } from "./types-internal.ts";

// ─── AgentSessionDO ───────────────────────────────────────────────────────────

/**
 * Implements IAgentSessionDO from specs/api.md §4.
 */
export class AgentSessionDO extends DurableObject<Env> {
  #state: DOState | null = null;
  /** Pending flush promise — tests await this via waitForFlush() to ensure D1 is up-to-date. */
  #flushPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // blockConcurrencyWhile ensures no RPC calls are served until initialize() completes.
    ctx.blockConcurrencyWhile(async () => {
      this.#state = await this.#initialize();
    });
  }

  // ─── Test-only helpers ────────────────────────────────────────────────────
  // These methods are used by integration tests via runInDurableObject().
  // They are prefixed with _ to signal internal/test use. They are NOT part
  // of IAgentSessionDO and must not be called from production code paths.

  /**
   * Replace the agent's model. Used in tests to inject a mock model.
   * Sets modelOverridden = true so initSession does not re-create the model.
   */
  _setModelForTest(model: import("@piccolo/agent").LanguageModel): void {
    const state = this.#requireState();
    state.agent.setModel(model);
    state.modelId = "test-mock";
    state.modelOverridden = true;
  }

  /** Return the assembled system prompt for the current session. */
  _getAssembledSystemPrompt(): string {
    return this.#requireState().assembledSystemPrompt;
  }

  /**
   * Wait for the most recent agent-end flush to complete.
   * Tests must call this after draining the stream to ensure D1 writes are done.
   */
  async waitForFlush(): Promise<void> {
    if (this.#flushPromise !== null) {
      await this.#flushPromise;
    }
  }

  // ─── Initialisation ──────────────────────────────────────────────────────

  /**
   * Cold start / rehydration.
   * Spec ref: specs/core.md §Cold start / rehydration
   */
  async #initialize(): Promise<DOState> {
    // 1. Read sessionId from DO storage (set on first prompt)
    const sessionId = (await this.ctx.storage.get<string>("sessionId")) ?? "";

    // 2. Start with empty defaults — filled in from D1 if session exists
    let userId = "";
    let modelId = DEFAULT_MODEL_ID;
    let leafId: string | null = null;
    let name: string | undefined;
    let createdAt = 0;
    let updatedAt = 0;
    let messages: ModelMessage[] = [];
    const messageToEntryId = new Map<ModelMessage, string>();

    // 3–5. If we have a sessionId, load from D1
    if (sessionId !== "") {
      const db = this.env.SESSIONS_DB;
      const sessionRow = await getSession(db, sessionId);
      if (sessionRow !== null) {
        userId = sessionRow.user_id;
        modelId = sessionRow.model_id;
        leafId = sessionRow.leaf_id;
        name = sessionRow.name ?? undefined;
        createdAt = sessionRow.created_at;
        updatedAt = sessionRow.updated_at;

        // Rebuild message history from the entry tree
        const rawRows = await getEntries(db, sessionId);
        const allEntries = rawRows.map(parseEntry);
        const context = buildSessionContext(allEntries, leafId);
        messages = context.messages;
        modelId = context.modelId;

        // Register all message entries in the map (for compaction)
        for (const entry of allEntries) {
          if (entry.type === "message") {
            const msg = (entry as MessageEntry).data;
            messageToEntryId.set(msg, entry.id);
          }
        }
      }
    }

    // 6. Build the Agent (needed before ExtensionRunner so tools can be registered)
    const model = createModel(this.env, modelId);
    const agent = new Agent({ model, systemPrompt: "" /* filled in step 8 */ });
    agent.replaceMessages(messages);

    // 7. Assemble the ExtensionRunner — we need a bootstrap ISession for initialize().
    //    Build a partial DOState first, then construct SessionImpl and call initialize().
    const extensionRunner = new ExtensionRunner();
    const assembler = new SystemPromptAssembler();

    // Partial state for bootstrap — session and assembledSystemPrompt filled below.
    const state: DOState = {
      sessionId,
      userId,
      modelId,
      leafId,
      name,
      createdAt,
      updatedAt,
      messages,
      pendingEntries: [],
      branchEntries: [],
      agent,
      abortController: null,
      followUpQueue: [],
      extensionRunner,
      assembler,
      assembledSystemPrompt: "", // filled after assembly
      messageToEntryId,
      lastInputTokens: 0,
      lastContextWindowTokens: 200_000,
      messagesAtTurnStart: 0,
      session: null,
      modelOverridden: false,
    };

    // Create the SessionImpl now — it holds a live reference to state so all
    // mutations during initialize() are visible immediately.
    const session = new SessionImpl(state, this.env);
    state.session = session;

    // Initialize ExtensionRunner with the real ISession
    await extensionRunner.initialize(session, this.env.CONFIG, this.env.EXTENSIONS, modelId);

    // 8. Assemble system prompt (after extensions registered their additions)
    const basePrompt = buildBasePrompt(this.env.AGENT_NAME);
    const assembledSystemPrompt = assembler.assemble(
      basePrompt,
      extensionRunner.getSystemPromptAdditions(),
      extensionRunner.getToolDescriptors(),
    );
    state.assembledSystemPrompt = assembledSystemPrompt;
    agent.setSystemPrompt(assembledSystemPrompt);

    // Register all IAgentTool instances with the agent
    agent.setTools(
      extensionRunner.getToolsByNames(extensionRunner.getToolDescriptors().map((d) => d.name)),
    );

    // 9. Populate branchEntries from the loaded D1 entries for getEntries() support
    if (sessionId !== "") {
      const db = this.env.SESSIONS_DB;
      const rawRows = await getEntries(db, sessionId);
      const allEntries = rawRows.map(parseEntry);
      state.branchEntries = walkToRoot(allEntries, leafId);
    }

    return state;
  }

  #requireState(): DOState {
    if (this.#state === null) throw new Error("AgentSessionDO not initialized");
    return this.#state;
  }

  // ─── Session (ISession) ───────────────────────────────────────────────────

  /**
   * Return the live ISession for the current turn.
   * If no session has been created yet for this turn, create one now (lazy).
   * The session holds a live reference to state, so mutations are shared.
   * Spec ref: specs/core.md §ISession — Core-Side Implementation
   */
  #getOrCreateSession(): import("../types.ts").ISession {
    const s = this.#requireState();
    if (s.session === null) {
      s.session = new SessionImpl(s, this.env);
    }
    return s.session;
  }

  // ─── Conversation ─────────────────────────────────────────────────────────

  /**
   * Start a new agent turn.
   * Returns a ReadableStream<AgentEvent> for the caller to consume.
   * Spec ref: specs/core.md §prompt() pipeline
   */
  async prompt(text: string, attachments?: Attachment[]): Promise<ReadableStream<AgentEvent>> {
    const state = this.#requireState();
    const ctx = this.#getOrCreateSession();

    // Inject the live ISession into the agent so tools receive it via execute().
    // Spec ref: specs/core.md §ISession — Context injection into tool execute()
    state.agent.setContext(ctx);

    // ── Step 1: emitInput ─────────────────────────────────────────────────
    const inputResult = await state.extensionRunner.emitInput(
      { text, attachments: attachments ?? [], source: "user" },
      ctx,
    );
    if (inputResult.action === "handled") {
      // Extension handled the input — return an empty stream
      return new ReadableStream<AgentEvent>({
        start(controller) {
          controller.close();
        },
      });
    }
    const effectiveText = inputResult.action === "transform" ? (inputResult.text ?? text) : text;

    // ── Step 2: build UserMessage and queue entry ─────────────────────────
    const userMessage: ModelMessage =
      attachments && attachments.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: effectiveText },
              ...attachments.map((a) => ({
                type: "file" as const,
                data: a.data,
                // ai v6 FilePart uses `mediaType` (not `mimeType`)
                mediaType: a.mimeType,
              })),
            ],
          }
        : { role: "user", content: effectiveText };

    const userEntryId = generateEntryId();
    const userEntry: MessageEntry = {
      id: userEntryId,
      sessionId: state.sessionId,
      parentId: state.leafId,
      type: "message",
      timestamp: new Date().toISOString(),
      data: userMessage,
    };
    state.pendingEntries.push(userEntry);
    state.leafId = userEntryId;
    state.messageToEntryId.set(userMessage, userEntryId);

    // ── Step 3: emitBeforeAgentStart ──────────────────────────────────────
    const beforeStart = await state.extensionRunner.emitBeforeAgentStart(
      {
        text: effectiveText,
        attachments: attachments ?? [],
        systemPrompt: state.assembledSystemPrompt,
      },
      ctx,
    );
    if (beforeStart.contextMessages && beforeStart.contextMessages.length > 0) {
      // Context messages are prepended for this turn only — not persisted
      state.agent.appendMessages(beforeStart.contextMessages);
    }

    // ── Step 4: assemble system prompt ────────────────────────────────────
    const systemPrompt = beforeStart.systemPrompt ?? state.assembledSystemPrompt;
    state.agent.setSystemPrompt(systemPrompt);

    // ── Step 5: compaction threshold check ────────────────────────────────
    const usage = this.#computeContextUsage(state);
    if (usage.usedFraction > 0.8) {
      await this.#compact(state, ctx, {});
    }

    // ── Steps 6–7: set up ReadableStream and start agent ──────────────────
    const { readable, writable } = new TransformStream<AgentEvent, AgentEvent>();
    const writer = writable.getWriter();

    // Record current message count so _handleAgentEnd can find new messages.
    // agent.prompt([userMessage]) will append the user message + all response
    // messages, so messagesAtTurnStart is the count BEFORE the call.
    state.messagesAtTurnStart = state.agent.state.messages.length;

    // Set up abort controller for this turn
    const abortController = new AbortController();
    state.abortController = abortController;

    const unsub = state.agent.subscribe((event: AgentEvent) => {
      // Forward event to the caller's stream
      writer.write(event).catch(() => {});

      // Track token usage from turn_end events
      if (event.type === "turn_end") {
        state.lastInputTokens = event.usage.inputTokens ?? state.lastInputTokens;
      }

      // Fire-and-forget to extension runner
      state.extensionRunner.emit(event.type, event, ctx).catch(() => {});

      // On agent_end: persist and check retry
      if (event.type === "agent_end") {
        state.lastInputTokens = event.totalUsage.inputTokens ?? state.lastInputTokens;
        this.#flushPromise = this.#handleAgentEnd(state, ctx, abortController.signal);
        this.#flushPromise.catch((err) => {
          console.error("AgentSessionDO: _handleAgentEnd error", err);
        });
      }
    });

    // Start the agent turn. We pass only the user message — agent.prompt()
    // appends it internally. Do NOT call agent.appendMessages() separately.
    state.agent
      .prompt([userMessage])
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        writer.write({ type: "error", message: msg }).catch(() => {});
      })
      .finally(() => {
        unsub();
        state.abortController = null;
        writer.close().catch(() => {});
      });

    // ── Step 8: return ReadableStream ──────────────────────────────────────
    return readable;
  }

  async steer(text: string): Promise<void> {
    this.#requireState().agent.steer({ role: "user", content: text });
  }

  async followUp(text: string): Promise<void> {
    this.#requireState().agent.followUp({ role: "user", content: text });
  }

  async abort(): Promise<void> {
    this.#requireState().agent.abort();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  async getInfo(): Promise<SessionRecord> {
    const s = this.#requireState();
    return {
      id: s.sessionId,
      userId: s.userId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(s.name !== undefined ? { name: s.name } : {}),
    };
  }

  async getName(): Promise<string | undefined> {
    return this.#requireState().name;
  }

  async setName(name: string): Promise<void> {
    const state = this.#requireState();
    state.name = name;
    const entry: SessionInfoEntry = {
      id: generateEntryId(),
      sessionId: state.sessionId,
      parentId: state.leafId,
      type: "session_info",
      timestamp: new Date().toISOString(),
      data: { name },
    };
    state.pendingEntries.push(entry);
    state.leafId = entry.id;
    if (state.createdAt !== 0) {
      await flushPendingEntries(
        state.pendingEntries,
        state.sessionId,
        state.leafId,
        this.env.SESSIONS_DB,
      );
      state.pendingEntries = [];
    }
  }

  async getModel(): Promise<ModelInfo> {
    return resolveModel(this.#requireState().modelId);
  }

  async setModel(modelId: string): Promise<void> {
    const state = this.#requireState();
    state.modelId = modelId;
    const newModel = createModel(this.env, modelId);
    state.agent.setModel(newModel);

    const entry: ModelChangeEntry = {
      id: generateEntryId(),
      sessionId: state.sessionId,
      parentId: state.leafId,
      type: "model_change",
      timestamp: new Date().toISOString(),
      data: { modelId },
    };
    state.pendingEntries.push(entry);
    state.leafId = entry.id;
    if (state.createdAt !== 0) {
      await flushPendingEntries(
        state.pendingEntries,
        state.sessionId,
        state.leafId,
        this.env.SESSIONS_DB,
      );
      state.pendingEntries = [];
    }
  }

  async getContextUsage(): Promise<ContextUsage> {
    return this.#computeContextUsage(this.#requireState());
  }

  // ─── Session control ──────────────────────────────────────────────────────

  async branch(entryId: string): Promise<void> {
    const state = this.#requireState();
    state.leafId = entryId;
    // Rebuild messages from this new leaf
    const db = this.env.SESSIONS_DB;
    const rawRows = await getEntries(db, state.sessionId);
    const allEntries = rawRows.map(parseEntry);
    const context = buildSessionContext(allEntries, entryId);
    state.agent.replaceMessages(context.messages);
    state.messages = context.messages;
    if (context.modelId !== state.modelId) {
      state.modelId = context.modelId;
      state.agent.setModel(createModel(this.env, context.modelId));
    }
  }

  async compact(options?: CompactOptions): Promise<void> {
    const state = this.#requireState();
    const ctx = this.#getOrCreateSession();
    await this.#compact(state, ctx, options ?? {});
    // Flush compaction entry if session is committed
    if (state.createdAt !== 0 && state.leafId !== null) {
      await flushPendingEntries(
        state.pendingEntries,
        state.sessionId,
        state.leafId,
        this.env.SESSIONS_DB,
      );
      state.pendingEntries = [];
    }
  }

  async delete(): Promise<void> {
    const state = this.#requireState();
    if (state.sessionId !== "" && state.createdAt !== 0) {
      await deleteSession(state.sessionId, this.env.SESSIONS_DB);
    }
    // Reset in-memory state
    state.agent.abort();
    state.pendingEntries = [];
    state.messages = [];
    state.leafId = null;
  }

  async fork(fromEntryId?: string): Promise<string> {
    const state = this.#requireState();
    return await forkSession(
      state.sessionId,
      fromEntryId,
      state.leafId,
      state.userId,
      state.modelId,
      this.env.SESSIONS_DB,
    );
  }

  // ─── First-prompt session initialisation ──────────────────────────────────

  /**
   * Called at the start of the first prompt for a new session.
   * Stores sessionId in DO storage (so it survives eviction) and
   * sets up the full DOState for a fresh session.
   */
  async initSession(
    sessionId: string,
    userId: string,
    options?: {
      name?: string;
      modelId?: string;
    },
  ): Promise<void> {
    const state = this.#requireState();
    if (state.sessionId !== "") return; // already initialized

    const modelId = options?.modelId ?? DEFAULT_MODEL_ID;
    state.sessionId = sessionId;
    state.userId = userId;
    state.modelId = modelId;
    state.name = options?.name;

    // Persist sessionId to DO storage for cold-start recovery
    await this.ctx.storage.put("sessionId", sessionId);

    // Re-build the agent with the correct model, unless a test has already
    // injected a mock model via _setModelForTest().
    if (!state.modelOverridden) {
      const model = createModel(this.env, modelId);
      state.agent.setModel(model);
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /** Compute context usage using real last-turn tokens + heuristic delta. */
  #computeContextUsage(state: DOState): ContextUsage {
    // Estimate tokens for messages added since the last turn
    const messagesSinceLastTurn = state.agent.state.messages.slice(
      state.lastInputTokens === 0 ? 0 : undefined,
    );
    const heuristicExtra = estimateTokens(messagesSinceLastTurn);
    const inputTokens = state.lastInputTokens + heuristicExtra;
    const contextWindowTokens = state.lastContextWindowTokens;
    return {
      inputTokens,
      contextWindowTokens,
      usedFraction: contextWindowTokens > 0 ? inputTokens / contextWindowTokens : 0,
    };
  }

  /** Run context compaction. Mutates state directly. */
  async #compact(
    state: DOState,
    ctx: import("../types.ts").ISession,
    options: CompactOptions,
  ): Promise<void> {
    const compactionState: CompactionState = {
      sessionId: state.sessionId,
      leafId: state.leafId,
      agent: state.agent,
      extensionRunner: state.extensionRunner,
      messageToEntryId: state.messageToEntryId,
      pendingEntries: state.pendingEntries,
      lastInputTokens: state.lastInputTokens,
    };
    await compact(compactionState, ctx, options);
    // Sync back any mutations from compact()
    state.leafId = compactionState.leafId;
  }

  /** Persist new messages after an agent turn completes. */
  async #handleAgentEnd(
    state: DOState,
    ctx: import("../types.ts").ISession,
    signal: AbortSignal,
  ): Promise<void> {
    const currentMessages = state.agent.state.messages;
    const newMessages = currentMessages.slice(state.messagesAtTurnStart);

    // Create MessageEntry for each new message
    for (const msg of newMessages) {
      const entryId = generateEntryId();
      const entry: MessageEntry = {
        id: entryId,
        sessionId: state.sessionId,
        parentId: state.leafId,
        type: "message",
        timestamp: new Date().toISOString(),
        data: msg,
      };
      state.pendingEntries.push(entry);
      state.leafId = entryId;
      state.messageToEntryId.set(msg, entryId);
    }

    // Lazy session creation: commit D1 sessions row on first assistant response
    if (state.createdAt === 0 && state.sessionId !== "") {
      const now = Date.now();
      state.createdAt = now;
      state.updatedAt = now;
      await commitSession(
        state.sessionId,
        state.userId,
        {
          ...(state.name !== undefined ? { name: state.name } : {}),
          modelId: state.modelId,
        },
        this.env.SESSIONS_DB,
      );
    }

    // Flush all pending entries to D1
    if (state.pendingEntries.length > 0 && state.leafId !== null) {
      await flushPendingEntries(
        state.pendingEntries,
        state.sessionId,
        state.leafId,
        this.env.SESSIONS_DB,
      );
      state.pendingEntries = [];
      state.updatedAt = Date.now();
    }

    // Check if the last event was an error and retry if transient
    if (state.agent.state.error) {
      await checkRetry(state.agent.state.error, state.agent, signal, async () => {
        // Context overflow — compact and continue
        await this.#compact(state, ctx, {});
        if (state.sessionId !== "" && state.leafId !== null) {
          await flushPendingEntries(
            state.pendingEntries,
            state.sessionId,
            state.leafId,
            this.env.SESSIONS_DB,
          );
          state.pendingEntries = [];
        }
        await state.agent.continue();
      });
    }
  }
}

// ─── Token estimation helper ──────────────────────────────────────────────────

/** Estimate token count for a list of messages using the 4-chars/token heuristic. */
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
