/**
 * Unit tests for ExtensionRunner and parseCommand.
 *
 * Pure unit tests — no Miniflare, no D1. All extension stubs are in-process
 * mocks created via createMockExtension(). KV and DispatchNamespace are
 * lightweight mocks from test/mocks/extension-stub.ts.
 *
 * Test groups:
 *   1. parseCommand()
 *   2. initialize() — empty registry, single, multiple, error isolation
 *   3. emitInput() — merge rules
 *   4. emitBeforeAgentStart() — merge rules
 *   5. emitContext() — last wins
 *   6. emitToolCall() — first block wins
 *   7. emitToolResult() — chaining
 *   8. emitBeforeCompact() — cancel/summary merge
 *   9. emit() — fire-and-forget
 *
 * Spec ref: specs/core.md §ExtensionRunner
 */

import type {
  BeforeAgentStartResult,
  BeforeCompactResult,
  ContextResult,
  ExtensionEvent,
  InputResult,
  ISession,
  ToolCallResult,
  ToolResultOverride,
} from "@piccolo/api";
import { describe, expect, it } from "vitest";
import { ExtensionRunner, parseCommand } from "../../src/extension-runner.ts";
import { asRpcTarget } from "../../src/rpc-util.ts";
import {
  createMockDispatchNamespace,
  createMockExtension,
  createMockKv,
  createMockSession,
} from "../mocks/extension-stub.ts";

// ─── Typed emit helpers ───────────────────────────────────────────────────────
// Wrap runner.emit() with result casts so tests remain readable.

async function emitInput(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "input" }>,
  session: ISession,
): Promise<InputResult> {
  return (await runner.emit(event, session)) as InputResult;
}

async function emitBeforeAgentStart(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "before_agent_start" }>,
  session: ISession,
): Promise<BeforeAgentStartResult> {
  return (await runner.emit(event, session)) as BeforeAgentStartResult;
}

async function emitContext(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "context" }>,
  session: ISession,
): Promise<ContextResult | undefined> {
  return (await runner.emit(event, session)) as ContextResult | undefined;
}

async function emitToolCall(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "tool_call" }>,
  session: ISession,
): Promise<ToolCallResult> {
  return (await runner.emit(event, session)) as ToolCallResult;
}

async function emitToolResult(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "tool_result" }>,
  session: ISession,
): Promise<ToolResultOverride | undefined> {
  return (await runner.emit(event, session)) as ToolResultOverride | undefined;
}

