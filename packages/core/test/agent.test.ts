/**
 * Unit tests for Agent (packages/core/src/agent.ts).
 *
 * Tests run in a plain Node/Vitest environment — no Workers globals needed.
 * Agent is a pure TypeScript class with no DO or JSRPC dependencies.
 *
 * Spec ref: specs/core.md §Agent Loop
 */

import type { AgentEvent, IObserver, ISession, ITool, ToolResult } from "@piccolo/api";
import type { ImagePart, LanguageModel, ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { createMockModel } from "./do/mock-model.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal ISession stub — Agent only needs it to pass into tool execute(). */
const mockSession = {} as ISession;

function makeAgent(overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const agent = new Agent({
    model: createMockModel({ response: "ok" }),
    systemPrompt: "You are helpful.",
    ...overrides,
  });
  agent.setContext(mockSession);
  return agent;
}

function makeTool(
  name: string,
  result: ToolResult = { content: [{ type: "text", text: "tool result" }] },
): ITool {
  return {
    descriptor: {
      name,
      label: name,
      description: `${name} tool`,
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        additionalProperties: false,
      },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

/**
 * Subscribe to agent, call prompt(), collect all events until finish or error.
 * Must subscribe before prompt() to avoid missing early events.
 */
async function drainAgent(
  agent: Agent,
  input: string | ModelMessage[],
  images?: ImagePart[],
  afterPrompt?: (resolve: () => void) => void,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const observer: IObserver<AgentEvent> = {
    async onNext(event) {
      events.push(event);
      console.debug(
        "[test] onNext type=%s currentTurn=%s",
        event.type,
        agent.getCurrentTurn() !== null,
      );
      if (event.type === "finish" || event.type === "error" || agent.getCurrentTurn() === null) {
        resolve();
      }
    },
    async onError() {
      resolve();
    },
    async onComplete() {
      resolve();
    },
  };
  void agent.subscribe(observer);
  await Promise.resolve();
  if (typeof input === "string") {
    agent.prompt(input, images);
  } else {
    agent.prompt(input);
  }
  afterPrompt?.(resolve);
  await done;
  return events;
}

// ─── Basic streaming ──────────────────────────────────────────────────────────

describe("Agent — basic streaming", () => {
  it("prompt() returns an AgentTurn", async () => {
    const agent = makeAgent();
    const draining = drainAgent(agent, "hi"); // subscribes first, then prompts
    // After drainAgent's internal await Promise.resolve(), prompt() is called.
    // Advance past that one microtask so prompt() has run.
    await Promise.resolve();
    await Promise.resolve();
    expect(agent.getCurrentTurn()).not.toBeNull();
    await draining;
  });

  it("emits start and finish events", async () => {
    const agent = makeAgent();
    const events = await drainAgent(agent, "hi");
    expect(events.some((e) => e.type === "start")).toBe(true);
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("emits text-delta events that reconstruct the response", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "Hello world" }) });
    const events = await drainAgent(agent, "hi");
    const deltas = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e.type === "text-delta" ? e.delta : ""));
    expect(deltas.join("")).toBe("Hello world");
  });

  it("emits step-finish event", async () => {
    const agent = makeAgent();
    const events = await drainAgent(agent, "hi");
    expect(events.some((e) => e.type === "step-finish")).toBe(true);
  });

  it("getCurrentTurn() is null after drain", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "hi");
    expect(agent.getCurrentTurn()).toBeNull();
  });

  it("appends user message and response messages to state", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "hello" }) });
    expect(agent.state.messages).toHaveLength(0);
    await drainAgent(agent, "hello");
    expect(agent.state.messages.length).toBeGreaterThanOrEqual(2);
    expect(agent.state.messages[0]).toMatchObject({ role: "user" });
  });

  it("accumulates messages across multiple turns", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "first");
    const afterFirst = agent.state.messages.length;
    await drainAgent(agent, "second");
    expect(agent.state.messages.length).toBeGreaterThan(afterFirst);
  });
});

// ─── getCurrentTurn ───────────────────────────────────────────────────────────

describe("Agent — getCurrentTurn", () => {
  it("getCurrentTurn() returns the AgentTurn while streaming", async () => {
    const agent = makeAgent();
    const draining = drainAgent(agent, "hi");
    await Promise.resolve();
    await Promise.resolve();
    expect(agent.getCurrentTurn()).not.toBeNull();
    await draining;
  });

  it("getCurrentTurn() returns null after turn completes", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "hi");
    expect(agent.getCurrentTurn()).toBeNull();
  });

  it("prompt() throws if a turn is already active", async () => {
    const agent = makeAgent();
    const draining = drainAgent(agent, "first");
    await Promise.resolve();
    await Promise.resolve();
    expect(() => agent.prompt("second")).toThrow("turn is already in progress");
    await draining;
  });
});

// ─── Prompt overloads ─────────────────────────────────────────────────────────

