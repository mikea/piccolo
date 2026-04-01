export interface SkillRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  file_name: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata_json: string | null;
  allowed_tools: string | null;
  content: string;
  sha256: string;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface UpsertSkillInput {
  userId: string | null;
  sessionId: string | null;
  fileName: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadataJson: string | null;
  allowedTools: string | null;
  content: string;
  sha256: string;
}

export type ScopeLabel = "global" | "user" | "session";

export function scopeLabelForRow(row: SkillRow): ScopeLabel {
  if (row.session_id) return "session";
  if (row.user_id) return "user";
  return "global";
}

export async function getByScopeAndFileName(
  db: D1Database,
  userId: string | null,
  sessionId: string | null,
  fileName: string,
): Promise<SkillRow | null> {
  const result = await db
    .prepare(
      `SELECT id, user_id, session_id, file_name, name, description, license, compatibility,
              metadata_json, allowed_tools, content, sha256, active, created_at, updated_at
       FROM skills
       WHERE ((user_id IS NULL AND ? IS NULL) OR user_id = ?)
         AND ((session_id IS NULL AND ? IS NULL) OR session_id = ?)
         AND file_name = ?
       LIMIT 1`,
    )
    .bind(userId, userId, sessionId, sessionId, fileName)
    .first<SkillRow>();
  return result ?? null;
}

export async function upsertSkillByScopeAndFileName(
  db: D1Database,
  input: UpsertSkillInput,
): Promise<{ id: string; inserted: boolean }> {
  const existing = await getByScopeAndFileName(db, input.userId, input.sessionId, input.fileName);
  const now = Date.now();

  if (existing) {
    await db
      .prepare(
        `UPDATE skills
         SET name = ?, description = ?, license = ?, compatibility = ?, metadata_json = ?,
             allowed_tools = ?, content = ?, sha256 = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.name,
        input.description,
        input.license,
        input.compatibility,
        input.metadataJson,
        input.allowedTools,
        input.content,
        input.sha256,
        now,
        existing.id,
      )
      .run();
    return { id: existing.id, inserted: false };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO skills (
         id, user_id, session_id, file_name, name, description, license, compatibility,
         metadata_json, allowed_tools, content, sha256, active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.sessionId,
      input.fileName,
      input.name,
      input.description,
      input.license,
      input.compatibility,
      input.metadataJson,
      input.allowedTools,
      input.content,
      input.sha256,
      now,
      now,
    )
    .run();
  return { id, inserted: true };
}

export async function listVisibleSkills(
  db: D1Database,
  userId: string,
  sessionId: string,
  query?: string,
): Promise<SkillRow[]> {
  const like = query && query.trim().length > 0 ? `%${query.trim()}%` : null;

  if (like) {
    const result = await db
      .prepare(
        `SELECT id, user_id, session_id, file_name, name, description, license, compatibility,
                metadata_json, allowed_tools, content, sha256, active, created_at, updated_at
         FROM skills
         WHERE active = 1
           AND (
             (user_id IS NULL AND session_id IS NULL)
             OR (user_id = ? AND session_id IS NULL)
             OR (user_id IS NULL AND session_id = ?)
           )
           AND (name LIKE ? OR description LIKE ?)
         ORDER BY name ASC, file_name ASC`,
      )
      .bind(userId, sessionId, like, like)
      .all<SkillRow>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT id, user_id, session_id, file_name, name, description, license, compatibility,
              metadata_json, allowed_tools, content, sha256, active, created_at, updated_at
       FROM skills
       WHERE active = 1
         AND (
           (user_id IS NULL AND session_id IS NULL)
           OR (user_id = ? AND session_id IS NULL)
           OR (user_id IS NULL AND session_id = ?)
         )
       ORDER BY name ASC, file_name ASC`,
    )
    .bind(userId, sessionId)
    .all<SkillRow>();
  return result.results;
}

export async function findVisibleSkillByName(
  db: D1Database,
  userId: string,
  sessionId: string,
  name: string,
): Promise<SkillRow | null> {
  const row = await db
    .prepare(
      `SELECT id, user_id, session_id, file_name, name, description, license, compatibility,
              metadata_json, allowed_tools, content, sha256, active, created_at, updated_at
       FROM skills
       WHERE active = 1
         AND name = ?
         AND (
           (user_id IS NULL AND session_id IS NULL)
           OR (user_id = ? AND session_id IS NULL)
           OR (user_id IS NULL AND session_id = ?)
         )
       ORDER BY
         CASE
           WHEN user_id IS NULL AND session_id = ? THEN 3
           WHEN user_id = ? AND session_id IS NULL THEN 2
           ELSE 1
         END DESC,
         updated_at DESC
       LIMIT 1`,
    )
    .bind(name, userId, sessionId, sessionId, userId)
    .first<SkillRow>();
  return row ?? null;
}
