/**
 * SessionImpl — the core-side implementation of ISession.
 *
 * This is the RpcTarget passed to every extension handler call and to every
 * tool execute() call. Gateways receive this same type via IPiccoloCore
 * (step 9 wires that path).
 *
 * Design constraints:
 *   - No code outside this file references SessionImpl by class name.
 *     All signatures use ISession — the interface.
 *   - Holds a live reference to DOState. Mutations (model changes, custom
 *     entries, etc.) write directly into doState.pendingEntries /
 *     doState.branchEntries. No D1 flush here — flushing occurs at agent_end.
 *   - One instance per prompt() call, stored in doState.session (typed ISession).
 *
 * Spec refs:
 *   specs/api.md §2  ISession
 *   specs/core.md §ISession — Core-Side Implementation
 */

import { RpcTarget } from "cloudflare:workers";
import type { AgentEvent, ModelMessage } from "@piccolo/agent";
import type { CompactionState } from "./compaction.ts";
import { compact } from "./compaction.ts";
import type { AnyEntry, CustomEntry, CustomMessageEntry } from "./db/entry-types.ts";
import { generateEntryId } from "./db/entry-types.ts";
import type { DOState } from "./do-state.ts";
import { createModel } from "./gateway.ts";
import { forkSession } from "./session/persistence.ts";
import type {
  Attachment,
  CompactOptions,
  ContextUsage,
  CustomEntry as CustomEntryType,
  IAgentTool,
  IGatewayCallback,
  ISession,
  ITurn,
  ModelInfo,
  SessionRecord,
  ToolDescriptor,
} from "./types.ts";
import { MODEL_CATALOG, resolveModel } from "./types-internal.ts";

/**
 * Core-side implementation of ISession.
 *
 * Created once per prompt() call by AgentSessionDO and stored in
 * doState.session (typed as ISession). Also passed to agent.setContext()
 * so the agent can inject it into every tool execute() call.
 *
 * Only session-impl.ts knows this class name. All callers use ISession.
 *
 * Spec ref: specs/core.md §ISession — Core-Side Implementation
 */
export class SessionImpl extends RpcTarget implements ISession {
  readonly userId: string;

  constructor(
    private readonly doState: DOState,
    private readonly env: Env,
  ) {
    super();
    this.userId = doState.userId;
  }

  // ─── Identity ───────────────────────────────────────────────────────────────

  async id(): Promise<string> {
    return this.doState.sessionId;
  }

  async info(): Promise<SessionRecord> {
    const s = this.doState;
    return {
      id: s.sessionId,
      userId: s.userId,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(s.name !== undefined ? { name: s.name } : {}),
    };
  }

  // ─── Metadata ───────────────────────────────────────────────────────────────

  async getName(): Promise<string | undefined> {
    return this.doState.name;
  }

