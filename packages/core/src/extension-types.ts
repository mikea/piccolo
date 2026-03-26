/**
 * extension-types.ts — piccolo-core internal extension dispatch types.
 *
 * Re-exports all public extension event/result types from @piccolo/api so that
 * core implementation files have a single import point.
 *
 * Also defines IExtensionRunner — the core-internal interface implemented by
 * ExtensionRunner. This is NOT part of the public JSRPC API; it is used only
 * inside piccolo-core to dispatch events to extension Workers.
 */

// Re-export everything from @piccolo/api that core internals need
export type {
  AgentEndEvent,
  AgentStartEvent,
  Attachment,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  CompactEvent,
  ContextEvent,
  ContextResult,
  ICommand,
  IExtensionListener,
  IExtensionWorker,
  InputEvent,
  InputResult,
  ISession,
  ITool,
  SessionShutdownEvent,
  SessionStartEvent,
  SystemPromptAddition,
  ToolCallEvent,
  ToolCallResult,
  ToolEndEvent,
  ToolResult,
  ToolResultEvent,
  ToolResultOverride,
  ToolStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@piccolo/api";

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  ContextEvent,
  ContextResult,
  ICommand,
  InputEvent,
  InputResult,
  ISession,
  ITool,
  SystemPromptAddition,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultOverride,
} from "@piccolo/api";

/**
 * IExtensionRunner — core-internal interface for dispatching to extensions.
 * Implemented by ExtensionRunner. NOT a JSRPC surface.
 */
export interface IExtensionRunner {
  emitInput(event: InputEvent, ctx: ISession): Promise<InputResult>;
  emitBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ISession,
  ): Promise<BeforeAgentStartResult>;
  emitContext(event: ContextEvent, ctx: ISession): Promise<ContextResult | undefined>;
  emitToolCall(event: ToolCallEvent, ctx: ISession): Promise<ToolCallResult>;
  emitToolResult(event: ToolResultEvent, ctx: ISession): Promise<ToolResultOverride | undefined>;
  emitBeforeCompact(event: BeforeCompactEvent, ctx: ISession): Promise<BeforeCompactResult>;
  // biome-ignore lint/suspicious/noExplicitAny: event payload varies by type
  emit(eventType: string, event: any, ctx: ISession): Promise<void>;
  getSystemPromptAdditions(): SystemPromptAddition[];
  getCommands(): ICommand[];
  getTools(): ITool[];
}
