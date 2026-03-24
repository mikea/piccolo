/**
 * Unit tests for SessionImpl (the ISession implementation in context.ts).
 *
 * These tests construct a minimal mock DOState directly — no Miniflare required.
 * They verify that SessionImpl correctly delegates to DOState, appends entries,
 * updates leafId, and handles all ISession methods.
 *
 * Spec ref: specs/api.md §2 ISession, specs/core.md §ISession — Core-Side Implementation
 */

import type { IAgentSession, IAgentTool } from "@piccolo/agent";
import { Agent } from "@piccolo/agent";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AnyEntry } from "../../src/db/entry-types.ts";
import type { DOState } from "../../src/do/do-state.ts";
import type { ExtensionRunner } from "../../src/do/extension-runner.ts";
import { SessionImpl } from "../../src/do/session-impl.ts";
import type { SystemPromptAssembler } from "../../src/do/system-prompt-assembler.ts";
import { MODEL_CATALOG } from "../../src/do/types-internal.ts";
import type { ISession } from "../../src/types.ts";
import { createMockModel } from "./mock-model.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockTool(name: string): IAgentTool {
  return {
    descriptor: {
      name,
      description: `${name} description`,
      inputSchema: z.object({ value: z.string() }),
    },
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
}

/**
 * Build a minimal DOState for unit testing SessionImpl.
 * All fields are at their zero-state defaults unless overridden.
 */
function makeMockDOState(overrides: Partial<DOState> = {}): DOState {
  const model = createMockModel({ response: "hi" });
  const agent = new Agent({ model, systemPrompt: "test prompt" });

  return {
    sessionId: "test-session",
    userId: "test-user",
    modelId: "anthropic/claude-sonnet-4-5",
    leafId: null,
    name: undefined,
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    pendingEntries: [],
    branchEntries: [],
    agent,
    abortController: null,
    followUpQueue: [],
    extensionRunner: {
      getToolsByNames: (_names: string[]) => [],
      getToolDescriptors: () => [],
      getSystemPromptAdditions: () => [],
      getCommands: () => [],
      emitInput: vi.fn(),
      emitBeforeAgentStart: vi.fn(),
      emitContext: vi.fn(),
      emitToolCall: vi.fn(),
      emitToolResult: vi.fn(),
      emitBeforeCompact: vi.fn(),
      emit: vi.fn(),
    } as unknown as ExtensionRunner,
    assembler: {} as SystemPromptAssembler,
    assembledSystemPrompt: "assembled system prompt",
    messageToEntryId: new Map(),
    lastInputTokens: 100,
    lastContextWindowTokens: 200_000,
    messagesAtTurnStart: 0,
    session: null,
    modelOverridden: false,
    ...overrides,
  };
}

/** Create a SessionImpl with a mock env. */
function makeSession(doState: DOState): ISession {
  // env is only used by setModel() and compact(); mock it minimally
  const mockEnv = {
    CF_ACCOUNT_ID: "test-account",
    CF_AI_GATEWAY_NAME: "test-gateway",
    CF_AI_GATEWAY_TOKEN: "test-token",
  } as unknown as Env;
  return new SessionImpl(doState, mockEnv);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionImpl — identity", () => {
  it("id() returns doState.sessionId", async () => {
    const state = makeMockDOState({ sessionId: "my-session-123" });
    const session = makeSession(state);
    expect(await session.id()).toBe("my-session-123");
  });

  it("userId matches doState.userId", () => {
    const state = makeMockDOState({ userId: "user-abc" });
    const session = makeSession(state);
    expect(session.userId).toBe("user-abc");
  });

  it("info() returns a SessionRecord with correct fields", async () => {
    const state = makeMockDOState({
      sessionId: "sess-1",
      userId: "u-1",
      createdAt: 1000,
      updatedAt: 2000,
      name: "My Session",
    });
    const session = makeSession(state);
    const info = await session.info();
    expect(info.id).toBe("sess-1");
    expect(info.userId).toBe("u-1");
    expect(info.createdAt).toBe(1000);
    expect(info.updatedAt).toBe(2000);
    expect(info.name).toBe("My Session");
  });

  it("info() omits name when undefined", async () => {
    const state = makeMockDOState({ name: undefined });
    const session = makeSession(state);
    const info = await session.info();
    expect("name" in info).toBe(false);
  });
});

