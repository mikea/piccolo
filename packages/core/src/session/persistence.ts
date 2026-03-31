/**
 * Session persistence layer.
 *
 * Stateless functions that read and write session data to D1. No Durable
 * Object or Worker-specific globals — all functions take a `D1Database`
 * argument. This is the layer `AgentSessionDO` (step 5) delegates to.
 *
 * Functions:
 *   appendEntry          — insert one entry and update sessions.leaf_id
 *   flushPendingEntries  — batch-insert pending entries and update sessions row
 *   createSession        — return a new sessionId without touching D1 (lazy)
 *   commitSession        — write the D1 sessions row on first assistant response
 *   listSessions         — list sessions for a user as SessionInfo[]
 *   forkSession          — copy a path into a new session record
 *   deleteSession        — DELETE CASCADE a session and all its entries
 *
 * Spec ref: specs/core.md §Persistence, §Fork Session, §Session Listing
 */

import type { AnyEntry } from "../db/entry-types.ts";
import { generateEntryId, parseEntry } from "../db/entry-types.ts";
import {
  deleteSession as dbDeleteSession,
  getEntries,
  insertEntries,
  insertEntry,
  listSessionsByUser,
  updateSessionLeaf,
  upsertSession,
} from "../db/schema.ts";

/** Internal session summary used only by persistence.ts for D1 list queries. */
interface SessionInfo {
  id: string;
  userId: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  firstMessage: string;
}

import { walkToRoot } from "./context.ts";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Truncate a string to at most `max` characters. */
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Serialise an `AnyEntry` to the column shape expected by the D1 helpers.
 * `data` is JSON-stringified here; the DB CHECK constraint validates it.
 */
function entryToRow(entry: AnyEntry) {
  return {
    id: entry.id,
    session_id: entry.sessionId,
    parent_id: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
    data: JSON.stringify(entry.data),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Insert a single entry into D1 and update `sessions.leaf_id` + `updated_at`.
 *
 * The `sessions` row must already exist (created by `commitSession`) before
 * this is called — the UPDATE is a no-op if the row is missing.
 *
 * Spec ref: specs/core.md §Per-message append
 */
export async function appendEntry(entry: AnyEntry, db: D1Database): Promise<void> {
  await insertEntry(db, entryToRow(entry));
  await updateSessionLeaf(db, entry.sessionId, entry.id, Date.now());
}

/**
 * Batch-insert all pending entries to D1 and update the sessions row once.
 *
 * `leafId` is the id of the last entry in `entries` — this becomes the new
 * `sessions.leaf_id`. Callers must supply the correct value (typically the id
 * of the last element of `entries`).
 *
 * If `entries` is empty this is a no-op.
 *
 * Spec ref: specs/core.md §Per-message append (step 2 — Flush pendingEntries)
 */
export async function flushPendingEntries(
  entries: AnyEntry[],
  sessionId: string,
  leafId: string,
  db: D1Database,
): Promise<void> {
  if (entries.length === 0) return;
  await insertEntries(db, entries.map(entryToRow));
  await updateSessionLeaf(db, sessionId, leafId, Date.now());
}

/**
 * Return a new session ID without writing anything to D1.
 *
 * Sessions are created lazily — the D1 row is only written by `commitSession`
 * on the first assistant response. Before that, the session exists only in
 * the Durable Object's in-memory state.
 *
 * Spec ref: specs/core.md §Lazy session creation
 */
export function createSession(): string {
  return crypto.randomUUID();
}

/**
 * Options passed when creating a session, forwarded from `NewSessionOptions`.
 */
export interface CommitSessionOptions {
  name?: string;
  modelId: string;
}

/**
 * Write the D1 `sessions` row for a session on its first assistant response.
 *
 * Uses INSERT OR IGNORE so this is idempotent — calling it multiple times
 * with the same `sessionId` is safe; the original row is preserved.
 *
 * Spec ref: specs/core.md §Lazy session creation
 */
export async function commitSession(
  sessionId: string,
  userId: string,
  options: CommitSessionOptions,
  db: D1Database,
): Promise<void> {
  const now = Date.now();
  await upsertSession(db, {
    id: sessionId,
    user_id: userId,
    created_at: now,
    updated_at: now,
    name: options.name ?? sessionId,
    model_id: options.modelId,
    leaf_id: null,
  });
}

/**
 * List all sessions belonging to a user, ordered by most recently updated.
 * Maps `SessionListRow[]` to `SessionInfo[]`.
 *
 * `firstMessage` is truncated to 100 characters.
 *
 * Spec ref: specs/core.md §Session Listing
 */
export async function listSessions(userId: string, db: D1Database): Promise<SessionInfo[]> {
  const rows = await listSessionsByUser(db, userId);
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name ?? r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    firstMessage: truncate(r.first_message ?? "", 100),
  }));
}

