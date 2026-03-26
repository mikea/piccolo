/**
 * Unit tests for Agent (packages/core/src/agent.ts).
 *
 * Tests run in a plain Node/Vitest environment — no Workers globals needed.
 * Agent is a pure TypeScript class with no DO or JSRPC dependencies.
 *
 * Spec ref: specs/core.md §Agent Loop
 */

import type { AgentEvent, ISession, ITool, ToolResult } from "@piccolo/api";
import type { LanguageModel, ModelMessage } from "ai";
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

// ─── Basic streaming ──────────────────────────────────────────────────────────

describe("Agent — basic streaming", () => {
  it("prompt() returns an AgentTurn with a ReadableStream", () => {
    const agent = makeAgent();
    const turn = agent.prompt("hi");
    expect(turn).not.toBeNull();
    expect(turn.stream).toBeInstanceOf(ReadableStream);
    // drain to avoid unhandled stream
    void drainStream(turn.stream);
  });

  it("emits agent_start and agent_end events", async () => {
    const agent = makeAgent();
    const turn = agent.prompt("hi");
    const events = await drainStream(turn.stream);
    expect(events.some((e) => e.type === "agent_start")).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
  });

  it("emits text_delta events that reconstruct the response", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "Hello world" }) });
    const turn = agent.prompt("hi");
    const events = await drainStream(turn.stream);
    const deltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""));
    expect(deltas.join("")).toBe("Hello world");
  });

  it("emits turn_end event", async () => {
    const agent = makeAgent();
    const events = await drainStream(agent.prompt("hi").stream);
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
  });

  it("isStreaming is false after stream drains", async () => {
    const agent = makeAgent();
    const turn = agent.prompt("hi");
    expect(agent.state.isStreaming).toBe(true);
    await drainStream(turn.stream);
    expect(agent.state.isStreaming).toBe(false);
  });

  it("appends user message and response messages to state", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "hello" }) });
    expect(agent.state.messages).toHaveLength(0);
    await drainStream(agent.prompt("hello").stream);
    expect(agent.state.messages.length).toBeGreaterThanOrEqual(2);
    expect(agent.state.messages[0]).toMatchObject({ role: "user" });
  });

  it("accumulates messages across multiple turns", async () => {
    const agent = makeAgent();
    await drainStream(agent.prompt("first").stream);
    const afterFirst = agent.state.messages.length;
    await drainStream(agent.prompt("second").stream);
    expect(agent.state.messages.length).toBeGreaterThan(afterFirst);
  });
});

// ─── getCurrentTurn ───────────────────────────────────────────────────────────

describe("Agent — getCurrentTurn", () => {
  it("getCurrentTurn() returns the AgentTurn while streaming", () => {
    const agent = makeAgent();
    const turn = agent.prompt("hi");
    expect(agent.getCurrentTurn()).toBe(turn);
    // drain to clean up
    void drainStream(turn.stream);
  });

  it("getCurrentTurn() returns null after stream drains", async () => {
    const agent = makeAgent();
    const turn = agent.prompt("hi");
    await drainStream(turn.stream);
    expect(agent.getCurrentTurn()).toBeNull();
  });

  it("prompt() throws if a turn is already active", () => {
    const agent = makeAgent();
    const turn = agent.prompt("first");
    expect(() => agent.prompt("second")).toThrow("turn is already in progress");
    void drainStream(turn.stream);
  });
});

// ─── Prompt overloads ─────────────────────────────────────────────────────────

describe("Agent — prompt overloads", () => {
  it("accepts string prompt", async () => {
    const agent = makeAgent();
    await drainStream(agent.prompt("text").stream);
    expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "text" });
  });

  it("accepts ModelMessage array", async () => {
    const agent = makeAgent();
    const msgs: ModelMessage[] = [{ role: "user", content: "pre-built" }];
    await drainStream(agent.prompt(msgs).stream);
    expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "pre-built" });
  });

  it("builds content array for text + images", async () => {
    const agent = makeAgent();
    await drainStream(
      agent.prompt("describe this", [{ type: "image", image: "https://example.com/img.png" }])
        .stream,
    );
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
    await drainStream(agent.prompt("original").stream);
    const replacement: ModelMessage[] = [{ role: "user", content: "replaced" }];
    agent.replaceMessages(replacement);
    expect(agent.state.messages).toEqual(replacement);
  });

  it("appendMessages adds to existing history", async () => {
    const agent = makeAgent();
    await drainStream(agent.prompt("first").stream);
    const before = agent.state.messages.length;
    agent.appendMessages([{ role: "user", content: "appended" }]);
    expect(agent.state.messages.length).toBe(before + 1);
  });
});

// ─── Abort ────────────────────────────────────────────────────────────────────

describe("Agent — abort", () => {
  it("turn.abort() stops streaming and suppresses agent_end", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "a b c d e f g h i j" }) });
    const turn = agent.prompt("go");
    turn.abort();
    const events = await drainStream(turn.stream);
    expect(agent.state.isStreaming).toBe(false);
    expect(events.some((e) => e.type === "agent_end")).toBe(false);
  });

  it("agent.abort() delegates to current turn", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "a b c d e f g h i j" }) });
    const turn = agent.prompt("go");
    agent.abort();
    const events = await drainStream(turn.stream);
    expect(events.some((e) => e.type === "agent_end")).toBe(false);
  });

  it("getCurrentTurn() is null after abort", async () => {
    const agent = makeAgent();
    const turn = agent.prompt("go");
    turn.abort();
    await drainStream(turn.stream);
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
  it("emits tool_start and tool_end events for a tool call", async () => {
    const t = makeTool("my_tool");
    const agent = makeAgent({
      model: createMockModel({
        toolCalls: [{ name: "my_tool", input: { input: "test" } }],
        response: "done",
      }),
      tools: [t],
    });
    const events = await drainStream(agent.prompt("use tool").stream);
    expect(events.some((e) => e.type === "tool_start" && e.toolName === "my_tool")).toBe(true);
    expect(events.some((e) => e.type === "tool_end" && e.toolName === "my_tool")).toBe(true);
  });

  it("tool_end has isError: false for successful tool", async () => {
    const t = makeTool("ok_tool");
    const agent = makeAgent({
      model: createMockModel({
        toolCalls: [{ name: "ok_tool", input: {} }],
        response: "finished",
      }),
      tools: [t],
    });
    const events = await drainStream(agent.prompt("go").stream);
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === "tool_end") {
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
    const events = await drainStream(agent.prompt("hi").stream);

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("network failure");
    }
    expect(agent.state.error).toContain("network failure");
    expect(agent.state.isStreaming).toBe(false);
  });
});
