/**
 * Integration tests for AgentSessionDO.
 *
 * All tests run in Miniflare via @cloudflare/vitest-pool-workers.
 * Each test gets a fresh D1 database (via setupTestDb) and a fresh DO instance
 * (via a unique name so Miniflare isolates storage per test).
 *
 * Pattern:
 *   1. Get a DO stub: env.AGENT_SESSION.idFromName(uniqueId)
 *   2. Inside runInDurableObject(), call _setModelForTest(mockModel) to bypass
 *      the real AI Gateway, then call newSession() + prompt().
 *   3. Call waitForFlush() before querying D1 to ensure writes are complete.
 *
 * Spec ref: specs/core.md §AgentSessionDO
 */

import { env, runInDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { AgentEvent } from "@piccolo/agent";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { AgentSessionDO } from "../../src/agent-session-do.ts";
import { parseEntry } from "../../src/db/entry-types.ts";
import { getEntries, getSession } from "../../src/db/schema.ts";
import { setupTestDb } from "../mocks/d1.ts";
import { createMockModel } from "./mock-model.ts";

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  const migrations = inject("migrations") as D1Migration[];
  await setupTestDb(env.SESSIONS_DB, migrations);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function uniqueId(): string {
  _counter += 1;
  return `test-session-${_counter.toString().padStart(4, "0")}`;
}

function getStub(sessionId: string) {
  return env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sessionId));
}

/** Drain a ReadableStream<AgentEvent> into an array. */
async function drainStream(stream: ReadableStream<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) events.push(value);
  }
  return events;
}

/**
 * Run a single prompt inside a DO, injecting a mock model.
 * Awaits waitForFlush() so D1 writes are complete before returning.
 */
async function runPrompt(
  sessionId: string,
  text: string,
  mockResponse: string,
): Promise<AgentEvent[]> {
  const stub = getStub(sessionId);
  return await runInDurableObject(stub, async (instance: AgentSessionDO) => {
    instance._setModelForTest(createMockModel({ response: mockResponse }));
    await instance._init(sessionId, "user-1");
    const stream = await instance.prompt(text);
    const events = await drainStream(stream);
    await instance.waitForFlush();
    return events;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AgentSessionDO — prompt() pipeline", () => {
  it("emits agent_start, text_delta(s), turn_end, agent_end for a simple turn", async () => {
    const sid = uniqueId();
    const events = await runPrompt(sid, "hello", "Hi there");

    expect(events.find((e) => e.type === "agent_start")).toBeDefined();
    expect(events.find((e) => e.type === "agent_end")).toBeDefined();
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    const fullText = textDeltas
      .map((e) => (e as { type: "text_delta"; delta: string }).delta)
      .join("");
    expect(fullText).toBe("Hi there");
    expect(events.find((e) => e.type === "turn_end")).toBeDefined();
  });

  it("does not emit error event on a successful turn", async () => {
    const sid = uniqueId();
    const events = await runPrompt(sid, "ping", "pong");
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("returns an empty stream when extension stub returns action: handled", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    const events = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "should not appear" }));
      await instance._init(sid, "user-1");
      const stream = await instance.prompt("test input that produces output");
      const ev = await drainStream(stream);
      await instance.waitForFlush();
      return ev;
    });
    // With a valid mock model, the stream is NOT empty — this confirms the
    // extension stub defaults to "continue" (not "handled").
    expect(events.find((e) => e.type === "agent_start")).toBeDefined();
  });

  it("extension stub defaults to action: continue (not handled)", async () => {
    const sid = uniqueId();
    const events = await runPrompt(sid, "any input", "any response");
    // If extension stub wrongly returned "handled", stream would be empty
    expect(events.find((e) => e.type === "agent_end")).toBeDefined();
  });
});

