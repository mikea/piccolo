/**
 * types-public.ts — Public type-only re-exports for @piccolo/core.
 *
 * Used by gateways and extensions that map "@piccolo/core" to this file via
 * tsconfig paths to avoid pulling in the Workers `Env` interface.
 *
 * All types are sourced from @piccolo/api — the canonical contract package.
 * Gateways and extensions should prefer importing from @piccolo/api directly;
 * this file exists for backwards compatibility during the transition.
 *
 * Spec ref: specs/api.md — all public interfaces
 */

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
// SessionRecord is core-internal only (D1 storage detail); not re-exported here
