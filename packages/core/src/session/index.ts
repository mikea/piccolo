/**
 * Session module public API.
 *
 * Re-exports all public symbols from context.ts and persistence.ts so that
 * consumers can import from `@piccolo/core/session` (or the package root) without
 * needing to know the internal file layout.
 */

export {
  buildSessionContext,
  buildSessionContextFromDb,
  DEFAULT_MODEL_ID,
  walkToRoot,
} from "./context.ts";
export { ContextIterator } from "./context-iterator.ts";
export {
  appendEntry,
  type CommitSessionOptions,
  commitSession,
  createSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
  listSessions,
} from "./persistence.ts";
