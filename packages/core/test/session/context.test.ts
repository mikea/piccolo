/**
 * Tests for buildSessionContext and walkToRoot.
 *
 * These are pure-function tests — no D1 or Workers globals required.
 * They run in the standard Miniflare sandbox (Workers runtime) but never
 * touch any bindings.
 *
 * Spec ref: specs/core.md §Context Reconstruction
 */

import { describe, expect, it } from "vitest";
import type { AnyEntry } from "../../src/db/entry-types.ts";
import { buildSessionContext, DEFAULT_MODEL_ID, walkToRoot } from "../../src/session/context.ts";

// ─── Entry factory helpers ────────────────────────────────────────────────────

let _seq = 0;
function nextId(): string {
  _seq += 1;
  return _seq.toString(16).padStart(8, "0");
}

function ts(offset = 0): string {
  return new Date(1_700_000_000_000 + offset * 1000).toISOString();
}

function makeEntry(
  overrides: Partial<AnyEntry> & { type: AnyEntry["type"] },
  data: unknown,
): AnyEntry {
  return {
    id: nextId(),
    sessionId: "sess-1",
    parentId: null,
    timestamp: ts(),
    data,
    ...overrides,
  } as AnyEntry;
}

function sessionInfo(id: string, parentId: string | null = null): AnyEntry {
  return makeEntry({ id, parentId, type: "session_info" }, { name: undefined });
}

function userMsg(id: string, parentId: string | null, text: string): AnyEntry {
  return makeEntry({ id, parentId, type: "message" }, { role: "user", content: text, id });
}

function assistantMsg(id: string, parentId: string | null, text: string): AnyEntry {
  return makeEntry(
    { id, parentId, type: "message" },
    { role: "assistant", content: [{ type: "text", text }], id },
  );
}

function modelChange(id: string, parentId: string | null, modelId: string): AnyEntry {
  return makeEntry({ id, parentId, type: "model_change" }, { modelId });
}

function compaction(
  id: string,
  parentId: string | null,
  summary: string,
  firstKeptEntryId: string,
): AnyEntry {
  return makeEntry(
    { id, parentId, type: "compaction" },
    { summary, firstKeptEntryId, tokensBefore: 1000 },
  );
}

function branchSummary(id: string, parentId: string | null, summary: string): AnyEntry {
  return makeEntry({ id, parentId, type: "branch_summary" }, { summary, fromId: parentId ?? "" });
}

function labelEntry(id: string, parentId: string | null): AnyEntry {
  return makeEntry({ id, parentId, type: "label" }, { targetId: "x", label: "foo" });
}

// ─── walkToRoot ───────────────────────────────────────────────────────────────

