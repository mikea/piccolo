/**
 * piccolo-core entry point.
 *
 * PiccoloCore is the WorkerEntrypoint (IPiccoloCore) that gateways connect to.
 * AgentSessionDO must also be a named export for Wrangler DO registration.
 *
 * Spec ref: specs/api.md §1 IPiccoloCore, specs/core.md §IPiccoloCore WorkerEntrypoint
 */

// ── Durable Objects ───────────────────────────────────────────────────────────
// AgentSessionDO — must be a named export for Wrangler DO registration
export { AgentSessionDO } from "./agent-session-do.ts";
// ── Worker entrypoint ─────────────────────────────────────────────────────────
export { PiccoloCore as default } from "./piccolo-core.ts";

// ── Public library API ────────────────────────────────────────────────────────
// Session persistence layer
export * from "./session/index.ts";
// ── Public types ──────────────────────────────────────────────────────────────
// All shared types from specs/api.md — consumed by gateways and extensions.
export type {
  AgentEvent,
  AgentToolDescriptor,
  AgentToolResult,
  Attachment,
  CompactOptions,
  ContextUsage,
  CustomEntry,
  GatewayId,
  HistoryEntry,
  IAgentTool,
  IGatewayCallback,
  IPiccoloCore,
  ISession,
  IUser,
  ITextUI,
  ITool,
  IWebUI,
  NewSessionOptions,
  SessionRecord,
  SessionStatus,
  ToolDescriptor,
  ToolResult,
  WebComponentDescriptor,
} from "./types.ts";