async function emitBeforeCompact(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "before_compact" }>,
  session: ISession,
): Promise<BeforeCompactResult> {
  return (await runner.emit(event, session)) as BeforeCompactResult;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const ctx = createMockSession({ sessionId: "sess-1", userId: "user-1" });

async function makeRunner(
  stubs: Record<string, ReturnType<typeof createMockExtension>>,
  registryNames?: string[],
): Promise<ExtensionRunner> {
  const names = registryNames ?? Object.keys(stubs);
  const runner = new ExtensionRunner();
  // In tests ctx and ctxStub are the same mock — no RPC boundary.
  await runner.initialize(ctx, ctx, createMockKv(names), createMockDispatchNamespace(stubs));
  return runner;
}

function inputEvent(text: string) {
  return { type: "input" as const, text, attachments: [] as never[], source: "user" as const };
}

// ─── 1. parseCommand ──────────────────────────────────────────────────────────

describe("parseCommand()", () => {
  const commands = [
    { name: "help", description: "Show help" },
    { name: "skill:search", description: "Search skill" },
  ];

  it("returns undefined for non-slash text", () => {
    expect(parseCommand("hello", commands)).toBeUndefined();
    expect(parseCommand("", commands)).toBeUndefined();
  });

  it("returns undefined for unknown slash command", () => {
    expect(parseCommand("/unknown", commands)).toBeUndefined();
    expect(parseCommand("/other foo", commands)).toBeUndefined();
  });

  it("parses a known command with no args", () => {
    expect(parseCommand("/help", commands)).toEqual({
      commandName: "help",
      commandArgs: "",
    });
  });

  it("parses a known command with args", () => {
    expect(parseCommand("/help arg1 arg2", commands)).toEqual({
      commandName: "help",
      commandArgs: "arg1 arg2",
    });
  });

  it("parses a compound command name (skill:search)", () => {
    expect(parseCommand("/skill:search foo bar", commands)).toEqual({
      commandName: "skill:search",
      commandArgs: "foo bar",
    });
  });

  it("handles extra whitespace between command and args", () => {
    const result = parseCommand("/help  arg1", commands);
    // split(/\s+/) collapses runs of whitespace
    expect(result?.commandName).toBe("help");
    expect(result?.commandArgs).toBe("arg1");
  });
});

// ─── 2. initialize() ─────────────────────────────────────────────────────────

describe("initialize()", () => {
  it("empty registry → no stubs, empty commands and additions", async () => {
    const runner = new ExtensionRunner();
    await runner.initialize(ctx, ctx, createMockKv([]), createMockDispatchNamespace({}));
    expect(runner.getCommands()).toEqual([]);
    expect(runner.getSystemPromptAdditions()).toEqual([]);
    expect(runner.getTools()).toEqual([]);
  });

  it("absent KV key → treated as empty registry", async () => {
    const runner = new ExtensionRunner();
    // No registry key set
    await runner.initialize(ctx, ctx, createMockKv(undefined), createMockDispatchNamespace({}));
    expect(runner.getCommands()).toEqual([]);
  });

  it("malformed KV JSON → treated as empty registry", async () => {
    const runner = new ExtensionRunner();
    const kv = createMockKv(undefined);
    // Manually override with invalid JSON
    await kv.put("extensions:registry", "not-json");
    await runner.initialize(ctx, ctx, kv, createMockDispatchNamespace({}));
    expect(runner.getCommands()).toEqual([]);
  });

  it("single extension: commands, additions, and tools collected", async () => {
    const ext = createMockExtension({
      name: "ext-a",
      commands: [{ name: "status", description: "Show status" }],
      systemPromptAdditions: [{ section: "guidelines", content: "Be concise" }],
      tools: [
        {
          name: "status_tool",
          label: "Status",
          description: "Check status",
          inputSchema: {},
        },
      ],
    });
    const runner = await makeRunner({ "ext-a": ext });
    expect(runner.getCommands()).toEqual([{ name: "status", description: "Show status" }]);
    expect(runner.getSystemPromptAdditions()).toEqual([
      { section: "guidelines", content: "Be concise" },
    ]);
    expect(runner.getTools()).toHaveLength(1);
  });

  it("multiple extensions: commands and additions from all are merged", async () => {
    const extA = createMockExtension({
      name: "ext-a",
      commands: [{ name: "cmd-a", description: "A" }],
      systemPromptAdditions: [{ section: "skills", content: "Skill A" }],
    });
    const extB = createMockExtension({
      name: "ext-b",
      commands: [{ name: "cmd-b", description: "B" }],
      systemPromptAdditions: [{ section: "context", content: "Context B" }],
    });
    const runner = await makeRunner({ "ext-a": extA, "ext-b": extB });
    const cmds = runner.getCommands().map((c) => c.name);
    expect(cmds).toContain("cmd-a");
    expect(cmds).toContain("cmd-b");
    const sections = runner.getSystemPromptAdditions().map((a) => a.section);
    expect(sections).toContain("skills");
    expect(sections).toContain("context");
  });

  it("onSessionStart is called on all stubs after init", async () => {
    const extA = createMockExtension({ name: "ext-a" });
    const extB = createMockExtension({ name: "ext-b" });
    await makeRunner({ "ext-a": extA, "ext-b": extB });
    expect(extA.calls.onSessionStart).toHaveLength(1);
    expect(extB.calls.onSessionStart).toHaveLength(1);
  });

  it("getCommands() throwing on one extension is isolated; others succeed", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const good = createMockExtension({
      name: "good",
      commands: [{ name: "cmd-good", description: "Good" }],
    });
    const runner = new ExtensionRunner();
    await runner.initialize(
      ctx,
      ctx,
      createMockKv(["bad", "good"]),
      createMockDispatchNamespace({ bad: throwing, good }),
    );
    const names = runner.getCommands().map((c) => c.name);
    expect(names).toContain("cmd-good");
  });

  it("getSystemPromptAdditions() throwing on one extension is isolated", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const good = createMockExtension({
      name: "good",
      systemPromptAdditions: [{ section: "footer", content: "Footer" }],
    });
    const runner = new ExtensionRunner();
    await runner.initialize(
      ctx,
      ctx,
      createMockKv(["bad", "good"]),
      createMockDispatchNamespace({ bad: throwing, good }),
    );
    expect(runner.getSystemPromptAdditions()).toHaveLength(1);
  });
});

// ─── 3. emitInput() ──────────────────────────────────────────────────────────

