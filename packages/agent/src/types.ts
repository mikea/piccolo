/**
 * Agent-loop types for packages/agent.
 *
 * This file is intentionally minimal. It contains only what the agent loop
 * itself needs to run: tool registration, tool execution, and event emission.
 *
 * Deliberately excluded — all belong in packages/core or callers:
 * - Gateway IDs, gateway-specific UI interfaces, AI Gateway construction
 * - Session/storage types (SessionRecord, ModelInfo, ContextUsage, etc.)
 * - Extension system types (IExtensionContext full interface, commands, etc.)
 * - System-prompt assembly types (label, promptSnippet, promptGuidelines)
 * - Attachment handling (delegated to the caller before constructing messages)
 *
 * packages/core extends these minimal types with the full piccolo surface.
 */

import type { JSONSchema7 } from "@ai-sdk/provider";
import type { FinishReason, ImagePart, LanguageModel, LanguageModelUsage, ModelMessage } from "ai";

export type JsonSchema7 = JSONSchema7;

export type { FinishReason, ImagePart, LanguageModel, LanguageModelUsage, ModelMessage };

// ─── Session (minimal agent-layer interface) ──────────────────────────────────

/**
 * Minimal session interface at the agent layer.
 *
 * This is the type of the `ctx` parameter in `IAgentTool.execute()`.
 * `piccolo-core`'s `ISession` extends this interface — tools receive the full
 * `ISession` at runtime; the agent passes it through opaquely as `IAgentSession`.
 *
 * Intentionally empty here: the agent loop has no knowledge of what a session
 * can do — it only needs a stable type to thread through to tools.
 *
 * Spec ref: specs/agent.md §IAgentSession
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty — see JSDoc above
export interface IAgentSession {}

// ─── Tool ─────────────────────────────────────────────────────────────────────

/**
 * The minimal descriptor needed to register a tool with the LLM and execute it.
 *
 * This is intentionally a subset of the richer ToolDescriptor in packages/core,
 * which adds label, promptSnippet, promptGuidelines, and gateway UI hooks.
 */
export interface AgentToolDescriptor {
  /** Identifier the LLM uses to call this tool. Snake_case, unique within a session. */
  name: string;

  /** Full description sent to the LLM in the system prompt. */
  description: string;

  /** JSON Schema (draft-07 style) for the tool input parameters. */
  inputSchema: JsonSchema7;
}

/**
 * The result returned by a tool's execute() method.
 *
 * `content` is sent to the LLM as the tool result.
 * Throw from execute() rather than setting isError manually — the agent sets
 * isError: true automatically when execute() throws.
 */
export interface AgentToolResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

/**
 * The minimal interface the agent loop needs from any tool.
 *
 * No gateway UI method. No label. No system-prompt snippets.
 * packages/core extends this with ITextUI hooks and richer descriptor fields.
 *
 * IExtensionContext is typed as `unknown` here — it is a forward reference to
 * a type defined in packages/core (item 8). Tools receive the real context at
 * runtime via the execute() call; the agent passes it through opaquely.
 */
export interface IAgentTool {
  readonly descriptor: AgentToolDescriptor;

  /**
   * Execute the tool.
   *
   * `ctx` is the session context for this turn. Typed as `IAgentSession` here;
   * at runtime piccolo-core supplies the full `ISession` which extends `IAgentSession`.
   * Cast to `ISession` inside tool implementations.
   *
   * Spec ref: specs/api.md §ITool, specs/agent.md §IAgentSession
   */
  execute(
    toolCallId: string,
    params: unknown,
    ctx: IAgentSession,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

/**
 * Events emitted by the Agent class during a streaming turn.
 * Maps directly from streamText callbacks — no gateway or session concerns.
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

// ─── Agent State ──────────────────────────────────────────────────────────────

/**
 * Mutable runtime state of the Agent.
 * Exposed as a readonly reference via agent.state.
 */
export interface AgentState {
  model: LanguageModel;
  systemPrompt: string;
  tools: IAgentTool[];
  messages: ModelMessage[];
  isStreaming: boolean;
  error?: string;
}

// ─── Agent Options ────────────────────────────────────────────────────────────

/**
 * Constructor options for the Agent class.
 *
 * The agent accepts a LanguageModel directly — the caller (piccolo-core) is
 * responsible for constructing it via createAiGateway + createUnified, or
 * any other provider. This keeps packages/agent free of gateway concerns.
 */
export interface AgentOptions {
  /**
   * The language model to use for LLM calls.
   * piccolo-core constructs this via ai-gateway-provider; tests use MockLanguageModelV3.
   * packages/agent has no knowledge of how the model was built.
   */
  model: LanguageModel;

  /** System prompt string assembled by the caller. */
  systemPrompt: string;

  /** Initial tool set. Can be updated via agent.setTools(). */
  tools?: IAgentTool[];

  /**
   * Maximum number of LLM steps (tool call rounds) per prompt() call.
   * @default 20
   */
  maxSteps?: number;

  /**
   * How many steering messages to dequeue per step.
   * "one-at-a-time": dequeue one message per step (default).
   * "all": dequeue all pending messages at once.
   * @default "one-at-a-time"
   */
  steeringMode?: "one-at-a-time" | "all";

  /**
   * How many follow-up messages to dequeue when continue() is triggered.
   * "one-at-a-time": trigger one follow-up per continue() call (default).
   * "all": prepend all pending follow-up messages at once.
   * @default "one-at-a-time"
   */
  followUpMode?: "one-at-a-time" | "all";
}