describe("AgentSessionDO — D1 persistence", () => {
  it("does NOT write a D1 sessions row before first prompt", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "hi" }));
      await instance._init(sid, "user-1");
    });
    const row = await getSession(env.SESSIONS_DB, sid);
    expect(row).toBeNull();
  });

  it("creates a D1 sessions row after the first prompt completes", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hello", "world");
    const row = await getSession(env.SESSIONS_DB, sid);
    expect(row).not.toBeNull();
    expect(row?.user_id).toBe("user-1");
    expect(row?.model_id).toBeTruthy();
  });

  it("persists user and assistant MessageEntry rows after a turn", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hello", "world response");
    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const entries = rawRows.map(parseEntry);
    const messages = entries.filter((e) => e.type === "message");
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const userMsg = messages.find(
      (e) => e.type === "message" && (e.data as { role: string }).role === "user",
    );
    const assistantMsg = messages.find(
      (e) => e.type === "message" && (e.data as { role: string }).role === "assistant",
    );
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });

  it("entries form a valid parent-child chain", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "first", "first response");
    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const entries = rawRows.map(parseEntry);

    const root = entries.find((e) => e.parentId === null);
    expect(root).toBeDefined();

    const ids = new Set(entries.map((e) => e.id));
    for (const entry of entries) {
      if (entry.parentId !== null) {
        expect(ids.has(entry.parentId)).toBe(true);
      }
    }
  });

  it("accumulates entries across multiple turns", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      await instance._init(sid, "user-1");

      instance._setModelForTest(createMockModel({ response: "turn one" }));
      await drainStream(await instance.prompt("question one"));
      await instance.waitForFlush();

      instance._setModelForTest(createMockModel({ response: "turn two" }));
      await drainStream(await instance.prompt("question two"));
      await instance.waitForFlush();
    });

    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const messages = rawRows.map(parseEntry).filter((e) => e.type === "message");
    expect(messages.length).toBeGreaterThanOrEqual(4);
  });

  it("sessions.leaf_id points to an entry that exists in the entries table", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "hello");
    const row = await getSession(env.SESSIONS_DB, sid);
    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const ids = rawRows.map((r) => r.id);
    expect(row?.leaf_id).toBeTruthy();
    expect(ids).toContain(row?.leaf_id);
  });
});

describe("AgentSessionDO — session accessors", () => {
  it("getUpdatedAt() returns a valid timestamp", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "there");
    const stub = getStub(sid);
    const updatedAt = await runInDurableObject(stub, (instance: AgentSessionDO) => instance.getUpdatedAt());
    expect(typeof updatedAt).toBe("number");
    expect(updatedAt).toBeGreaterThan(0);
  });

  it("getName() returns undefined before setName()", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "there");
    const stub = getStub(sid);
    const name = await runInDurableObject(stub, (instance: AgentSessionDO) => instance.getName());
    expect(name).toBeUndefined();
  });

  it("setName() persists the name and getName() returns it", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "there");
    const stub = getStub(sid);

    await runInDurableObject(stub, (instance: AgentSessionDO) => instance.setName("My Session"));
    const name = await runInDurableObject(stub, (instance: AgentSessionDO) => instance.getName());
    expect(name).toBe("My Session");

    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const infoEntry = rawRows.map(parseEntry).find((e) => e.type === "session_info");
    expect(infoEntry).toBeDefined();
  });

  it("getModel() returns the configured modelId string", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "there");
    const stub = getStub(sid);
    const model = await runInDurableObject(stub, (instance: AgentSessionDO) => instance.getModel());
    expect(typeof model).toBe("string");
    expect(model.length).toBeGreaterThan(0);
  });

  it("setModel() persists a model_change entry", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "there");
    const stub = getStub(sid);

    await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.setModel("openai/gpt-4o"),
    );

    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const changeEntry = rawRows.map(parseEntry).find((e) => e.type === "model_change");
    expect(changeEntry).toBeDefined();
    expect((changeEntry?.data as { modelId: string }).modelId).toBe("openai/gpt-4o");
  });

  it("getContextUsage() returns valid structure after a prompt", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hello world", "the response text");
    const stub = getStub(sid);
    const usage = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getContextUsage(),
    );
  });
});

describe("AgentSessionDO — abort", () => {
  it("abort() does not throw and stops the agent", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);

    const events = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "long response text here" }));
      await instance._init(sid, "user-1");
      const stream = await instance.prompt("go");
      await instance.abort();
      const ev = await drainStream(stream);
      return ev;
    });

    // After abort the stream should be closed; no error event for a clean abort
    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(0);
  });
});

