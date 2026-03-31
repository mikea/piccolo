import { env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { DbEntryRow } from "../../src/db/entry-types.ts";
import { insertEntry, insertSession, type SessionRow } from "../../src/db/schema.ts";
import { buildSessionContextFromDb } from "../../src/session/context.ts";
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

function row(
  sessionId: string,
  id: string,
  parentId: string | null,
  type: string,
  data: unknown,
): DbEntryRow {
  return {
    id,
    session_id: sessionId,
    parent_id: parentId,
    type,
    timestamp: new Date().toISOString(),
    data: JSON.stringify(data),
  };
}

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

describe("buildSessionContextFromDb", () => {
  it("stops at firstKeptEntryId after seeing compaction", async () => {
    const sid = "ctx-db-comp";
    await insertSession(env.SESSIONS_DB, sessionRow(sid));
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "u1", null, "message", { role: "user", content: "old", id: "u1" }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "u2", "u1", "message", { role: "user", content: "keep", id: "u2" }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "comp", "u2", "compaction", {
        summary: "summary",
        firstKeptEntryId: "u2",
        tokensBefore: 1,
      }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "a1", "comp", "message", { role: "assistant", content: "new", id: "a1" }),
    );

    const ctx = await buildSessionContextFromDb({
      db: env.SESSIONS_DB,
      sessionId: sid,
      leafId: "a1",
    });

    expect(ctx.messages.map((m) => m.id)).toEqual(["comp", "u2", "a1"]);
  });

  it("respects context token limit until compaction is encountered", async () => {
    const sid = "ctx-db-limit";
    await insertSession(env.SESSIONS_DB, sessionRow(sid));
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "m1", null, "message", { role: "user", content: "a".repeat(200), id: "m1" }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "m2", "m1", "message", { role: "assistant", content: "b".repeat(200), id: "m2" }),
    );
    await insertEntry(
      env.SESSIONS_DB,
      row(sid, "m3", "m2", "message", { role: "user", content: "short", id: "m3" }),
    );

    const ctx = await buildSessionContextFromDb({
      db: env.SESSIONS_DB,
      sessionId: sid,
      leafId: "m3",
      contextTokenLimit: 20,
    });

    expect(ctx.messages.map((m) => m.id)).toEqual(["m3"]);
  });
});
