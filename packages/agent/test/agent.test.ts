import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentToolResult, IAgentTool } from "../src/types.ts";
import { createMockModel } from "./mock-gateway.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  return new Agent({
    model: createMockModel({ response: "ok" }),
    systemPrompt: "You are helpful.",
    ...overrides,
  });
}

function makeTool(
  name: string,
  result: AgentToolResult = { content: [{ type: "text", text: "tool result" }] },
): IAgentTool {
  return {
    descriptor: {
      name,
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

function collectEvents(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return events;
}

// ─── Basic streaming ──────────────────────────────────────────────────────────

describe("Agent — basic streaming", () => {
  it("emits agent_start and agent_end events", async () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    await agent.prompt("hi");
    expect(events.some((e) => e.type === "agent_start")).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
  });

  it("emits text_delta events that reconstruct the response", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "Hello world" }) });
    const events = collectEvents(agent);
    await agent.prompt("hi");
    const deltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => {
        if (e.type === "text_delta") return e.delta;
        return "";
      });
    expect(deltas.join("")).toBe("Hello world");
  });

  it("emits turn_end event", async () => {
    const agent = makeAgent();
    const events = collectEvents(agent);
    await agent.prompt("hi");
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
  });

  it("isStreaming is false after prompt resolves", async () => {
    const agent = makeAgent();
    await agent.prompt("hi");
    expect(agent.state.isStreaming).toBe(false);
  });

  it("appends user message and response messages to state", async () => {
    const agent = makeAgent({ model: createMockModel({ response: "hello" }) });
    expect(agent.state.messages).toHaveLength(0);
    await agent.prompt("hello");
    // At minimum: user message + assistant response
    expect(agent.state.messages.length).toBeGreaterThanOrEqual(2);
    expect(agent.state.messages[0]).toMatchObject({ role: "user" });
  });

  it("accumulates messages across multiple turns", async () => {
    const agent = makeAgent();
    await agent.prompt("first");
    const afterFirst = agent.state.messages.length;
    await agent.prompt("second");
    expect(agent.state.messages.length).toBeGreaterThan(afterFirst);
  });
});

// ─── Prompt overloads ─────────────────────────────────────────────────────────

describe("Agent — prompt overloads", () => {
  it("accepts string prompt", async () => {
    const agent = makeAgent();
    await expect(agent.prompt("text")).resolves.toBeUndefined();
    expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "text" });
  });

  it("accepts ModelMessage array", async () => {
    const agent = makeAgent();
    const msgs: ModelMessage[] = [{ role: "user", content: "pre-built" }];
    await expect(agent.prompt(msgs)).resolves.toBeUndefined();
    expect(agent.state.messages[0]).toMatchObject({ role: "user", content: "pre-built" });
  });

  it("builds content array for text + images", async () => {
    const agent = makeAgent();
    await agent.prompt("describe this", [{ type: "image", image: "https://example.com/img.png" }]);
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
    const tool = makeTool("my_tool");
    agent.setTools([tool]);
    expect(agent.state.tools).toHaveLength(1);
  });

  it("replaceMessages replaces conversation history", async () => {
    const agent = makeAgent();
    await agent.prompt("original");
    const replacement: ModelMessage[] = [{ role: "user", content: "replaced" }];
    agent.replaceMessages(replacement);
    expect(agent.state.messages).toEqual(replacement);
  });

  it("appendMessages adds to existing history", async () => {
    const agent = makeAgent();
    await agent.prompt("first");
    const before = agent.state.messages.length;
    agent.appendMessages([{ role: "user", content: "appended" }]);
    expect(agent.state.messages.length).toBe(before + 1);
  });
});

// ─── Subscribe / unsubscribe ──────────────────────────────────────────────────

