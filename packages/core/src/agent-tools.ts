/**
 * Tool bridge: converts ITool[] to the AI SDK ToolSet format.
 *
 * The Agent calls this before each streamText invocation, passing the ISession
 * context set via agent.setContext(). piccolo-core sets this to the live
 * ISession before each prompt() call so tools receive the full JSRPC-capable
 * context at execute() time.
 *
 * Spec ref: specs/core.md §Agent Loop §toAiSdkTools
 */

import type { ISession, ITool } from "@piccolo/api";
import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";

/**
 * Convert an array of ITool into the AI SDK ToolSet record.
 *
 * ctx is the live ISession threaded into every tool execute() call.
 * piccolo-core supplies it via agent.setContext() before each prompt().
 *
 * The tool name (descriptor.name) becomes the record key.
 * Tool execution errors are caught by the AI SDK and delivered as tool-error
 * stream parts; the agent translates these to tool_end events with isError: true.
 */
export function toAiSdkTools(tools: ITool[], ctx: ISession): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.descriptor.name,
      tool({
        description: t.descriptor.description,
        inputSchema: jsonSchema(t.descriptor.inputSchema),
        execute: async (input, { toolCallId, abortSignal }) => {
          return t.execute(toolCallId, input, ctx, abortSignal);
        },
      }),
    ]),
  );
}
