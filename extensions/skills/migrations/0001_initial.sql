-- Initial schema for piccolo-skills D1 database.
-- Binding: SKILLS_DB

CREATE TABLE skills (
  id            TEXT    PRIMARY KEY,
  user_id       TEXT,
  session_id    TEXT,
  file_name     TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  license       TEXT,
  compatibility TEXT,
  metadata_json TEXT,
  allowed_tools TEXT,
  content       TEXT    NOT NULL,
  sha256        TEXT    NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (
    (user_id IS NULL AND session_id IS NULL) OR
    (user_id IS NOT NULL AND session_id IS NULL) OR
    (user_id IS NULL AND session_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX skills_scope_file_unique
  ON skills(user_id, session_id, file_name);

CREATE INDEX skills_scope_active_lookup
  ON skills(user_id, session_id, active);

CREATE INDEX skills_scope_name_active_lookup
  ON skills(user_id, session_id, name, active);
