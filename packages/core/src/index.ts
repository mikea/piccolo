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
  AgentEvent,
  Attachment,
  BeforeAgentStartResult,
  BeforeCompactResult,
  ContextResult,
  ContextUsage,
  ExtensionEvent,
  FinishReason,
  GatewayId,
  ICommand,
  IDisposable,
  IExtensionListener,
  IExtensionWorker,
  IGatewayCallback,
  ImagePart,
  InputResult,
  IObservable,
  IObserver,
  ISessionListener,
  ITextUI,
  ITool,
  ITurn,
  IUser,
  IWebUI,
  JsonSchema7,
  LanguageModel,
  LanguageModelUsage,
  NewSessionOptions,
  SessionEvent,
  SystemPromptAddition,
  ToolCallResult,
  ToolDescriptor,
  ToolResult,
  ToolResultOverride,
  WebComponentDescriptor,
} from "@piccolo/api";
// ── Durable Objects ───────────────────────────────────────────────────────────
// AgentSessionDO — must be a named export for Wrangler DO registration
export { AgentSessionDO } from "./agent-session-do.ts";
// IExtensionRunner and ExtensionEventResult are core-internal (not in @piccolo/api)
// but exported for callers that interact with the runner directly.
export type { ExtensionEventResult, IExtensionRunner } from "./extension-runner.ts";
export { ObservableImpl } from "./observable-impl.ts";
// ── Worker entrypoint ─────────────────────────────────────────────────────────
export { PiccoloCore as default } from "./piccolo-core.ts";
// ── Public library API ────────────────────────────────────────────────────────
// Session persistence layer
export * from "./session/index.ts";
