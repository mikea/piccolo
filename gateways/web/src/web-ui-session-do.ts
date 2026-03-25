/**
 * web-ui-session-do.ts — Connection durability Durable Object for piccolo-web-gateway.
 *
 * WebUiSessionDO is a pure transport layer. It accepts native WebSocket
 * connections from browser tabs (via hibernation API) and broadcasts serialized
 * AgentEvents to all connected clients.
 *
 * Design: No capnweb RpcTarget stubs are stored here. The DO uses the Workers
 * WebSocket hibernation APIs (ctx.acceptWebSocket / ctx.getWebSockets) so that
 * connections survive Worker eviction. The gateway Worker establishes the
 * capnweb session in its own context; this DO is solely responsible for:
 *   1. Accepting WebSocket upgrades from browser tabs via addConnection(request).
 *   2. Broadcasting serialized events to all connected WebSockets via pushEvent(event).
 *   3. Buffering the last MAX_BUFFER events for reconnecting clients via getRecentEvents().
 *
 * Spec ref: specs/api.md §6 IWebUiSessionDO, specs/web_gateway.md §IWebUiSessionDO
 */

import { DurableObject } from "cloudflare:workers";
import type { AgentEvent } from "@piccolo/core";
import type { WebAgentEvent } from "./types.ts";

/** Maximum number of recent events buffered for reconnecting clients. */
const MAX_BUFFER = 50;

/**
 * Tag used to identify WebSocket connections managed by this DO instance.
 * Allows ctx.getWebSockets("session") to retrieve all session connections.
 */
const WS_TAG = "session";

/**
 * WebUiSessionDO — native WebSocket transport for browser tab connections.
 *
 * Acts as a pure transport: accepts WebSocket upgrades, buffers events,
 * and broadcasts to all connected clients. No capnweb stubs are stored here.
 *
 * Spec ref: specs/api.md §6 IWebUiSessionDO
 */
export class WebUiSessionDO extends DurableObject<Env> {
  /** Circular buffer of recent events for reconnect replay. */
  readonly #recentEvents: WebAgentEvent[] = [];

  // ─── IWebUiSessionDO interface ─────────────────────────────────────────────

  /**
   * Register a new browser tab WebSocket connection.
   *
   * The gateway Worker calls this when a browser tab sends a WebSocket upgrade
   * request. This method upgrades the connection using the Workers hibernation
   * API so the connection survives Worker eviction.
   *
   * After upgrade, recent buffered events are replayed to the new connection
   * so it can catch up without a full re-prompt.
   *
   * @param request  The incoming WebSocket upgrade request from the browser.
   * @returns        101 Switching Protocols response.
   */
  async addConnection(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Accept and hibernate the server side so this DO can receive WebSocket
    // events without staying warm. Workers will wake the DO for each message.
    this.ctx.acceptWebSocket(server, [WS_TAG]);

    // Replay recent buffered events so the new connection catches up.
    const replay = [...this.#recentEvents];
    for (const event of replay) {
      try {
        server.send(JSON.stringify(event));
      } catch {
        // Ignore — the client may close before replay finishes.
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Broadcast an AgentEvent to all connected browser tabs.
   *
   * Serializes the event as JSON and sends it over every active WebSocket
   * connection. Also adds the event to the recent buffer (capped at MAX_BUFFER)
   * for reconnecting clients. Stale connections that have been closed are
   * removed silently.
   *
   * @param event  The AgentEvent (or WebAgentEvent with optional component) to broadcast.
   */
  async pushEvent(event: AgentEvent): Promise<void> {
    // Buffer for reconnect replay
    this.#recentEvents.push(event as WebAgentEvent);
    if (this.#recentEvents.length > MAX_BUFFER) {
      this.#recentEvents.shift();
    }

    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets(WS_TAG)) {
      try {
        ws.send(payload);
      } catch {
        // WebSocket is closed or errored — ignore; hibernation will clean it up.
      }
    }
  }

  /**
   * Return recent events for a reconnecting client.
   *
   * Returns a copy of the event buffer (up to MAX_BUFFER entries).
   * Used by addConnection() to replay missed events to new connections.
   */
  async getRecentEvents(): Promise<WebAgentEvent[]> {
    return [...this.#recentEvents];
  }

  // ─── WebSocket hibernation handlers ───────────────────────────────────────

  /**
   * Called by the Workers runtime when a hibernated WebSocket receives a message.
   * Messages from the browser are ignored — this is a server-push-only channel.
   */
  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // No-op: the browser does not send messages over this channel.
  }

  /**
   * Called by the Workers runtime when a hibernated WebSocket closes.
   * Cleanup is automatic via hibernation — no action needed here.
   */
  override webSocketClose(_ws: WebSocket, _code: number, _reason: string, _clean: boolean): void {
    // No explicit cleanup needed: hibernation handles WebSocket lifecycle.
  }

  /**
   * Called by the Workers runtime when a hibernated WebSocket errors.
   */
  override webSocketError(_ws: WebSocket, _error: unknown): void {
    // Errors on individual connections are silently ignored.
  }
}
