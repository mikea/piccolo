/**
 * types-public.ts — Public type-only exports for @piccolo/core.
 *
 * This file re-exports all public types from types.ts without pulling in any
 * implementation files that reference the Workers `Env` interface (agent-session-do.ts,
 * piccolo-core.ts, session-impl.ts etc.).
 *
 * Used by gateways and extensions that depend on @piccolo/core types only.
 * They map "@piccolo/core" to this file via tsconfig paths to avoid Env conflicts.
 *
 * Spec ref: specs/api.md — all public interfaces
 */

// Re-export agent types that gateways may need
export type {
  FinishReason,
  IAgentSession,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "@piccolo/agent";
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
