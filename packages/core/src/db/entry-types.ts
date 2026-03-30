import type {
  AnyEntry,
  BranchSummaryEntry,
  CompactionEntry,
  EntryType,
  LabelEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionInfoEntry,
  ThinkingLevelChangeEntry,
} from "@piccolo/api";

export type {
  AnyEntry,
  BranchSummaryEntry,
  CompactionEntry,
  EntryType,
  LabelEntry,
  MessageEntry,
  ModelChangeEntry,
  SessionInfoEntry,
  ThinkingLevelChangeEntry,
};

export function generateEntryId(): string {
  return crypto.randomUUID();
}

export function isEntryType(type: string): type is EntryType {
  return (
    type === "message" ||
    type === "model_change" ||
    type === "thinking_level_change" ||
    type === "compaction" ||
    type === "branch_summary" ||
    type === "label" ||
    type === "session_info"
  );
}

export interface DbEntryRow {
  append_seq?: number;
  id: string;
  session_id: string;
  parent_id: string | null;
  type: string;
  timestamp: string;
  data: string;
}

export function parseEntry(row: DbEntryRow): AnyEntry {
  if (!isEntryType(row.type)) {
    throw new Error(`Unknown entry type: ${row.type}`);
  }
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