/**
 * Fork a session by copying the entry path from `fromEntryId` (or
 * `currentLeafId` when `fromEntryId` is undefined) to the root into a new
 * session record with fresh entry IDs.
 *
 * Returns the new session's UUID.
 *
 * Algorithm:
 *   1. Load + parse all entries for the source session
 *   2. Walk path from fork point to root
 *   3. Remap entry IDs (old → new) preserving parentId links
 *   4. Insert new sessions row + all remapped entries
 *
 * Spec ref: specs/core.md §Fork Session
 */
export async function forkSession(
  sessionId: string,
  fromEntryId: string | undefined,
  currentLeafId: string | null,
  userId: string,
  modelId: string,
  db: D1Database,
): Promise<string> {
  // 1. Load all entries for the source session
  const rawRows = await getEntries(db, sessionId);
  const allEntries = rawRows.map(parseEntry);

  // 2. Walk path from fork point to root (root-first order)
  const forkLeafId = fromEntryId ?? currentLeafId;
  const path = walkToRoot(allEntries, forkLeafId);

  // 3. Create new session ID and row
  const newSessionId = crypto.randomUUID();
  const now = Date.now();
  await upsertSession(db, {
    id: newSessionId,
    user_id: userId,
    created_at: now,
    updated_at: now,
    name: newSessionId,
    model_id: modelId,
    leaf_id: null,
  });

  if (path.length === 0) {
    return newSessionId;
  }

  // 4. Remap IDs: build old → new map in root-first order so parentId
  //    references are always resolved before the child entry is processed.
  const idMap = new Map<string, string>();
  const newEntries: AnyEntry[] = path.map((entry) => {
    const newId = generateEntryId();
    idMap.set(entry.id, newId);
    const newParentId = entry.parentId !== null ? (idMap.get(entry.parentId) ?? null) : null;
    let newData: unknown = entry.data;
    if (entry.type === "message") {
      newData = {
        ...entry.data,
        id: newId,
      };
    } else if (entry.type === "compaction") {
      const firstKept = entry.data.firstKeptEntryId;
      newData = {
        ...entry.data,
        firstKeptEntryId: firstKept ? (idMap.get(firstKept) ?? firstKept) : firstKept,
      };
    } else if (entry.type === "branch_summary") {
      newData = {
        ...entry.data,
        fromId: idMap.get(entry.data.fromId) ?? entry.data.fromId,
      };
    } else if (entry.type === "label") {
      newData = {
        ...entry.data,
        targetId: idMap.get(entry.data.targetId) ?? entry.data.targetId,
      };
    }
    return {
      ...entry,
      id: newId,
      sessionId: newSessionId,
      parentId: newParentId,
      data: newData,
    } as AnyEntry;
  });

  // 5. Update sessions.leaf_id to the new last entry's id
  const lastEntry = newEntries.at(-1);
  if (lastEntry !== undefined) {
    await insertEntries(db, newEntries.map(entryToRow));
    await updateSessionLeaf(db, newSessionId, lastEntry.id, now);
  }

  return newSessionId;
}

/**
 * Delete a session and all its entries (via the ON DELETE CASCADE FK).
 *
 * Spec ref: specs/core.md §D1 Schema (entries FK → sessions)
 */
export async function deleteSession(sessionId: string, db: D1Database): Promise<void> {
  await dbDeleteSession(db, sessionId);
}
