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

import { RpcTarget } from "cloudflare:workers";
import type { IAbortSignal, ISession, ITool } from "@piccolo/api";
import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";

/** RpcTarget wrapping a platform AbortSignal for cross-JSRPC cancellation. */
class AbortSignalTarget extends RpcTarget implements IAbortSignal {
  readonly #signal: AbortSignal;
  constructor(signal: AbortSignal) {
    super();
    this.#signal = signal;
  }
  isAborted(): Promise<boolean> {
    return Promise.resolve(this.#signal.aborted);
  }
}

/**
 * Convert an array of ITool into the AI SDK ToolSet record.
 *
 * ctx is the live ISession threaded into every tool execute() call.
 * piccolo-core supplies it via agent.setContext() before each prompt().
 *
 * The tool name (descriptor.name) becomes the record key.
 * Tool execution errors are caught by the AI SDK and delivered as tool-error
 * stream parts; the agent translates these to tool-result events with isError: true.
 */
export async function toAiSdkTools(tools: ITool[], ctx: ISession): Promise<ToolSet> {
  const entries = await Promise.all(
    tools.map(async (t) => {
      const desc = await t.getDescriptor();
      return [
        desc.name,
        tool({
          description: desc.description,
          inputSchema: jsonSchema(desc.inputSchema),
          execute: async (input, { toolCallId, abortSignal }) => {
            return t.execute(
              toolCallId,
              input,
              ctx,
              abortSignal ? new AbortSignalTarget(abortSignal) : undefined,
            );
          },
        }),
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}
