/**
 * Shared type stubs — piccolo-core public JSRPC API types.
 *
 * Every type here is a TODO placeholder that mirrors the shape declared in
 * specs/api.md §Shared Types exactly. Each will be replaced with a full
 * implementation as the relevant milestone is completed. The field names,
 * optionality, and comments must remain in sync with specs/api.md at all
 * times per AGENTS.md Rule 1.
 *
 * Do NOT add logic here. This file is pure types.
 */

// ── External dependencies (will be real imports once packages are installed) ──
// import type { ModelMessage, LanguageModelUsage, FinishReason } from "ai";
// import type { ZodObject } from "zod";

// Temporary stand-ins until `ai` and `zod` packages are installed in item 2.
// TODO(item-2): replace with `import type { ModelMessage, LanguageModelUsage, FinishReason } from "ai"`
// and `import type { ZodObject } from "zod"`.
type ModelMessage = unknown;
type LanguageModelUsage = unknown;
type FinishReason = string;
// ZodObject<any> is required by Zod's own API — no safer type exists.
// TODO(item-2): replace with ZodObject<any> from "zod" (permitted per code.md §any Policy)
type ZodObjectAny = unknown;

// Re-export so consuming packages can import from this single location.
export type { ModelMessage, LanguageModelUsage, FinishReason };

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

// TODO(item-2): implement — placeholder only
export interface ModelInfo {
  id: string; // "{provider}/{model-id}", e.g. "anthropic/claude-sonnet-4-5"
  label: string; // human-readable display name
  provider: string;
}

// ─── Attachments ──────────────────────────────────────────────────────────────

// TODO(item-2): implement — placeholder only
export interface Attachment {
  name: string;
  mimeType: string;
  data: string; // base64 for binary; UTF-8 text otherwise
  size: number;
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

// Streamed from IAgentSessionDO → IPiccoloCore → gateways over JSRPC ReadableStream.
// Also dispatched to extensions via ExtensionRunner.
// TODO(item-2): implement — placeholder only
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; totalUsage: LanguageModelUsage }
  | { type: "turn_start"; stepNumber: number }
  | {
      type: "turn_end";
      stepNumber: number;
      finishReason: FinishReason;
      usage: LanguageModelUsage;
    }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "error"; message: string };

// ─── Tool ─────────────────────────────────────────────────────────────────────

// ToolDescriptor — pure data, no logic.
// Describes the tool to the LLM and to the piccolo core.
// Placed as a static property on every ITool Worker class.
// See tools.md for full authoring guidance.
// TODO(item-12): implement — placeholder only
export interface ToolDescriptor {
  // Identifier the LLM uses to call this tool. Snake_case, unique within a session.
  name: string;

  // Human-readable display name shown in gateway UIs and logs.
  label: string;

  // Full description sent to the LLM in the system prompt.
  description: string;

  // Optional one-line entry added to "Available tools" in the system prompt.
  promptSnippet?: string;

  // Optional bullets appended to "Guidelines" while this tool is active.
  promptGuidelines?: string[];

  // Zod schema for the tool's input parameters.
  // TODO(item-2): type becomes ZodObject<any> once zod is installed (permitted per code.md §any Policy)
  inputSchema: ZodObjectAny;
}

// ITool — the full interface every tool Worker must implement.
// TODO(item-12): implement — placeholder only
export interface ITool {
  readonly descriptor: ToolDescriptor;

  execute(
    toolCallId: string,
    params: unknown,
    ctx: IExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  getGatewayUI?(gatewayId: GatewayId): Promise<ITextUI | undefined>;
}

// Returned by tool execute() and extension executeTool() calls.
// TODO(item-12): implement — placeholder only
export interface ToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  // Arbitrary metadata stored in the session entry for gateway UI rendering.
  // NOT sent to the LLM.
  details?: unknown;
  // Prefer throwing from execute() over setting isError manually.
  isError?: boolean;
}

// ─── Gateway UI ───────────────────────────────────────────────────────────────

// Well-known gateway identifiers.
// TODO(item-10): implement — placeholder only
export type GatewayId = "web" | "telegram" | (string & Record<never, never>);

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
// ITool.execute() to reference it in this stub file without circular imports.
// TODO(item-8): replace with full implementation
export type IExtensionContext = unknown;
