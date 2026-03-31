import { env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { DbEntryRow } from "../../src/db/entry-types.ts";
import { insertEntry, insertSession, type SessionRow } from "../../src/db/schema.ts";
import { ContextIterator } from "../../src/session/context-iterator.ts";
import { setupTestDb } from "../mocks/d1.ts";

function sessionRow(id: string): SessionRow {
  return {
    id,
    user_id: "u1",
    created_at: Date.now(),
    updated_at: Date.now(),
    name: id,
    model_id: "anthropic/claude-sonnet-4-5",
    leaf_id: null,
  };
}

function messageRow(
  sessionId: string,
  id: string,
  parentId: string | null,
  text: string,
): DbEntryRow {
  return {
    id,
    session_id: sessionId,
    parent_id: parentId,
    type: "message",
    timestamp: new Date().toISOString(),
    data: JSON.stringify({ role: "user", content: text, id }),
  };
}

function branchSummaryRow(
  sessionId: string,
  id: string,
  parentId: string | null,
  fromId: string,
): DbEntryRow {
  return {
    id,
    session_id: sessionId,
    parent_id: parentId,
    type: "branch_summary",
    timestamp: new Date().toISOString(),
    data: JSON.stringify({ summary: "fork marker", fromId }),
  };
}

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

describe("ContextIterator", () => {
  it("iterates newest-to-oldest on a linear chain", async () => {
    const sid = "ctx-it-linear";
    await insertSession(env.SESSIONS_DB, sessionRow(sid));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "a", null, "a"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "b", "a", "b"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "c", "b", "c"));

    const ids: string[] = [];
    for await (const entry of new ContextIterator({
      db: env.SESSIONS_DB,
      sessionId: sid,
      leafId: "c",
    })) {
      ids.push(entry.id);
    }
    expect(ids).toEqual(["c", "b", "a"]);
  });

  it("continues across query pages", async () => {
    const sid = "ctx-it-pages";
    await insertSession(env.SESSIONS_DB, sessionRow(sid));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "e1", null, "1"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "e2", "e1", "2"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "e3", "e2", "3"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "e4", "e3", "4"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "e5", "e4", "5"));

    const ids: string[] = [];
    for await (const entry of new ContextIterator({
      db: env.SESSIONS_DB,
      sessionId: sid,
      leafId: "e5",
      pageSize: 2,
    })) {
      ids.push(entry.id);
    }
    expect(ids).toEqual(["e5", "e4", "e3", "e2", "e1"]);
  });

  it("jumps to branch_summary.fromId and starts a new query", async () => {
    const sid = "ctx-it-jump";
    await insertSession(env.SESSIONS_DB, sessionRow(sid));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "r", null, "root"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "p1", "r", "p1"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "p2", "p1", "p2"));
    await insertEntry(env.SESSIONS_DB, branchSummaryRow(sid, "bs", "p2", "alt2"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "leaf", "bs", "leaf"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "alt1", "r", "alt1"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "alt2", "alt1", "alt2"));

    const ids: string[] = [];
    for await (const entry of new ContextIterator({
      db: env.SESSIONS_DB,
      sessionId: sid,
      leafId: "leaf",
    })) {
      ids.push(entry.id);
    }

    expect(ids).toEqual(["leaf", "bs", "alt2", "alt1", "r"]);
  });

  it("stops safely when a jump would loop", async () => {
    const sid = "ctx-it-loop";
    await insertSession(env.SESSIONS_DB, sessionRow(sid));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "r", null, "root"));
    await insertEntry(env.SESSIONS_DB, branchSummaryRow(sid, "bs", "r", "bs"));
    await insertEntry(env.SESSIONS_DB, messageRow(sid, "leaf", "bs", "leaf"));

    const ids: string[] = [];
    for await (const entry of new ContextIterator({
      db: env.SESSIONS_DB,
      sessionId: sid,
      leafId: "leaf",
    })) {
      ids.push(entry.id);
    }

    expect(ids).toEqual(["leaf", "bs"]);
  });
});
