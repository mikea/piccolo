/**
 * @piccolo/api — Public JSRPC contract types for piccolo.
 *
 * This package contains ONLY type declarations. No implementations, no logic,
 * no runtime code. Extensions and gateways depend on this package; piccolo-core
 * implements the interfaces defined here.
 *
 * Dependency rule:
 *   extensions → @piccolo/api   (NOT @piccolo/core)
 *   gateways   → @piccolo/api   (NOT @piccolo/core)
 *   piccolo-core implements @piccolo/api interfaces
 *
 * Spec ref: specs/api.md
 */

// ── Re-export ai types used in the public API ─────────────────────────────────
export type { JSONSchema7 as JsonSchema7 } from "@ai-sdk/provider";
export type {
  FinishReason,
  ImagePart,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "ai";

// ─── Imports for use below ───────────────────────────────────────────────────

import type { JSONSchema7 } from "@ai-sdk/provider";
import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai";

// ─── Shared data types ────────────────────────────────────────────────────────

/**
 * File attachment passed to ISession.prompt().
 * Spec ref: specs/api.md §Shared Types §Attachment
 */
export interface Attachment {
  name: string;
  mimeType: string;
  /** base64 for binary; UTF-8 text otherwise */
  data: string;
  size: number;
}

/**
 * Options for creating a new session.
 * Spec ref: specs/api.md §Shared Types §NewSessionOptions
 */
export interface NewSessionOptions {
  name?: string;
  modelId?: string;
  cwd?: string;
}

/**
 * Agent events streamed from the core to gateways during a turn.
 * Spec ref: specs/api.md §Shared Types §AgentEvent
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; totalUsage: LanguageModelUsage }
  | { type: "turn_start"; stepNumber: number }
  | { type: "turn_end"; stepNumber: number; finishReason: FinishReason; usage: LanguageModelUsage }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_end"; toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: "error"; message: string };

// ─── Tool ─────────────────────────────────────────────────────────────────────

/**
 * ToolDescriptor — pure data describing a tool to the LLM and piccolo-core.
 * Spec ref: specs/api.md §Shared Types §ToolDescriptor
 */
export interface ToolDescriptor {
  /** Identifier the LLM uses to call this tool. Snake_case, unique within a session. */
  name: string;
  /** Human-readable display name shown in gateway UIs and logs. */
  label: string;
  /** Full description sent to the LLM. */
  description: string;
  /** Optional one-line entry added to "Available tools" in the system prompt. */
  promptSnippet?: string;
  /** Optional bullets appended to "Guidelines" while this tool is active. */
  promptGuidelines?: string[];
  /** JSON Schema (draft-07 style) for the tool input parameters. */
  inputSchema: JSONSchema7;
}

/**
 * ToolResult — returned by ITool.execute().
 * Spec ref: specs/api.md §Shared Types §ToolResult
 */
export interface ToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  /** Arbitrary metadata for gateway UI rendering. NOT sent to the LLM. */
  details?: unknown;
  /** Prefer throwing from execute() over setting isError manually. */
  isError?: boolean;
}

/**
 * ITool — the full interface every tool Worker must implement.
 * Spec ref: specs/api.md §Shared Types §ITool
 */
export interface ITool {
  readonly descriptor: ToolDescriptor;

