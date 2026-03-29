/**
 * Entry types for piccolo-core session history.
 *
 * All entries are stored as rows in the `entries` D1 table.
 * Each row has a `type` discriminant and a `data` JSON column.
 * This file defines:
 *   - The discriminated union of all entry variants (AnyEntry)
 *   - generateEntryId() for producing stable UUID v4 IDs
 *   - isEntryType() for narrowing unknown strings
 *   - parseEntry() for deserialising a raw DB row into a typed entry
 *
 * Spec ref: specs/core.md §Entry Types
 */

import type { IMessage } from "@piccolo/api";
import type { UserContent } from "ai";

// ─── Discriminant union ───────────────────────────────────────────────────────

export type EntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

// ─── Base ─────────────────────────────────────────────────────────────────────

export interface EntryBase {
  /** Stable UUID v4 identifier, unique within a session. */
  id: string;
  sessionId: string;
  /** null for the root entry. */
  parentId: string | null;
  type: EntryType;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Typed by each concrete subtype; unknown here so the base is safely generic. */
  data: unknown;
}

// ─── Concrete entry types ─────────────────────────────────────────────────────

/** A single LLM message (user | assistant | tool | system). */
export interface MessageEntry extends EntryBase {
  type: "message";
  data: IMessage;
}

/** Active model was switched. */
export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  data: { modelId: string };
}

/** Reserved for future thinking-level tracking. */
export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  data: { thinkingLevel: string };
}

/** Context was summarised; firstKeptEntryId marks the resumption point. */
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  data: { summary: string; firstKeptEntryId: string | undefined; tokensBefore: number };
}

/** Summary of an abandoned branch stored at the fork point. */
export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  data: { summary: string; fromId: string; fromHook?: boolean };
}

/** Opaque extension state — NOT sent to LLM. */
export interface CustomEntry extends EntryBase {
  type: "custom";
  data: { customType: string; payload?: unknown };
}

/** Extension-defined content sent to LLM. */
export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  data: {
    customType: string;
    content: string | UserContent;
    display: boolean;
    details?: unknown;
  };
}

/** User bookmark on an entry. */
export interface LabelEntry extends EntryBase {
  type: "label";
  data: { targetId: string; label: string | undefined };
}

/** Root entry storing session display metadata. */
export interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  data: { name?: string };
}

// ─── Full discriminated union ─────────────────────────────────────────────────

export type AnyEntry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a random UUID v4 entry ID.
 * Available in both Workers runtime and Vitest/Miniflare environments.
 */
export function generateEntryId(): string {
  return crypto.randomUUID();
}

/** Narrow an unknown string to EntryType. */
export function isEntryType(type: string): type is EntryType {
  return (
    type === "message" ||
    type === "model_change" ||
    type === "thinking_level_change" ||
    type === "compaction" ||
    type === "branch_summary" ||
    type === "custom" ||
    type === "custom_message" ||
    type === "label" ||
    type === "session_info"
  );
}

/**
 * Raw D1 row shape for the `entries` table.
 * `data` is a JSON string — parse before use.
 */
export interface DbEntryRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  type: string;
  timestamp: string;
  /** Raw JSON string. Always valid JSON (enforced by CHECK constraint). */
  data: string;
}

/**
 * Parse a raw DB row into a typed AnyEntry.
 * Throws if `type` is not a known EntryType (should never happen with a valid DB).
 */
export function parseEntry(row: DbEntryRow): AnyEntry {
  if (!isEntryType(row.type)) {
    throw new Error(`Unknown entry type: ${row.type}`);
  }
  // data is guaranteed valid JSON by the CHECK constraint; cast is safe.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = JSON.parse(row.data) as unknown;
  if (row.type === "message" && typeof data === "object" && data !== null) {
    return {
      id: row.id,
      sessionId: row.session_id,
      parentId: row.parent_id,
      type: row.type,
      timestamp: row.timestamp,
      data: {
        ...(data as Record<string, unknown>),
        id: row.id,
      },
    } as MessageEntry;
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    type: row.type,
    timestamp: row.timestamp,
    data,
  } as AnyEntry;
}
