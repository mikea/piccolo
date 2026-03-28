/**
 * Unit tests for ext-instructions.
 *
 * Tests cover:
 *   - db helpers: listVisible, addInstruction, removeInstruction
 *   - InstructionsTool: list / add / remove actions via execute()
 *   - buildSystemPromptAdditions: system prompt injection logic
 *
 * All tests run against a real Miniflare D1 database (via @cloudflare/vitest-pool-workers).
 * InstructionsExtension (WorkerEntrypoint) is not constructed directly in tests —
 * its logic is covered through the exported helpers and InstructionsTool.
 *
 * Spec ref: specs/instructions_extension.md
 */

import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { ISession } from "@piccolo/api";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { addInstruction, listVisible, removeInstruction } from "../src/db.ts";
import { buildSystemPromptAdditions, InstructionsTool } from "../src/extension.ts";

// ── DB setup: apply migrations and truncate data before each test ─────────────

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await applyD1Migrations(env.INSTRUCTIONS_DB, migrations);
  // Clear all rows so tests are fully isolated from each other.
  await env.INSTRUCTIONS_DB.prepare("DELETE FROM instructions").run();
});

// ── Mock ISession ─────────────────────────────────────────────────────────────

function makeSession(userId = "user-1", sessionId = "session-1"): ISession {
  return {
    sessionId: async () => sessionId,
    userId: async () => userId,
    getUpdatedAt: async () => 0,
    getName: async () => undefined,
    setName: async () => {},
    prompt: async () => {
      throw new Error("not implemented");
    },
    sendUserMessage: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    getCurrentTurn: async () => undefined,
    getModel: async () => "test/model",
    setModel: async () => {},
    listModels: async () => [],
    getActiveTools: async () => [],
    appendCustomMessage: async () => {},
    appendCustomEntry: async () => {},
    getEntries: async () => [],
    getHistory: async () => [],
    getContextUsage: async () => ({ inputTokens: 0 }),
    compact: async () => {},
    getSystemPrompt: async () => "",
    branch: async () => {},
    fork: async () => {
      throw new Error("not implemented");
    },
    delete: async () => {},
    subscribe: async () => {
      throw new Error("not implemented");
    },
  } as unknown as ISession;
}

// ── db helpers ────────────────────────────────────────────────────────────────

describe("db: listVisible", () => {
  it("returns empty array when no instructions exist", async () => {
    const rows = await listVisible(env.INSTRUCTIONS_DB, "u-empty", "s-empty");
    expect(rows).toEqual([]);
  });

  it("returns only instructions visible to the given user/session", async () => {
    const db = env.INSTRUCTIONS_DB;
    const evId = await addInstruction(db, "everyone", "", "global rule");
    const u2Id = await addInstruction(db, "user", "u-other", "other user rule");
    const s2Id = await addInstruction(db, "session", "s-other", "other session rule");
    const myUId = await addInstruction(db, "user", "u-mine", "my user rule");
    const mySId = await addInstruction(db, "session", "s-mine", "my session rule");

    const rows = await listVisible(db, "u-mine", "s-mine");
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(evId);
    expect(ids).toContain(myUId);
    expect(ids).toContain(mySId);
    expect(ids).not.toContain(u2Id);
    expect(ids).not.toContain(s2Id);
  });

  it("orders rows by created_at ASC", async () => {
    const db = env.INSTRUCTIONS_DB;
    const id1 = await addInstruction(db, "everyone", "", "first-order");
    const id2 = await addInstruction(db, "everyone", "", "second-order");
    const rows = await listVisible(db, "any", "any");
    const ours = rows.filter((r) => r.id === id1 || r.id === id2);
    expect(ours[0]?.id).toBe(id1);
    expect(ours[1]?.id).toBe(id2);
  });
});