  /**
   * Called by the core when the LLM invokes this tool.
   * Throw to signal failure — the core sets isError: true automatically.
   */
  execute(
    toolCallId: string,
    params: unknown,
    ctx: ISession,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  /** Optional. Called by a gateway before rendering a tool call or result. */
  getGatewayUI?(gatewayId: GatewayId): Promise<ITextUI | undefined>;
}

/** Well-known gateway identifiers. */
export type GatewayId = "web" | "telegram" | (string & {});

/**
 * ICommand — a slash command contributed by an extension.
 * Spec ref: specs/api.md §8
 */
export interface ICommand {
  name: string;
  description: string;
  showInAutocomplete?: boolean;
}

// ─── Gateway UI interfaces ────────────────────────────────────────────────────

/**
 * ITextUI — minimal shared tool rendering interface.
 * Spec ref: specs/api.md §3
 */
export interface ITextUI {
  getStatusText(): Promise<string>;
  getResultText(output: unknown): Promise<string>;
  getErrorText(error: unknown): Promise<string>;
}

/**
 * IWebUI — Web UI Gateway rendering interface.
 * Spec ref: specs/api.md §3
 */
export interface IWebUI extends ITextUI {
  getComponent(phase: "call" | "result"): Promise<WebComponentDescriptor | undefined>;
}

export interface WebComponentDescriptor {
  componentId: string;
  props: Record<string, unknown>;
}

// ─── Gateway Callback ─────────────────────────────────────────────────────────

/**
 * IGatewayCallback — interactive prompts from core back into the gateway mid-turn.
 * Spec ref: specs/api.md §5
 */
export interface IGatewayCallback {
  requestSelect(title: string, options: string[], multiple?: boolean): Promise<string[] | null>;
  requestConfirm(title: string, message: string): Promise<boolean>;
  requestInput(title: string, placeholder?: string): Promise<string | null>;
  notify(message: string, level: "info" | "success" | "warning" | "error"): Promise<void>;
}

// ─── ITurn — Active turn context ──────────────────────────────────────────────

/**
 * ITurn — returned by ISession.prompt(). Owns the AgentEvent stream and the
 * optional gateway callback for this turn.
 * Spec ref: specs/api.md §2
 */
export interface ITurn {
  getStream(): Promise<ReadableStream<AgentEvent>>;
  getCallback(): Promise<IGatewayCallback | undefined>;
}

// ─── Context / Compaction ─────────────────────────────────────────────────────

export interface ContextUsage {
  inputTokens: number;
}

export interface CompactOptions {
  keepRecentTokens?: number; // default: 20_000
}

/** Entry returned by ISession.getEntries(). */
export interface CustomEntry {
  id: string;
  customType: string;
  data: unknown;
  timestamp: string; // ISO 8601
}

// ─── History ──────────────────────────────────────────────────────────────────

/**
 * A single renderable entry in a session's conversation history.
 * Returned by ISession.getHistory().
 * Spec ref: specs/api.md §Shared Types
 */
export type HistoryEntry =
  | { type: "user"; id: string; content: string }
  | { type: "assistant"; id: string; content: string; isStreaming: boolean }
  | {
      type: "tool";
      id: string;
      toolName: string;
      input: unknown;
      output: unknown;
      isError: boolean;
      isStreaming: boolean;
    }
  | { type: "error"; id: string; message: string };

// ─── ISession ────────────────────────────────────────────────────────────────

/**
 * ISession — the unified session/context interface.
 * Returned by IPiccoloCore.newSession() / getSession().
 * Also passed as ctx to every extension handler and every ITool.execute() call.
 * Spec ref: specs/api.md §2
 */
export interface ISession {
  // ─── Identity ───────────────────────────────────────────────────────────────

  sessionId(): Promise<string>;
  getUpdatedAt(): Promise<number>;
  userId(): Promise<string>;

  // ─── Metadata ───────────────────────────────────────────────────────────────

  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ────────────────────────────────────────────────────────────

