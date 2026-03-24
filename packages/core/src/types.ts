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
 *                       AgentToolResult, AgentEvent, LanguageModel, ModelMessage, …)
 *   packages/core    — extends those with the full piccolo surface:
 *                       ToolDescriptor extends AgentToolDescriptor (adds label, snippets)
 *                       ITool extends IAgentTool (adds getGatewayUI)
 *                       ToolResult extends AgentToolResult (adds details)
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
  IAgentTool,
  ImagePart,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "@piccolo/agent";

// ── External dependencies ────────────────────────────────────────────────────
import type { AgentToolDescriptor, AgentToolResult, IAgentTool } from "@piccolo/agent";
import type { ZodObject } from "zod";

// ─── Session ──────────────────────────────────────────────────────────────────

// TODO(item-4): implement — placeholder only
export interface SessionRecord {
  id: string; // UUID v4
  userId: string;
  createdAt: number; // Unix ms
  updatedAt: number; // Unix ms
  name?: string;
  cwd?: string;
}

// Lightweight summary returned by listSessions().
// TODO(item-4): implement — placeholder only
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
    ctx: IExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  getGatewayUI?(gatewayId: string): Promise<ITextUI | undefined>;
}

// ─── Gateway UI ───────────────────────────────────────────────────────────────

// Well-known gateway identifiers. Defined as a plain string type here;
// specific gateway implementations declare their own constants.
// The agent layer has no knowledge of gateway IDs.
// TODO(item-10): implement — placeholder only
export type GatewayId = string;

// ITextUI — minimal shared interface implemented by every gateway.
// TODO(item-10): implement — placeholder only
export interface ITextUI {
  showStatus(text: string): Promise<void>;
  showResult(text: string): Promise<void>;
  showError(text: string): Promise<void>;
}

// ─── Context / Compaction ─────────────────────────────────────────────────────

// TODO(item-5): implement — placeholder only
export interface ContextUsage {
  inputTokens: number;
  contextWindowTokens: number; // model's context window size
  usedFraction: number; // inputTokens / contextWindowTokens
}

// TODO(item-5): implement — placeholder only
export interface CompactOptions {
  keepRecentTokens?: number; // default: 20_000
}

// Entry returned by IExtensionContext.getEntries()
// TODO(item-8): implement — placeholder only
export interface CustomEntry {
  id: string;
  customType: string;
  data: unknown;
  timestamp: string; // ISO 8601
}

// ─── Extension Context (forward reference) ───────────────────────────────────

// IExtensionContext is defined fully in item 8. This forward declaration allows
// ITool.execute() to reference it without circular imports.
// TODO(item-8): replace with full implementation
export type IExtensionContext = unknown;

// Prevent unused import lint error — ZodObject is used in the JSDoc comment
// for ToolDescriptor.inputSchema which is inherited. Explicitly reference it
// so the import is not flagged.
// biome-ignore lint/suspicious/noExplicitAny: Zod's own API requires ZodObject<any>
type _ZodRef = ZodObject<any>;
