/**
 * Integration tests for PiccoloCore WorkerEntrypoint.
 *
 * Spec refs:
 *   specs/api.md §IPiccoloCore
 *   specs/api.md §IUser
 *   specs/api.md §ISession
 *   specs/core.md §IPiccoloCore WorkerEntrypoint
 */

import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { AgentSessionDO } from "../../src/agent-session-do.ts";
import { PiccoloCore } from "../../src/piccolo-core.ts";
import type { ISession, IUser } from "../../src/types.ts";
import { setupTestDb } from "../mocks/d1.ts";
import { createMockModel } from "./mock-model.ts";

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

function makeCore(): PiccoloCore {
  return new PiccoloCore(createExecutionContext(), env);
}

let _counter = 0;
function uniqueUserId(): string {
  _counter += 1;
  return `user-${_counter.toString().padStart(4, "0")}`;
}

function makeUser(userId?: string): IUser {
  return makeCore().getUser(userId ?? uniqueUserId());
}

async function runPromptViaDoInstance(
  session: ISession,
  text: string,
  mockResponse: string,
): Promise<void> {
  const sessionId = await session.sessionId();
  const stub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sessionId));
  await runInDurableObject(stub, async (instance: AgentSessionDO) => {
    instance._setModelForTest(createMockModel({ response: mockResponse }));
    const turn = await instance.prompt(text);
    const stream = await turn.getStream();
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    await instance.waitForFlush();
  });
}

describe("PiccoloCore — getUser()", () => {
  it("returns an IUser stub synchronously", () => {
    const core = makeCore();
    const user = core.getUser("user-1");
    expect(user).toBeDefined();
    expect(typeof user.newSession).toBe("function");
    expect(typeof user.listSessions).toBe("function");
    expect(typeof user.listModels).toBe("function");
  });
});

describe("IUser — newSession()", () => {
  it("returns a session with a valid UUID id", async () => {
    const user = makeUser();
    const session = await user.newSession();
    expect(await session.sessionId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two calls produce different session ids", async () => {
    const user = makeUser();
    const a = await user.newSession();
    const b = await user.newSession();
    expect(await a.sessionId()).not.toBe(await b.sessionId());
  });

  it("accepts NewSessionOptions (name, modelId)", async () => {
    const user = makeUser();
    const session = await user.newSession({
      name: "My test session",
      modelId: "openai/gpt-4o-mini",
    });
    expect(await session.sessionId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(await session.getModel()).toBe("openai/gpt-4o-mini");
  });
});

describe("IUser — getSession()", () => {
  it("returns the same session by id after it is committed", async () => {
    const user = makeUser();
    const created = await user.newSession();
    await runPromptViaDoInstance(created, "hi", "r");
    const createdId = await created.sessionId();
    const retrieved = await user.getSession(createdId);
    expect(await retrieved.sessionId()).toBe(createdId);
  });

  it("throws Forbidden for another user's session", async () => {
    const uid1 = uniqueUserId();
    const uid2 = uniqueUserId();
    const core = makeCore();
    const session = await core.getUser(uid1).newSession();
    await runPromptViaDoInstance(session, "hi", "r");
    const sid = await session.sessionId();
    await expect(core.getUser(uid2).getSession(sid)).rejects.toThrow("Forbidden");
  });

  it("retrieved session has same id after a prompt", async () => {
    const user = makeUser();
    const session = await user.newSession();
    await runPromptViaDoInstance(session, "hi", "hello");
    const retrieved = await user.getSession(await session.sessionId());
    expect(await retrieved.sessionId()).toBe(await session.sessionId());
  });
});

describe("IUser — listSessions()", () => {
  it("returns empty list for user with no committed sessions", async () => {
    const user = makeUser();
    expect(await user.listSessions()).toHaveLength(0);
  });

  it("returns ISession after first prompt commits it to D1", async () => {
    const user = makeUser();
    const session = await user.newSession();
    await runPromptViaDoInstance(session, "hello", "response");
    const list = await user.listSessions();
    expect(list).toHaveLength(1);
    expect(await list[0]?.sessionId()).toBe(await session.sessionId());
  });

  it("does not list sessions for other users", async () => {
    const core = makeCore();
    const user1 = core.getUser(uniqueUserId());
    const user2 = core.getUser(uniqueUserId());
    const s1 = await user1.newSession();
    await runPromptViaDoInstance(s1, "hi", "r1");
    expect(await user2.listSessions()).toHaveLength(0);
  });
});

describe("IUser — listModels()", () => {
  it("returns a non-empty list of model ID strings", async () => {
    const user = makeUser();
    const models = await user.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => typeof m === "string")).toBe(true);
    expect(models[0]).toContain("/");
  });
});

describe("IUser — ISession methods", () => {
  it("getModel() returns the model ID set via NewSessionOptions", async () => {
    const user = makeUser();
    const session = await user.newSession({ modelId: "openai/gpt-4o" });
    expect(await session.getModel()).toBe("openai/gpt-4o");
  });

  it("getContextUsage() returns valid ContextUsage shape", async () => {
    const user = makeUser();
    const session = await user.newSession();
    const usage = await session.getContextUsage();
    expect(typeof usage.inputTokens).toBe("number");
  });

  it("getName() defaults to sessionId before setName()", async () => {
    const user = makeUser();
    const session = await user.newSession();
    expect(await session.getName()).toBe(await session.sessionId());
  });

  it("setName() / getName() round-trips correctly", async () => {
    const user = makeUser();
    const session = await user.newSession();
    await session.setName("My Session");
    expect(await session.getName()).toBe("My Session");
  });

  it("prompt commits the session to D1 and getUpdatedAt() reflects it", async () => {
    const user = makeUser();
    const session = await user.newSession({ name: "Test" });
    await runPromptViaDoInstance(session, "hi", "response");
    expect(await session.getName()).toBe("Test");
    expect(await session.getUpdatedAt()).toBeGreaterThan(0);
  });
});

describe("IUser — fork()", () => {
  it("fork() returns a new sessionId different from the original", async () => {
    const user = makeUser();
    const original = await user.newSession();
    await runPromptViaDoInstance(original, "hello", "first response");
    const forkedId = await original.fork();
    expect(forkedId).not.toBe(await original.sessionId());
    expect(forkedId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