describe("SessionImpl — metadata", () => {
  it("getName() returns undefined when not set", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    expect(await session.getName()).toBeUndefined();
  });

  it("getName() returns the current name", async () => {
    const state = makeMockDOState({ name: "Alice" });
    const session = makeSession(state);
    expect(await session.getName()).toBe("Alice");
  });

  it("setName() updates doState.name and pushes SessionInfoEntry", async () => {
    const state = makeMockDOState({ sessionId: "s1", leafId: "prev-leaf" });
    const session = makeSession(state);

    await session.setName("New Name");

    expect(state.name).toBe("New Name");
    expect(state.pendingEntries).toHaveLength(1);
    const entry = state.pendingEntries[0];
    expect(entry?.type).toBe("session_info");
    expect((entry?.data as { name: string }).name).toBe("New Name");
    expect(entry?.parentId).toBe("prev-leaf");
    // leafId should advance to the new entry
    expect(state.leafId).toBe(entry?.id);
  });

  it("setName() also appends to branchEntries", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    await session.setName("X");
    expect(state.branchEntries).toHaveLength(1);
    expect(state.branchEntries[0]?.type).toBe("session_info");
  });
});

describe("SessionImpl — model", () => {
  it("getModel() returns the resolved model for current modelId", async () => {
    const state = makeMockDOState({ modelId: "openai/gpt-4o" });
    const session = makeSession(state);
    const model = await session.getModel();
    expect(model.id).toBe("openai/gpt-4o");
    expect(typeof model.label).toBe("string");
    expect(model.provider).toBe("openai");
  });

  it("listModels() returns non-empty catalog", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    const models = await session.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models).toEqual(MODEL_CATALOG);
  });

  it("setModel() updates doState.modelId and pushes ModelChangeEntry", async () => {
    const state = makeMockDOState({ leafId: "leaf-0" });
    const session = makeSession(state);

    await session.setModel("openai/gpt-4o");

    expect(state.modelId).toBe("openai/gpt-4o");
    expect(state.pendingEntries).toHaveLength(1);
    const entry = state.pendingEntries[0];
    expect(entry?.type).toBe("model_change");
    expect((entry?.data as { modelId: string }).modelId).toBe("openai/gpt-4o");
    expect(state.leafId).toBe(entry?.id);
  });
});

describe("SessionImpl — tools", () => {
  it("getActiveTools() returns descriptors from agent.state.tools", async () => {
    const tool = makeMockTool("my_tool");
    const state = makeMockDOState();
    state.agent.setTools([tool]);
    const session = makeSession(state);
    const tools = await session.getActiveTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("my_tool");
  });

  it("setActiveTools() calls agent.setTools with filtered tools", async () => {
    const toolA = makeMockTool("tool_a");
    const state = makeMockDOState();
    const setToolsSpy = vi.spyOn(state.agent, "setTools");
    // Override extensionRunner.getToolsByNames to return toolA
    (state.extensionRunner as { getToolsByNames: (n: string[]) => IAgentTool[] }).getToolsByNames =
      (names: string[]) => (names.includes("tool_a") ? [toolA] : []);

    const session = makeSession(state);
    await session.setActiveTools(["tool_a"]);

    expect(setToolsSpy).toHaveBeenCalledWith([toolA]);
  });
});