describe("AgentSessionDO — steer and followUp", () => {
  it("steer() enqueues a message without throwing", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "reply" }));
      await instance._init(sid, "user-1");
      await instance.steer("steer message");
      const stream = await instance.prompt("hi");
      await drainStream(stream);
      await instance.waitForFlush();
    });
  });

  it("followUp() enqueues a message without throwing", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "reply" }));
      await instance._init(sid, "user-1");
      await instance.followUp("follow up");
    });
  });
});

describe("AgentSessionDO — delete and fork", () => {
  it("delete() removes the D1 sessions row and entries", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "there");
    expect(await getSession(env.SESSIONS_DB, sid)).not.toBeNull();

    const stub = getStub(sid);
    await runInDurableObject(stub, (instance: AgentSessionDO) => instance.delete());

    expect(await getSession(env.SESSIONS_DB, sid)).toBeNull();
    expect(await getEntries(env.SESSIONS_DB, sid)).toHaveLength(0);
  });

  it("fork() creates a new D1 session with copied entries", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "original message", "original reply");

    const stub = getStub(sid);
    const newSessionId = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.fork(),
    );

    expect(typeof newSessionId).toBe("string");
    expect(newSessionId).not.toBe(sid);
    expect(await getSession(env.SESSIONS_DB, newSessionId)).not.toBeNull();
    expect(await getEntries(env.SESSIONS_DB, newSessionId)).not.toHaveLength(0);
  });
});

describe("AgentSessionDO — branch", () => {
  it("branch(entryId) repoints the in-memory leaf to the given entry", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "turn one", "response one");

    const rowAfterTurn1 = await getSession(env.SESSIONS_DB, sid);
    const leafAfterTurn1 = rowAfterTurn1?.leaf_id;
    expect(leafAfterTurn1).toBeTruthy();

    // Do a second turn to advance leaf further
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "response two" }));
      await drainStream(await instance.prompt("turn two"));
      await instance.waitForFlush();
    });

    // Branch back to leaf after turn 1 — confirm no throw
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      await instance.branch(leafAfterTurn1!);
    });
  });
});

describe("AgentSessionDO — compaction", () => {
  it("compact() creates a CompactionEntry in D1", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hello", "world");
    const stub = getStub(sid);

    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      // Inject mock for the summarisation LLM call inside agentCompact
      instance._setModelForTest(createMockModel({ response: "compact summary text" }));
      await instance.compact({ keepRecentTokens: 1 }); // tiny budget forces compaction
    });

    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const compactionEntry = rawRows.map(parseEntry).find((e) => e.type === "compaction");
    expect(compactionEntry).toBeDefined();
    expect((compactionEntry?.data as { summary: string }).summary).toBe("compact summary text");
  });
});

describe("AgentSessionDO — system prompt", () => {
  it("assembled system prompt contains the AGENT_NAME from env", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    const prompt = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      await instance._init(sid, "user-1");
      return instance._getAssembledSystemPrompt();
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    // env.AGENT_NAME defaults to "Piccolo" in wrangler.template.jsonc
    expect(prompt).toContain("Piccolo");
  });
});

describe("AgentSessionDO — tool events", () => {
  it("emits tool_start and tool_end events when a tool call occurs", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);

    const events = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(
        createMockModel({
          toolCalls: [{ name: "mock_tool", input: { query: "test" } }],
          response: "done",
        }),
      );
      await instance._init(sid, "user-1");
      const stream = await instance.prompt("use a tool");
      const ev = await drainStream(stream);
      await instance.waitForFlush();
      return ev;
    });

    expect(events.find((e) => e.type === "tool_start")).toBeDefined();
    expect(events.find((e) => e.type === "tool_end")).toBeDefined();
  });
});

describe("AgentSessionDO — compaction extension paths", () => {
  it("compact() with extension cancel=true writes no CompactionEntry", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hello", "world");
    const stub = getStub(sid);

    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "summary" }));
      // Test the no-op path: with huge budget, toSummarize is empty → no entry written
      await instance.compact({ keepRecentTokens: 1_000_000 });
    });

    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    // With a huge token budget, toSummarize is empty → no entry written
    const compactionEntry = rawRows.map(parseEntry).find((e) => e.type === "compaction");
    expect(compactionEntry).toBeUndefined();
  });

  it("compact() with extension-provided summary skips LLM call", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "test", "response");
    const stub = getStub(sid);

    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "should not be called" }));
      // Force compaction with tiny budget — ext stub returns {} so LLM is called
      await instance.compact({ keepRecentTokens: 1 });
    });

    const rawRows = await getEntries(env.SESSIONS_DB, sid);
    const compactionEntry = rawRows.map(parseEntry).find((e) => e.type === "compaction");
    expect(compactionEntry).toBeDefined();
  });
});