  prompt(text: string, attachments?: Attachment[], callback?: IGatewayCallback): Promise<ITurn>;
  sendUserMessage(content: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  getCurrentTurn(): Promise<ITurn | undefined>;

  // ─── Model management ────────────────────────────────────────────────────────

  getModel(): Promise<string>;
  setModel(modelId: string): Promise<void>;
  listModels(): Promise<string[]>;

  // ─── Tools ───────────────────────────────────────────────────────────────────

  getActiveTools(): Promise<ToolDescriptor[]>;
  setActiveTools(tools: ITool[]): Promise<void>;

  // ─── Custom session entries ───────────────────────────────────────────────────

  appendCustomMessage(customType: string, content: string, display: boolean): Promise<void>;
  appendCustomEntry(customType: string, data?: unknown): Promise<void>;
  getEntries(customType?: string): Promise<CustomEntry[]>;

  // ─── History & live subscription ─────────────────────────────────────────────

  getHistory(): Promise<HistoryEntry[]>;

  // ─── Context usage ────────────────────────────────────────────────────────────

  getContextUsage(): Promise<ContextUsage>;
  compact(options?: CompactOptions): Promise<void>;

  // ─── System prompt ────────────────────────────────────────────────────────────

  getSystemPrompt(): Promise<string>;

  // ─── Session tree / branching ─────────────────────────────────────────────────

  branch(entryId: string): Promise<void>;
  fork(fromEntryId?: string): Promise<string>;

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  delete(): Promise<void>;
}

// ─── IUser ───────────────────────────────────────────────────────────────────

/**
 * IUser — per-user interface, returned by IPiccoloCore.getUser().
 * Spec ref: specs/api.md §1
 */
export interface IUser {
  newSession(options?: NewSessionOptions): Promise<ISession>;
  getSession(sessionId: string): Promise<ISession>;
  listSessions(): Promise<ISession[]>;
  listModels(): Promise<string[]>;
}

// ─── IPiccoloCore ─────────────────────────────────────────────────────────────

/**
 * IPiccoloCore — WorkerEntrypoint interface exposed by piccolo-core.
 * Gateways connect to this via service binding.
 * Spec ref: specs/api.md §1
 */
export interface IPiccoloCore {
  getUser(userId: string): IUser;
}

// ─── System prompt additions ──────────────────────────────────────────────────

/**
 * A snippet contributed by an extension to the assembled system prompt.
 * Spec ref: specs/api.md §8 §System prompt
 */
export interface SystemPromptAddition {
  section: "skills" | "guidelines" | "context" | "footer";
  content: string;
  priority?: number;
}

// ─── Extension events — single discriminated union ───────────────────────────

/**
 * ExtensionEvent — every event piccolo-core dispatches to extension Workers.
 *
 * Extends AgentEvent: all variants that flow through the agent stream
 * (agent_start, agent_end, turn_start, turn_end, tool_start, tool_end,
 * text_delta, reasoning_delta, error) are also valid ExtensionEvents and can
 * be passed directly to IExtensionRunner.emit() without any mapping.
 *
 * Adds extension-only variants for lifecycle and interception events.
 * Every variant carries a `type` field for discrimination.
 *
 * Spec ref: specs/api.md §8
 */
export type ExtensionEvent =
  // ── All agent loop events (same type strings as AgentEvent) ───────────────
  | AgentEvent
  // ── Lifecycle (extension-only) ────────────────────────────────────────────
  | { type: "session_start"; sessionId: string; userId: string; modelId: string }
  | { type: "session_shutdown"; sessionId: string }
  // ── Interception events (extension-only; have structured return values) ───
  | {
      type: "input";
      text: string;
      attachments: Attachment[];
      source: "user";
      commandName?: string;
      commandArgs?: string;
    }
  | { type: "before_agent_start"; text: string; attachments: Attachment[]; systemPrompt: string }
  | { type: "context"; messages: ModelMessage[] }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: unknown;
      isError: boolean;
    }
  | { type: "before_compact"; messages: ModelMessage[]; keepRecentTokens: number }
  // ── Compact notification ──────────────────────────────────────────────────
  | { type: "compact"; summary: string; keptMessageCount: number };

// ─── Result types for interception events ────────────────────────────────────

export interface InputResult {
  action: "handled" | "transform" | "continue";
  text?: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  contextMessages?: ModelMessage[];
}

export interface ContextResult {
  messages: ModelMessage[];
}

export interface ToolCallResult {
  block: boolean;
  reason?: string;
}

export type ToolResultOverride = Partial<ToolResult>;

export interface BeforeCompactResult {
  cancel?: boolean;
  summary?: string;
}

// ─── Extension interfaces ─────────────────────────────────────────────────────

/**
 * IExtensionListener — event handler interface implemented by extensions.
 *
 * A single `onEvent` method receives any ExtensionEvent and the session context.
 * Return void for fire-and-forget events. For interception events (input,
 * before_agent_start, context, tool_call, tool_result, before_compact) the
 * return type is the appropriate result union (see IExtensionRunner for how
 * the core calls each extension and merges results).
 *
 * Spec ref: specs/api.md §8
 */
export interface IExtensionListener {
  onEvent?(
    event: ExtensionEvent,
    ctx: ISession,
  ): Promise<
    | InputResult
    | BeforeAgentStartResult
    | ContextResult
    | ToolCallResult
    | ToolResultOverride
    | BeforeCompactResult
    | undefined
  >;
}

/**
 * IExtensionWorker — the WorkerEntrypoint interface every extension must implement.
 * Spec ref: specs/api.md §8
 */
export interface IExtensionWorker extends IExtensionListener {
  getTools?(ctx: ISession): Promise<ITool[] | undefined>;
  getCommands?(ctx: ISession): Promise<ICommand[] | undefined>;
  getSystemPromptAdditions?(ctx: ISession): Promise<SystemPromptAddition[] | undefined>;
}
