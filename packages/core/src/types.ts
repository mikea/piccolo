/**
 * Shared type definitions — piccolo-core public JSRPC API types.
 *
 * Every type here mirrors the shape declared in specs/api.md §Shared Types
 * exactly. Field names, optionality, and comments must remain in sync with
 * specs/api.md at all times per AGENTS.md Rule 1.
 *
 * Do NOT add logic here. This file is pure types.
 *
 * All types that were previously split across @piccolo/agent and @piccolo/core
 * are now defined here directly. There is a single type hierarchy with no
 * intermediate base types:
 *   ToolDescriptor  — name, description, inputSchema, label, snippets
 *   ITool           — descriptor: ToolDescriptor, execute(), getGatewayUI?()
 *   ToolResult      — content, isError?, details?
 *   ISession        — full per-session API
 *   AgentTurn       — active turn handle (stream + abort)
 */

export type { JSONSchema7 as JsonSchema7 } from "@ai-sdk/provider";
// ── Re-export ai types used across packages ──────────────────────────────────
export type {
  FinishReason,
  ImagePart,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "ai";

// ─── Session ──────────────────────────────────────────────────────────────────

/** Internal session record stored in D1. Not exposed to gateway clients. */
export interface SessionRecord {
  id: string; // UUID v4
  userId: string;
  createdAt: number; // Unix ms
  updatedAt: number; // Unix ms
  name?: string;
  cwd?: string;
}

export interface NewSessionOptions {
  name?: string;
  modelId?: string;
  cwd?: string;
}

// ─── Attachments ──────────────────────────────────────────────────────────────

export interface Attachment {
  name: string;
  mimeType: string;
  data: string; // base64 for binary; UTF-8 text otherwise
  size: number;
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

import type { JSONSchema7 } from "@ai-sdk/provider";
import type { FinishReason, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";

/**
 * Events streamed from the Agent during a turn.
 * Maps directly from streamText callbacks — no gateway or session concerns.
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

// ─── AgentTurn — active turn handle ──────────────────────────────────────────

/**
 * A handle to the currently active agent turn.
 * Returned synchronously by Agent.prompt().
 * The stream is a single-consumer ReadableStream — tee() if two consumers needed.
 * Spec ref: specs/core.md §Agent Loop §AgentTurn
 */
export interface AgentTurn {
  /** The AgentEvent stream for this turn. */
  readonly stream: ReadableStream<AgentEvent>;
  /** Abort this turn immediately. No-op after the turn completes. */
  abort(): void;
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

/**
 * ToolDescriptor — pure data describing a tool to the LLM and piccolo-core.
 * No intermediate AgentToolDescriptor base type — all fields live here directly.
 * Spec ref: specs/api.md §Shared Types §ToolDescriptor
 */
export interface ToolDescriptor {
  /** Identifier the LLM uses to call this tool. Snake_case, unique within a session. */
  name: string;

  /** Human-readable display name shown in gateway UIs and logs. */
  label: string;

  /** Full description sent to the LLM. Be precise and complete. */
  description: string;

  /** Optional one-line entry added to "Available tools" in the system prompt. */
  promptSnippet?: string;

  /** Optional bullets appended to "Guidelines" while this tool is active. */
  promptGuidelines?: string[];

  /** JSON Schema (draft-07 style) for the tool input parameters. */
  inputSchema: JSONSchema7;
}

export interface ICommand {
  name: string;
  description: string;
  showInAutocomplete?: boolean;
}

/**
 * ToolResult — returned by ITool.execute().
 * No intermediate AgentToolResult base type.
 * Spec ref: specs/api.md §Shared Types §ToolResult
 */
export interface ToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  /** Arbitrary metadata stored in the session entry for gateway UI rendering. NOT sent to LLM. */
  details?: unknown;
  /** Prefer throwing from execute() over setting isError manually. */
  isError?: boolean;
}

/**
 * ITool — the full interface every tool Worker must implement.
 * No intermediate IAgentTool base type.
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

// ─── Gateway UI ───────────────────────────────────────────────────────────────

export type GatewayId = "web" | "telegram" | (string & {});

export interface ITextUI {
  getStatusText(): Promise<string>;
  getResultText(output: unknown): Promise<string>;
  getErrorText(error: unknown): Promise<string>;
}

export interface IWebUI extends ITextUI {
  getComponent(phase: "call" | "result"): Promise<WebComponentDescriptor | undefined>;
}

export interface WebComponentDescriptor {
  componentId: string;
  props: Record<string, unknown>;
}

// ─── Gateway Callback ─────────────────────────────────────────────────────────

export interface IGatewayCallback {
  requestSelect(title: string, options: string[], multiple?: boolean): Promise<string[] | null>;
  requestConfirm(title: string, message: string): Promise<boolean>;
  requestInput(title: string, placeholder?: string): Promise<string | null>;
  notify(message: string, level: "info" | "success" | "warning" | "error"): Promise<void>;
}

// ─── ITurn — Active turn context ──────────────────────────────────────────────

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

export interface CustomEntry {
  id: string;
  customType: string;
  data: unknown;
  timestamp: string; // ISO 8601
}

// ─── History ──────────────────────────────────────────────────────────────────

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

// ─── Session Status ───────────────────────────────────────────────────────────

export interface SessionStatus {
  isStreaming: boolean;
  model: string;
  name: string | undefined;
}

// ─── ISession — the unified session/context interface ────────────────────────

export interface ISession {
  // ─── Identity ───────────────────────────────────────────────────────────────

  sessionId(): Promise<string>;
  getUpdatedAt(): Promise<number>;
  readonly userId: string;

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
  getStatus(): Promise<SessionStatus>;

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

// ─── IUser — Per-user interface ───────────────────────────────────────────────

export interface IUser {
  newSession(options?: NewSessionOptions): Promise<ISession>;
  getSession(sessionId: string): Promise<ISession>;
  listSessions(): Promise<ISession[]>;
  listModels(): Promise<string[]>;
}

// ─── IPiccoloCore — WorkerEntrypoint interface ────────────────────────────────

export interface IPiccoloCore {
  getUser(userId: string): IUser;
}

// ─── Agent State and Options ──────────────────────────────────────────────────

/**
 * Mutable runtime state of the Agent.
 * Exposed as a readonly reference via agent.state.
 * Spec ref: specs/core.md §Agent Loop §AgentState
 */
export interface AgentState {
  model: LanguageModel;
  systemPrompt: string;
  tools: ITool[];
  messages: ModelMessage[];
  isStreaming: boolean;
  error?: string;
}

/**
 * Constructor options for the Agent class.
 * Spec ref: specs/core.md §Agent Loop §AgentOptions
 */
export interface AgentOptions {
  model: LanguageModel;
  systemPrompt: string;
  tools?: ITool[];
  maxSteps?: number;
  steeringMode?: "one-at-a-time" | "all";
}