describe("Agent — subscribe/unsubscribe", () => {
  it("unsubscribe prevents further events", async () => {
    const agent = makeAgent();
    const events: AgentEvent[] = [];
    const unsub = agent.subscribe((e) => events.push(e));
    unsub();
    await agent.prompt("test");
    expect(events).toHaveLength(0);
  });

  it("multiple listeners each receive events", async () => {
    const agent = makeAgent();
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    agent.subscribe((e) => a.push(e));
    agent.subscribe((e) => b.push(e));
    await agent.prompt("test");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
  });
});

// ─── Abort ────────────────────────────────────────────────────────────────────

describe("Agent — abort", () => {
  it("abort() stops streaming and suppresses agent_end", async () => {
    // Use a long response so there's a streaming window to abort in
    const agent = makeAgent({ model: createMockModel({ response: "a b c d e f g h i j" }) });
    const events: AgentEvent[] = [];
    agent.subscribe((e) => events.push(e));

    const promptPromise = agent.prompt("go");
    agent.abort();
    await promptPromise;

    expect(agent.state.isStreaming).toBe(false);
    // agent_end should NOT be emitted after abort
    expect(events.some((e) => e.type === "agent_end")).toBe(false);
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

// ─── Follow-up ────────────────────────────────────────────────────────────────

describe("Agent — follow-up queue", () => {
  it("followUp() adds to follow-up queue", () => {
    const agent = makeAgent();
    agent.followUp({ role: "user", content: "follow" });
    expect(agent.clearFollowUp()).toHaveLength(1);
  });

  it("clearFollowUp() returns and empties the queue", () => {
    const agent = makeAgent();
    agent.followUp({ role: "user", content: "a" });
    agent.followUp({ role: "user", content: "b" });
    const cleared = agent.clearFollowUp();
    expect(cleared).toHaveLength(2);
    expect(agent.clearFollowUp()).toHaveLength(0);
  });

  it("follow-up triggers a second streaming turn", async () => {
    let callCount = 0;
    const { MockLanguageModelV3 } = await import("ai/test");
    const baseModel = createMockModel({ response: "reply" });
    // Wrap doStream to count calls
    const trackingModel = new MockLanguageModelV3({
      provider: "mock",
      modelId: "tracking",
      doStream: async (opts) => {
        callCount++;
        // biome-ignore lint/suspicious/noExplicitAny: delegating to base mock for stream
        return (baseModel as any).doStream(opts);
      },
      doGenerate: async (opts) => {
        // biome-ignore lint/suspicious/noExplicitAny: delegating to base mock for generate
        return (baseModel as any).doGenerate(opts);
      },
    });

    const agent = makeAgent({ model: trackingModel });
    agent.followUp({ role: "user", content: "follow up question" });
    await agent.prompt("initial");

    // The follow-up should have triggered a second stream call
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── Tool execution ───────────────────────────────────────────────────────────

describe("Agent — tool execution", () => {
  it("emits tool_start and tool_end events for a tool call", async () => {
    const tool = makeTool("my_tool");
    const agent = makeAgent({
      model: createMockModel({
        toolCalls: [{ name: "my_tool", input: { input: "test" } }],
        response: "done",
      }),
      tools: [tool],
    });
    const events = collectEvents(agent);
    await agent.prompt("use tool");

    expect(events.some((e) => e.type === "tool_start" && e.toolName === "my_tool")).toBe(true);
    expect(events.some((e) => e.type === "tool_end" && e.toolName === "my_tool")).toBe(true);
  });

  it("tool_end has isError: false for successful tool", async () => {
    const tool = makeTool("ok_tool");
    const agent = makeAgent({
      model: createMockModel({
        toolCalls: [{ name: "ok_tool", input: {} }],
        response: "finished",
      }),
      tools: [tool],
    });
    const events = collectEvents(agent);
    await agent.prompt("go");

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
    // Create a model that throws on doStream by using MockLanguageModelV3 directly
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
    const events = collectEvents(agent);
    await agent.prompt("hi");

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("network failure");
    }
    expect(agent.state.error).toContain("network failure");
    expect(agent.state.isStreaming).toBe(false);
  });
});
