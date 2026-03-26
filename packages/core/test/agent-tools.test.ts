/**
 * Unit tests for agent-tools.ts (toAiSdkTools).
 *
 * Spec ref: specs/core.md §Agent Loop §toAiSdkTools
 */

import type { ISession, ITool, ToolResult } from "@piccolo/api";
import { describe, expect, it, vi } from "vitest";
import { toAiSdkTools } from "../src/agent-tools.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal ISession stub — only needed as a passthrough in execute(). */
const mockSession = {} as ISession;

function makeTool(
  name: string,
  result: ToolResult = { content: [{ type: "text", text: "ok" }] },
): ITool {
  return {
    descriptor: {
      name,
      label: name,
      description: `${name} description`,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

// Helper to call the AI SDK execute without triggering exactOptionalPropertyTypes.
async function callExecute(
  execFn:
    | ((input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown>)
    | undefined,
  input: unknown,
  toolCallId: string,
): Promise<unknown> {
  if (!execFn) return undefined;
  return execFn(input, { toolCallId, messages: [] });
}

async function callExecuteWithSignal(
  execFn:
    | ((
        input: unknown,
        options: { toolCallId: string; messages: unknown[]; abortSignal: AbortSignal },
      ) => Promise<unknown>)
    | undefined,
  input: unknown,
  toolCallId: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!execFn) return undefined;
  return execFn(input, { toolCallId, messages: [], abortSignal: signal });
}

// ─── toAiSdkTools ─────────────────────────────────────────────────────────────

describe("toAiSdkTools", () => {
  it("returns empty record for empty tools array", () => {
    const result = toAiSdkTools([], mockSession);
    expect(result).toEqual({});
  });

  it("uses descriptor.name as the record key", () => {
    const t = makeTool("my_tool");
    const result = toAiSdkTools([t], mockSession);
    expect(Object.keys(result)).toEqual(["my_tool"]);
  });

  it("creates a separate entry per tool", () => {
    const tools = [makeTool("tool_a"), makeTool("tool_b"), makeTool("tool_c")];
    const result = toAiSdkTools(tools, mockSession);
    expect(Object.keys(result).sort()).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  it("produced tool has description matching descriptor", () => {
    const t = makeTool("greet");
    const sdkTools = toAiSdkTools([t], mockSession);
    const sdkTool = sdkTools["greet"];
    expect(sdkTool).toBeDefined();
    expect(sdkTool?.description).toBe("greet description");
  });

  it("execute() on the AI SDK tool calls ITool.execute() with the session", async () => {
    const t = makeTool("echo", { content: [{ type: "text", text: "echoed" }] });
    const sdkTools = toAiSdkTools([t], mockSession);
    const sdkTool = sdkTools["echo"];
    expect(sdkTool).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: test-only cast for AI SDK internal type
    const result = await callExecute(sdkTool?.execute as any, { value: "test" }, "call_1");
    expect(result).toEqual({ content: [{ type: "text", text: "echoed" }] });
    expect(t.execute).toHaveBeenCalledWith("call_1", { value: "test" }, mockSession, undefined);
  });

  it("passes abortSignal through to ITool.execute()", async () => {
    const t = makeTool("abort_tool");
    const sdkTools = toAiSdkTools([t], mockSession);
    const sdkTool = sdkTools["abort_tool"];
    const signal = new AbortController().signal;
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast for AI SDK internal type
    await callExecuteWithSignal(sdkTool?.execute as any, { value: "x" }, "call_2", signal);
    expect(t.execute).toHaveBeenCalledWith("call_2", { value: "x" }, mockSession, signal);
  });
});
