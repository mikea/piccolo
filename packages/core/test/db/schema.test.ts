import { env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { DbEntryRow } from "../../src/db/entry-types.ts";
import {
  deleteSession,
  getEntries,
  getPathEntriesBackward,
  getSession,
  insertEntries,
  insertEntry,
  insertSession,
  listSessionsByUser,
  type SessionRow,
  updateSessionLeaf,
  upsertSession,
} from "../../src/db/schema.ts";
import { setupTestDb } from "../mocks/d1.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-001",
    user_id: "user-abc",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    name: null,
    model_id: "anthropic/claude-sonnet-4-5",
    leaf_id: null,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<DbEntryRow> = {}): DbEntryRow {
  return {
    id: "a1b2c3d4",
    session_id: "session-001",
    parent_id: null,
    type: "session_info",
    timestamp: "2024-01-01T00:00:00.000Z",
    data: JSON.stringify({ name: "Test" }),
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

// ─── insertSession / getSession ───────────────────────────────────────────────

describe("insertSession + getSession", () => {
  it("round-trips all fields including nulls", async () => {
    const session = makeSession({
      id: "s1",
      name: null,
      leaf_id: null,
    });
    await insertSession(env.SESSIONS_DB, session);
    const row = await getSession(env.SESSIONS_DB, "s1");
    expect(row).toEqual(session);
  });

  it("round-trips with non-null optional fields", async () => {
    const session = makeSession({
      id: "s2",
      name: "My Session",
      leaf_id: "a1b2c3d4",
    });
    await insertSession(env.SESSIONS_DB, session);
    const row = await getSession(env.SESSIONS_DB, "s2");
    expect(row).toEqual(session);
  });

  it("returns null for a non-existent session ID", async () => {
    const row = await getSession(env.SESSIONS_DB, "does-not-exist");
    expect(row).toBeNull();
  });
});

// ─── upsertSession ────────────────────────────────────────────────────────────

describe("upsertSession", () => {
  it("inserts on first call", async () => {
    const session = makeSession({ id: "u1" });
    await upsertSession(env.SESSIONS_DB, session);
    const row = await getSession(env.SESSIONS_DB, "u1");
    expect(row).toEqual(session);
  });

  it("is a no-op on second call with same ID — original row unchanged", async () => {
    const session = makeSession({ id: "u2", name: "Original" });
    await upsertSession(env.SESSIONS_DB, session);

    const updated = makeSession({ id: "u2", name: "Updated", updated_at: 9_999_999_999_999 });
    await upsertSession(env.SESSIONS_DB, updated);

    const row = await getSession(env.SESSIONS_DB, "u2");
    expect(row?.name).toBe("Original"); // second upsert was a no-op
  });
});

// ─── updateSessionLeaf ────────────────────────────────────────────────────────

describe("updateSessionLeaf", () => {
  it("updates leaf_id and updated_at, leaving other fields unchanged", async () => {
    const session = makeSession({ id: "l1", name: "Persist Me" });
    await insertSession(env.SESSIONS_DB, session);

    await updateSessionLeaf(env.SESSIONS_DB, "l1", "newleaf1", 1_800_000_000_000);

    const row = await getSession(env.SESSIONS_DB, "l1");
    expect(row?.leaf_id).toBe("newleaf1");
    expect(row?.updated_at).toBe(1_800_000_000_000);
    expect(row?.name).toBe("Persist Me"); // unchanged
    expect(row?.model_id).toBe("anthropic/claude-sonnet-4-5"); // unchanged
  });
});

// ─── listSessionsByUser ───────────────────────────────────────────────────────

describe("listSessionsByUser", () => {
  it("returns empty array when user has no sessions", async () => {
    const rows = await listSessionsByUser(env.SESSIONS_DB, "no-such-user");
    expect(rows).toHaveLength(0);
  });

  it("returns sessions ordered by updated_at DESC", async () => {
    // Use a unique user_id to isolate from sessions created by other tests
    // (D1 state is shared within a test file run).
    const uid = "ordering-user";
    await insertSession(
      env.SESSIONS_DB,
      makeSession({ id: "ord-a", user_id: uid, updated_at: 1000 }),
    );
    await insertSession(
      env.SESSIONS_DB,
      makeSession({ id: "ord-b", user_id: uid, updated_at: 3000 }),
    );
    await insertSession(
      env.SESSIONS_DB,
      makeSession({ id: "ord-c", user_id: uid, updated_at: 2000 }),
    );

    const rows = await listSessionsByUser(env.SESSIONS_DB, uid);
    expect(rows.map((r) => r.id)).toEqual(["ord-b", "ord-c", "ord-a"]);
  });

  it("message_count = 0 for a session with no entries", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "mc-empty" }));
    const rows = await listSessionsByUser(env.SESSIONS_DB, "user-abc");
    const row = rows.find((r) => r.id === "mc-empty");
    expect(row?.message_count).toBe(0);
  });

  it("message_count reflects only 'message' type entries", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "mc-mixed" }));
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({
        id: "e1",
        session_id: "mc-mixed",
        type: "message",
        data: JSON.stringify({ role: "user", content: "hi" }),
        timestamp: "2024-01-01T00:00:00.000Z",
      }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({
        id: "e2",
        session_id: "mc-mixed",
        type: "message",
        data: JSON.stringify({ role: "assistant", content: "hello" }),
        timestamp: "2024-01-01T00:00:01.000Z",
      }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({
        id: "e3",
        session_id: "mc-mixed",
        type: "model_change",
        data: JSON.stringify({ modelId: "m" }),
        timestamp: "2024-01-01T00:00:02.000Z",
      }),
    );
    const rows = await listSessionsByUser(env.SESSIONS_DB, "user-abc");
    const row = rows.find((r) => r.id === "mc-mixed");
    expect(row?.message_count).toBe(2); // only 'message' type entries counted
  });

  it("first_message is the content of the first user-role message", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "fm-1" }));
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({
        id: "fm-e1",
        session_id: "fm-1",
        type: "message",
        data: JSON.stringify({ role: "user", content: "First question" }),
        timestamp: "2024-01-01T00:00:00.000Z",
      }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({
        id: "fm-e2",
        session_id: "fm-1",
        type: "message",
        data: JSON.stringify({ role: "assistant", content: "First answer" }),
        timestamp: "2024-01-01T00:00:01.000Z",
      }),
    );

    const rows = await listSessionsByUser(env.SESSIONS_DB, "user-abc");
    const row = rows.find((r) => r.id === "fm-1");
    expect(row?.first_message).toBe("First question");
  });

  it("first_message is null when session has no message entries", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "fm-none" }));
    const rows = await listSessionsByUser(env.SESSIONS_DB, "user-abc");
    const row = rows.find((r) => r.id === "fm-none");
    expect(row?.first_message).toBeNull();
  });

  it("does not return sessions belonging to a different user", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "other-s", user_id: "other-user" }));
    const rows = await listSessionsByUser(env.SESSIONS_DB, "user-abc");
    expect(rows.every((r) => r.user_id === "user-abc")).toBe(true);
  });
});