describe("db: addInstruction", () => {
  it("returns a v4 UUID", async () => {
    const id = await addInstruction(env.INSTRUCTIONS_DB, "session", "s-uuid", "content");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("stores the correct scope_type, scope_id, and content", async () => {
    const db = env.INSTRUCTIONS_DB;
    const id = await addInstruction(db, "user", "u-store", "stored content");
    const rows = await listVisible(db, "u-store", "s-irrelevant");
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.scope_type).toBe("user");
    expect(row?.scope_id).toBe("u-store");
    expect(row?.content).toBe("stored content");
  });
});

describe("db: removeInstruction", () => {
  it("returns true and deletes the row", async () => {
    const db = env.INSTRUCTIONS_DB;
    const id = await addInstruction(db, "session", "s-del", "to delete");
    const result = await removeInstruction(db, id);
    expect(result).toBe(true);
    const rows = await listVisible(db, "any", "s-del");
    expect(rows.find((r) => r.id === id)).toBeUndefined();
  });

  it("returns false for a non-existent id", async () => {
    const result = await removeInstruction(env.INSTRUCTIONS_DB, crypto.randomUUID());
    expect(result).toBe(false);
  });
});

// ── InstructionsTool ──────────────────────────────────────────────────────────

describe("InstructionsTool.getDescriptor", () => {
  it("returns descriptor with name=instructions", async () => {
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    const desc = await tool.getDescriptor();
    expect(desc.name).toBe("instructions");
    expect(desc.promptSnippet).toBeDefined();
    expect(desc.inputSchema).toBeDefined();
  });
});

describe("InstructionsTool: list action", () => {
  it("returns empty-state message when no instructions exist", async () => {
    const ctx = makeSession("u-list-empty", "s-list-empty");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    const result = await tool.execute("c1", { action: "list" }, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("No instructions");
    expect((result.details as { rows: unknown[] }).rows).toHaveLength(0);
  });

  it("shows instructions after they are added", async () => {
    const ctx = makeSession("u-list-show", "s-list-show");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    await tool.execute("c1", { action: "add", scope_type: "session", content: "Be concise." }, ctx);
    const result = await tool.execute("c2", { action: "list" }, ctx);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Be concise.");
    expect(text).toContain("session");
  });
});

describe("InstructionsTool: add action", () => {
  it("adds a session-scoped instruction and resolves scope_id from ctx", async () => {
    const ctx = makeSession("u-add-s", "s-add-s");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    const result = await tool.execute(
      "c1",
      { action: "add", scope_type: "session", content: "Session rule." },
      ctx,
    );
    const details = result.details as { id: string; scope_type: string; scope_id: string };
    expect(details.scope_type).toBe("session");
    expect(details.scope_id).toBe("s-add-s");
    expect(details.id).toMatch(/^[0-9a-f-]{36}$/i);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Instruction added");
  });

  it("adds a user-scoped instruction and resolves scope_id from ctx", async () => {
    const ctx = makeSession("u-add-u", "s-add-u");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    const result = await tool.execute(
      "c1",
      { action: "add", scope_type: "user", content: "User rule." },
      ctx,
    );
    const details = result.details as { scope_type: string; scope_id: string };
    expect(details.scope_type).toBe("user");
    expect(details.scope_id).toBe("u-add-u");
  });

  it("adds an everyone-scoped instruction with empty scope_id", async () => {
    const ctx = makeSession("u-add-e", "s-add-e");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    const result = await tool.execute(
      "c1",
      { action: "add", scope_type: "everyone", content: "Global rule." },
      ctx,
    );
    const details = result.details as { scope_type: string; scope_id: string };
    expect(details.scope_type).toBe("everyone");
    expect(details.scope_id).toBe("");
  });

  it("throws on invalid params (missing scope_type)", async () => {
    const ctx = makeSession();
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    await expect(tool.execute("c1", { action: "add", content: "no scope" }, ctx)).rejects.toThrow();
  });

  it("throws on empty content", async () => {
    const ctx = makeSession();
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    await expect(
      tool.execute("c1", { action: "add", scope_type: "session", content: "" }, ctx),
    ).rejects.toThrow();
  });
});

describe("InstructionsTool: remove action", () => {
  it("removes instruction and returns confirmation", async () => {
    const ctx = makeSession("u-remove", "s-remove");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);

    const addResult = await tool.execute(
      "c1",
      { action: "add", scope_type: "session", content: "Temporary." },
      ctx,
    );
    const { id } = addResult.details as { id: string };

    const removeResult = await tool.execute("c2", { action: "remove", id }, ctx);
    const text = (removeResult.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("removed");
    expect((removeResult.details as { id: string }).id).toBe(id);

    // Verify gone from list
    const listResult = await tool.execute("c3", { action: "list" }, ctx);
    const listText = (listResult.content[0] as { type: "text"; text: string }).text;
    expect(listText).toContain("No instructions");
  });

  it("throws for a non-existent id", async () => {
    const ctx = makeSession("u-remove-err", "s-remove-err");
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    await expect(
      tool.execute("c1", { action: "remove", id: crypto.randomUUID() }, ctx),
    ).rejects.toThrow("Instruction not found");
  });

  it("throws on invalid uuid format", async () => {
    const ctx = makeSession();
    const tool = new InstructionsTool(env.INSTRUCTIONS_DB);
    await expect(tool.execute("c1", { action: "remove", id: "not-a-uuid" }, ctx)).rejects.toThrow();
  });
});

// ── buildSystemPromptAdditions ────────────────────────────────────────────────

describe("buildSystemPromptAdditions", () => {
  it("returns empty array when no instructions exist", async () => {
    const ctx = makeSession("u-spa-empty", "s-spa-empty");
    const additions = await buildSystemPromptAdditions(env.INSTRUCTIONS_DB, ctx);
    expect(additions).toEqual([]);
  });

  it("returns one context addition with all visible instructions", async () => {
    const db = env.INSTRUCTIONS_DB;
    await addInstruction(db, "everyone", "", "Always be polite.");
    await addInstruction(db, "user", "u-spa", "Prefer TypeScript.");
    await addInstruction(db, "session", "s-spa", "Focus on testing today.");

    const ctx = makeSession("u-spa", "s-spa");
    const additions = await buildSystemPromptAdditions(db, ctx);

    expect(additions).toHaveLength(1);
    const [a] = additions;
    expect(a!.section).toBe("context");
    expect(a!.priority).toBe(10);
    expect(a!.content).toContain("## Instructions");
    expect(a!.content).toContain("Always be polite.");
    expect(a!.content).toContain("Prefer TypeScript.");
    expect(a!.content).toContain("Focus on testing today.");
  });

  it("does not include instructions from other users or sessions", async () => {
    const db = env.INSTRUCTIONS_DB;
    await addInstruction(db, "user", "u-foreign", "Foreign user rule.");
    await addInstruction(db, "session", "s-foreign", "Foreign session rule.");

    const ctx = makeSession("u-isolated", "s-isolated");
    // This user/session has no instructions of its own (apart from potential
    // 'everyone' rows added by other tests, which is fine — we only check absence).
    const additions = await buildSystemPromptAdditions(db, ctx);
    const content = additions[0]?.content ?? "";
    expect(content).not.toContain("Foreign user rule.");
    expect(content).not.toContain("Foreign session rule.");
  });
});