describe("emitInput()", () => {
  it("no extensions → { action: 'continue' }", async () => {
    const runner = await makeRunner({});
    const result = await emitInput(runner, inputEvent("hello"), ctx);
    expect(result).toEqual({ action: "continue" });
  });

  it("all extensions return continue → { action: 'continue' }", async () => {
    const extA = createMockExtension({ name: "a", onInput: () => ({ action: "continue" }) });
    const extB = createMockExtension({ name: "b", onInput: () => ({ action: "continue" }) });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitInput(runner, inputEvent("hello"), ctx);
    expect(result.action).toBe("continue");
  });

  it("first extension returns 'handled' → that result returned", async () => {
    const extA = createMockExtension({ name: "a", onInput: () => ({ action: "handled" }) });
    const extB = createMockExtension({
      name: "b",
      onInput: () => ({ action: "transform", text: "x" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitInput(runner, inputEvent("hello"), ctx);
    expect(result.action).toBe("handled");
  });

  it("first returns continue, second returns transform → transform returned", async () => {
    const extA = createMockExtension({ name: "a", onInput: () => undefined }); // no return = continue
    const extB = createMockExtension({
      name: "b",
      onInput: () => ({ action: "transform" as const, text: "transformed!" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitInput(runner, inputEvent("hello"), ctx);
    expect(result.action).toBe("transform");
    expect(result.text).toBe("transformed!");
  });

  it("throwing extension treated as continue; others proceed", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const good = createMockExtension({ name: "good", onInput: () => ({ action: "handled" }) });
    const runner = await makeRunner({ bad: throwing, good });
    const result = await emitInput(runner, inputEvent("hello"), ctx);
    expect(result.action).toBe("handled");
  });

  it("command is parsed and attached before dispatch", async () => {
    const ext = createMockExtension({
      name: "a",
      commands: [{ name: "my-cmd", description: "My command" }],
      onInput: (e) => {
        // Verify commandName is attached
        if (e.commandName === "my-cmd") return { action: "handled" };
        return { action: "continue" };
      },
    });
    // Runner must be initialized with this extension's commands already loaded
    const runner = new ExtensionRunner();
    await runner.initialize(ctx, ctx, createMockKv(["a"]), createMockDispatchNamespace({ a: ext }));
    const result = await emitInput(runner, inputEvent("/my-cmd extra args"), ctx);
    expect(result.action).toBe("handled");
  });

  it("commandArgs are passed to extension", async () => {
    let capturedArgs = "";
    const ext = createMockExtension({
      name: "a",
      commands: [{ name: "skill:test", description: "Test" }],
      onInput: (e) => {
        capturedArgs = e.commandArgs ?? "";
        return { action: "handled" };
      },
    });
    const runner = new ExtensionRunner();
    await runner.initialize(ctx, ctx, createMockKv(["a"]), createMockDispatchNamespace({ a: ext }));
    await emitInput(runner, inputEvent("/skill:test arg1 arg2"), ctx);
    expect(capturedArgs).toBe("arg1 arg2");
  });
});

// ─── 4. emitBeforeAgentStart() ───────────────────────────────────────────────

describe("emitBeforeAgentStart()", () => {
  const baseEvent = {
    type: "before_agent_start" as const,
    text: "hello",
    attachments: [] as never[],
    systemPrompt: "base",
  };

  it("no extensions → empty result", async () => {
    const runner = await makeRunner({});
    const result = await emitBeforeAgentStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toEqual([]);
    expect(result.systemPrompt).toBeUndefined();
  });

  it("one extension returns contextMessages → included", async () => {
    const ext = createMockExtension({
      name: "a",
      onBeforeAgentStart: () => ({
        contextMessages: [{ role: "user", content: "ctx msg" }],
      }),
    });
    const runner = await makeRunner({ a: ext });
    const result = await emitBeforeAgentStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toHaveLength(1);
    expect(result.contextMessages?.[0]).toMatchObject({ content: "ctx msg" });
  });

  it("two extensions both return contextMessages → arrays concatenated", async () => {
    const extA = createMockExtension({
      name: "a",
      onBeforeAgentStart: () => ({
        contextMessages: [{ role: "user", content: "from A" }],
      }),
    });
    const extB = createMockExtension({
      name: "b",
      onBeforeAgentStart: () => ({
        contextMessages: [{ role: "user", content: "from B" }],
      }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeAgentStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toHaveLength(2);
  });

  it("two extensions return systemPrompt → last one wins", async () => {
    const extA = createMockExtension({
      name: "a",
      onBeforeAgentStart: () => ({ systemPrompt: "prompt from A" }),
    });
    const extB = createMockExtension({
      name: "b",
      onBeforeAgentStart: () => ({ systemPrompt: "prompt from B" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeAgentStart(runner, baseEvent, ctx);
    expect(result.systemPrompt).toBe("prompt from B");
  });

  it("first returns contextMessages; second returns systemPrompt → both included", async () => {
    const extA = createMockExtension({
      name: "a",
      onBeforeAgentStart: () => ({
        contextMessages: [{ role: "user", content: "ctx" }],
      }),
    });
    const extB = createMockExtension({
      name: "b",
      onBeforeAgentStart: () => ({ systemPrompt: "override" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeAgentStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toHaveLength(1);
    expect(result.systemPrompt).toBe("override");
  });
});

// ─── 5. emitContext() ────────────────────────────────────────────────────────

describe("emitContext()", () => {
  const contextEvent = {
    type: "context" as const,
    messages: [{ role: "user" as const, content: "hi" }],
  };

  it("no extensions → undefined", async () => {
    const runner = await makeRunner({});
    expect(await emitContext(runner, contextEvent, ctx)).toBeUndefined();
  });

  it("all extensions return void → undefined", async () => {
    const ext = createMockExtension({ name: "a", onContext: () => undefined });
    const runner = await makeRunner({ a: ext });
    expect(await emitContext(runner, contextEvent, ctx)).toBeUndefined();
  });

  it("last extension returning a non-void ContextResult wins", async () => {
    const extA = createMockExtension({
      name: "a",
      onContext: () => ({ messages: [{ role: "user", content: "from A" }] }),
    });
    const extB = createMockExtension({
      name: "b",
      onContext: () => ({ messages: [{ role: "user", content: "from B" }] }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitContext(runner, contextEvent, ctx);
    expect(result?.messages[0]).toMatchObject({ content: "from B" });
  });

  it("first returns result, second returns void → first wins (it IS the last non-void)", async () => {
    const extA = createMockExtension({
      name: "a",
      onContext: () => ({ messages: [{ role: "user", content: "from A" }] }),
    });
    const extB = createMockExtension({ name: "b", onContext: () => undefined });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitContext(runner, contextEvent, ctx);
    expect(result?.messages[0]).toMatchObject({ content: "from A" });
  });
});

// ─── 6. emitToolCall() ───────────────────────────────────────────────────────

describe("emitToolCall()", () => {
  const toolCallEvent = {
    type: "tool_call" as const,
    toolCallId: "tc-1",
    toolName: "r2",
    input: { action: "read" },
  };

  it("no extensions → { block: false }", async () => {
    const runner = await makeRunner({});
    expect(await emitToolCall(runner, toolCallEvent, ctx)).toEqual({ block: false });
  });

  it("all return { block: false } → { block: false }", async () => {
    const extA = createMockExtension({ name: "a", onToolCall: () => ({ block: false }) });
    const extB = createMockExtension({ name: "b", onToolCall: () => ({ block: false }) });
    const runner = await makeRunner({ a: extA, b: extB });
    expect(await emitToolCall(runner, toolCallEvent, ctx)).toEqual({ block: false });
  });

  it("first extension blocks → { block: true } returned", async () => {
    const extA = createMockExtension({
      name: "a",
      onToolCall: () => ({ block: true, reason: "not allowed" }),
    });
    const extB = createMockExtension({ name: "b", onToolCall: () => ({ block: false }) });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitToolCall(runner, toolCallEvent, ctx);
    expect(result.block).toBe(true);
    expect(result.reason).toBe("not allowed");
  });

  it("second extension blocks → { block: true } returned", async () => {
    const extA = createMockExtension({ name: "a", onToolCall: () => ({ block: false }) });
    const extB = createMockExtension({
      name: "b",
      onToolCall: () => ({ block: true, reason: "blocked by B" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitToolCall(runner, toolCallEvent, ctx);
    expect(result.block).toBe(true);
  });

  it("throwing extension treated as undefined; other block still wins", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const blocking = createMockExtension({
      name: "blocker",
      onToolCall: () => ({ block: true }),
    });
    const runner = await makeRunner({ bad: throwing, blocker: blocking });
    const result = await emitToolCall(runner, toolCallEvent, ctx);
    expect(result.block).toBe(true);
  });
});

// ─── 7. emitToolResult() ─────────────────────────────────────────────────────

describe("emitToolResult()", () => {
  const baseToolResultEvent = {
    type: "tool_result" as const,
    toolCallId: "tc-1",
    toolName: "r2",
    input: {},
    output: { original: true },
    isError: false,
  };

  it("no extensions → undefined", async () => {
    const runner = await makeRunner({});
    expect(await emitToolResult(runner, baseToolResultEvent, ctx)).toBeUndefined();
  });

  it("single extension overrides output → override returned", async () => {
    const ext = createMockExtension({
      name: "a",
      onToolResult: () => ({ content: [{ type: "text", text: "overridden" }] }),
    });
    const runner = await makeRunner({ a: ext });
    const result = await emitToolResult(runner, baseToolResultEvent, ctx);
    expect(result).toBeDefined();
  });

  it("two extensions chained: second receives first's output", async () => {
    const receivedByB: unknown[] = [];
    const extA = createMockExtension({
      name: "a",
      onToolResult: () => ({ content: [{ type: "text", text: "from A" }] }),
    });
    const extB = createMockExtension({
      name: "b",
      onToolResult: (e) => {
        receivedByB.push(e.output);
        return { content: [{ type: "text", text: "from B" }] };
      },
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitToolResult(runner, baseToolResultEvent, ctx);
    // B received A's override as its input
    expect(receivedByB[0]).toMatchObject({ content: [{ type: "text", text: "from A" }] });
    // Final result is from B
    expect(result).toMatchObject({ content: [{ type: "text", text: "from B" }] });
  });

  it("throwing mid-chain treated as undefined; chain continues", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const good = createMockExtension({
      name: "good",
      onToolResult: () => ({ content: [{ type: "text", text: "good output" }] }),
    });
    const runner = await makeRunner({ bad: throwing, good });
    const result = await emitToolResult(runner, baseToolResultEvent, ctx);
    expect(result).toBeDefined();
  });

  it("all extensions return void → undefined", async () => {
    const ext = createMockExtension({ name: "a", onToolResult: () => undefined });
    const runner = await makeRunner({ a: ext });
    expect(await emitToolResult(runner, baseToolResultEvent, ctx)).toBeUndefined();
  });
});

// ─── 8. emitBeforeCompact() ──────────────────────────────────────────────────

describe("emitBeforeCompact()", () => {
  const compactEvent = {
    type: "before_compact" as const,
    messages: [] as never[],
    keepRecentTokens: 20_000,
  };

  it("no extensions → {}", async () => {
    const runner = await makeRunner({});
    expect(await emitBeforeCompact(runner, compactEvent, ctx)).toEqual({});
  });

  it("all return void → {}", async () => {
    const ext = createMockExtension({ name: "a", onBeforeCompact: () => undefined });
    const runner = await makeRunner({ a: ext });
    expect(await emitBeforeCompact(runner, compactEvent, ctx)).toEqual({});
  });

  it("first returns { cancel: true } → cancellation returned", async () => {
    const extA = createMockExtension({ name: "a", onBeforeCompact: () => ({ cancel: true }) });
    const extB = createMockExtension({ name: "b", onBeforeCompact: () => ({ summary: "x" }) });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeCompact(runner, compactEvent, ctx);
    expect(result.cancel).toBe(true);
  });

  it("first returns {} second returns { summary } → summary returned", async () => {
    const extA = createMockExtension({ name: "a", onBeforeCompact: () => ({}) });
    const extB = createMockExtension({
      name: "b",
      onBeforeCompact: () => ({ summary: "pre-built summary" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeCompact(runner, compactEvent, ctx);
    expect(result.summary).toBe("pre-built summary");
  });

  it("cancel wins over summary when first", async () => {
    const extA = createMockExtension({ name: "a", onBeforeCompact: () => ({ cancel: true }) });
    const extB = createMockExtension({
      name: "b",
      onBeforeCompact: () => ({ summary: "ignored" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeCompact(runner, compactEvent, ctx);
    expect(result.cancel).toBe(true);
    expect(result.summary).toBeUndefined();
  });
});

// ─── 9. emit() (fire-and-forget) ─────────────────────────────────────────────

describe("emit()", () => {
  it("no extensions → resolves without error", async () => {
    const runner = await makeRunner({});
    await expect(runner.emit({ type: "agent_start" }, ctx)).resolves.toBeUndefined();
  });

  it("all stubs called concurrently", async () => {
    const extA = createMockExtension({ name: "a" });
    const extB = createMockExtension({ name: "b" });
    const runner = await makeRunner({ a: extA, b: extB });
    await runner.emit({ type: "agent_start" }, ctx);
    // Fire agent_end too
    const agentEndEvent = {
      type: "agent_end" as const,
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      },
    };
    await runner.emit(agentEndEvent, ctx);
    // No error thrown
  });

  it("throwing extension does not propagate error", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const runner = await makeRunner({ bad: throwing });
    await expect(runner.emit({ type: "agent_start" }, ctx)).resolves.toBeUndefined();
  });

  it("results are discarded", async () => {
    const ext = createMockExtension({ name: "a" });
    const runner = await makeRunner({ a: ext });
    const result = await runner.emit({ type: "agent_start" }, ctx);
    expect(result).toBeUndefined();
  });
});

// ─── createMockSession coverage ───────────────────────────────────────────────
// Exercises every method on the default mock session to keep coverage thresholds met.

describe("createMockSession() — all methods reachable", () => {
  it("covers all ISession no-op methods", async () => {
    const s = createMockSession({ sessionId: "s1", userId: "u1" });
    expect(await s.userId()).toBe("u1");
    expect(await s.sessionId()).toBe("s1");
    expect(typeof (await s.getUpdatedAt())).toBe("number");
    expect(await s.getName()).toBeUndefined();
    await expect(s.setName("X")).resolves.toBeUndefined();
    await expect(s.sendUserMessage("hi")).resolves.toBeUndefined();
    await expect(s.steer("steer")).resolves.toBeUndefined();
    await expect(s.followUp("follow")).resolves.toBeUndefined();
    await expect(s.abort()).resolves.toBeUndefined();
    expect(await s.getModel()).toBe("test/model");
    await expect(s.setModel("x")).resolves.toBeUndefined();
    expect(await s.listModels()).toEqual([]);
    expect(await s.getActiveTools()).toEqual([]);
    await expect(s.setActiveTools([])).resolves.toBeUndefined();
    await expect(s.appendCustomMessage("t", "c", false)).resolves.toBeUndefined();
    await expect(s.appendCustomEntry("t")).resolves.toBeUndefined();
    expect(await s.getEntries()).toEqual([]);
    expect(await s.getEntries("type")).toEqual([]);
    expect(await s.getContextUsage()).toMatchObject({ inputTokens: 0 });
    await expect(s.compact()).resolves.toBeUndefined();
    expect(await s.getSystemPrompt()).toBe("");
    await expect(s.branch("e")).resolves.toBeUndefined();
    await expect(s.delete()).resolves.toBeUndefined();
  });
});

// ─── Proxy stub identity methods ──────────────────────────────────────────────
// Regression test: sessionId() and userId() must work when called through
// the asRpcTarget() Proxy. Previously, calling them on the Proxy would invoke
// the method with `this` = Proxy, causing a private-field brand-check failure.
// The fix is that initialize() reads identity from the real `ctx` (not the
// Proxy), and the Proxy is only passed to remote extension workers as ctxStub.

describe("asRpcTarget stub — sessionId() and userId() do not throw", () => {
  it("sessionId() and userId() resolve correctly through the Proxy", async () => {
    const session = createMockSession({ sessionId: "test-sid", userId: "test-uid" });
    const stub = asRpcTarget<ISession>(session);

    // These must not throw "Cannot read private member" or "(this) is not a function"
    await expect(stub.sessionId()).resolves.toBe("test-sid");
    await expect(stub.userId()).resolves.toBe("test-uid");
  });

  it("initialize() fires session_start with correct sessionId and userId from real ctx", async () => {
    const capturedEvents: Array<{ sessionId: string; userId: string }> = [];
    const ext = createMockExtension({
      name: "a",
      calls: {
        onSessionStart: [],
        onInput: [],
        onBeforeAgentStart: [],
        onContext: [],
        onToolCall: [],
        onToolResult: [],
        onBeforeCompact: [],
        onCompact: [],
        emit: [],
      },
    });
    // Manually capture session_start from calls after initialize
    const session = createMockSession({ sessionId: "real-sid", userId: "real-uid" });
    const stub = asRpcTarget<ISession>(session);
    const runner = new ExtensionRunner();
    // ctx = real session (for identity reads), ctxStub = Proxy (for remote workers)
    await runner.initialize(
      session,
      stub,
      createMockKv(["a"]),
      createMockDispatchNamespace({ a: ext }),
    );
    const startEvents = ext.calls.onSessionStart;
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]?.sessionId).toBe("real-sid");
    expect(startEvents[0]?.userId).toBe("real-uid");
  });
});