// ─── deleteSession ────────────────────────────────────────────────────────────

describe("deleteSession", () => {
  it("removes the session row", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "del-s1" }));
    await deleteSession(env.SESSIONS_DB, "del-s1");
    const row = await getSession(env.SESSIONS_DB, "del-s1");
    expect(row).toBeNull();
  });

  it("cascades to entries — getEntries returns empty after delete", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "del-s2" }));
    await insertEntry(env.SESSIONS_DB, makeEntry({ id: "del-e1", session_id: "del-s2" }));
    await deleteSession(env.SESSIONS_DB, "del-s2");
    const entries = await getEntries(env.SESSIONS_DB, "del-s2");
    expect(entries).toHaveLength(0);
  });
});

// ─── insertEntry / getEntries ─────────────────────────────────────────────────

describe("insertEntry + getEntries", () => {
  it("single entry round-trip — all fields preserved", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "ie-s1" }));
    const entry = makeEntry({
      id: "ie-e1",
      session_id: "ie-s1",
      parent_id: null,
      type: "session_info",
      timestamp: "2024-06-01T12:00:00.000Z",
      data: JSON.stringify({ name: "Hello" }),
    });
    await insertEntry(env.SESSIONS_DB, entry);
    const rows = await getEntries(env.SESSIONS_DB, "ie-s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ...entry,
      append_seq: expect.any(Number),
    });
  });

  it("data JSON string is preserved exactly", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "ie-s2" }));
    const data = { role: "user", content: "hello", nested: { x: [1, 2, 3] } };
    const entry = makeEntry({
      id: "ie-e2",
      session_id: "ie-s2",
      data: JSON.stringify(data),
    });
    await insertEntry(env.SESSIONS_DB, entry);
    const rows = await getEntries(env.SESSIONS_DB, "ie-s2");
    expect(JSON.parse(rows[0]?.data ?? "{}")).toEqual(data);
  });

  it("entries are returned in append order", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "ie-s3" }));
    const timestamps = [
      "2024-01-03T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
      "2024-01-02T00:00:00.000Z",
    ];
    // Insert out of order
    for (const [i, ts] of timestamps.entries()) {
      await insertEntry(
        env.SESSIONS_DB,
        makeEntry({ id: `ie-ts${i}`, session_id: "ie-s3", timestamp: ts }),
      );
    }
    const rows = await getEntries(env.SESSIONS_DB, "ie-s3");
    expect(rows.map((r) => r.id)).toEqual(["ie-ts0", "ie-ts1", "ie-ts2"]);
    expect(rows.map((r) => r.append_seq)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it("getEntries returns empty array for unknown session", async () => {
    const rows = await getEntries(env.SESSIONS_DB, "no-such-session");
    expect(rows).toHaveLength(0);
  });
});

