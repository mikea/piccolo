/**
 * Tests for the session persistence layer.
 *
 * All tests run against a real Miniflare D1 instance (via setupTestDb).
 * Each test gets a clean, fully-migrated database via the beforeEach hook.
 *
 * Spec ref: specs/core.md §Persistence, §Fork Session, §Session Listing
 */

import { env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { AnyEntry } from "../../src/db/entry-types.ts";
import { getEntries, getSession } from "../../src/db/schema.ts";
import {
  appendEntry,
  commitSession,
  createSession,
  deleteSession,
  flushPendingEntries,
  forkSession,
  listSessions,
} from "../../src/session/persistence.ts";
import { setupTestDb } from "../mocks/d1.ts";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function entryId(): string {
  _seq += 1;
  return _seq.toString(16).padStart(8, "0");
}

function ts(offset = 0): string {
  return new Date(1_700_000_000_000 + offset * 1000).toISOString();
}

function makeMessageEntry(
  id: string,
  sessionId: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  offset = 0,
): AnyEntry {
  return {
    id,
    sessionId,
    parentId,
    type: "message",
    timestamp: ts(offset),
    data: { role, content: text },
  };
}

function makeModelChangeEntry(
  id: string,
  sessionId: string,
  parentId: string | null,
  modelId: string,
): AnyEntry {
  return {
    id,
    sessionId,
    parentId,
    type: "model_change",
    timestamp: ts(),
    data: { modelId },
  };
}

async function seedSession(sessionId: string, userId = "user-1"): Promise<void> {
  await commitSession(
    sessionId,
    userId,
    { modelId: "anthropic/claude-sonnet-4-5" },
    env.SESSIONS_DB,
  );
}

// ─── createSession ────────────────────────────────────────────────────────────

describe("createSession", () => {
  it("returns a non-empty string", () => {
    const id = createSession();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("two calls return different IDs", () => {
    expect(createSession()).not.toBe(createSession());
  });

  it("does NOT write a D1 row", async () => {
    const id = createSession();
    const row = await getSession(env.SESSIONS_DB, id);
    expect(row).toBeNull();
  });
});

// ─── commitSession ────────────────────────────────────────────────────────────

describe("commitSession", () => {
  it("creates the sessions row with supplied options", async () => {
    const id = createSession();
    await commitSession(
      id,
      "user-1",
      { name: "Test", modelId: "openai/gpt-4o", cwd: "/tmp" },
      env.SESSIONS_DB,
    );
    const row = await getSession(env.SESSIONS_DB, id);
    expect(row).not.toBeNull();
    expect(row?.user_id).toBe("user-1");
    expect(row?.name).toBe("Test");
    expect(row?.model_id).toBe("openai/gpt-4o");
    expect(row?.cwd).toBe("/tmp");
    expect(row?.leaf_id).toBeNull();
  });

  it("uses DEFAULT_MODEL_ID when modelId is not supplied", async () => {
    const id = createSession();
    await commitSession(id, "user-1", {}, env.SESSIONS_DB);
    const row = await getSession(env.SESSIONS_DB, id);
    expect(row?.model_id).toBe("anthropic/claude-sonnet-4-5");
    expect(row?.name).toBe(id);
  });

  it("is idempotent — second call with same sessionId is a no-op", async () => {
    const id = createSession();
    await commitSession(id, "user-1", { name: "Original" }, env.SESSIONS_DB);
    await commitSession(id, "user-1", { name: "Updated" }, env.SESSIONS_DB);
    const row = await getSession(env.SESSIONS_DB, id);
    expect(row?.name).toBe("Original"); // second call was a no-op
  });
});

// ─── appendEntry ─────────────────────────────────────────────────────────────

describe("appendEntry", () => {
  it("inserts the entry row into D1", async () => {
    const sid = createSession();
    await seedSession(sid);
    const entry = makeMessageEntry("e1", sid, null, "user", "Hello", 0);
    await appendEntry(entry, env.SESSIONS_DB);
    const rows = await getEntries(env.SESSIONS_DB, sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("e1");
  });

  it("updates sessions.leaf_id to the inserted entry id", async () => {
    const sid = createSession();
    await seedSession(sid);
    const entry = makeMessageEntry("e2", sid, null, "user", "Hi", 0);
    await appendEntry(entry, env.SESSIONS_DB);
    const row = await getSession(env.SESSIONS_DB, sid);
    expect(row?.leaf_id).toBe("e2");
  });

  it("successive appends keep moving leaf_id forward", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry("ea1", sid, null, "user", "first", 0);
    const e2 = makeMessageEntry("ea2", sid, "ea1", "assistant", "second", 1);
    await appendEntry(e1, env.SESSIONS_DB);
    await appendEntry(e2, env.SESSIONS_DB);
    const row = await getSession(env.SESSIONS_DB, sid);
    expect(row?.leaf_id).toBe("ea2");
  });

  it("works for model_change entry type", async () => {
    const sid = createSession();
    await seedSession(sid);
    const entry = makeModelChangeEntry("mc1", sid, null, "openai/gpt-4o");
    await appendEntry(entry, env.SESSIONS_DB);
    const rows = await getEntries(env.SESSIONS_DB, sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("model_change");
  });
});

// ─── flushPendingEntries ──────────────────────────────────────────────────────

describe("flushPendingEntries", () => {
  it("inserts all entries and updates leaf_id", async () => {
    const sid = createSession();
    await seedSession(sid);
    const entries: AnyEntry[] = [
      makeMessageEntry("f1", sid, null, "user", "one", 0),
      makeMessageEntry("f2", sid, "f1", "assistant", "two", 1),
      makeMessageEntry("f3", sid, "f2", "user", "three", 2),
    ];
    await flushPendingEntries(entries, sid, "f3", env.SESSIONS_DB);

    const rows = await getEntries(env.SESSIONS_DB, sid);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id).sort()).toEqual(["f1", "f2", "f3"].sort());

    const session = await getSession(env.SESSIONS_DB, sid);
    expect(session?.leaf_id).toBe("f3");
  });

  it("is a no-op for an empty entries array", async () => {
    const sid = createSession();
    await seedSession(sid);
    await expect(
      flushPendingEntries([], sid, "irrelevant", env.SESSIONS_DB),
    ).resolves.toBeUndefined();
    const rows = await getEntries(env.SESSIONS_DB, sid);
    expect(rows).toHaveLength(0);
  });
});

// ─── listSessions ─────────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("returns empty array when user has no sessions", async () => {
    const result = await listSessions("no-such-user", env.SESSIONS_DB);
    expect(result).toHaveLength(0);
  });

  it("returns sessions ordered by updatedAt DESC", async () => {
    // Use unique user to isolate from other tests
    const uid = "ls-ordering";
    const s1 = createSession();
    const s2 = createSession();
    const s3 = createSession();
    // commitSession sets updated_at = now; batch quickly enough they might be equal,
    // so we append entries with different timestamps to force ordering via leaf update.
    await commitSession(s1, uid, {}, env.SESSIONS_DB);
    await commitSession(s2, uid, {}, env.SESSIONS_DB);
    await commitSession(s3, uid, {}, env.SESSIONS_DB);
    // Append entries to bump updated_at in a known order
    await appendEntry(makeMessageEntry(entryId(), s1, null, "user", "hi", 0), env.SESSIONS_DB);
    await appendEntry(makeMessageEntry(entryId(), s3, null, "user", "hi", 0), env.SESSIONS_DB);
    await appendEntry(makeMessageEntry(entryId(), s2, null, "user", "hi", 0), env.SESSIONS_DB);

    const results = await listSessions(uid, env.SESSIONS_DB);
    // s2 was updated last
    expect(results[0]?.id).toBe(s2);
  });

  it("populates messageCount correctly", async () => {
    const uid = "ls-count";
    const sid = createSession();
    await commitSession(sid, uid, {}, env.SESSIONS_DB);
    await appendEntry(makeMessageEntry(entryId(), sid, null, "user", "one", 0), env.SESSIONS_DB);
    await appendEntry(
      makeMessageEntry(entryId(), sid, null, "assistant", "two", 1),
      env.SESSIONS_DB,
    );
    // model_change should NOT count
    await appendEntry(makeModelChangeEntry(entryId(), sid, null, "openai/gpt-4o"), env.SESSIONS_DB);

    const results = await listSessions(uid, env.SESSIONS_DB);
    const s = results.find((r) => r.id === sid);
    expect(s?.messageCount).toBe(2);
  });

  it("truncates firstMessage to 100 chars", async () => {
    const uid = "ls-truncate";
    const sid = createSession();
    await commitSession(sid, uid, {}, env.SESSIONS_DB);
    const longText = "x".repeat(200);
    await appendEntry(makeMessageEntry(entryId(), sid, null, "user", longText, 0), env.SESSIONS_DB);

    const results = await listSessions(uid, env.SESSIONS_DB);
    const s = results.find((r) => r.id === sid);
    expect(s?.firstMessage.length).toBe(100);
  });

  it("firstMessage is empty string when no messages exist", async () => {
    const uid = "ls-nomsg";
    const sid = createSession();
    await commitSession(sid, uid, {}, env.SESSIONS_DB);

    const results = await listSessions(uid, env.SESSIONS_DB);
    const s = results.find((r) => r.id === sid);
    expect(s?.firstMessage).toBe("");
    expect(s?.name).toBe(sid);
  });

  it("does not include sessions from other users", async () => {
    const uid = "ls-myuser";
    const sid = createSession();
    await commitSession(sid, uid, {}, env.SESSIONS_DB);
    const results = await listSessions("other-user", env.SESSIONS_DB);
    expect(results.every((r) => r.id !== sid)).toBe(true);
  });

  it("maps optional name and cwd fields correctly", async () => {
    const uid = "ls-opts";
    const sid = createSession();
    await commitSession(sid, uid, { name: "My Session", cwd: "/home/user" }, env.SESSIONS_DB);
    const results = await listSessions(uid, env.SESSIONS_DB);
    const s = results.find((r) => r.id === sid);
    expect(s?.name).toBe("My Session");
    expect(s?.cwd).toBe("/home/user");
  });
});

