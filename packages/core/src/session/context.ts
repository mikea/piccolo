/**
 * Session context reconstruction.
 *
 * `buildSessionContext` rebuilds the `IMessage[]` list the agent receives
 * on cold start or after forking. It walks the entry tree from the active
 * `leafId` to the root, applies compaction if present, and converts the
 * resulting path to the message types the agent understands.
 *
 * `walkToRoot` is exported separately for use in fork operations (persistence.ts).
 *
 * Spec ref: specs/core.md §Context Reconstruction
 */

import type { IMessage } from "@piccolo/api";
import { type ModelMessage, modelMessageSchema } from "ai";
import type {
  AnyEntry,
  BranchSummaryEntry,
  CompactionEntry,
  MessageEntry,
} from "../db/entry-types.ts";
import { ContextIterator } from "./context-iterator.ts";

// ─── Message schema validation ────────────────────────────────────────────────

/**
 * Check a ModelMessage against the AI SDK schema, logging an error if invalid.
 * The message is never dropped — this is diagnostic only.
 */
function checkMessage(msg: ModelMessage, entryId: string): void {
  const result = modelMessageSchema.safeParse(msg);
  if (!result.success) {
    console.error(
      `[context] invalid ModelMessage in entry ${entryId}:`,
      JSON.stringify(msg),
      result.error.issues,
    );
  }
}

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
function entryToMessage(entry: AnyEntry): IMessage | undefined {
  switch (entry.type) {
    case "message": {
      return (entry as MessageEntry).data;
    }
    case "branch_summary": {
      const bs = entry as BranchSummaryEntry;
      return {
        role: "assistant",
        content: `[Previous branch summary]\n\n${bs.data.summary}`,
        id: entry.id,
      };
    }
    // compaction, model_change, thinking_level_change, label, session_info → skip
    default:
      return undefined;
  }
}

// ─── Context reconstruction ───────────────────────────────────────────────────

/**
 * Convert an ordered entry path (root-first) to the `IMessage[]` list
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
): { messages: IMessage[] } {
  const path = walkToRoot(entries, leafId);

  if (path.length === 0) {
    return { messages: [] };
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
  const messages: IMessage[] = [];

  if (lastCompaction !== undefined) {
    // 1. Emit the synthetic summary message first.
    messages.push({
      role: "user",
      content: `[Conversation Summary]\n\n${lastCompaction.data.summary}`,
      id: lastCompaction.id,
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
      if (msg !== undefined) {
        checkMessage(msg, entry.id);
        messages.push(msg);
      }
    }
  } else {
    // No compaction — emit all entries on the path.
    for (const entry of path) {
      const msg = entryToMessage(entry);
      if (msg !== undefined) {
        checkMessage(msg, entry.id);
        messages.push(msg);
      }
    }
  }

  return { messages };
}

function estimateMessageTokens(msg: IMessage): number {
  let chars = 0;
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
  return Math.ceil(chars / 4);
}

interface BuildSessionContextFromDbOptions {
  db: D1Database;
  sessionId: string;
  leafId: string | null;
  contextTokenLimit?: number;
}

/**
 * DB-backed context builder used by runtime code.
 *
 * Traverses entries newest->oldest via ContextIterator, then materialises the
 * LLM message list in root->leaf order.
 */
export async function buildSessionContextFromDb(
  options: BuildSessionContextFromDbOptions,
): Promise<{ messages: IMessage[] }> {
  const { db, sessionId, leafId, contextTokenLimit } = options;
  if (leafId === null) {
    return { messages: [] };
  }

  const newestToOldest: AnyEntry[] = [];
  let tokens = 0;
  let compaction: CompactionEntry | undefined;
  let cutoffId: string | undefined;

  const iter = new ContextIterator({ db, sessionId, leafId });
  for await (const entry of iter) {
    newestToOldest.push(entry);

    if (compaction === undefined && entry.type === "compaction") {
      compaction = entry as CompactionEntry;
      cutoffId = compaction.data.firstKeptEntryId;
      if (cutoffId === undefined) {
        break;
      }
      continue;
    }

    if (compaction !== undefined) {
      if (cutoffId !== undefined && entry.id === cutoffId) {
        break;
      }
      continue;
    }

    if (contextTokenLimit !== undefined) {
      const msg = entryToMessage(entry);
      if (msg !== undefined) {
        const delta = estimateMessageTokens(msg);
        if (tokens + delta > contextTokenLimit) {
          newestToOldest.pop();
          break;
        }
        tokens += delta;
      }
    }
  }

  const messages: IMessage[] = [];
  const oldestToNewest = [...newestToOldest].reverse();

  if (compaction !== undefined) {
    messages.push({
      role: "user",
      content: `[Conversation Summary]\n\n${compaction.data.summary}`,
      id: compaction.id,
    });
  }

  for (const entry of oldestToNewest) {
    if (entry.type === "compaction") continue;
    const msg = entryToMessage(entry);
    if (msg !== undefined) {
      checkMessage(msg, entry.id);
      messages.push(msg);
    }
  }

  return { messages };
}

// ─── Token estimation ─────────────────────────────────────────────────────────
export function estimateTokens(messages: ModelMessage[]): number {
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
