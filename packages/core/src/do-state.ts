/**
 * DOState — in-memory state of a live AgentSessionDO instance.
 *
 * Extracted into its own file to break the circular import between
 * agent-session.ts and session-impl.ts:
 *   agent-session.ts imports SessionImpl from session-impl.ts
 *   session-impl.ts  imports DOState from do-state.ts  (no cycle)
 *
 * Spec ref: specs/core.md §AgentSessionDO §Internal state
 */

import type { Agent, AgentEvent, ModelMessage } from "@piccolo/agent";
import type { AnyEntry } from "./db/entry-types.ts";
import type { ExtensionRunner } from "./extension-runner.ts";
import type { SystemPromptAssembler } from "./system-prompt-assembler.ts";
import type { Attachment, ISession } from "./types.ts";

/**
 * In-memory state of a live session.
 * Rebuilt from D1 on cold start via #initialize().
 *
 * Spec ref: specs/core.md §AgentSessionDO §Internal state
 */
export interface DOState {
  sessionId: string;
  userId: string;
  modelId: string;
  leafId: string | null;
  name: string | undefined;
  createdAt: number; // Unix ms; 0 = not yet committed to D1
  updatedAt: number;

  /** In-memory message list; rebuilt from D1 on cold start. */
  messages: ModelMessage[];

  /** Pending entries not yet flushed to D1. */
  pendingEntries: AnyEntry[];

  /**
   * In-memory cache of all AnyEntry objects on the current branch path (root→leaf
   * order). Populated on cold start from D1. New custom/custom_message entries are
   * appended here when SessionImpl.appendCustomEntry/appendCustomMessage are called.
   * Used by ISession.getEntries() to avoid a D1 round-trip.
   *
   * Spec ref: specs/core.md §AgentSessionDO §Internal state
   */
  branchEntries: AnyEntry[];

  /** Active agent instance. */
  agent: Agent;

  /** AbortController for the current streaming turn, or null if idle. */
  abortController: AbortController | null;

  /**
   * Follow-up queue: messages accumulated via ISession.followUp() during a turn.
   * Drained at agent_end by AgentSessionDO.
   */
  followUpQueue: string[];

  /** Extension runner — real ExtensionRunner from step 6. */
  extensionRunner: ExtensionRunner;

  /** System prompt assembler. */
  assembler: SystemPromptAssembler;

  /** The assembled system prompt for the current session. */
  assembledSystemPrompt: string;

  /**
   * Maps ModelMessage object references → entry IDs.
   * Used by compaction to locate firstKeptEntryId without walking D1.
   */
  messageToEntryId: Map<ModelMessage, string>;

  /**
   * Token counts from the last completed agent turn.
   * Used by getContextUsage() and the compaction threshold check.
   */
  lastInputTokens: number;
  lastContextWindowTokens: number;

  /** Count of messages in agent.state.messages at the start of the current prompt(). */
  messagesAtTurnStart: number;

  /**
   * The live ISession for the current turn. Set at the start of prompt(), null when idle.
   * Typed as ISession — implementation is SessionImpl, but DOState never references the Impl.
   * Also passed to agent.setContext() so tools receive it via execute().
   *
   * Spec ref: specs/core.md §AgentSessionDO §Internal state
   */
  session: ISession | null;

  /**
   * Set to true by _setModelForTest() so that initSession() does not overwrite
   * the injected model with a real gateway model.
   * Not used in production — tests only.
   */
  modelOverridden: boolean;

  /**
   * Reference to AgentSessionDO.prompt() bound to the DO instance.
   * Set in #initialize() so SessionImpl.prompt() can start a full agent turn
   * without needing a DO stub (which would add an extra JSRPC hop).
   *
   * Using a function reference avoids a circular import between do-state.ts
   * and agent-session-do.ts.
   */
  promptFn: (text: string, attachments?: Attachment[]) => Promise<ReadableStream<AgentEvent>>;
}
