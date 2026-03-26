/**
 * Shared type stubs — piccolo-core public JSRPC API types.
 *
 * Every type here mirrors the shape declared in specs/api.md §Shared Types
 * exactly. Each will be replaced with a full implementation as the relevant
 * milestone is completed. The field names, optionality, and comments must
 * remain in sync with specs/api.md at all times per AGENTS.md Rule 1.
 *
 * Do NOT add logic here. This file is pure types.
 *
 * Layering:
 *   packages/agent   — minimal agent-loop types (AgentToolDescriptor, IAgentTool,
 *                       AgentToolResult, AgentEvent, IAgentSession, LanguageModel, …)
 *   packages/core    — extends those with the full piccolo surface:
 *                       ToolDescriptor extends AgentToolDescriptor (adds label, snippets)
 *                       ITool extends IAgentTool (adds getGatewayUI)
 *                       ToolResult extends AgentToolResult (adds details)
 *                       ISession extends IAgentSession (full per-session API)
 *                       AgentEvent re-exported (canonical definition in agent)
 */

// ── Re-export agent types ────────────────────────────────────────────────────
// packages/core consumers import from here; they don't need to depend on
// @piccolo/agent directly.
export type {
  AgentEvent,
  AgentToolDescriptor,
  AgentToolResult,
  FinishReason,
  IAgentSession,
  IAgentTool,
  ImagePart,
  JsonSchema7,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "@piccolo/agent";

// ── External dependencies ────────────────────────────────────────────────────
import type {
  AgentEvent,
  AgentToolDescriptor,
  AgentToolResult,
  IAgentSession,
  IAgentTool,
  JsonSchema7,
} from "@piccolo/agent";

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

// TODO(item-9): implement — placeholder only
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

// ─── Tool ─────────────────────────────────────────────────────────────────────

// ToolDescriptor extends AgentToolDescriptor with piccolo-core-specific fields
// used by SystemPromptAssembler and gateway UIs.
//
// AgentToolDescriptor (in @piccolo/agent) carries:
//   name, description, inputSchema
//
// ToolDescriptor adds:
//   label, promptSnippet?, promptGuidelines?
//
// TODO(item-12): implement — placeholder only
export interface ToolDescriptor extends AgentToolDescriptor {
  // Human-readable display name shown in gateway UIs and logs.
  label: string;

  // Optional one-line entry added to "Available tools" in the system prompt.
  promptSnippet?: string;

  // Optional bullets appended to "Guidelines" while this tool is active.
  promptGuidelines?: string[];

  // Inherits from AgentToolDescriptor:
  //   name: string
  //   description: string
  //   inputSchema: JsonSchema7
}

export interface ICommand {
  name: string;
  description: string;
  showInAutocomplete?: boolean;
}

// ToolResult extends AgentToolResult with the piccolo-core-specific `details` field.
// AgentToolResult carries: content, isError?
// ToolResult adds:         details? (stored in session entry, NOT sent to LLM)
//
// TODO(item-12): implement — placeholder only
export interface ToolResult extends AgentToolResult {
  // Arbitrary metadata stored in the session entry for gateway UI rendering.
  // NOT sent to the LLM.
  details?: unknown;

  // Inherits from AgentToolResult:
  //   content: Array<{ type: "text"; text: string } | { type: "image"; ... }>
  //   isError?: boolean
}

// ITool extends IAgentTool with the piccolo-core-specific getGatewayUI hook.
// IAgentTool (in @piccolo/agent) carries:
//   descriptor: AgentToolDescriptor
//   execute(toolCallId, params, ctx, signal?): Promise<AgentToolResult>
//
// ITool adds:
//   descriptor: ToolDescriptor  (narrower — adds label, snippets)
//   execute(...): Promise<ToolResult>  (narrower — adds details)
//   getGatewayUI?(gatewayId): Promise<ITextUI | undefined>
//
// TODO(item-12): implement — placeholder only
export interface ITool extends IAgentTool {
  readonly descriptor: ToolDescriptor;

  execute(
    toolCallId: string,
    params: unknown,
    ctx: ISession,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  getGatewayUI?(gatewayId: string): Promise<ITextUI | undefined>;
}

// ─── Gateway UI ───────────────────────────────────────────────────────────────

// Well-known gateway identifiers.
// The branded union `"web" | "telegram" | (string & {})` provides IDE autocomplete
// for the two built-in gateways while still accepting arbitrary extension gateway IDs.
export type GatewayId = "web" | "telegram" | (string & {});

// ITextUI — minimal shared interface implemented by tool Workers.
// Returned by ITool.getGatewayUI("web") or getGatewayUI("telegram")
// when the tool does not need gateway-specific rendering.
// The gateway calls these to PULL rendering text from the tool;
// the tool provides its own display strings.
// Spec ref: specs/api.md §3
export interface ITextUI {
  // Return a status line to display while the tool is executing.
  getStatusText(): Promise<string>;
  // Return the formatted result text once execute() completes.
  getResultText(output: unknown): Promise<string>;
  // Return an error message when execute() throws.
  getErrorText(error: unknown): Promise<string>;
}

// IWebUI — Web UI Gateway rendering interface.
// Returned by ITool.getGatewayUI("web").
// Spec ref: specs/api.md §3
export interface IWebUI extends ITextUI {
  // Return a component descriptor for custom React rendering.
  // componentId must be a stable string registered by the tool's extension Worker.
  getComponent(phase: "call" | "result"): Promise<WebComponentDescriptor | undefined>;
}

// Descriptor for a custom React component served at /components/{componentId}.js.
// Spec ref: specs/api.md §3
export interface WebComponentDescriptor {
  componentId: string; // stable identifier, e.g. "r2-file-tree"
  props: Record<string, unknown>; // serialisable props passed to the component
}

// ─── Gateway Callback ─────────────────────────────────────────────────────────

// IGatewayCallback — Interactive prompts from core back to the gateway mid-turn.
// Implemented by each gateway. An RpcTarget stub is passed into ISession.prompt()
// so the core can call back for interactive input (select, confirm, input, notify).
// Tools access the active callback via ITurn.getCallback() from ctx.getCurrentTurn().
// Spec ref: specs/api.md §5
export interface IGatewayCallback {
  requestSelect(title: string, options: string[], multiple?: boolean): Promise<string[] | null>;
  requestConfirm(title: string, message: string): Promise<boolean>;
  requestInput(title: string, placeholder?: string): Promise<string | null>;
  notify(message: string, level: "info" | "success" | "warning" | "error"): Promise<void>;
}

// ─── ITurn — Active turn context ──────────────────────────────────────────────

// ITurn — represents the currently active agent turn.
// Owns the AgentEvent stream for the turn and the optional gateway callback.
// Accessible from tool and extension context via ISession.getCurrentTurn().
// Only available while a turn is in progress; undefined between turns.
// The callback is a property of the turn (not the session) since it is
// bound to a specific prompt() call and is ephemeral.
// For refresh support, the active turn is also available via
// ISession.getCurrentTurn(), which returns undefined between turns.
// Spec ref: specs/api.md §2
export interface ITurn {
  // Return the ReadableStream<AgentEvent> for this turn.
  // The stream emits all events for the turn in progress.
  getStream(): Promise<ReadableStream<AgentEvent>>;

  // Return the gateway's IGatewayCallback stub for this turn (if any).
  // Tools call this to request interactive input mid-turn.
  getCallback(): Promise<IGatewayCallback | undefined>;
}

// ─── Context / Compaction ─────────────────────────────────────────────────────

export interface ContextUsage {
  /** Total input tokens used in the last completed turn. */
  inputTokens: number;
}

export interface CompactOptions {
  keepRecentTokens?: number; // default: 20_000
}

// Entry returned by ISession.getEntries()
export interface CustomEntry {
  id: string;
  customType: string;
  data: unknown;
  timestamp: string; // ISO 8601
}

// ─── History ──────────────────────────────────────────────────────────────────

// A single renderable entry in a session's conversation history.
// Returned by ISession.getHistory() — the canonical server-side view of the
// conversation. Gateways render this directly on load; no client-side state.
//
// Roles:
//   "user"      — a message typed by the user
//   "assistant" — text generated by the LLM (may still be streaming)
//   "tool"      — a tool invocation with its result
//   "error"     — an error that occurred during a turn
//
// Spec ref: specs/api.md §Shared Types
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

// Snapshot of session-level state. Returned by ISession.getStatus().
// Gateways use this to render controls (e.g. disable send while streaming).
// Spec ref: specs/api.md §Shared Types
export interface SessionStatus {
  isStreaming: boolean; // true while a prompt() turn is in progress
  model: string; // current model ID
  name: string | undefined;
}

// ─── ISession — the unified session/context interface ────────────────────────
//
// Used as:
//   - The RpcTarget stub returned by IPiccoloCore.newSession() / getSession() to gateways
//   - The context object (ctx) passed to every IExtensionWorker handler call
//   - The ctx parameter of ITool.execute()
//
// In packages/agent, the minimal subset IAgentSession is used so that the agent
// loop has no knowledge of the full session surface.
//
// Implemented in packages/core by AgentSessionDO (extends DurableObject, implements ISession).
// All code uses ISession — no code outside agent-session-do.ts references AgentSessionDO directly.
//
// Spec ref: specs/api.md §2
export interface ISession extends IAgentSession {
  // ─── Identity ───────────────────────────────────────────────────────────────

  /** Stable session identifier (UUID v4). */
  sessionId(): Promise<string>;

  /** Unix ms timestamp of the last update (used for sorting). */
  getUpdatedAt(): Promise<number>;

  /** The user who owns this session. */
  readonly userId: string;

  // ─── Metadata ───────────────────────────────────────────────────────────────

  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ────────────────────────────────────────────────────────────

  /**
   * Start a new agent turn. Returns an ITurn that owns the event stream for
   * this turn. Callers consume ITurn.getStream() to receive AgentEvents.
   * The callback is bound to the turn (not the session) and is ephemeral.
   */
  prompt(text: string, attachments?: Attachment[], callback?: IGatewayCallback): Promise<ITurn>;

  /**
   * Inject a user-role message into the conversation (visible to the LLM).
   * If a turn is active, delivered as a steer (mid-turn injection).
   */
  sendUserMessage(content: string): Promise<void>;

  /** Inject text mid-turn (after next tool batch, before next LLM call). */
  steer(text: string): Promise<void>;

  /**
   * Queue text to be sent when the current turn finishes naturally.
   * Use this from onAgentEnd or background tasks to chain follow-on turns.
   */
  followUp(text: string): Promise<void>;

  /** Abort the current streaming turn immediately. */
  abort(): Promise<void>;

  /**
   * Return the active turn context (if a turn is in progress), or undefined if idle.
   * Gateways call this after getHistory() to reconnect to an in-progress turn
   * (e.g. after a page reload): call ITurn.getStream() on the result to receive
   * the remaining AgentEvents. Use ITurn.getCallback() for interactive mid-turn prompts.
   */
  getCurrentTurn(): Promise<ITurn | undefined>;

  // ─── Model management ────────────────────────────────────────────────────────

  getModel(): Promise<string>;
  setModel(modelId: string): Promise<void>;
  listModels(): Promise<string[]>;

  // ─── Tools ───────────────────────────────────────────────────────────────────

  /** Returns descriptors of all currently active tools. */
  getActiveTools(): Promise<ToolDescriptor[]>;
  /** Set the active tools. Accepts IAgentTool RpcTargets directly over JSRPC. */
  setActiveTools(tools: IAgentTool[]): Promise<void>;

  // ─── Custom session entries ───────────────────────────────────────────────────

  /** Appends an extension-defined message visible to the LLM. */
  appendCustomMessage(customType: string, content: string, display: boolean): Promise<void>;

  /** Appends an opaque entry to the session log (NOT sent to LLM). */
  appendCustomEntry(customType: string, data?: unknown): Promise<void>;

  /**
   * Read back custom entries on the current branch.
   * @param customType - If provided, filters to entries matching this type.
   */
  getEntries(customType?: string): Promise<CustomEntry[]>;

  // ─── History & live subscription ─────────────────────────────────────────────

  /**
   * Return the full conversation history as renderable HistoryEntry items.
   * Gateways call this on load (including after page reload) to reconstruct
   * the visible chat. If a turn is currently streaming, the last entry will
   * be an assistant entry with isStreaming: true and the text accumulated so far.
   * Replaces client-side message state — the server is the single source of truth.
   * Spec ref: specs/api.md §ISession
   */
  getHistory(): Promise<HistoryEntry[]>;

  /**
   * Return a snapshot of session-level state (isStreaming, model, name).
   * Gateways use this to render controls without holding local state.
   * Spec ref: specs/api.md §ISession
   */
  getStatus(): Promise<SessionStatus>;

  // ─── Context usage ────────────────────────────────────────────────────────────

  getContextUsage(): Promise<ContextUsage>;

  /** Trigger context compaction immediately. */
  compact(options?: CompactOptions): Promise<void>;

  // ─── System prompt ────────────────────────────────────────────────────────────

  getSystemPrompt(): Promise<string>;

  // ─── Session tree / branching ─────────────────────────────────────────────────

  /** Set the active leaf to a prior entry. Next prompt branches from there. */
  branch(entryId: string): Promise<void>;

  /**
   * Fork this session from a given entry (or current leaf).
   * Returns a new ISession stub for the forked session.
   */
  fork(fromEntryId?: string): Promise<string>; // returns new sessionId; caller fetches stub

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  delete(): Promise<void>;
}

// ─── IUser — Per-user interface ───────────────────────────────────────────────
//
// Spec ref: specs/api.md §IUser
export interface IUser {
  newSession(options?: NewSessionOptions): Promise<ISession>;
  getSession(sessionId: string): Promise<ISession>;
  listSessions(): Promise<ISession[]>;
  listModels(): Promise<string[]>;
}

// ─── IPiccoloCore — WorkerEntrypoint interface ────────────────────────────────
//
// Spec ref: specs/api.md §1
export interface IPiccoloCore {
  getUser(userId: string): IUser;
}

// Prevent unused import lint error — JsonSchema7 is referenced in ToolDescriptor docs.
type _JsonSchemaRef = JsonSchema7;