  async setName(name: string): Promise<void> {
    const s = this.doState;
    s.name = name;
    this.#appendEntry({
      id: generateEntryId(),
      sessionId: s.sessionId,
      parentId: s.leafId,
      type: "session_info",
      timestamp: new Date().toISOString(),
      data: { name },
    });
  }

  // ─── Conversation ────────────────────────────────────────────────────────────

  async prompt(
    text: string,
    attachments?: Attachment[],
    callback?: IGatewayCallback,
  ): Promise<ReadableStream<AgentEvent>> {
    // Delegates to AgentSessionDO.prompt() via the promptFn bound during
    // #initialize(). This avoids an extra JSRPC hop and works both when called
    // from gateway context (via JSRPC) and from tool/extension context.
    return this.doState.promptFn(text, attachments, callback);
  }

  async sendUserMessage(content: string): Promise<void> {
    this.doState.agent.steer({ role: "user", content });
  }

  async steer(text: string): Promise<void> {
    this.doState.agent.steer({ role: "user", content: text });
  }

  async followUp(text: string): Promise<void> {
    this.doState.followUpQueue.push(text);
  }

  async abort(): Promise<void> {
    this.doState.abortController?.abort();
  }

  async getCurrentTurn(): Promise<ITurn | undefined> {
    // Only return a turn context if a turn is actively in progress.
    if (this.doState.callback === undefined && this.doState.abortController === null) {
      return undefined;
    }
    return new TurnImpl(this.doState);
  }

  // ─── Model management ────────────────────────────────────────────────────────

  async getModel(): Promise<ModelInfo> {
    return resolveModel(this.doState.modelId);
  }

  async setModel(modelId: string): Promise<void> {
    const s = this.doState;
    s.modelId = modelId;
    s.agent.setModel(createModel(this.env, modelId));
    this.#appendEntry({
      id: generateEntryId(),
      sessionId: s.sessionId,
      parentId: s.leafId,
      type: "model_change",
      timestamp: new Date().toISOString(),
      data: { modelId },
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return MODEL_CATALOG;
  }

  // ─── Tools ───────────────────────────────────────────────────────────────────

  async getActiveTools(): Promise<ToolDescriptor[]> {
    return this.doState.agent.state.tools.map((t) => t.descriptor as ToolDescriptor);
  }

  async setActiveTools(tools: IAgentTool[]): Promise<void> {
    this.doState.agent.setTools(tools);
  }

  // ─── Custom session entries ───────────────────────────────────────────────────

  async appendCustomMessage(customType: string, content: string, display: boolean): Promise<void> {
    const s = this.doState;
    const entry: CustomMessageEntry = {
      id: generateEntryId(),
      sessionId: s.sessionId,
      parentId: s.leafId,
      type: "custom_message",
      timestamp: new Date().toISOString(),
      data: { customType, content, display },
    };
    this.#appendEntry(entry);
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<void> {
    const s = this.doState;
    const entry: CustomEntry = {
      id: generateEntryId(),
      sessionId: s.sessionId,
      parentId: s.leafId,
      type: "custom",
      timestamp: new Date().toISOString(),
      data: { customType, payload: data },
    };
    this.#appendEntry(entry);
  }

  async getEntries(customType?: string): Promise<CustomEntryType[]> {
    return this.doState.branchEntries
      .filter((e): e is CustomEntry => {
        if (e.type !== "custom") return false;
        if (customType === undefined) return true;
        return (e.data as { customType: string }).customType === customType;
      })
      .map((e) => {
        const d = e.data as { customType: string; payload?: unknown };
        return {
          id: e.id,
          customType: d.customType,
          data: d.payload,
          timestamp: e.timestamp,
        };
      });
  }

  // ─── Context usage ────────────────────────────────────────────────────────────

  async getContextUsage(): Promise<ContextUsage> {
    const s = this.doState;
    const heuristicExtra = estimateTokens(s.agent.state.messages);
    const inputTokens = s.lastInputTokens + heuristicExtra;
    const contextWindowTokens = s.lastContextWindowTokens;
    return {
      inputTokens,
      contextWindowTokens,
      usedFraction: contextWindowTokens > 0 ? inputTokens / contextWindowTokens : 0,
    };
  }

  async compact(options?: CompactOptions): Promise<void> {
    const s = this.doState;
    const compactionState: CompactionState = {
      sessionId: s.sessionId,
      leafId: s.leafId,
      agent: s.agent,
      extensionRunner: s.extensionRunner,
      messageToEntryId: s.messageToEntryId,
      pendingEntries: s.pendingEntries,
      lastInputTokens: s.lastInputTokens,
    };
    await compact(compactionState, this, options ?? {});
    // Sync back leafId mutation from compact()
    s.leafId = compactionState.leafId;
  }

  // ─── System prompt ────────────────────────────────────────────────────────────

  async getSystemPrompt(): Promise<string> {
    return this.doState.assembledSystemPrompt;
  }

  // ─── Session tree / branching ─────────────────────────────────────────────────

  async branch(_entryId: string): Promise<void> {
    // Branching from within a tool/extension context is not supported.
    // Gateways call this directly on the DO (step 9 wires that path).
    throw new Error("SessionImpl.branch() is not available from tool/extension context.");
  }

  async fork(fromEntryId?: string): Promise<ISession> {
    const s = this.doState;
    const newSessionId = await forkSession(
      s.sessionId,
      fromEntryId,
      s.leafId,
      s.userId,
      s.modelId,
      this.env.SESSIONS_DB,
    );
    // initSession() persists the sessionId to DO storage so the new DO can
    // cold-start correctly. forkSession() only writes D1 — DO storage needs
    // to be set separately.
    const newStub = this.env.AGENT_SESSION.get(this.env.AGENT_SESSION.idFromName(newSessionId));
    await newStub.initSession(newSessionId, s.userId, { modelId: s.modelId });
    return newStub.getSession(s.userId);
  }

  async delete(): Promise<void> {
    throw new Error("SessionImpl.delete() is not available from tool/extension context.");
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────

  /**
   * Append an entry to both pendingEntries (for D1 flush at agent_end) and
   * branchEntries (for in-memory getEntries() queries). Updates leafId.
   */
  #appendEntry(entry: AnyEntry): void {
    const s = this.doState;
    s.pendingEntries.push(entry);
    s.branchEntries.push(entry);
    s.leafId = entry.id;
  }
}

// ─── TurnImpl ─────────────────────────────────────────────────────────────────

/**
 * Core-side implementation of ITurn.
 *
 * Created by SessionImpl.getCurrentTurn() while a turn is in progress.
 * Provides access to the gateway callback for the active turn.
 * The callback is a property of the turn (not the session) — it is bound
 * to a specific prompt() call and is ephemeral.
 *
 * Spec ref: specs/api.md §2 ITurn
 */
export class TurnImpl extends RpcTarget implements ITurn {
  constructor(private readonly doState: DOState) {
    super();
  }

  async getCallback(): Promise<IGatewayCallback | undefined> {
    return this.doState.callback;
  }
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Estimate token count for messages added since last turn (4 chars/token heuristic). */
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
