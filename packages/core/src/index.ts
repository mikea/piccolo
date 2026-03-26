/**
 * piccolo-core entry point.
 *
 * PiccoloCore is the WorkerEntrypoint (IPiccoloCore) that gateways connect to.
 * AgentSessionDO must also be a named export for Wrangler DO registration.
 *
 * All public JSRPC types are re-exported from @piccolo/api.
 *
 * Spec ref: specs/api.md §1 IPiccoloCore, specs/core.md §IPiccoloCore WorkerEntrypoint
 */

// All public JSRPC contract types from @piccolo/api
export type {
  AgentEndEvent,
  AgentEvent,
  AgentStartEvent,
  Attachment,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  CompactEvent,
  CompactOptions,
  ContextEvent,
  ContextResult,
  ContextUsage,
  CustomEntry,
  FinishReason,
  GatewayId,
  HistoryEntry,
  ICommand,
  IExtensionListener,
  IExtensionWorker,
  IGatewayCallback,
  ImagePart,
  InputEvent,
  InputResult,
  IPiccoloCore,
  ISession,
  ITextUI,
  ITool,
  ITurn,
  IUser,
  IWebUI,
  JsonSchema7,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  NewSessionOptions,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionStatus,
  SystemPromptAddition,
  ToolCallEvent,
  ToolCallResult,
  ToolDescriptor,
  ToolEndEvent,
  ToolResult,
  ToolResultEvent,
  ToolResultOverride,
  ToolStartEvent,
  TurnEndEvent,
  TurnStartEvent,
  WebComponentDescriptor,
} from "@piccolo/api";
// ── Durable Objects ───────────────────────────────────────────────────────────
// AgentSessionDO — must be a named export for Wrangler DO registration
export { AgentSessionDO } from "./agent-session-do.ts";
// ── Worker entrypoint ─────────────────────────────────────────────────────────
export { PiccoloCore as default } from "./piccolo-core.ts";
// ── Public library API ────────────────────────────────────────────────────────
// Session persistence layer
export * from "./session/index.ts";
