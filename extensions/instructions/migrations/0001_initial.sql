-- Initial schema for piccolo-instructions D1 database.
-- Binding: INSTRUCTIONS_DB

CREATE TABLE instructions (
  id         TEXT    PRIMARY KEY,   -- UUID v4
  scope_type TEXT    NOT NULL CHECK (scope_type IN ('everyone', 'user', 'session')),
  scope_id   TEXT    NOT NULL,      -- '' for everyone, userId for user, sessionId for session
  content    TEXT    NOT NULL,      -- the instruction text
  created_at INTEGER NOT NULL       -- Unix ms
);

-- Composite index used by the single visible-instructions query:
-- WHERE (scope_type='everyone' AND scope_id='')
--    OR (scope_type='user'    AND scope_id=?)
--    OR (scope_type='session' AND scope_id=?)
CREATE INDEX instructions_lookup ON instructions(scope_type, scope_id);
