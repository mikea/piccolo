/**
 * Tool bridge: converts IAgentTool[] to the AI SDK ToolSet format.
 *
 * The Agent calls this before each streamText invocation.
 * IAgentTool.execute() receives the IExtensionContext as an opaque `unknown`
 * value — piccolo-core supplies a wrapper that injects the real context before
 * passing tools to the Agent.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import type { IAgentTool } from "./types.ts";

/**
 * Convert an array of IAgentTool into the AI SDK ToolSet record.
 *
 * The tool name (descriptor.name) becomes the record key.
 * Tool execution errors are caught by the AI SDK and delivered as tool-error
 * stream parts; the agent translates these to tool_end events with isError: true.
 */
export function toAiSdkTools(tools: IAgentTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.descriptor.name,
      tool({
        description: t.descriptor.description,
        inputSchema: t.descriptor.inputSchema,
        execute: async (input, { toolCallId, abortSignal }) => {
          return t.execute(toolCallId, input, undefined, abortSignal);
        },
      }),
    ]),
  );
}
