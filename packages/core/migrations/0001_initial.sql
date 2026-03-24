-- Initial schema for piccolo-sessions D1 database.
-- Binding: SESSIONS_DB

CREATE TABLE sessions (
  id          TEXT    PRIMARY KEY,           -- UUID v4
  user_id     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,              -- Unix ms
  updated_at  INTEGER NOT NULL,              -- Unix ms
  name        TEXT,
  cwd         TEXT,
  model_id    TEXT    NOT NULL,              -- no default — callers supply explicitly
  leaf_id     TEXT                           -- current active entry ID (null until first message)
);

CREATE TABLE entries (
  id          TEXT    NOT NULL,              -- 8-char hex
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id   TEXT,                          -- null for root entry
  type        TEXT    NOT NULL,              -- discriminant (see entry-types.ts)
  timestamp   TEXT    NOT NULL,              -- ISO 8601
  data        TEXT    NOT NULL CHECK (json_valid(data)),  -- JSON payload; DB enforces validity
  PRIMARY KEY (session_id, id)
);

CREATE INDEX entries_session ON entries(session_id);
CREATE INDEX entries_parent  ON entries(session_id, parent_id);
CREATE INDEX sessions_user   ON sessions(user_id, updated_at DESC);
