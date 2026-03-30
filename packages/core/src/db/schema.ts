/**
 * Typed D1 query helpers for piccolo-core session storage.
 *
 * All functions take a D1Database as their first argument — no global state.
 * `data` is stored and returned as raw JSON strings; callers use parseEntry()
 * from entry-types.ts to deserialise into typed entries.
 *
 * Spec ref: specs/core.md §D1 Schema, §Persistence, §Session Listing, §Fork Session
 */

import type { DbEntryRow } from "./entry-types.ts";

// ─── Row shapes ───────────────────────────────────────────────────────────────
// These mirror D1 column names (snake_case) exactly.

/** Raw D1 row for the `sessions` table. */
export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number; // Unix ms
  updated_at: number; // Unix ms
  name: string | null;
  cwd: string | null;
  model_id: string;
  leaf_id: string | null;
}

/** Extended row returned by listSessionsByUser — adds aggregated entry fields. */
export interface SessionListRow extends SessionRow {
  message_count: number;
  /** Preview of the first user message (may be null if no messages yet). */
  first_message: string | null;
}

// ─── Session queries ──────────────────────────────────────────────────────────

/**
 * Insert a new session row.
 * Throws if the session ID already exists (use upsertSession for idempotent writes).
 */
export async function insertSession(db: D1Database, row: SessionRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, updated_at, name, cwd, model_id, leaf_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.created_at,
      row.updated_at,
      row.name,
      row.cwd,
      row.model_id,
      row.leaf_id,
    )
    .run();
}

/**
 * Insert a session row, silently ignoring if one with the same ID already exists.
 * Used for lazy session creation — the first flush wins, subsequent are no-ops.
 */
export async function upsertSession(db: D1Database, row: SessionRow): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, user_id, created_at, updated_at, name, cwd, model_id, leaf_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.created_at,
      row.updated_at,
      row.name,
      row.cwd,
      row.model_id,
      row.leaf_id,
    )
    .run();
}

/**
 * Update the active leaf entry and updated_at timestamp for a session.
 * Called after each successful agent turn flush.
 */
export async function updateSessionLeaf(
  db: D1Database,
  sessionId: string,
  leafId: string,
  updatedAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET leaf_id = ?, updated_at = ? WHERE id = ?")
    .bind(leafId, updatedAt, sessionId)
    .run();
}

/**
 * Update the active model and updated_at timestamp for a session.
 */
export async function updateSessionModel(
  db: D1Database,
  sessionId: string,
  modelId: string,
  updatedAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET model_id = ?, updated_at = ? WHERE id = ?")
    .bind(modelId, updatedAt, sessionId)
    .run();
}

/**
 * Fetch a single session row by ID.
 * Returns null if the session does not exist (does not throw).
 */
export async function getSession(db: D1Database, sessionId: string): Promise<SessionRow | null> {
  const result = await db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<SessionRow>();
  return result ?? null;
}

/**
 * List all sessions belonging to a user, ordered by most recently updated.
 * Includes aggregated message_count and first_message preview.
 *
 * first_message is the content of the first user-role message entry, truncated
 * to 100 chars in the calling layer. For array-content messages the raw JSON
 * fragment is returned — callers should truncate defensively.
 */
export async function listSessionsByUser(
  db: D1Database,
  userId: string,
): Promise<SessionListRow[]> {
  const result = await db
    .prepare(
      `SELECT
         s.id, s.user_id, s.name, s.cwd, s.created_at, s.updated_at, s.model_id, s.leaf_id,
         COUNT(CASE WHEN e.type = 'message' THEN 1 END)                              AS message_count,
         MIN(CASE WHEN e.type = 'message'
                       AND json_extract(e.data, '$.role') = 'user'
                  THEN json_extract(e.data, '$.content') END)                        AS first_message
       FROM sessions s
       LEFT JOIN entries e ON e.session_id = s.id
       WHERE s.user_id = ?
       GROUP BY s.id
       ORDER BY s.updated_at DESC`,
    )
    .bind(userId)
    .all<SessionListRow>();
  return result.results;
}

/**
 * Delete a session and all its entries (CASCADE enforced by FK constraint).
 */
export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

// ─── Entry queries ────────────────────────────────────────────────────────────

/**
 * Insert a single entry row.
 * `data` must be a valid JSON string (the DB CHECK constraint will reject otherwise).
 */
export async function insertEntry(db: D1Database, row: DbEntryRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entries (id, session_id, parent_id, type, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.session_id, row.parent_id, row.type, row.timestamp, row.data)
    .run();
}

/**
 * Batch-insert multiple entry rows atomically using D1's batch() API.
 * Preferred over multiple insertEntry() calls for flush operations.
 */
export async function insertEntries(db: D1Database, rows: DbEntryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO entries (id, session_id, parent_id, type, timestamp, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  await db.batch(
    rows.map((row) =>
      stmt.bind(row.id, row.session_id, row.parent_id, row.type, row.timestamp, row.data),
    ),
  );
}

/**
 * Fetch all entry rows for a session, ordered by DB append sequence ascending.
 * Returns raw DbEntryRow[] — callers use parseEntry() to get typed AnyEntry[].
 */
export async function getEntries(db: D1Database, sessionId: string): Promise<DbEntryRow[]> {
  const result = await db
    .prepare(
      `SELECT append_seq, id, session_id, parent_id, type, timestamp, data
       FROM entries
       WHERE session_id = ?
       ORDER BY append_seq ASC`,
    )
    .bind(sessionId)
    .all<DbEntryRow>();
  return result.results;
}

/**
 * Walk a session path backwards from a starting entry ID, returning at most
 * `limit` rows in append-descending order.
 */
export async function getPathEntriesBackward(
  db: D1Database,
  sessionId: string,
  fromEntryId: string,
  limit: number,
): Promise<DbEntryRow[]> {
  const result = await db
    .prepare(
      `WITH RECURSIVE path AS (
         SELECT append_seq, id, session_id, parent_id, type, timestamp, data
         FROM entries
         WHERE session_id = ? AND id = ?
         UNION ALL
         SELECT e.append_seq, e.id, e.session_id, e.parent_id, e.type, e.timestamp, e.data
         FROM entries e
         JOIN path p ON e.session_id = p.session_id AND e.id = p.parent_id
       )
       SELECT append_seq, id, session_id, parent_id, type, timestamp, data
       FROM path
       ORDER BY append_seq DESC
       LIMIT ?`,
    )
    .bind(sessionId, fromEntryId, limit)
    .all<DbEntryRow>();
  return result.results;
}
