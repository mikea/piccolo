/**
 * Session context reconstruction.
 *
 * `buildSessionContext` rebuilds the `ModelMessage[]` list the agent receives
 * on cold start or after forking. It walks the entry tree from the active
 * `leafId` to the root, applies compaction if present, and converts the
 * resulting path to the message types the agent understands.
 *
 * `walkToRoot` is exported separately for use in fork operations (persistence.ts).
 *
 * Spec ref: specs/core.md §Context Reconstruction
 */

import type { ModelMessage } from "ai";
import type {
  AnyEntry,
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  MessageEntry,
  ModelChangeEntry,
} from "../db/entry-types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4-5";

// ─── Walk ─────────────────────────────────────────────────────────────────────

/**
 * Walk the entry tree from `leafId` to the root following `parentId` links.
 * Returns entries in **root-first** order (i.e. the walk is reversed before
 * returning).
 *
 * If `leafId` is null (empty session) an empty array is returned.
 * If an entry references a `parentId` that does not exist in the map the walk
 * stops at that point — no infinite loop is possible.
 */
export function walkToRoot(entries: AnyEntry[], leafId: string | null): AnyEntry[] {
  if (leafId === null) return [];

  const byId = new Map<string, AnyEntry>();
  for (const e of entries) {
    byId.set(e.id, e);
  }

  const path: AnyEntry[] = [];
  let current: AnyEntry | undefined = byId.get(leafId);
  while (current !== undefined) {
    path.push(current);
    current = current.parentId !== null ? byId.get(current.parentId) : undefined;
  }

  // path is leaf-first; reverse to root-first
  path.reverse();
  return path;
}

// ─── Entry → ModelMessage conversion ─────────────────────────────────────────

/**
 * Convert a single non-compaction entry to zero or one ModelMessage.
 * Returns `undefined` for entry types that are not sent to the LLM.
 */
function entryToMessage(entry: AnyEntry): ModelMessage | undefined {
  switch (entry.type) {
    case "message":
      return (entry as MessageEntry).data;
    case "custom_message": {
      const cm = entry as CustomMessageEntry;
      if (cm.data.display) {
        return { role: "user", content: cm.data.content as string };
      }
      return undefined;
    }
    case "branch_summary": {
      const bs = entry as BranchSummaryEntry;
      return {
        role: "assistant",
        content: `[Previous branch summary]\n\n${bs.data.summary}`,
      };
    }
    // compaction, model_change, thinking_level_change, custom, label, session_info → skip
    default:
      return undefined;
  }
}

// ─── Context reconstruction ───────────────────────────────────────────────────

/**
 * Convert an ordered entry path (root-first) to the `ModelMessage[]` list
 * the agent receives, and extract the active `modelId`.
 *
 * Compaction layout in the entry tree:
 *   Entries are linked as: firstKeptEntry → compactionEntry → nextEntry
 *   Root-first path: [ ..., firstKeptEntry, compactionEntry, nextEntry, ... ]
 *
 * Expected output when compaction is present:
 *   [ synthetic_summary_msg, firstKeptEntry_msg, ..., nextEntry_msg, ... ]
 *
 * Algorithm:
 *   1. Find the most recent `compaction` entry on the path.
 *   2. Prepend the synthetic summary message.
 *   3. Include entries from `firstKeptEntryId` onward, skipping the compaction
 *      entry itself (it was already represented by the synthetic summary).
 *   4. If no compaction: include all entries.
 *
 * Spec ref: specs/core.md §Context Reconstruction
 */
export function buildSessionContext(
  entries: AnyEntry[],
  leafId: string | null,
): { messages: ModelMessage[]; modelId: string } {
  const path = walkToRoot(entries, leafId);

  if (path.length === 0) {
    return { messages: [], modelId: DEFAULT_MODEL_ID };
  }

  // ── Find most recent compaction on the path ────────────────────────────────
  let lastCompaction: CompactionEntry | undefined;
  for (let i = path.length - 1; i >= 0; i--) {
    const e = path[i];
    if (e !== undefined && e.type === "compaction") {
      lastCompaction = e as CompactionEntry;
      break;
    }
  }

  // ── Build message list ─────────────────────────────────────────────────────
  const messages: ModelMessage[] = [];

  if (lastCompaction !== undefined) {
    // 1. Emit the synthetic summary message first.
    messages.push({
      role: "user",
      content: `[Conversation Summary]\n\n${lastCompaction.data.summary}`,
    });

    // 2. Find where firstKeptEntryId sits on the path.
    const firstKeptId = lastCompaction.data.firstKeptEntryId;
    const firstKeptIndex = path.findIndex((e) => e.id === firstKeptId);

    // 3. Determine slice start: from firstKeptEntryId if found, else from the
    //    entry after the compaction node (nothing to keep before it).
    let startIndex: number;
    if (firstKeptIndex !== -1) {
      startIndex = firstKeptIndex;
    } else {
      // firstKeptEntryId not found on the path — start right after compaction
      const compIndex = path.findIndex((e) => e.id === lastCompaction?.id);
      startIndex = compIndex === -1 ? path.length : compIndex + 1;
    }

    // 4. Emit entries from startIndex onward, skipping the compaction entry
    //    itself (it was already emitted as the summary message above).
    for (let i = startIndex; i < path.length; i++) {
      const entry = path[i];
      if (entry === undefined || entry.type === "compaction") continue;
      const msg = entryToMessage(entry);
      if (msg !== undefined) messages.push(msg);
    }
  } else {
    // No compaction — emit all entries on the path.
    for (const entry of path) {
      const msg = entryToMessage(entry);
      if (msg !== undefined) messages.push(msg);
    }
  }

  // ── Extract most recent modelId from the full path ────────────────────────
  let modelId = DEFAULT_MODEL_ID;
  for (let i = path.length - 1; i >= 0; i--) {
    const e = path[i];
    if (e !== undefined && e.type === "model_change") {
      modelId = (e as ModelChangeEntry).data.modelId;
      break;
    }
  }

  return { messages, modelId };
}
