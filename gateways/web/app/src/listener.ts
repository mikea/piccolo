/**
 * listener.ts — IAgentEventListener browser implementation.
 *
 * The browser creates an EventListener and passes it to session.prompt().
 * The server calls onEvent() for each AgentEvent as it streams from the
 * agent loop. The listener dispatches events to the provided callback
 * so the SolidJS store can update reactive state.
 *
 * Spec ref: specs/api.md §6, specs/web_gateway.md §IAgentEventListener
 */

import { RpcTarget } from "capnweb";
import type { IAgentEventListener, WebAgentEvent } from "../../src/types.ts";

/**
 * Browser implementation of IAgentEventListener.
 * Created fresh for each prompt() call; disposed when the turn ends.
 */
export class EventListener extends RpcTarget implements IAgentEventListener {
  readonly #onEvent: (event: WebAgentEvent) => void;

  constructor(onEvent: (event: WebAgentEvent) => void) {
    super();
    this.#onEvent = onEvent;
  }

  async onEvent(event: WebAgentEvent): Promise<void> {
    this.#onEvent(event);
  }
}