describe("walkToRoot", () => {
  it("returns empty array when leafId is null", () => {
    expect(walkToRoot([], null)).toEqual([]);
  });

  it("returns empty array when entries is empty and leafId is non-null", () => {
    expect(walkToRoot([], "missing")).toEqual([]);
  });

  it("returns single entry when it has no parent", () => {
    const root = sessionInfo("r1");
    expect(walkToRoot([root], "r1")).toEqual([root]);
  });

  it("returns path in root-first order", () => {
    const r = sessionInfo("r");
    const a = userMsg("a", "r", "hi");
    const b = assistantMsg("b", "a", "hello");
    const result = walkToRoot([r, a, b], "b");
    expect(result.map((e) => e.id)).toEqual(["r", "a", "b"]);
  });

  it("stops at an entry whose parentId is not in the map", () => {
    // 'a' references parentId 'missing' — walk stops at 'a' (orphan)
    const a = userMsg("a", "missing", "hi");
    const b = assistantMsg("b", "a", "hello");
    const result = walkToRoot([a, b], "b");
    // walk starts at b → a → parentId 'missing' not found → stop; root-first = [a, b]
    expect(result.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("handles a branch — only active branch entries are returned", () => {
    const r = sessionInfo("r");
    const a = userMsg("a", "r", "common");
    // branch 1
    const b1 = assistantMsg("b1", "a", "branch 1");
    // branch 2 (active)
    const b2 = assistantMsg("b2", "a", "branch 2");
    const c2 = userMsg("c2", "b2", "continue");

    const entries = [r, a, b1, b2, c2];
    const result = walkToRoot(entries, "c2");
    // should only include the active branch: r → a → b2 → c2
    expect(result.map((e) => e.id)).toEqual(["r", "a", "b2", "c2"]);
    expect(result.map((e) => e.id)).not.toContain("b1");
  });
});

// ─── buildSessionContext — empty / trivial cases ──────────────────────────────

describe("buildSessionContext — empty / trivial", () => {
  it("returns default state for empty entries + null leafId", () => {
    const result = buildSessionContext([], null);
    expect(result.messages).toEqual([]);
    expect(result.modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("returns default state when leafId is not found in entries", () => {
    const root = sessionInfo("r");
    const result = buildSessionContext([root], "missing");
    expect(result.messages).toEqual([]);
    expect(result.modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("session_info root produces no messages", () => {
    const root = sessionInfo("r");
    const result = buildSessionContext([root], "r");
    expect(result.messages).toEqual([]);
  });
});

// ─── buildSessionContext — message conversion ─────────────────────────────────

describe("buildSessionContext — message entries", () => {
  it("includes user and assistant messages in order", () => {
    const r = sessionInfo("r");
    const u = userMsg("u", "r", "Hello");
    const a = assistantMsg("a", "u", "Hi");
    const { messages } = buildSessionContext([r, u, a], "a");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", content: "Hello", id: "u" });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      id: "a",
    });
  });
});

// ─── buildSessionContext — model extraction ───────────────────────────────────

describe("buildSessionContext — modelId", () => {
  it("returns DEFAULT_MODEL_ID when no model_change entries exist", () => {
    const r = sessionInfo("r");
    const u = userMsg("u", "r", "hi");
    const { modelId } = buildSessionContext([r, u], "u");
    expect(modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("returns modelId from the last model_change entry on the path", () => {
    const r = sessionInfo("r");
    const m1 = modelChange("m1", "r", "openai/gpt-4o");
    const u = userMsg("u", "m1", "hi");
    const m2 = modelChange("m2", "u", "anthropic/claude-opus-4");
    const a = assistantMsg("a", "m2", "hello");
    const { modelId } = buildSessionContext([r, m1, u, m2, a], "a");
    expect(modelId).toBe("anthropic/claude-opus-4");
  });

  it("ignores model_change entries on a different branch", () => {
    const r = sessionInfo("r");
    const m1 = modelChange("m1", "r", "openai/gpt-4o");
    // branch A (inactive)
    const _ua = userMsg("ua", "m1", "branch A");
    const _ma = modelChange("ma", "ua", "google/gemini-pro");
    // branch B (active)
    const ub = userMsg("ub", "m1", "branch B");
    const { modelId } = buildSessionContext([r, m1, _ua, _ma, ub], "ub");
    expect(modelId).toBe("openai/gpt-4o");
  });
});

// ─── buildSessionContext — branch_summary ────────────────────────────────────

describe("buildSessionContext — branch_summary entries", () => {
  it("includes branch_summary as assistant message with prefix", () => {
    const r = sessionInfo("r");
    const bs = branchSummary("bs", "r", "The other branch did X.");
    const { messages } = buildSessionContext([r, bs], "bs");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: "[Previous branch summary]\n\nThe other branch did X.",
      id: "bs",
    });
  });
});

// ─── buildSessionContext — skipped entry types ────────────────────────────────

describe("buildSessionContext — non-message entry types are skipped", () => {
  it("skips label entries", () => {
    const r = sessionInfo("r");
    const l = labelEntry("l", "r");
    const { messages } = buildSessionContext([r, l], "l");
    expect(messages).toHaveLength(0);
  });

  it("skips model_change entries", () => {
    const r = sessionInfo("r");
    const mc = modelChange("mc", "r", "openai/gpt-4o");
    const { messages } = buildSessionContext([r, mc], "mc");
    expect(messages).toHaveLength(0);
  });

  it("skips thinking_level_change entries", () => {
    const r = sessionInfo("r");
    const tl = makeEntry(
      { id: "tl", parentId: "r", type: "thinking_level_change" },
      { thinkingLevel: "high" },
    );
    const { messages } = buildSessionContext([r, tl], "tl");
    expect(messages).toHaveLength(0);
  });
});

// ─── buildSessionContext — compaction ────────────────────────────────────────

describe("buildSessionContext — compaction", () => {
  it("replaces history before compaction with a synthetic summary message", () => {
    const r = sessionInfo("r");
    const u1 = userMsg("u1", "r", "Old message 1");
    const a1 = assistantMsg("a1", "u1", "Old reply");
    const u2 = userMsg("u2", "a1", "Old message 2");
    // compaction: firstKeptEntryId = u3 (the message kept after summarisation)
    const u3 = userMsg("u3", "u2", "Kept message");
    const comp = compaction("comp", "u3", "Summary of old stuff", "u3");
    const a2 = assistantMsg("a2", "comp", "New reply");

    const { messages } = buildSessionContext([r, u1, a1, u2, u3, comp, a2], "a2");

    // Expected: summary message + u3 (firstKeptEntryId) + a2
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Conversation Summary]\n\nSummary of old stuff",
      id: "comp",
    });
    expect(messages[1]).toEqual({ role: "user", content: "Kept message", id: "u3" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "New reply" }],
      id: "a2",
    });
  });

  it("uses the most recent compaction when multiple exist on the path", () => {
    const r = sessionInfo("r");
    const u1 = userMsg("u1", "r", "Very old");
    const u2 = userMsg("u2", "u1", "Old kept");
    const comp1 = compaction("comp1", "u2", "First summary", "u2");
    const u3 = userMsg("u3", "comp1", "Middle message");
    const u4 = userMsg("u4", "u3", "Second kept");
    const comp2 = compaction("comp2", "u4", "Second summary", "u4");
    const u5 = userMsg("u5", "comp2", "Recent message");

    const { messages } = buildSessionContext([r, u1, u2, comp1, u3, u4, comp2, u5], "u5");

    // Only comp2 should be active; comp1 and everything before u4 dropped
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Conversation Summary]\n\nSecond summary",
      id: "comp2",
    });
    // u4 is firstKeptEntryId for comp2
    expect(messages[1]).toEqual({ role: "user", content: "Second kept", id: "u4" });
    expect(messages[2]).toEqual({ role: "user", content: "Recent message", id: "u5" });
    expect(messages).toHaveLength(3);
  });

  it("handles compaction where firstKeptEntryId is missing from entries gracefully", () => {
    const r = sessionInfo("r");
    const comp = compaction("comp", "r", "Summary", "nonexistent-id");
    const u = userMsg("u", "comp", "After compaction");

    const { messages } = buildSessionContext([r, comp, u], "u");

    // firstKeptEntryId not found — include compaction entry + everything after
    expect(messages[0]).toEqual({
      role: "user",
      content: "[Conversation Summary]\n\nSummary",
      id: "comp",
    });
    expect(messages[1]).toEqual({ role: "user", content: "After compaction", id: "u" });
  });
});

// ─── buildSessionContext — mixed entry types ──────────────────────────────────

describe("buildSessionContext — mixed entry types on path", () => {
  it("produces correct message sequence with all entry types interleaved", () => {
    const r = sessionInfo("r");
    const mc = modelChange("mc", "r", "openai/gpt-4o");
    const u1 = userMsg("u1", "mc", "Hello");
    const a1 = assistantMsg("a1", "u1", "Reply");
    const lb = labelEntry("lb", "a1");
    const bs = branchSummary("bs", "lb", "Old branch");

    const entries = [r, mc, u1, a1, lb, bs];
    const { messages, modelId } = buildSessionContext(entries, "bs");

    expect(modelId).toBe("openai/gpt-4o");
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: "user", content: "Hello", id: "u1" });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Reply" }],
      id: "a1",
    });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "[Previous branch summary]\n\nOld branch",
      id: "bs",
    });
  });
});
