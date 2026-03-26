/**
 * SessionTransformStream — a pass-through TransformStream that peeks at every
 * AgentEvent flowing from the Agent to the gateway.
 *
 * The transform itself has zero session logic. All event processing is delegated
 * to the callbacks provided by AgentSessionDO:
 *   - onEvent: called synchronously for every event (tracking, token counts,
 *              extension dispatch fire-and-forget)
 *   - onClose: called when the Agent's stream closes (triggers #handleAgentEnd)
 *
 * This replaces both the old subscribe() bridge and LoggingTransformStream.
 *
 * Spec ref: specs/core.md §Agent Loop §SessionTransformStream
 */

import type { AgentEvent } from "@piccolo/api";

export class SessionTransformStream extends TransformStream<AgentEvent, AgentEvent> {
  constructor(label: string, onEvent: (event: AgentEvent) => void, onClose: () => void) {
    super({
      start() {
        console.debug("[stream] %s: opened", label);
      },
      transform(event, controller) {
        console.debug("[stream] %s: chunk type=%s", label, event.type);
        onEvent(event);
        controller.enqueue(event);
      },
      flush() {
        console.debug("[stream] %s: closed", label);
        onClose();
      },
    });
  }
}