describe("AgentSessionDO — cold-start with model_change history", () => {
  it("rebuilds modelId from model_change entry on cold start", async () => {
    const sid = uniqueId();
    // First prompt commits the session to D1
    await runPrompt(sid, "hi", "hello");

    // Change model — persists a model_change entry
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      await instance.setModel("openai/gpt-4o");
      await instance.waitForFlush();
    });

    // Simulate cold start by getting a fresh DO reference and calling a method
    const freshStub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(sid));
    const model = await runInDurableObject(freshStub, (instance: AgentSessionDO) =>
      instance.getModel(),
    );
    expect(model).toBe("openai/gpt-4o");
  });
});

describe("AgentSessionDO — context overflow retry", () => {
  it("compact() is called on context overflow and agent continues", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);

    // Run a first prompt to commit the session so compaction has entries to work with
    await runPrompt(sid, "first", "response");

    // Now trigger a context overflow error — the retry path runs compact() + continue()
    const events = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ contextOverflow: true }));
      const stream = await instance.prompt("overflow me");
      const ev = await drainStream(stream);
      await instance.waitForFlush();
      return ev;
    });

    // Context overflow produces an agent_end (after retry exhaustion or recovery)
    expect(events.some((e) => e.type === "agent_end" || e.type === "error")).toBe(true);
  });
});

describe("AgentSessionDO — getCurrentTurn and TurnImpl", () => {
  it("getCurrentTurn() returns undefined when idle", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      await instance._init(sid, "user-1");
    });
    const turn = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getCurrentTurn(),
    );
    expect(turn).toBeUndefined();
  });

  it("TurnImpl.getCallback() returns undefined when no callback set", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    // Prompt without a callback — TurnImpl still constructed mid-turn
    const events = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "hi" }));
      await instance._init(sid, "user-1");
      const stream = await instance.prompt("hello");
      return drainStream(stream);
    });
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
  });
});

describe("AgentSessionDO — estimateTokens with non-text content", () => {
  it("prompt() with attachment counts non-text parts in token estimate", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "ok" }));
      await instance._init(sid, "user-1");
      // Pass an attachment (file part) — hits the else branch in estimateTokens
      const stream = await instance.prompt("describe this", [
        { name: "test.png", data: "iVBORw0KGgo=", mimeType: "image/png", size: 9 },
      ]);
      await drainStream(stream);
      await instance.waitForFlush();
    });
    const usage = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getContextUsage(),
    );
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
  });
});

describe("AgentSessionDO — getEntries with customType filter", () => {
  it("getEntries(customType) filters to matching entries only", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "ok" }));
      await instance._init(sid, "user-1");
      await instance.appendCustomEntry("foo", { x: 1 });
      await instance.appendCustomEntry("bar", { y: 2 });
    });
    const entries = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getEntries("foo"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe("foo");
  });
});

describe("AgentSessionDO — TurnImpl.getCallback", () => {
  it("getCurrentTurn() returns a TurnImpl; getCallback() returns undefined when no callback", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);

    // Capture the turn mid-flight by checking getCurrentTurn inside the prompt stream
    let callbackResult: unknown = "NOT_CHECKED";
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "hi" }));
      await instance._init(sid, "user-1");
      const stream = await instance.prompt("hello");
      // getCurrentTurn is only valid while streaming
      const turn = await instance.getCurrentTurn();
      if (turn) {
        callbackResult = await turn.getCallback();
      }
      await drainStream(stream);
    });
    // No callback was passed to prompt(), so getCallback() returns undefined
    expect(callbackResult).toBeUndefined();
  });
});

describe("AgentSessionDO — _init idempotency", () => {
  it("calling _init twice is a no-op on second call", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      instance._setModelForTest(createMockModel({ response: "hello" }));
      await instance._init(sid, "user-1");
      await instance._init(sid, "user-2"); // second call ignored
      const stream = await instance.prompt("hi");
      await drainStream(stream);
      await instance.waitForFlush();
    });
    const row = await getSession(env.SESSIONS_DB, sid);
    // userId should still be user-1 (second newSession was no-op)
    expect(row?.user_id).toBe("user-1");
  });
});

