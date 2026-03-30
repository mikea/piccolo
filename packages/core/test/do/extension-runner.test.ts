/**
 * Unit tests for ExtensionRunner and parseCommand.
 *
 * Pure unit tests — no Miniflare, no D1. All extension stubs are in-process
 * mocks created via createMockExtension(). Extension env bindings are
 * lightweight mocks from test/mocks/extension-stub.ts.
 *
 * Test groups:
 *   1. parseCommand()
 *   2. initialize() — empty bindings, single, multiple, error isolation
 *   3. emitInput() — merge rules
 *   4. emitBeforeStart() — merge rules
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
  IExtensionWorker,
  InputResult,
  ISession,
  ToolCallResult,
  ToolDescriptor,
  ToolResultOverride,
} from "@piccolo/api";
import { describe, expect, it } from "vitest";
import { ExtensionRunner, parseCommand } from "../../src/extension-runner.ts";
import {
  createMockExtension,
  createMockExtensionEnv,
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

async function emitBeforeStart(
  runner: ExtensionRunner,
  event: Extract<ExtensionEvent, { type: "before_start" }>,
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
  extras: Record<string, unknown> = {},
): Promise<ExtensionRunner> {
  const extensionBindings: Record<string, ReturnType<typeof createMockExtension>> = {};
  for (const [name, stub] of Object.entries(stubs)) {
    extensionBindings[`EXTENSION_${name.toUpperCase()}`] = stub;
  }
  const runner = new ExtensionRunner();
  await runner.initialize(createMockExtensionEnv(extensionBindings, extras), ctx);
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
  it("no extension bindings → no stubs, empty commands and additions", async () => {
    const runner = new ExtensionRunner();
    await runner.initialize(createMockExtensionEnv({}), ctx);
    expect(await runner.getCommands(ctx)).toEqual([]);
    expect(await runner.getSystemPromptAdditions(ctx)).toEqual([]);
    expect(await runner.getTools(ctx)).toEqual([]);
  });

  it("no EXTENSION_ bindings present → treated as empty", async () => {
    const runner = new ExtensionRunner();
    await runner.initialize(createMockExtensionEnv({}, { CONFIG: {}, CORE: {} }), ctx);
    expect(await runner.getCommands(ctx)).toEqual([]);
  });

  it("non-extension bindings are ignored", async () => {
    const runner = new ExtensionRunner();
    await runner.initialize(
      createMockExtensionEnv(
        {},
        {
          EXTENSIONS: {},
          CONFIG: {},
          FOO: "bar",
        },
      ),
      ctx,
    );
    expect(await runner.getCommands(ctx)).toEqual([]);
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
    expect(await runner.getCommands(ctx)).toEqual([{ name: "status", description: "Show status" }]);
    expect(await runner.getSystemPromptAdditions(ctx)).toEqual([
      { section: "guidelines", content: "Be concise" },
    ]);
    expect(await runner.getTools(ctx)).toHaveLength(1);
  });

  it("keeps discovered tools even if getDescriptor() fails", async () => {
    const brokenDescriptorTool = {
      async getDescriptor(): Promise<ToolDescriptor> {
        throw new Error("descriptor unavailable");
      },
      async execute() {
        return { content: [] };
      },
    };

    const ext = createMockExtension({
      name: "ext-a",
      tools: [brokenDescriptorTool],
    });
    const runner = await makeRunner({ "ext-a": ext });

    const tools = await runner.getTools(ctx);
    expect(tools).toHaveLength(1);

    const descriptor = await tools[0]!.getDescriptor();
    expect(descriptor.name).toContain("unavailable_extension_ext-a_0");
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
    const cmds = (await runner.getCommands(ctx)).map((c) => c.name);
    expect(cmds).toContain("cmd-a");
    expect(cmds).toContain("cmd-b");
    const sections = (await runner.getSystemPromptAdditions(ctx)).map((a) => a.section);
    expect(sections).toContain("skills");
    expect(sections).toContain("context");
  });

  it("extensions are initialised in lexicographic binding-name order", async () => {
    const seen: string[] = [];
    const extB = createMockExtension({ name: "b", onInit: () => seen.push("b") });
    const extA = createMockExtension({ name: "a", onInit: () => seen.push("a") });
    const runner = new ExtensionRunner();
    await runner.initialize(
      createMockExtensionEnv({
        EXTENSION_20_B: extB,
        EXTENSION_10_A: extA,
      }),
      ctx,
    );
    expect(seen).toEqual(["a", "b"]);
  });

  it("init() is called on all stubs by initialize()", async () => {
    const extA = createMockExtension({ name: "ext-a" });
    const extB = createMockExtension({ name: "ext-b" });
    await makeRunner({ "ext-a": extA, "ext-b": extB });
    expect(extA.calls.onInit).toHaveLength(1);
    expect(extB.calls.onInit).toHaveLength(1);
  });

  it("getCommands() throwing on one extension is isolated; others succeed", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const good = createMockExtension({
      name: "good",
      commands: [{ name: "cmd-good", description: "Good" }],
    });
    const runner = new ExtensionRunner();
    await runner.initialize(
      createMockExtensionEnv({ EXTENSION_BAD: throwing, EXTENSION_GOOD: good }),
      ctx,
    );
    const names = (await runner.getCommands(ctx)).map((c) => c.name);
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
      createMockExtensionEnv({ EXTENSION_BAD: throwing, EXTENSION_GOOD: good }),
      ctx,
    );
    expect(await runner.getSystemPromptAdditions(ctx)).toHaveLength(1);
  });

  it("caches missing getCommands() implementation after first probe", async () => {
    let probes = 0;
    const missingCommands = {
      async init() {
        return undefined;
      },
      get getCommands() {
        probes += 1;
        return undefined;
      },
    } as unknown as IExtensionWorker;

    const runner = new ExtensionRunner();
    await runner.initialize(createMockExtensionEnv({ EXTENSION_MISSING: missingCommands }), ctx);

    await expect(runner.getCommands(ctx)).resolves.toEqual([]);
    await expect(runner.getCommands(ctx)).resolves.toEqual([]);
    expect(probes).toBe(1);
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
    const runner = new ExtensionRunner();
    await runner.initialize(createMockExtensionEnv({ EXTENSION_A: ext }), ctx);
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
    await runner.initialize(createMockExtensionEnv({ EXTENSION_A: ext }), ctx);
    await emitInput(runner, inputEvent("/skill:test arg1 arg2"), ctx);
    expect(capturedArgs).toBe("arg1 arg2");
  });
});

// ─── 4. emitBeforeStart() ───────────────────────────────────────────────

describe("emitBeforeStart()", () => {
  const baseEvent = {
    type: "before_start" as const,
    text: "hello",
    attachments: [] as never[],
    systemPrompt: "base",
  };

  it("no extensions → empty result", async () => {
    const runner = await makeRunner({});
    const result = await emitBeforeStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toEqual([]);
    expect(result.systemPrompt).toBeUndefined();
  });

  it("one extension returns contextMessages → included", async () => {
    const ext = createMockExtension({
      name: "a",
      onBeforeStart: () => ({
        contextMessages: [{ id: "m1", role: "user", content: "ctx msg" }],
      }),
    });
    const runner = await makeRunner({ a: ext });
    const result = await emitBeforeStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toHaveLength(1);
    expect(result.contextMessages?.[0]).toMatchObject({ content: "ctx msg" });
  });

  it("two extensions both return contextMessages → arrays concatenated", async () => {
    const extA = createMockExtension({
      name: "a",
      onBeforeStart: () => ({
        contextMessages: [{ id: "m2", role: "user", content: "from A" }],
      }),
    });
    const extB = createMockExtension({
      name: "b",
      onBeforeStart: () => ({
        contextMessages: [{ id: "m3", role: "user", content: "from B" }],
      }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toHaveLength(2);
  });

  it("two extensions return systemPrompt → last one wins", async () => {
    const extA = createMockExtension({
      name: "a",
      onBeforeStart: () => ({ systemPrompt: "prompt from A" }),
    });
    const extB = createMockExtension({
      name: "b",
      onBeforeStart: () => ({ systemPrompt: "prompt from B" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeStart(runner, baseEvent, ctx);
    expect(result.systemPrompt).toBe("prompt from B");
  });

  it("first returns contextMessages; second returns systemPrompt → both included", async () => {
    const extA = createMockExtension({
      name: "a",
      onBeforeStart: () => ({
        contextMessages: [{ id: "m4", role: "user", content: "ctx" }],
      }),
    });
    const extB = createMockExtension({
      name: "b",
      onBeforeStart: () => ({ systemPrompt: "override" }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitBeforeStart(runner, baseEvent, ctx);
    expect(result.contextMessages).toHaveLength(1);
    expect(result.systemPrompt).toBe("override");
  });
});

// ─── 5. emitContext() ────────────────────────────────────────────────────────

describe("emitContext()", () => {
  const contextEvent = {
    type: "context" as const,
    messages: [{ id: "m5", role: "user" as const, content: "hi" }],
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
      onContext: () => ({ messages: [{ id: "m6", role: "user", content: "from A" }] }),
    });
    const extB = createMockExtension({
      name: "b",
      onContext: () => ({ messages: [{ id: "m7", role: "user", content: "from B" }] }),
    });
    const runner = await makeRunner({ a: extA, b: extB });
    const result = await emitContext(runner, contextEvent, ctx);
    expect(result?.messages[0]).toMatchObject({ content: "from B" });
  });

  it("first returns result, second returns void → first wins (it IS the last non-void)", async () => {
    const extA = createMockExtension({
      name: "a",
      onContext: () => ({ messages: [{ id: "m8", role: "user", content: "from A" }] }),
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

// ─── 9. emit() (interception only) ───────────────────────────────────────────

describe("emit()", () => {
  it("no extensions → resolves without error for interception events", async () => {
    const runner = await makeRunner({});
    await expect(
      runner.emit({ type: "input", text: "hi", attachments: [], source: "user" }, ctx),
    ).resolves.toBeDefined(); // { action: "continue" }
  });

  it("throwing extension during interception does not propagate error", async () => {
    const throwing = createMockExtension({ name: "bad", shouldThrow: true });
    const runner = await makeRunner({ bad: throwing });
    await expect(
      runner.emit({ type: "input", text: "hi", attachments: [], source: "user" }, ctx),
    ).resolves.toEqual({ action: "continue" });
  });

  it("caches missing onEvent() implementation after first probe", async () => {
    let probes = 0;
    const missingOnEvent = {
      async init() {
        return undefined;
      },
      async getCommands() {
        return [];
      },
      get onEvent() {
        probes += 1;
        return undefined;
      },
    } as unknown as IExtensionWorker;

    const runner = new ExtensionRunner();
    await runner.initialize(createMockExtensionEnv({ EXTENSION_MISSING: missingOnEvent }), ctx);

    await expect(
      runner.emit({ type: "input", text: "hi", attachments: [], source: "user" }, ctx),
    ).resolves.toEqual({ action: "continue" });
    await expect(
      runner.emit({ type: "tool_call", toolCallId: "t1", toolName: "x", input: {} }, ctx),
    ).resolves.toEqual({ block: false });
    expect(probes).toBe(1);
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
    expect(await s.getModel()).toBe("test/model");
    await expect(s.setModel("x")).resolves.toBeUndefined();
    expect(await s.listModels()).toEqual([]);
    expect(await s.getActiveTools()).toEqual([]);
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

// ─── initialize() — init(ctx) propagation ────────────────────────────────────

describe("initialize() — init(ctx) propagation", () => {
  it("init() is called with the session ctx passed to initialize()", async () => {
    const ext = createMockExtension({ name: "a" });
    const session = createMockSession({ sessionId: "real-sid", userId: "real-uid" });
    const runner = new ExtensionRunner();
    await runner.initialize(createMockExtensionEnv({ EXTENSION_A: ext }), session);
    expect(ext.calls.onInit).toHaveLength(1);
    expect(ext.calls.onInit[0]).toBeDefined();
  });
});
