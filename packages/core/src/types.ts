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
} from "@piccolo/agent";
import type { ZodObject } from "zod";

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string; // UUID v4
  userId: string;
  createdAt: number; // Unix ms
  updatedAt: number; // Unix ms
  name?: string;
  cwd?: string;
}

// Lightweight summary returned by listSessions().
export interface SessionInfo {
  id: string;
  userId: string;
  name?: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  firstMessage: string; // preview of first user message
}

// TODO(item-9): implement — placeholder only
export interface NewSessionOptions {
  name?: string;
  modelId?: string;
  cwd?: string;
}

// ─── Model ────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string; // "{provider}/{model-id}", e.g. "anthropic/claude-sonnet-4-5"
  label: string; // human-readable display name
  provider: string;
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
  //   inputSchema: ZodObject<any>  — biome-ignore lint/suspicious/noExplicitAny: Zod API
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
// TODO(item-10): gateway implementations declare their own ID constants
export type GatewayId = "web" | "telegram" | (string & {});

// ITextUI — minimal shared interface implemented by every gateway.
// TODO(item-10): implement — placeholder only
export interface ITextUI {
  showStatus(text: string): Promise<void>;
  showResult(text: string): Promise<void>;
  showError(text: string): Promise<void>;
}

// ─── Context / Compaction ─────────────────────────────────────────────────────

export interface ContextUsage {
  inputTokens: number;
  contextWindowTokens: number; // model's context window size
  usedFraction: number; // inputTokens / contextWindowTokens
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
// Implemented in packages/core by SessionImpl extends RpcTarget.
// All code uses ISession — no code outside session-impl.ts references SessionImpl.
//
// Spec ref: specs/api.md §2
export interface ISession extends IAgentSession {
  // ─── Identity ───────────────────────────────────────────────────────────────

  /** Stable session identifier (UUID v4). */
  id(): Promise<string>;

  /** Full session record including timestamps and metadata. */
  info(): Promise<SessionRecord>;

  /** The user who owns this session. */
  readonly userId: string;

  // ─── Metadata ───────────────────────────────────────────────────────────────

  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ────────────────────────────────────────────────────────────

  /** Start a new agent turn. Returns a stream of AgentEvents for this turn. */
  prompt(text: string, attachments?: Attachment[]): Promise<ReadableStream<AgentEvent>>;

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

  // ─── Model management ────────────────────────────────────────────────────────

  getModel(): Promise<ModelInfo>;
  setModel(modelId: string): Promise<void>;
  listModels(): Promise<ModelInfo[]>;

  // ─── Tools ───────────────────────────────────────────────────────────────────

  /** Returns descriptors of all currently active tools. */
  getActiveTools(): Promise<ToolDescriptor[]>;
  setActiveTools(toolNames: string[]): Promise<void>;

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
  fork(fromEntryId?: string): Promise<ISession>;

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  delete(): Promise<void>;
}

// Prevent unused import lint error — ZodObject is used in the JSDoc comment
// for ToolDescriptor.inputSchema which is inherited. Explicitly reference it
// so the import is not flagged.
// biome-ignore lint/suspicious/noExplicitAny: Zod's own API requires ZodObject<any>
type _ZodRef = ZodObject<any>;
