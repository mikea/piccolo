/**
 * Gateway-local types for piccolo-web-gateway.
 *
 * All browser-facing RPC interfaces are defined here using capnweb's RpcTarget.
 * These types match specs/api.md §6 and specs/web_gateway.md exactly.
 *
 * Import discipline:
 *   - RpcTarget for browser-facing classes: from "capnweb"
 *   - DurableObject for WebUiSessionDO: from "cloudflare:workers"
 *   - Shared piccolo types: from "@piccolo/core"
 *
 * Spec refs:
 *   specs/api.md §6  Web UI Gateway API
 *   specs/web_gateway.md
 */

import type {
  AgentEvent,
  Attachment,
  CompactOptions,
  ContextUsage,
  ModelInfo,
  NewSessionOptions,
  SessionInfo,
  SessionRecord,
  WebComponentDescriptor,
} from "@piccolo/core";
import type { RpcTarget } from "capnweb";

// ─── IWebGatewayApi — Root browser-facing interface ───────────────────────────

/**
 * Root interface the browser receives on WebSocket connection.
 * The browser calls newWebSocketRpcSession<IWebGatewayApi>(url) to get a stub.
 *
 * Spec ref: specs/api.md §6, specs/web_gateway.md §IWebGatewayApi
 */
export interface IWebGatewayApi extends RpcTarget {
  // ─── Session management ──────────────────────────────────────────────────────
  /** Create a new session and return a stub for it. */
  newSession(options?: NewSessionOptions): IWebGatewaySession;
  /** Retrieve an existing session by ID. */
  getSession(sessionId: string): IWebGatewaySession;
  /** List all sessions belonging to the authenticated user. */
  listSessions(): Promise<SessionInfo[]>;
  // ─── Model registry ──────────────────────────────────────────────────────────
  listModels(): Promise<ModelInfo[]>;
}

// ─── IWebGatewaySession — Per-session browser-facing interface ────────────────

/**
 * Per-session interface returned by IWebGatewayApi.newSession() / getSession().
 * Wraps ISession (api.md §2) with browser-facing additions.
 *
 * Spec ref: specs/api.md §6, specs/web_gateway.md §IWebGatewaySession
 */
export interface IWebGatewaySession extends RpcTarget {
  // ─── Identity and metadata ───────────────────────────────────────────────────
  id(): Promise<string>;
  info(): Promise<SessionRecord>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ────────────────────────────────────────────────────────────
  /**
   * Start a new agent turn.
   * listener — browser's stub for receiving AgentEvents (server → browser).
   * callback — browser's stub for interactive mid-turn prompts (server → browser).
   * Returns a handle the browser can use to abort or await completion.
   */
  prompt(
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallback,
    attachments?: Attachment[],
  ): ITurnHandle;

  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;

  // ─── Model management ────────────────────────────────────────────────────────
  getModel(): Promise<ModelInfo>;
  setModel(modelId: string): Promise<void>;

  // ─── Context ─────────────────────────────────────────────────────────────────
  getContextUsage(): Promise<ContextUsage>;
  compact(options?: CompactOptions): Promise<void>;

  // ─── Session tree ─────────────────────────────────────────────────────────────
  branch(entryId: string): Promise<void>;
  /** Fork returns a stub for the new session (pipelined). */
  fork(fromEntryId?: string): IWebGatewaySession;

  // ─── Lifecycle ───────────────────────────────────────────────────────────────
  delete(): Promise<void>;

  // ─── Attachments ─────────────────────────────────────────────────────────────
  /** Upload a file attachment. Returns an opaque attachmentId. */
  uploadAttachment(attachment: Attachment): Promise<string>;
}

// ─── IAgentEventListener — Browser callback for streaming ────────────────────

/**
 * Implemented by the browser. The server calls onEvent() for each AgentEvent
 * as it arrives from the agent loop — replacing SSE with a typed callback.
 *
 * Spec ref: specs/api.md §6, specs/web_gateway.md §IAgentEventListener
 */
export interface IAgentEventListener extends RpcTarget {
  onEvent(event: WebAgentEvent): Promise<void>;
}

// ─── ITurnHandle — Active turn reference ─────────────────────────────────────

/**
 * Returned by IWebGatewaySession.prompt(). Lets the browser abort an in-progress
 * turn or wait for its completion.
 *
 * Spec ref: specs/api.md §6, specs/web_gateway.md §ITurnHandle
 */
export interface ITurnHandle extends RpcTarget {
  /** Abort the current turn immediately. */
  abort(): Promise<void>;
  /** Resolves when the turn ends (agent_end or error event). */
  done(): Promise<void>;
}

// ─── IGatewayCallback — Interactive prompts from server to browser ────────────

/**
 * Implemented by the browser. The server calls these mid-turn when the agent
 * (via a tool) needs interactive input from the user.
 *
 * Spec ref: specs/api.md §5, specs/web_gateway.md §IGatewayCallback
 */
export interface IGatewayCallback extends RpcTarget {
  requestSelect(title: string, options: string[], multiple?: boolean): Promise<string[] | null>;
  requestConfirm(title: string, message: string): Promise<boolean>;
  requestInput(title: string, placeholder?: string): Promise<string | null>;
  notify(message: string, level: "info" | "success" | "warning" | "error"): Promise<void>;
}

// ─── WebAgentEvent — Gateway-extended AgentEvent with optional component ──────

/**
 * AgentEvent extended with an optional `component` field for tool_start and tool_end.
 * The gateway enriches these events by calling tool.getGatewayUI("web").getComponent()
 * before forwarding to the browser listener.
 *
 * The base AgentEvent type is unchanged in piccolo-core. This extension is
 * gateway-local only — it does not modify the core event types.
 *
 * Spec ref: specs/web_gateway.md §IWebUI — Component loading
 */
export type WebAgentEvent =
  | Exclude<AgentEvent, { type: "tool_start" } | { type: "tool_end" }>
  | (Extract<AgentEvent, { type: "tool_start" }> & { component?: WebComponentDescriptor })
  | (Extract<AgentEvent, { type: "tool_end" }> & { component?: WebComponentDescriptor });