// ─── deleteSession ────────────────────────────────────────────────────────────

describe("deleteSession", () => {
  it("removes the session row from D1", async () => {
    const sid = createSession();
    await seedSession(sid);
    await deleteSession(sid, env.SESSIONS_DB);
    const row = await getSession(env.SESSIONS_DB, sid);
    expect(row).toBeNull();
  });

  it("cascades to all entry rows", async () => {
    const sid = createSession();
    await seedSession(sid);
    await appendEntry(makeMessageEntry(entryId(), sid, null, "user", "hi"), env.SESSIONS_DB);
    await appendEntry(
      makeMessageEntry(entryId(), sid, null, "assistant", "hello"),
      env.SESSIONS_DB,
    );
    await deleteSession(sid, env.SESSIONS_DB);
    const rows = await getEntries(env.SESSIONS_DB, sid);
    expect(rows).toHaveLength(0);
  });

  it("is a no-op for a non-existent session ID", async () => {
    await expect(deleteSession("does-not-exist", env.SESSIONS_DB)).resolves.toBeUndefined();
  });
});

// ─── forkSession ─────────────────────────────────────────────────────────────

describe("forkSession", () => {
  it("returns a different sessionId from the original", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "hi", 0);
    await appendEntry(e1, env.SESSIONS_DB);

    const newSid = await forkSession(
      sid,
      undefined,
      e1.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    expect(newSid).not.toBe(sid);
    const newSession = await getSession(env.SESSIONS_DB, newSid);
    expect(newSession?.name).toBe(newSid);
  });

  it("new session has the same number of entries as the forked path", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "one", 0);
    const e2 = makeMessageEntry(entryId(), sid, e1.id, "assistant", "two", 1);
    const e3 = makeMessageEntry(entryId(), sid, e2.id, "user", "three", 2);
    await flushPendingEntries([e1, e2, e3], sid, e3.id, env.SESSIONS_DB);

    const newSid = await forkSession(
      sid,
      undefined,
      e3.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    const newRows = await getEntries(env.SESSIONS_DB, newSid);
    expect(newRows).toHaveLength(3);
  });

  it("new entry IDs are different from original IDs", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "hi", 0);
    const e2 = makeMessageEntry(entryId(), sid, e1.id, "assistant", "hello", 1);
    await flushPendingEntries([e1, e2], sid, e2.id, env.SESSIONS_DB);

    const newSid = await forkSession(
      sid,
      undefined,
      e2.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    const newRows = await getEntries(env.SESSIONS_DB, newSid);
    const newIds = new Set(newRows.map((r) => r.id));
    expect(newIds.has(e1.id)).toBe(false);
    expect(newIds.has(e2.id)).toBe(false);
  });

  it("parentId links in the new session point to new IDs, not original IDs", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "root", 0);
    const e2 = makeMessageEntry(entryId(), sid, e1.id, "assistant", "reply", 1);
    const e3 = makeMessageEntry(entryId(), sid, e2.id, "user", "follow", 2);
    await flushPendingEntries([e1, e2, e3], sid, e3.id, env.SESSIONS_DB);

    const newSid = await forkSession(
      sid,
      undefined,
      e3.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    const newRows = await getEntries(env.SESSIONS_DB, newSid);
    const newIds = new Set(newRows.map((r) => r.id));

    // Every non-null parent_id in the new session must be a new ID
    for (const row of newRows) {
      if (row.parent_id !== null) {
        expect(newIds.has(row.parent_id)).toBe(true);
        // And must NOT be an original entry ID
        expect(row.parent_id).not.toBe(e1.id);
        expect(row.parent_id).not.toBe(e2.id);
        expect(row.parent_id).not.toBe(e3.id);
      }
    }
  });

  it("forking at a mid-point includes only the path from root to that entry", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "root", 0);
    const e2 = makeMessageEntry(entryId(), sid, e1.id, "assistant", "mid", 1);
    const e3 = makeMessageEntry(entryId(), sid, e2.id, "user", "tail", 2);
    await flushPendingEntries([e1, e2, e3], sid, e3.id, env.SESSIONS_DB);

    // Fork from e2, not the leaf e3
    const newSid = await forkSession(
      sid,
      e2.id,
      e3.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    const newRows = await getEntries(env.SESSIONS_DB, newSid);
    // Should only contain e1 and e2 (path from root to e2)
    expect(newRows).toHaveLength(2);
  });

  it("forking an empty session returns a new session with no entries", async () => {
    const sid = createSession();
    await seedSession(sid);
    const newSid = await forkSession(
      sid,
      undefined,
      null,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    expect(newSid).not.toBe(sid);
    const newRows = await getEntries(env.SESSIONS_DB, newSid);
    expect(newRows).toHaveLength(0);
  });

  it("original session is unmodified after fork", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "hi", 0);
    await appendEntry(e1, env.SESSIONS_DB);

    await forkSession(
      sid,
      undefined,
      e1.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );

    const origRows = await getEntries(env.SESSIONS_DB, sid);
    expect(origRows).toHaveLength(1);
    expect(origRows[0]?.id).toBe(e1.id);
  });

  it("new session leaf_id is set to the last forked entry", async () => {
    const sid = createSession();
    await seedSession(sid);
    const e1 = makeMessageEntry(entryId(), sid, null, "user", "hi", 0);
    const e2 = makeMessageEntry(entryId(), sid, e1.id, "assistant", "hello", 1);
    await flushPendingEntries([e1, e2], sid, e2.id, env.SESSIONS_DB);

    const newSid = await forkSession(
      sid,
      undefined,
      e2.id,
      "user-1",
      "anthropic/claude-sonnet-4-5",
      env.SESSIONS_DB,
    );
    const newSession = await getSession(env.SESSIONS_DB, newSid);
    expect(newSession?.leaf_id).not.toBeNull();
  });
});
