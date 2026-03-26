/**
 * types.ts — UI-specific type aliases for the web SPA.
 *
 * The canonical conversation types (HistoryEntry, SessionStatus, etc.) come
 * from @piccolo/core and are used directly. This file contains only types that
 * are specific to the SPA's own component props and state — NOT duplicates of
 * server-side types.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

// Re-export HistoryEntry so components can import from one place.
export type { HistoryEntry } from "@piccolo/core";
