/**
 * Tool bridge: converts IAgentTool[] to the AI SDK ToolSet format.
 *
 * The Agent calls this before each streamText invocation, passing the opaque
 * `ctx` value set via `agent.setContext()`. piccolo-core sets this to the live
 * `ExtensionContextImpl` before each `prompt()` call so tools receive the full
 * JSRPC-capable context at execute() time.
 *
 * `ctx` is typed as `unknown` here to keep packages/agent free of any
 * IExtensionContext import.
 */

import type { ToolSet } from "ai";
import { tool } from "ai";
import type { IAgentSession, IAgentTool } from "./types.ts";

/**
 * Convert an array of IAgentTool into the AI SDK ToolSet record.
 *
 * `ctx` is the opaque extension context threaded into every tool execute() call.
 * piccolo-core supplies the live ExtensionContextImpl via agent.setContext().
 *
 * The tool name (descriptor.name) becomes the record key.
 * Tool execution errors are caught by the AI SDK and delivered as tool-error
 * stream parts; the agent translates these to tool_end events with isError: true.
 */
export function toAiSdkTools(tools: IAgentTool[], ctx: IAgentSession): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.descriptor.name,
      tool({
        description: t.descriptor.description,
        inputSchema: t.descriptor.inputSchema,
        execute: async (input, { toolCallId, abortSignal }) => {
          return t.execute(toolCallId, input, ctx, abortSignal);
        },
      }),
    ]),
  );
}
