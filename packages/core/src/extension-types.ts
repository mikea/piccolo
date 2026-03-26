import type { FinishReason, LanguageModelUsage, ModelMessage } from "@piccolo/agent";
import type { Attachment, ICommand, ISession, ITool, ToolResult } from "./types.ts";
import type { SystemPromptAddition } from "./types-internal.ts";

export interface InputEvent {
  text: string;
  attachments: Attachment[];
  source: "user";
  commandName?: string;
  commandArgs?: string;
}

export interface InputResult {
  action: "handled" | "transform" | "continue";
  text?: string;
}

export interface BeforeAgentStartEvent {
  text: string;
  attachments: Attachment[];
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  contextMessages?: ModelMessage[];
}

export interface ContextEvent {
  messages: ModelMessage[];
}

export interface ContextResult {
  messages: ModelMessage[];
}

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCallResult {
  block: boolean;
  reason?: string;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

export type ToolResultOverride = Partial<ToolResult>;

export interface BeforeCompactEvent {
  messages: ModelMessage[];
  keepRecentTokens: number;
}

export interface BeforeCompactResult {
  cancel?: boolean;
  summary?: string;
}

export interface SessionStartEvent {
  sessionId: string;
  userId: string;
  modelId: string;
}

export interface SessionShutdownEvent {
  sessionId: string;
}

export interface AgentStartEvent {
  sessionId: string;
}

export interface AgentEndEvent {
  sessionId: string;
  messages: ModelMessage[];
  totalUsage: LanguageModelUsage;
}

export interface TurnStartEvent {
  stepNumber: number;
}

export interface TurnEndEvent {
  stepNumber: number;
  finishReason: FinishReason;
  usage: LanguageModelUsage;
}

export interface ToolStartEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolEndEvent {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}

export interface CompactEvent {
  summary: string;
  keptMessageCount: number;
}

export interface IExtensionListener {
  onSessionStart?(event: SessionStartEvent, ctx: ISession): Promise<void>;
  onSessionShutdown?(event: SessionShutdownEvent, ctx: ISession): Promise<void>;
  onBeforeAgentStart?(
    event: BeforeAgentStartEvent,
    ctx: ISession,
  ): Promise<BeforeAgentStartResult | undefined>;
  onAgentStart?(event: AgentStartEvent, ctx: ISession): Promise<void>;
  onAgentEnd?(event: AgentEndEvent, ctx: ISession): Promise<void>;
  onTurnStart?(event: TurnStartEvent, ctx: ISession): Promise<void>;
  onTurnEnd?(event: TurnEndEvent, ctx: ISession): Promise<void>;
  onToolStart?(event: ToolStartEvent, ctx: ISession): Promise<void>;
  onToolEnd?(event: ToolEndEvent, ctx: ISession): Promise<void>;
  onContext?(event: ContextEvent, ctx: ISession): Promise<ContextResult | undefined>;
  onToolCall?(event: ToolCallEvent, ctx: ISession): Promise<ToolCallResult | undefined>;
  onToolResult?(event: ToolResultEvent, ctx: ISession): Promise<ToolResultOverride | undefined>;
  onInput?(event: InputEvent, ctx: ISession): Promise<InputResult | undefined>;
  onBeforeCompact?(
    event: BeforeCompactEvent,
    ctx: ISession,
  ): Promise<BeforeCompactResult | undefined>;
  onCompact?(event: CompactEvent, ctx: ISession): Promise<void>;
}

export interface IExtensionWorker extends IExtensionListener {
  getTools?(ctx: ISession): Promise<ITool[] | undefined>;
  getCommands?(ctx: ISession): Promise<ICommand[] | undefined>;
  getSystemPromptAdditions?(ctx: ISession): Promise<SystemPromptAddition[] | undefined>;
}

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
