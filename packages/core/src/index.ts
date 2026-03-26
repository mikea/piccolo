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
// ── Public types ──────────────────────────────────────────────────────────────
// All shared types from specs/api.md — consumed by gateways and extensions.
export type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  CompactEvent,
  ContextEvent,
  ContextResult,
  IExtensionListener,
  IExtensionRunner,
  IExtensionWorker,
  InputEvent,
  InputResult,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallResult,
  ToolEndEvent,
  ToolResultEvent,
  ToolResultOverride,
  ToolStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "./extension-types.ts";
// ── Worker entrypoint ─────────────────────────────────────────────────────────
export { PiccoloCore as default } from "./piccolo-core.ts";
// ── Public library API ────────────────────────────────────────────────────────
// Session persistence layer
export * from "./session/index.ts";
export type {
  AgentEvent,
  AgentTurn,
  Attachment,
  CompactOptions,
  ContextUsage,
  CustomEntry,
  GatewayId,
  HistoryEntry,
  ICommand,
  IGatewayCallback,
  IPiccoloCore,
  ISession,
  ITextUI,
  ITool,
  ITurn,
  IUser,
  IWebUI,
  JsonSchema7,
  NewSessionOptions,
  SessionRecord,
  SessionStatus,
  ToolDescriptor,
  ToolResult,
  WebComponentDescriptor,
} from "./types.ts";
