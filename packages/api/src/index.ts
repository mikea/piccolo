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
export type {
  FinishReason,
  ImagePart,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "ai";

// ─── Imports for use below ───────────────────────────────────────────────────

import type { JSONSchema7 as JsonSchema7 } from "@ai-sdk/provider";
import type { FinishReason, LanguageModelUsage, ModelMessage } from "ai";

export type { JsonSchema7 };

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
  | { type: "start" }
  | { type: "finish"; totalUsage: LanguageModelUsage }
  | { type: "step-start"; stepNumber: number }
  | {
      type: "step-finish";
      stepNumber: number;
      finishReason: FinishReason;
      usage: LanguageModelUsage;
    }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: "error"; message: string }
  | { type: "usage"; inputTokens: number };

/**
 * SessionEvent — superset of AgentEvent, plus lifecycle events fired by the DO.
 * `turn_flushed` fires after #handleAgentEnd() completes (D1 written, follow-ups done).
 * Spec ref: specs/api.md §Shared Types §SessionEvent
 */
export type SessionEvent = AgentEvent | { type: "turn_flushed" };

/**
 * ISessionListener — receives every SessionEvent as the DO processes a turn.
 * Install via AgentSessionDO.addListener(). The extension runner is always
 * registered as a listener; tests may add additional ones.
 * Spec ref: specs/api.md §ISessionListener
 */
export interface ISessionListener {
  onEvent(event: SessionEvent): void;
}

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
  inputSchema: JsonSchema7;
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
 * IAbortSignal — JSRPC-serializable cancellation token.
 *
 * The platform AbortSignal cannot cross JSRPC boundaries. This interface is
 * an RpcTarget capability: piccolo-core creates an implementation backed by the
 * real AbortSignal and passes it to tool execute() calls over JSRPC.
 * Tool implementations call isAborted() to poll and cancel their own
 * AbortController accordingly.
 * Spec ref: specs/api.md §Shared Types §IAbortSignal
 */
export interface IAbortSignal {
  /** Returns true if cancellation has been requested. */
  isAborted(): Promise<boolean>;
}

/**
 * ITool — the full interface every tool Worker must implement.
 * Spec ref: specs/api.md §Shared Types §ITool
 */
export interface ITool {
  getDescriptor(): Promise<ToolDescriptor>;

  /**
   * Called by the core when the LLM invokes this tool.
   * Throw to signal failure — the core sets isError: true automatically.
   */
  execute(
    toolCallId: string,
    params: unknown,
    ctx: ISession,
    signal?: IAbortSignal,
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

// ─── IObserver / IObservable ──────────────────────────────────────────────────

/**
 * IObserver<T> — receives values from an IObservable<T>.
 * onNext() is called for each value; return a Promise to apply backpressure.
 * Spec ref: specs/api.md §IObserver
 */
export interface IObserver<T> {
  onNext(value: T): Promise<void>;
  onError(error: unknown): Promise<void>;
  onComplete(): Promise<void>;
}

/**
 * IDisposable — anything that can be explicitly released.
 * Integrates with JavaScript's explicit resource management (`using` declarations).
 * Spec ref: specs/api.md §IDisposable
 */
export interface IDisposable {
  [Symbol.dispose](): void;
}

/**
 * IObservable<T> — a push-based sequence of values.
 * Call subscribe() to start receiving values via an IObserver<T>.
 * Returns an IDisposable that must be disposed to unsubscribe.
 * Spec ref: specs/api.md §IObservable
 */
export interface IObservable<T> {
  subscribe(observer: IObserver<T>): Promise<IDisposable>;
}

// ─── ITurn — Active turn context ──────────────────────────────────────────────

/**
 * ITurn — returned by ISession.prompt().
 * Carries only the optional gateway callback for interactive mid-turn prompts.
 * AgentEvents are delivered via ISession.subscribe() — the session is the observable.
 * Spec ref: specs/api.md §ITurn
 */
export interface ITurn {
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
 *
 * Extends IObservable<AgentEvent>: subscribe() delivers all AgentEvents for
 * all turns through this session. The session is the single observable surface.
 * Spec ref: specs/api.md §2
 */
export interface ISession extends IObservable<AgentEvent> {
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
 * ExtensionEvent — interception events dispatched to extension Workers.
 *
 * Only contains events that require a return value (interception/merge semantics).
 * AgentEvents are no longer dispatched here — extensions subscribe to ISession
 * directly via init(ctx) if they want to observe agent events.
 *
 * Every variant carries a `type` field for discrimination.
 *
 * Spec ref: specs/api.md §8
 */
export type ExtensionEvent =
  // ── Interception events (have structured return values) ───────────────────
  | {
      type: "input";
      text: string;
      attachments: Attachment[];
      source: "user";
      commandName?: string;
      commandArgs?: string;
    }
  | { type: "before_start"; text: string; attachments: Attachment[]; systemPrompt: string }
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
  | { type: "before_compact"; messages: ModelMessage[]; keepRecentTokens: number };

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
 * IExtensionListener — interception event handler implemented by extensions.
 *
 * onEvent receives only interception events (input, before_start, context,
 * tool_call, tool_result, before_compact) that require a structured return value.
 *
 * For observing AgentEvents, extensions subscribe to ISession via init(ctx).
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
  /**
   * Called once when the session starts. The extension receives the full ISession
   * and may call session.subscribe() to observe AgentEvents for the session lifetime.
   */
  init?(ctx: ISession): Promise<void>;
  getTools?(ctx: ISession): Promise<ITool[] | undefined>;
  getCommands?(ctx: ISession): Promise<ICommand[] | undefined>;
  getSystemPromptAdditions?(ctx: ISession): Promise<SystemPromptAddition[] | undefined>;
}
