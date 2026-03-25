/**
 * Integration tests for PiccoloCore WorkerEntrypoint (step 9).
 *
 * PiccoloCore is instantiated directly with `new PiccoloCore(ctx, env)` — the
 * same pattern used throughout @cloudflare/vitest-pool-workers integration tests.
 * The test env (from `cloudflare:test`) is the live Miniflare environment, so
 * AGENT_SESSION bindings point to real in-process DOs, and SESSIONS_DB is a
 * real in-memory D1 instance.
 *
 * Note on stream draining: Miniflare's in-process JSRPC cannot reliably stream
 * ReadableStream<AgentEvent> across the Worker→DO boundary in tests. In production,
 * real Workers JSRPC handles this correctly. For tests, prompt turns are run via
 * runInDurableObject() which gives direct DO access (no JSRPC boundary).
 *
 * Spec refs:
 *   specs/api.md §1 IPiccoloCore
 *   specs/api.md §2 ISession
 *   specs/core.md §IPiccoloCore WorkerEntrypoint
 */

import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { AgentSessionDO } from "../../src/agent-session-do.ts";
import { PiccoloCore } from "../../src/piccolo-core.ts";
import type { ISession } from "../../src/types.ts";
import { setupTestDb } from "../mocks/d1.ts";
import { createMockModel } from "./mock-model.ts";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a PiccoloCore instance backed by the Miniflare test env. */
function makeCore(): PiccoloCore {
  return new PiccoloCore(createExecutionContext(), env);
}

let _counter = 0;
function uniqueUserId(): string {
  _counter += 1;
  return `user-${_counter.toString().padStart(4, "0")}`;
}

/**
 * Run a full prompt turn inside the DO via runInDurableObject.
 *
 * Miniflare's in-process JSRPC cannot reliably stream ReadableStream<AgentEvent>
 * across the Worker→DO boundary. In production real Workers JSRPC handles this.
 * Tests use this helper to drive prompts at the DO level directly.
 */
async function runPromptViaDoInstance(
  session: ISession,
  text: string,
  mockResponse: string,
): Promise<void> {
  const sessionId = await session.id();
  const stub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sessionId));
  await runInDurableObject(stub, async (instance: AgentSessionDO) => {
    instance._setModelForTest(createMockModel({ response: mockResponse }));
    const stream = await instance.prompt(text);
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await instance.waitForFlush();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PiccoloCore — newSession()", () => {
  it("returns a session with a valid UUID id", async () => {
    const core = makeCore();
    const session = await core.newSession(uniqueUserId());
    const id = await session.id();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("session.info() returns the correct userId", async () => {
    // userId is a readonly field; use info() to retrieve it via JSRPC.
    const core = makeCore();
    const userId = uniqueUserId();
    const session = await core.newSession(userId);
    const info = await session.info();
    expect(info.userId).toBe(userId);
  });

  it("two calls produce different session ids", async () => {
    const core = makeCore();
    const uid = uniqueUserId();
    const a = await core.newSession(uid);
    const b = await core.newSession(uid);
    expect(await a.id()).not.toBe(await b.id());
  });

  it("accepts NewSessionOptions (name, modelId)", async () => {
    const core = makeCore();
    const session = await core.newSession(uniqueUserId(), {
      name: "My test session",
      modelId: "openai/gpt-4o-mini",
    });
    expect(await session.id()).toMatch(/^[0-9a-f-]{36}$/);
    const model = await session.getModel();
    expect(model).toBe("openai/gpt-4o-mini");
  });
});

describe("PiccoloCore — getSession()", () => {
  it("returns a session stub with the given sessionId", async () => {
    const core = makeCore();
    const created = await core.newSession(uniqueUserId());
    const createdId = await created.id();

    const retrieved = await core.getSession(createdId);
    expect(await retrieved.id()).toBe(createdId);
  });

  it("session.info() returns the correct userId after a prompt", async () => {
    const core = makeCore();
    const userId = uniqueUserId();
    const session = await core.newSession(userId);
    await runPromptViaDoInstance(session, "hi", "hello");

    const retrieved = await core.getSession(await session.id());
    const info = await retrieved.info();
    expect(info.userId).toBe(userId);
  });
});

describe("PiccoloCore — prompt turn (via DO instance)", () => {
  it("prompt commits the session to D1 and info() reflects it", async () => {
    const core = makeCore();
    const userId = uniqueUserId();
    const session = await core.newSession(userId, { name: "Test" });
    await runPromptViaDoInstance(session, "hi", "response");

    const info = await session.info();
    expect(info.userId).toBe(userId);
    expect(info.name).toBe("Test");
    expect(info.createdAt).toBeGreaterThan(0);
  });
});

describe("PiccoloCore — listSessions()", () => {
  it("returns empty list for user with no committed sessions", async () => {
    const core = makeCore();
    const sessions = await core.listSessions(uniqueUserId());
    expect(sessions).toHaveLength(0);
  });

  it("returns ISession after first prompt commits it to D1", async () => {
    const core = makeCore();
    const userId = uniqueUserId();
    const session = await core.newSession(userId);
    await runPromptViaDoInstance(session, "hello", "response");

    const list = await core.listSessions(userId);
    expect(list).toHaveLength(1);
    // listSessions returns ISession[] — call info() for metadata
    const listedInfo = await list[0]?.info();
    expect(listedInfo?.userId).toBe(userId);
    expect(listedInfo?.id).toBe(await session.id());
  });

  it("does not list sessions for other users", async () => {
    const core = makeCore();
    const uid1 = uniqueUserId();
    const uid2 = uniqueUserId();

    const s1 = await core.newSession(uid1);
    await runPromptViaDoInstance(s1, "hi", "r1");

    const list = await core.listSessions(uid2);
    expect(list).toHaveLength(0);
  });
});

describe("PiccoloCore — listModels()", () => {
  it("returns a non-empty list of model ID strings", async () => {
    const core = makeCore();
    const models = await core.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => typeof m === "string")).toBe(true);
    expect(models[0]).toContain("/");
  });
});

describe("PiccoloCore — ISession methods via returned stub", () => {
  it("getModel() returns the model ID set via NewSessionOptions", async () => {
    const core = makeCore();
    const session = await core.newSession(uniqueUserId(), { modelId: "openai/gpt-4o" });
    const model = await session.getModel();
    expect(model).toBe("openai/gpt-4o");
  });

  it("getContextUsage() returns valid ContextUsage shape", async () => {
    const core = makeCore();
    const session = await core.newSession(uniqueUserId());
    const usage = await session.getContextUsage();
    expect(typeof usage.inputTokens).toBe("number");
    expect(typeof usage.contextWindowTokens).toBe("number");
    expect(typeof usage.usedFraction).toBe("number");
    expect(usage.contextWindowTokens).toBeGreaterThan(0);
  });

  it("getName() returns undefined before setName()", async () => {
    const core = makeCore();
    const session = await core.newSession(uniqueUserId());
    expect(await session.getName()).toBeUndefined();
  });

  it("setName() / getName() round-trips correctly", async () => {
    const core = makeCore();
    const session = await core.newSession(uniqueUserId());
    await session.setName("My Session");
    expect(await session.getName()).toBe("My Session");
  });
});

describe("PiccoloCore — fork()", () => {
  it("fork() returns a new ISession with a different id", async () => {
    const core = makeCore();
    const userId = uniqueUserId();
    const original = await core.newSession(userId);
    await runPromptViaDoInstance(original, "hello", "first response");

    const forked = await original.fork();
    const forkedId = await forked.id();
    expect(forkedId).not.toBe(await original.id());
    expect(forkedId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
