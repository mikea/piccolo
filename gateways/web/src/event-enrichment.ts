/**
 * event-enrichment.ts — AgentEvent enrichment for piccolo-web-gateway.
 *
 * Enriches tool_start and tool_end AgentEvents with an optional
 * `component` field (WebComponentDescriptor) by calling
 * `tool.getGatewayUI("web").getComponent(phase)` for each tool event.
 *
 * Tools that provide a custom IWebUI return a WebComponentDescriptor that
 * the browser uses to mount a custom React component instead of the default
 * tool call/result rendering.
 *
 * Enrichment failures are swallowed — a broken tool UI must never break
 * the event stream.
 *
 * Spec ref: specs/web_gateway.md §IWebUI — Component loading
 */

import type { IWebUI, WebComponentDescriptor } from "@piccolo/core";
import type { WebAgentEvent } from "./types.ts";

/**
 * Minimal shape of a tool that may have gateway UI.
 * Used for the tool cache entries passed from WebGatewaySessionImpl.
 */
export interface ToolWithGatewayUI {
  getGatewayUI?(gatewayId: string): Promise<unknown | undefined>;
}

/**
 * Enrich an AgentEvent with a WebComponentDescriptor when the tool provides one.
 *
 * For tool_start and tool_end events:
 *   1. Look up the tool by name in the provided cache.
 *   2. Call tool.getGatewayUI("web") to get the IWebUI stub.
 *   3. Call ui.getComponent(phase) for the appropriate phase.
 *   4. If a descriptor is returned, attach it to the event as `component`.
 *
 * All other event types are returned unchanged.
 * Any error during enrichment returns the original event unmodified.
 *
 * @param event      The raw AgentEvent from piccolo-core.
 * @param toolCache  Map of toolName → tool stub with getGatewayUI.
 */
export async function enrichEvent(
  event: WebAgentEvent,
  toolCache: Map<string, ToolWithGatewayUI>,
): Promise<WebAgentEvent> {
  if (event.type !== "tool_start" && event.type !== "tool_end") {
    return event;
  }

  const tool = toolCache.get(event.toolName);
  if (!tool?.getGatewayUI) return event;

  try {
    const ui = await tool.getGatewayUI("web");
    if (!ui || typeof ui !== "object") return event;

    // Type-check for IWebUI.getComponent
    const webUi = ui as Partial<IWebUI>;
    if (typeof webUi.getComponent !== "function") return event;

    const phase: "call" | "result" = event.type === "tool_start" ? "call" : "result";
    const component: WebComponentDescriptor | undefined = await webUi.getComponent(phase);
    if (!component) return event;

    return { ...event, component };
  } catch {
    // Enrichment failure must never break the turn — return original event.
    return event;
  }
}
