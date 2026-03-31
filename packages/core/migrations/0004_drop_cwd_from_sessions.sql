-- Remove deprecated sessions.cwd column.
-- Earlier schema versions included this column; runtime no longer reads/writes it.

ALTER TABLE sessions DROP COLUMN cwd;
