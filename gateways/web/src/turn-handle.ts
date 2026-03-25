/**
 * turn-handle.ts — TurnHandleImpl for piccolo-web-gateway.
 *
 * TurnHandleImpl drives the agent turn:
 *   1. Calls session.prompt(text, attachments, callback) → ReadableStream<AgentEvent>
 *   2. Reads each event from the stream
 *   3. Enriches tool_start/tool_end events with WebComponentDescriptor (if available)
 *   4. Calls listener.onEvent(enrichedEvent) for each event
 *   5. Exposes abort() and done() to the browser
 *
 * The constructor returns synchronously — the async work runs in the background
 * via #run(). This is necessary because Cap'n Web requires prompt() to return
 * ITurnHandle synchronously (for promise pipelining).
 *
 * Spec ref: specs/api.md §6 ITurnHandle, specs/web_gateway.md §TurnHandleImpl
 */

import type { Attachment, IGatewayCallback, ISession } from "@piccolo/core";
import { RpcTarget } from "capnweb";
import type { ToolWithGatewayUI } from "./event-enrichment.ts";
import { enrichEvent } from "./event-enrichment.ts";
import type { IAgentEventListener, ITurnHandle, WebAgentEvent } from "./types.ts";

/**
 * TurnHandleImpl — active turn reference returned by WebGatewaySessionImpl.prompt().
 *
 * Manages the lifecycle of a single agent turn: streams events to the browser
 * listener, enriches tool events with custom UI descriptors, and supports abort.
 *
 * Spec ref: specs/api.md §6 ITurnHandle
 */
export class TurnHandleImpl extends RpcTarget implements ITurnHandle {
  readonly #sessionPromise: Promise<ISession>;
  readonly #donePromise: Promise<void>;
  #aborted = false;

  constructor(
    session: Promise<ISession>,
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallback,
    attachments: Attachment[] | undefined,
    toolCache: Map<string, ToolWithGatewayUI>,
  ) {
    super();
    this.#sessionPromise = session;
    // Start the turn immediately — #run() is fire-and-forget from the constructor.
    this.#donePromise = this.#run(text, listener, callback, attachments, toolCache);
  }

  /**
   * Drive the agent turn:
   *   - Call session.prompt() to get the ReadableStream<AgentEvent>
   *   - For each event: enrich with component info, forward to listener
   *   - Close when the stream ends
   */
  async #run(
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallback,
    attachments: Attachment[] | undefined,
    toolCache: Map<string, ToolWithGatewayUI>,
  ): Promise<void> {
    let stream: ReadableStream<WebAgentEvent>;
    try {
      const session = await this.#sessionPromise;
      // Pass the callback through so tools can call requestSelect/requestConfirm.
      stream = (await session.prompt(
        text,
        attachments,
        callback as IGatewayCallback,
      )) as ReadableStream<WebAgentEvent>;
    } catch (err: unknown) {
      // prompt() itself threw — notify the listener and stop
      const msg = err instanceof Error ? err.message : String(err);
      await listener.onEvent({ type: "error", message: msg }).catch(() => {});
      return;
    }

    const reader = stream.getReader();
    try {
      while (true) {
        if (this.#aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        const enriched = await enrichEvent(value, toolCache);
        await listener.onEvent(enriched).catch(() => {});
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Abort the current turn.
   *
   * Sets the abort flag (stops the reader loop) and delegates to
   * session.abort() which signals the agent's AbortController.
   *
   * Spec ref: specs/api.md §6 ITurnHandle.abort
   */
  async abort(): Promise<void> {
    this.#aborted = true;
    const session = await this.#sessionPromise;
    await session.abort();
  }

  /**
   * Resolves when the turn ends naturally (after the last event is delivered).
   * Rejects if the turn threw an unhandled error.
   *
   * Spec ref: specs/api.md §6 ITurnHandle.done
   */
  done(): Promise<void> {
    return this.#donePromise;
  }
}