describe("SessionImpl — conversation", () => {
  it("sendUserMessage() calls agent.steer with user role message", async () => {
    const state = makeMockDOState();
    const steerSpy = vi.spyOn(state.agent, "steer");
    const session = makeSession(state);

    await session.sendUserMessage("hello world");

    expect(steerSpy).toHaveBeenCalledWith({ role: "user", content: "hello world" });
  });

  it("steer() calls agent.steer with user role message", async () => {
    const state = makeMockDOState();
    const steerSpy = vi.spyOn(state.agent, "steer");
    const session = makeSession(state);

    await session.steer("steer text");

    expect(steerSpy).toHaveBeenCalledWith({ role: "user", content: "steer text" });
  });

  it("followUp() pushes to doState.followUpQueue", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);

    await session.followUp("follow this up");

    expect(state.followUpQueue).toEqual(["follow this up"]);
  });

  it("abort() calls doState.abortController.abort()", async () => {
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, "abort");
    const state = makeMockDOState({ abortController });
    const session = makeSession(state);

    await session.abort();

    expect(abortSpy).toHaveBeenCalled();
  });

  it("abort() does nothing when abortController is null", async () => {
    const state = makeMockDOState({ abortController: null });
    const session = makeSession(state);
    // Should not throw
    await expect(session.abort()).resolves.toBeUndefined();
  });
});

describe("SessionImpl — custom entries", () => {
  it("appendCustomMessage() pushes a CustomMessageEntry to pendingEntries and branchEntries", async () => {
    const state = makeMockDOState({ leafId: "prev" });
    const session = makeSession(state);

    await session.appendCustomMessage("my-type", "hello content", true);

    expect(state.pendingEntries).toHaveLength(1);
    expect(state.branchEntries).toHaveLength(1);
    const entry = state.pendingEntries[0];
    expect(entry?.type).toBe("custom_message");
    expect((entry?.data as { customType: string }).customType).toBe("my-type");
    expect((entry?.data as { content: string }).content).toBe("hello content");
    expect((entry?.data as { display: boolean }).display).toBe(true);
    expect(entry?.parentId).toBe("prev");
    expect(state.leafId).toBe(entry?.id);
  });

  it("appendCustomEntry() pushes a CustomEntry with payload", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);

    await session.appendCustomEntry("my-type", { foo: 42 });

    expect(state.pendingEntries).toHaveLength(1);
    const entry = state.pendingEntries[0];
    expect(entry?.type).toBe("custom");
    expect((entry?.data as { customType: string }).customType).toBe("my-type");
    expect((entry?.data as { payload: unknown }).payload).toEqual({ foo: 42 });
  });

  it("appendCustomEntry() without data stores undefined payload", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);

    await session.appendCustomEntry("no-payload");

    const entry = state.pendingEntries[0];
    expect((entry?.data as { payload: unknown }).payload).toBeUndefined();
  });

  it("getEntries() returns all custom entries when no filter", async () => {
    const state = makeMockDOState();
    const entries: AnyEntry[] = [
      {
        id: "e1",
        sessionId: "s",
        parentId: null,
        type: "custom",
        timestamp: "2024-01-01T00:00:00.000Z",
        data: { customType: "type-a", payload: { x: 1 } },
      },
      {
        id: "e2",
        sessionId: "s",
        parentId: "e1",
        type: "custom",
        timestamp: "2024-01-01T00:01:00.000Z",
        data: { customType: "type-b", payload: { x: 2 } },
      },
      // non-custom entry — should be excluded
      {
        id: "e3",
        sessionId: "s",
        parentId: "e2",
        type: "message",
        timestamp: "2024-01-01T00:02:00.000Z",
        data: { role: "user", content: "hi" },
      },
    ];
    state.branchEntries = entries;
    const session = makeSession(state);

    const result = await session.getEntries();

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("e1");
    expect(result[0]?.customType).toBe("type-a");
    expect(result[0]?.data).toEqual({ x: 1 });
    expect(result[1]?.id).toBe("e2");
    expect(result[1]?.customType).toBe("type-b");
  });

  it("getEntries(customType) filters to matching entries only", async () => {
    const state = makeMockDOState();
    state.branchEntries = [
      {
        id: "e1",
        sessionId: "s",
        parentId: null,
        type: "custom",
        timestamp: "2024-01-01T00:00:00.000Z",
        data: { customType: "type-a", payload: 1 },
      },
      {
        id: "e2",
        sessionId: "s",
        parentId: "e1",
        type: "custom",
        timestamp: "2024-01-01T00:01:00.000Z",
        data: { customType: "type-b", payload: 2 },
      },
    ];
    const session = makeSession(state);

    const result = await session.getEntries("type-a");

    expect(result).toHaveLength(1);
    expect(result[0]?.customType).toBe("type-a");
    expect(result[0]?.data).toBe(1);
  });

  it("getEntries(customType) returns empty array when no match", async () => {
    const state = makeMockDOState();
    state.branchEntries = [
      {
        id: "e1",
        sessionId: "s",
        parentId: null,
        type: "custom",
        timestamp: "2024-01-01T00:00:00.000Z",
        data: { customType: "type-a", payload: null },
      },
    ];
    const session = makeSession(state);

    const result = await session.getEntries("type-z");

    expect(result).toHaveLength(0);
  });
});

