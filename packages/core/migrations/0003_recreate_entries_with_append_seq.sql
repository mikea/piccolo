-- Switch entry ordering to a DB-managed append sequence.
-- Existing rows are intentionally not preserved.

DROP TABLE IF EXISTS entries;

CREATE TABLE entries (
  append_seq  INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT    NOT NULL,              -- UUID v4; also used as IMessage.id for message entries
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id   TEXT,                          -- null for root entry
  type        TEXT    NOT NULL,              -- discriminant (see entry-types.ts)
  timestamp   TEXT    NOT NULL,              -- ISO 8601 (display/debug only)
  data        TEXT    NOT NULL CHECK (json_valid(data)),
  UNIQUE (session_id, id)
);

CREATE INDEX entries_session ON entries(session_id, append_seq);
CREATE INDEX entries_parent  ON entries(session_id, parent_id);
