-- Message persistence format changed to store AI SDK ModelMessage JSON directly.
-- Existing sessions may contain incompatible message payloads.
-- Reset persisted conversation state so all sessions rehydrate with the new format.

DELETE FROM entries;
DELETE FROM sessions;
