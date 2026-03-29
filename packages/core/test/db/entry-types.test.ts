import { describe, expect, it } from "vitest";
import {
  type AnyEntry,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type DbEntryRow,
  generateEntryId,
  isEntryType,
  type LabelEntry,
  type MessageEntry,
  type ModelChangeEntry,
  parseEntry,
  type SessionInfoEntry,
  type ThinkingLevelChangeEntry,
} from "../../src/db/entry-types.ts";

// ─── generateEntryId ──────────────────────────────────────────────────────────

describe("generateEntryId", () => {
  it("returns a UUID v4", () => {
    expect(generateEntryId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("produces unique IDs across 1000 calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateEntryId()));
    expect(ids.size).toBe(1000);
  });
});

// ─── isEntryType ──────────────────────────────────────────────────────────────

describe("isEntryType", () => {
  it.each([
    "message",
    "model_change",
    "thinking_level_change",
    "compaction",
    "branch_summary",
    "custom",
    "custom_message",
    "label",
    "session_info",
  ])("returns true for valid type %s", (type) => {
    expect(isEntryType(type)).toBe(true);
  });

  it.each([
    "unknown",
    "",
    "MESSAGE",
    "msg",
    "compaction_entry",
    "custom message",
  ])("returns false for invalid type %s", (type) => {
    expect(isEntryType(type)).toBe(false);
  });
});

// ─── parseEntry ───────────────────────────────────────────────────────────────

function makeRow(type: string, data: unknown): DbEntryRow {
  return {
    id: "aabb1122",
    session_id: "session-1",
    parent_id: "parent-1",
    type,
    timestamp: "2024-01-01T00:00:00.000Z",
    data: JSON.stringify(data),
  };
}

describe("parseEntry — MessageEntry", () => {
  it("parses a user message", () => {
    const data = { role: "user", content: "hello" };
    const entry = parseEntry(makeRow("message", data)) as MessageEntry;
    expect(entry.type).toBe("message");
    expect(entry.id).toBe("aabb1122");
    expect(entry.sessionId).toBe("session-1");
    expect(entry.parentId).toBe("parent-1");
    expect(entry.timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(entry.data).toEqual({ ...data, id: "aabb1122" });
  });

  it("parses an assistant message", () => {
    const data = { role: "assistant", content: "world" };
    const entry = parseEntry(makeRow("message", data)) as MessageEntry;
    expect(entry.type).toBe("message");
    expect(entry.data).toEqual({ ...data, id: "aabb1122" });
  });

  it("preserves parentId = null for root entry", () => {
    const row = { ...makeRow("message", { role: "user", content: "hi" }), parent_id: null };
    const entry = parseEntry(row);
    expect(entry.parentId).toBeNull();
  });
});

describe("parseEntry — ModelChangeEntry", () => {
  it("round-trips correctly", () => {
    const data = { modelId: "anthropic/claude-sonnet-4-5" };
    const entry = parseEntry(makeRow("model_change", data)) as ModelChangeEntry;
    expect(entry.type).toBe("model_change");
    expect(entry.data).toEqual(data);
  });
});

describe("parseEntry — ThinkingLevelChangeEntry", () => {
  it("round-trips correctly", () => {
    const data = { thinkingLevel: "high" };
    const entry = parseEntry(makeRow("thinking_level_change", data)) as ThinkingLevelChangeEntry;
    expect(entry.type).toBe("thinking_level_change");
    expect(entry.data).toEqual(data);
  });
});

describe("parseEntry — CompactionEntry", () => {
  it("round-trips correctly", () => {
    const data = {
      summary: "We discussed X.",
      firstKeptEntryId: "c3d4e5f6",
      tokensBefore: 95000,
    };
    const entry = parseEntry(makeRow("compaction", data)) as CompactionEntry;
    expect(entry.type).toBe("compaction");
    expect(entry.data).toEqual(data);
  });
});

describe("parseEntry — BranchSummaryEntry", () => {
  it("round-trips with fromHook present", () => {
    const data = { summary: "Branch A did X.", fromId: "a1b2c3d4", fromHook: true };
    const entry = parseEntry(makeRow("branch_summary", data)) as BranchSummaryEntry;
    expect(entry.type).toBe("branch_summary");
    expect(entry.data).toEqual(data);
  });

  it("round-trips with fromHook absent", () => {
    const data = { summary: "Branch B.", fromId: "b2c3d4e5" };
    const entry = parseEntry(makeRow("branch_summary", data)) as BranchSummaryEntry;
    expect(entry.data.fromHook).toBeUndefined();
  });
});

describe("parseEntry — CustomEntry", () => {
  it("round-trips with payload present", () => {
    const data = { customType: "my-ext:state", payload: { key: "value" } };
    const entry = parseEntry(makeRow("custom", data)) as CustomEntry;
    expect(entry.type).toBe("custom");
    expect(entry.data).toEqual(data);
  });

  it("round-trips with payload absent", () => {
    const data = { customType: "my-ext:state" };
    const entry = parseEntry(makeRow("custom", data)) as CustomEntry;
    expect(entry.data.payload).toBeUndefined();
  });
});

describe("parseEntry — CustomMessageEntry", () => {
  it("round-trips with string content", () => {
    const data = { customType: "skills:inject", content: "Some injected text.", display: true };
    const entry = parseEntry(makeRow("custom_message", data)) as CustomMessageEntry;
    expect(entry.type).toBe("custom_message");
    expect(entry.data).toEqual(data);
  });

  it("round-trips with UserContent array", () => {
    const data = {
      customType: "skills:inject",
      content: [{ type: "text", text: "Part A" }],
      display: false,
    };
    const entry = parseEntry(makeRow("custom_message", data)) as CustomMessageEntry;
    expect(entry.data.content).toEqual(data.content);
  });

  it("round-trips with details present", () => {
    const data = {
      customType: "ext:x",
      content: "msg",
      display: true,
      details: { extra: 42 },
    };
    const entry = parseEntry(makeRow("custom_message", data)) as CustomMessageEntry;
    expect(entry.data.details).toEqual({ extra: 42 });
  });

  it("round-trips with details absent", () => {
    const data = { customType: "ext:x", content: "msg", display: true };
    const entry = parseEntry(makeRow("custom_message", data)) as CustomMessageEntry;
    expect(entry.data.details).toBeUndefined();
  });
});

describe("parseEntry — LabelEntry", () => {
  it("round-trips with label string", () => {
    const data = { targetId: "a1b2c3d4", label: "checkpoint" };
    const entry = parseEntry(makeRow("label", data)) as LabelEntry;
    expect(entry.type).toBe("label");
    expect(entry.data).toEqual(data);
  });

  it("round-trips with label undefined (stored as null in JSON)", () => {
    // When label is undefined, JSON.stringify omits the key.
    // The round-trip recovers undefined (absent key).
    const data: { targetId: string; label: string | undefined } = {
      targetId: "e5f6a7b8",
      label: undefined,
    };
    const row = { ...makeRow("label", data) };
    const entry = parseEntry(row) as LabelEntry;
    expect(entry.data.label).toBeUndefined();
  });
});

describe("parseEntry — SessionInfoEntry", () => {
  it("round-trips with name present", () => {
    const data = { name: "My Session" };
    const entry = parseEntry(makeRow("session_info", data)) as SessionInfoEntry;
    expect(entry.type).toBe("session_info");
    expect(entry.data).toEqual(data);
  });

  it("round-trips with name absent", () => {
    const data = {};
    const entry = parseEntry(makeRow("session_info", data)) as SessionInfoEntry;
    expect(entry.data.name).toBeUndefined();
  });
});

describe("parseEntry — error handling", () => {
  it("throws for unknown entry type", () => {
    const row = makeRow("unknown_type", {});
    expect(() => parseEntry(row)).toThrow("Unknown entry type: unknown_type");
  });
});

// ─── AnyEntry discriminated union — exhaustiveness check ─────────────────────

describe("AnyEntry — exhaustiveness", () => {
  it("covers all 9 entry types via discriminated union switch", () => {
    // This test verifies at the TypeScript level that the switch is exhaustive.
    // If a new entry type is added without updating the union, this function
    // will produce a tsc error on the `never` branch.
    function assertExhaustive(entry: AnyEntry): string {
      switch (entry.type) {
        case "message":
          return "message";
        case "model_change":
          return "model_change";
        case "thinking_level_change":
          return "thinking_level_change";
        case "compaction":
          return "compaction";
        case "branch_summary":
          return "branch_summary";
        case "custom":
          return "custom";
        case "custom_message":
          return "custom_message";
        case "label":
          return "label";
        case "session_info":
          return "session_info";
        default: {
          const _exhaustive: never = entry;
          return _exhaustive;
        }
      }
    }

    // Runtime exercise: parse one of each type and pass through the switch.
    const types: string[] = [
      "message",
      "model_change",
      "thinking_level_change",
      "compaction",
      "branch_summary",
      "custom",
      "custom_message",
      "label",
      "session_info",
    ];

    const sampleData: Record<string, unknown> = {
      message: { role: "user", content: "hi" },
      model_change: { modelId: "m" },
      thinking_level_change: { thinkingLevel: "high" },
      compaction: { summary: "s", firstKeptEntryId: "id", tokensBefore: 0 },
      branch_summary: { summary: "s", fromId: "id" },
      custom: { customType: "t" },
      custom_message: { customType: "t", content: "c", display: true },
      label: { targetId: "id", label: "l" },
      session_info: {},
    };

    for (const type of types) {
      const entry = parseEntry(makeRow(type, sampleData[type]));
      expect(assertExhaustive(entry)).toBe(type);
    }
  });
});