describe("getPathEntriesBackward", () => {
  it("returns path rows from leaf to root in append-desc order", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "path-s1" }));
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({ id: "p1", session_id: "path-s1", parent_id: null }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({ id: "p2", session_id: "path-s1", parent_id: "p1" }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      makeEntry({ id: "p3", session_id: "path-s1", parent_id: "p2" }),
    );

    const rows = await getPathEntriesBackward(env.SESSIONS_DB, "path-s1", "p3", 10);
    expect(rows.map((r) => r.id)).toEqual(["p3", "p2", "p1"]);
  });
});

// ─── insertEntries (batch) ────────────────────────────────────────────────────

describe("insertEntries (batch)", () => {
  it("inserts all rows atomically and they are all present", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "batch-s1" }));
    const entries: DbEntryRow[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        id: `batch-e${i}`,
        session_id: "batch-s1",
        timestamp: `2024-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
    await insertEntries(env.SESSIONS_DB, entries);
    const rows = await getEntries(env.SESSIONS_DB, "batch-s1");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.id).sort()).toEqual(entries.map((e) => e.id).sort());
  });

  it("is a no-op for an empty array", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "batch-empty" }));
    await expect(insertEntries(env.SESSIONS_DB, [])).resolves.toBeUndefined();
    const rows = await getEntries(env.SESSIONS_DB, "batch-empty");
    expect(rows).toHaveLength(0);
  });
});

// ─── json_valid CHECK constraint ─────────────────────────────────────────────

describe("entries.data CHECK (json_valid)", () => {
  it("rejects a non-JSON string for data", async () => {
    await insertSession(env.SESSIONS_DB, makeSession({ id: "json-s1" }));
    await expect(
      insertEntry(
        env.SESSIONS_DB,
        makeEntry({ id: "json-e1", session_id: "json-s1", data: "not valid json" }),
      ),
    ).rejects.toThrow();
  });
});
