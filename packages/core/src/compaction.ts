/**
 * Context compaction for AgentSessionDO.
 *
 * `compact()` is called from two places:
 *   1. At the start of `prompt()` when `contextUsage.usedFraction > 0.8`.
 *   2. From `_handleAgentEnd()` when the LLM returns a context-overflow error.
 *
 * It delegates the summarisation LLM call to `agentCompact()` from
 * `@piccolo/agent`, then persists a `CompactionEntry` to the session tree
 * and updates the agent's message history.
 *
 * Extensions may cancel compaction or supply a pre-built summary via
 * `ExtensionRunner.emitBeforeCompact()`.
 *
 * Spec ref: specs/core.md §Context Compaction
 */

import type { Agent, ModelMessage } from "@piccolo/agent";
import { agentCompact, splitForCompaction } from "@piccolo/agent";
import type { AnyEntry, CompactionEntry } from "./db/entry-types.ts";
import { generateEntryId } from "./db/entry-types.ts";
import type { BeforeCompactEvent, IExtensionRunner } from "./extension-types.ts";
import type { ISession } from "./types.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CompactionState {
  sessionId: string;
  leafId: string | null;
  agent: Agent;
  extensionRunner: IExtensionRunner;
  /** Map from ModelMessage object reference → entry ID (used to find firstKeptEntryId). */
  messageToEntryId: Map<ModelMessage, string>;
  /** Accumulated entries not yet flushed to D1. Compaction entry is appended here. */
  pendingEntries: AnyEntry[];
  /** Last known input token count — used for CompactionEntry.tokensBefore. */
  lastInputTokens: number;
}

export interface CompactOptions {
  keepRecentTokens?: number;
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Run context compaction on the current agent message history.
 *
 * Mutates `state.agent.state.messages`, `state.leafId`, and appends to
 * `state.pendingEntries`. Does NOT flush to D1 — the caller (AgentSessionDO)
 * flushes after the turn ends.
 *
 * Spec ref: specs/core.md §Compaction algorithm
 */
export async function compact(
  state: CompactionState,
  ctx: ISession,
  options: CompactOptions = {},
): Promise<void> {
  const keepRecentTokens = options.keepRecentTokens ?? 20_000;
  const { agent } = state;

  // 1. Let extensions cancel or supply a pre-built summary
  const beforeCompactEvent: BeforeCompactEvent = {
    messages: agent.state.messages,
    keepRecentTokens,
  };
  const extResult = await state.extensionRunner.emitBeforeCompact(beforeCompactEvent, ctx);
  if (extResult.cancel) return;

  let summary: string;
  let keptMessages: ModelMessage[];

  if (extResult.summary) {
    // Extension provided a ready-made summary — skip the LLM call
    summary = extResult.summary;
    keptMessages = splitForCompaction(agent.state.messages, keepRecentTokens).toKeep;
  } else {
    // Use agentCompact() from @piccolo/agent (calls generateText internally)
    ({ summary, keptMessages } = await agentCompact(
      agent.state.messages,
      keepRecentTokens,
      agent.state.model,
    ));
  }

  // 2. If nothing was summarised, skip writing a CompactionEntry entirely.
  if (summary === "" && !extResult.summary) return;

  // 3. Find firstKeptEntryId by looking up keptMessages[0] in the message→entry map.
  //    If not found (e.g. the message came from a prior cold-start rehydration and
  //    was not assigned a local entry ID), use an empty string — the compaction still
  //    proceeds; buildSessionContext handles missing firstKeptEntryId gracefully.
  const firstKeptMessage = keptMessages[0];
  const firstKeptEntryId =
    firstKeptMessage !== undefined ? (state.messageToEntryId.get(firstKeptMessage) ?? "") : "";

  // 4. Build and queue the CompactionEntry
  const compactionEntry: CompactionEntry = {
    id: generateEntryId(),
    sessionId: state.sessionId,
    parentId: state.leafId,
    type: "compaction",
    timestamp: new Date().toISOString(),
    data: {
      summary,
      firstKeptEntryId,
      tokensBefore: state.lastInputTokens,
    },
  };
  state.pendingEntries.push(compactionEntry);
  state.leafId = compactionEntry.id;

  // 5. Rebuild the agent's message list with the summary as the first message
  const summaryMessage: ModelMessage = {
    role: "user",
    content: `[Conversation Summary]\n\n${summary}`,
  };
  agent.replaceMessages([summaryMessage, ...keptMessages]);

  // 6. Notify extensions (fire-and-forget)
  await state.extensionRunner.emit(
    "onCompact",
    { summary, keptMessageCount: keptMessages.length },
    ctx,
  );
}