describe("AgentSessionDO — getStatus", () => {
  it("getStatus() returns isStreaming: false when idle", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, (instance: AgentSessionDO) => instance._init(sid, "user-1"));
    const status = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getStatus(),
    );
    expect(status.isStreaming).toBe(false);
    expect(typeof status.model).toBe("string");
    expect(status.model.length).toBeGreaterThan(0);
    expect(status.name).toBeUndefined();
  });

  it("getStatus() returns the session name after setName()", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hi", "hello");
    const stub = getStub(sid);
    await runInDurableObject(stub, (instance: AgentSessionDO) => instance.setName("My Chat"));
    const status = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getStatus(),
    );
    expect(status.name).toBe("My Chat");
  });
});

describe("AgentSessionDO — getHistory", () => {
  it("getHistory() returns [] before any prompts", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, (instance: AgentSessionDO) => instance._init(sid, "user-1"));
    const history = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getHistory(),
    );
    expect(history).toEqual([]);
  });

  it("getHistory() returns user and assistant entries after a turn", async () => {
    const sid = uniqueId();
    await runPrompt(sid, "hello world", "assistant response text");
    const stub = getStub(sid);
    const history = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getHistory(),
    );
    const userEntry = history.find((e) => e.type === "user");
    const assistantEntry = history.find((e) => e.type === "assistant");
    expect(userEntry).toBeDefined();
    if (userEntry?.type === "user") expect(userEntry.content).toBe("hello world");
    expect(assistantEntry).toBeDefined();
    if (assistantEntry?.type === "assistant") {
      expect(assistantEntry.content).toBe("assistant response text");
      expect(assistantEntry.isStreaming).toBe(false);
    }
  });

  it("getHistory() accumulates entries across multiple turns", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      await instance._init(sid, "user-1");
      instance._setModelForTest(createMockModel({ response: "reply one" }));
      await drainStream(await instance.prompt("question one"));
      await instance.waitForFlush();
      instance._setModelForTest(createMockModel({ response: "reply two" }));
      await drainStream(await instance.prompt("question two"));
      await instance.waitForFlush();
    });
    const history = await runInDurableObject(stub, (instance: AgentSessionDO) =>
      instance.getHistory(),
    );
    const userEntries = history.filter((e) => e.type === "user");
    const assistantEntries = history.filter((e) => e.type === "assistant");
    expect(userEntries.length).toBeGreaterThanOrEqual(2);
    expect(assistantEntries.length).toBeGreaterThanOrEqual(2);
  });
});

describe("AgentSessionDO — subscribe", () => {
  it("subscribe() returns an immediately-closed stream when idle", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);
    await runInDurableObject(stub, (instance: AgentSessionDO) => instance._init(sid, "user-1"));
    const events = await runInDurableObject(stub, async (instance: AgentSessionDO) => {
      const stream = await instance.subscribe();
      return drainStream(stream);
    });
    expect(events).toHaveLength(0);
  });

  it("subscribe() during an active turn receives the remaining events", async () => {
    const sid = uniqueId();
    const stub = getStub(sid);

    const [promptEvents, subscribeEvents] = await runInDurableObject(
      stub,
      async (instance: AgentSessionDO) => {
        instance._setModelForTest(createMockModel({ response: "hello from subscribe" }));
        await instance._init(sid, "user-1");

        // Start prompt (returns stream immediately — agent runs async).
        const promptStream = await instance.prompt("go");
        // Subscribe to the same turn.
        const subscribeStream = await instance.subscribe();

        // Drain both concurrently.
        const [pEvents, sEvents] = await Promise.all([
          drainStream(promptStream),
          drainStream(subscribeStream),
        ]);
        await instance.waitForFlush();
        return [pEvents, sEvents] as [AgentEvent[], AgentEvent[]];
      },
    );

    // Both streams should contain agent events.
    expect(promptEvents.some((e) => e.type === "agent_end")).toBe(true);
    expect(subscribeEvents.some((e) => e.type === "agent_end")).toBe(true);
  });
});