describe("Agent — prompt overloads", () => {
  it("accepts string prompt", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "text");
    expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "text" });
  });

  it("accepts ModelMessage array", async () => {
    const agent = makeAgent();
    const msgs: ModelMessage[] = [{ role: "user", content: "pre-built" }];
    await drainAgent(agent, msgs);
    expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "pre-built" });
  });

  it("builds content array for text + images", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "describe this", [
      { type: "image", image: "https://example.com/img.png" },
    ]);
    const firstMsg = agent.state.messages[0];
    if (firstMsg && Array.isArray(firstMsg.content)) {
      expect(firstMsg.content[0]).toMatchObject({ type: "text", text: "describe this" });
      expect(firstMsg.content[1]).toMatchObject({ type: "image" });
    } else {
      throw new Error("Expected array content");
    }
  });
});

// ─── State mutations ──────────────────────────────────────────────────────────

describe("Agent — state mutations", () => {
  it("setModel updates model", () => {
    const agent = makeAgent();
    const newModel = createMockModel({ response: "new" });
    agent.setModel(newModel);
    expect(agent.state.model).toBe(newModel);
  });

  it("setSystemPrompt updates systemPrompt", () => {
    const agent = makeAgent();
    agent.setSystemPrompt("new prompt");
    expect(agent.state.systemPrompt).toBe("new prompt");
  });

  it("setTools updates tools", () => {
    const agent = makeAgent();
    const t = makeTool("my_tool");
    agent.setTools([t]);
    expect(agent.state.tools).toHaveLength(1);
  });

  it("replaceMessages replaces conversation history", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "original");
    const replacement: ModelMessage[] = [{ role: "user", content: "replaced" }];
    agent.replaceMessages(replacement);
    expect(agent.state.messages).toEqual(replacement);
  });

  it("appendMessages adds to existing history", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "first");
    const before = agent.state.messages.length;
    agent.appendMessages([{ role: "user", content: "appended" }]);
    expect(agent.state.messages.length).toBe(before + 1);
  });
});

// ─── Abort ────────────────────────────────────────────────────────────────────

describe("Agent — abort", () => {
  it("turn.abort() stops streaming and suppresses finish", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "a b c d e f g h i j" }) });
    const events = await drainAgent(agent, "go", undefined, (resolve) => {
      agent.abort();
      setTimeout(resolve, 50);
    });
    expect(agent.getCurrentTurn()).toBeNull();
    expect(events.some((e) => e.type === "finish")).toBe(false);
  });

  it("agent.abort() delegates to current turn", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "a b c d e f g h i j" }) });
    const events = await drainAgent(agent, "go", undefined, (resolve) => {
      agent.abort();
      setTimeout(resolve, 50);
    });
    expect(events.some((e) => e.type === "finish")).toBe(false);
  });

  it("getCurrentTurn() is null after abort", async () => {
    const agent = makeAgent();
    await drainAgent(agent, "go", undefined, (resolve) => {
      agent.abort();
      setTimeout(resolve, 50);
    });
    expect(agent.getCurrentTurn()).toBeNull();
  });
});

// ─── Steering ────────────────────────────────────────────────────────────────

describe("Agent — steering queue", () => {
  it("steer() adds to steering queue", () => {
    const agent = makeAgent();
    agent.steer({ role: "user", content: "steer me" });
    expect(agent.clearSteering()).toHaveLength(1);
  });

  it("clearSteering() returns and empties the queue", () => {
    const agent = makeAgent();
    agent.steer({ role: "user", content: "a" });
    agent.steer({ role: "user", content: "b" });
    const cleared = agent.clearSteering();
    expect(cleared).toHaveLength(2);
    expect(agent.clearSteering()).toHaveLength(0);
  });
});

// ─── Tool execution ───────────────────────────────────────────────────────────

describe("Agent — tool execution", () => {
  it("emits tool-call and tool-result events for a tool call", async () => {
    const t = makeTool("my_tool");
    const agent = makeAgent({
      model: createMockModel({
        toolCalls: [{ name: "my_tool", input: { input: "test" } }],
        response: "done",
      }),
      tools: [t],
    });
    const events = await drainAgent(agent, "use tool");
    expect(events.some((e) => e.type === "tool-call" && e.toolName === "my_tool")).toBe(true);
    expect(events.some((e) => e.type === "tool-result" && e.toolName === "my_tool")).toBe(true);
  });

  it("tool-result has isError: false for successful tool", async () => {
    const t = makeTool("ok_tool");
    const agent = makeAgent({
      model: createMockModel({
        toolCalls: [{ name: "ok_tool", input: {} }],
        response: "finished",
      }),
      tools: [t],
    });
    const events = await drainAgent(agent, "go");
    const toolEnd = events.find((e) => e.type === "tool-result");
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool-result") {
      expect(toolEnd.isError).toBe(false);
    }
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("Agent — error handling", () => {
  it("sets state.error and emits error event on model failure", async () => {
    const { MockLanguageModelV3 } = await import("ai/test");
    const failingModel: LanguageModel = new MockLanguageModelV3({
      provider: "mock",
      modelId: "failing",
      doStream: async () => {
        throw new Error("network failure");
      },
      doGenerate: async () => {
        throw new Error("network failure");
      },
    });

    const agent = makeAgent({ model: failingModel });
    const events = await drainAgent(agent, "hi");

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("network failure");
    }
    expect(agent.state.error).toContain("network failure");
    expect(agent.getCurrentTurn()).toBeNull();
  });
});