describe("SessionImpl — context usage", () => {
  it("getContextUsage() returns ContextUsage shape", async () => {
    const state = makeMockDOState({
      lastInputTokens: 50,
      lastContextWindowTokens: 1000,
    });
    const session = makeSession(state);
    const usage = await session.getContextUsage();

    expect(typeof usage.inputTokens).toBe("number");
    expect(usage.contextWindowTokens).toBe(1000);
    expect(typeof usage.usedFraction).toBe("number");
    expect(usage.usedFraction).toBeGreaterThanOrEqual(0);
  });

  it("getContextUsage() usedFraction is inputTokens/contextWindowTokens", async () => {
    const state = makeMockDOState({
      lastInputTokens: 100,
      lastContextWindowTokens: 200_000,
    });
    const session = makeSession(state);
    const usage = await session.getContextUsage();
    // 100 base + small heuristic for empty messages
    expect(usage.usedFraction).toBeCloseTo(usage.inputTokens / 200_000, 5);
  });
});

describe("SessionImpl — system prompt", () => {
  it("getSystemPrompt() returns doState.assembledSystemPrompt", async () => {
    const state = makeMockDOState({ assembledSystemPrompt: "my prompt text" });
    const session = makeSession(state);
    expect(await session.getSystemPrompt()).toBe("my prompt text");
  });
});

describe("SessionImpl — multiple entries update leafId chain", () => {
  it("sequential appends form a parent-child chain via leafId", async () => {
    const state = makeMockDOState({ leafId: null });
    const session = makeSession(state);

    await session.appendCustomEntry("type-1", "first");
    const firstId = state.leafId;
    expect(firstId).not.toBeNull();

    await session.appendCustomEntry("type-2", "second");
    const secondId = state.leafId;
    expect(secondId).not.toBeNull();
    expect(secondId).not.toBe(firstId);

    // Second entry's parentId should be the first entry's id
    const secondEntry = state.pendingEntries[1];
    expect(secondEntry?.parentId).toBe(firstId);
  });
});

describe("SessionImpl — ISession implements IAgentSession", () => {
  it("SessionImpl satisfies IAgentSession (structural)", () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    // IAgentSession is intentionally empty — ISession extends it.
    // This test confirms the type relationship holds at runtime.
    const asAgentSession: IAgentSession = session;
    expect(asAgentSession).toBeDefined();
  });
});

describe("SessionImpl — not-yet-implemented methods throw", () => {
  it("prompt() throws with a clear message", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    await expect(session.prompt("hello")).rejects.toThrow("SessionImpl.prompt()");
  });

  it("branch() throws with a clear message", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    await expect(session.branch("some-entry-id")).rejects.toThrow("SessionImpl.branch()");
  });

  it("fork() throws with a clear message", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    await expect(session.fork()).rejects.toThrow("SessionImpl.fork()");
  });

  it("delete() throws with a clear message", async () => {
    const state = makeMockDOState();
    const session = makeSession(state);
    await expect(session.delete()).rejects.toThrow("SessionImpl.delete()");
  });
});
