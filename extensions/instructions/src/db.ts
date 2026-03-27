/**
 * Typed D1 query helpers for the instructions extension.
 *
 * All functions operate on the `instructions` table defined in
 * migrations/0001_initial.sql. No business logic lives here — only
 * parameterised SQL and row-shape typing.
 *
 * Spec ref: specs/instructions_extension.md §D1 Schema
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The three scopes an instruction can be assigned to. */
export type ScopeType = "everyone" | "user" | "session";

/** Shape of a row returned from the instructions table. */
export interface InstructionRow {
  id: string;
  scope_type: ScopeType;
  scope_id: string;
  content: string;
  created_at: number;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Return all instructions visible in a given session — one query covering all
 * three scopes:
 *   - scope_type='everyone' (scope_id='')
 *   - scope_type='user'     (scope_id=userId)
 *   - scope_type='session'  (scope_id=sessionId)
 *
 * Results are ordered by created_at ASC so the LLM sees them in insertion order.
 *
 * Spec ref: specs/instructions_extension.md §Visible Instructions Query
 */
export async function listVisible(
  db: D1Database,
  userId: string,
  sessionId: string,
): Promise<InstructionRow[]> {
  const result = await db
    .prepare(
      `SELECT id, scope_type, scope_id, content, created_at
       FROM instructions
       WHERE (scope_type = 'everyone' AND scope_id = '')
          OR (scope_type = 'user'     AND scope_id = ?)
          OR (scope_type = 'session'  AND scope_id = ?)
       ORDER BY created_at ASC`,
    )
    .bind(userId, sessionId)
    .all<InstructionRow>();
  return result.results;
}

/**
 * Insert a new instruction row. Generates a UUID v4 internally.
 * Returns the new row's `id`.
 *
 * Spec ref: specs/instructions_extension.md §Tool §add
 */
export async function addInstruction(
  db: D1Database,
  scopeType: ScopeType,
  scopeId: string,
  content: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO instructions (id, scope_type, scope_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, scopeType, scopeId, content, now)
    .run();
  return id;
}

/**
 * Delete an instruction by its UUID.
 * Returns `true` if a row was deleted, `false` if the ID was not found.
 *
 * Spec ref: specs/instructions_extension.md §Tool §remove
 */
export async function removeInstruction(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM instructions WHERE id = ?`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
