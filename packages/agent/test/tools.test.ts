import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { toAiSdkTools } from "../src/tools.ts";
import type { AgentToolResult, IAgentTool } from "../src/types.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTool(
  name: string,
  result: AgentToolResult = { content: [{ type: "text", text: "ok" }] },
): IAgentTool {
  return {
    descriptor: {
      name,
      description: `${name} description`,
      inputSchema: z.object({ value: z.string() }),
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
    const result = toAiSdkTools([]);
    expect(result).toEqual({});
  });

  it("uses descriptor.name as the record key", () => {
    const tool = makeTool("my_tool");
    const result = toAiSdkTools([tool]);
    expect(Object.keys(result)).toEqual(["my_tool"]);
  });

  it("creates a separate entry per tool", () => {
    const tools = [makeTool("tool_a"), makeTool("tool_b"), makeTool("tool_c")];
    const result = toAiSdkTools(tools);
    expect(Object.keys(result).sort()).toEqual(["tool_a", "tool_b", "tool_c"]);
  });

  it("produced tool has description matching descriptor", () => {
    const tool = makeTool("greet");
    const sdkTools = toAiSdkTools([tool]);
    const toolName = "greet";
    const sdkTool = sdkTools[toolName];
    expect(sdkTool).toBeDefined();
    expect(sdkTool?.description).toBe("greet description");
  });

  it("execute() on the AI SDK tool calls IAgentTool.execute()", async () => {
    const tool = makeTool("echo", {
      content: [{ type: "text", text: "echoed" }],
    });
    const sdkTools = toAiSdkTools([tool]);
    const toolName = "echo";
    const sdkTool = sdkTools[toolName];
    expect(sdkTool).toBeDefined();

    // Call via the helper to avoid exactOptionalPropertyTypes issues with abortSignal
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast for AI SDK internal type
    const result = await callExecute(sdkTool?.execute as any, { value: "test" }, "call_1");
    expect(result).toEqual({ content: [{ type: "text", text: "echoed" }] });
    expect(tool.execute).toHaveBeenCalledWith("call_1", { value: "test" }, undefined, undefined);
  });

  it("passes abortSignal through to IAgentTool.execute()", async () => {
    const tool = makeTool("abort_tool");
    const sdkTools = toAiSdkTools([tool]);
    const toolName = "abort_tool";
    const sdkTool = sdkTools[toolName];
    const signal = new AbortController().signal;
    // biome-ignore lint/suspicious/noExplicitAny: test-only cast for AI SDK internal type
    await callExecuteWithSignal(sdkTool?.execute as any, { value: "x" }, "call_2", signal);
    expect(tool.execute).toHaveBeenCalledWith("call_2", { value: "x" }, undefined, signal);
  });
});
