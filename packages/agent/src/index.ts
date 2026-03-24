/**
 * @piccolo/agent — public API
 *
 * Pure TypeScript AI agent loop library. No Workers-specific globals.
 * No gateway knowledge — depends only on: ai, zod.
 *
 * Usage:
 *   import { Agent } from "@piccolo/agent";
 *   // The caller (piccolo-core) constructs the LanguageModel via ai-gateway-provider.
 *   // Tests use MockLanguageModelV3 from ai/test directly.
 *   const agent = new Agent({ model, systemPrompt, tools });
 */

export { Agent } from "./agent.ts";
export type { CompactionSplit } from "./compact.ts";
export {
  agentCompact,
  SUMMARIZATION_SYSTEM_PROMPT,
  serializeConversation,
  splitForCompaction,
} from "./compact.ts";
export { toAiSdkTools } from "./tools.ts";
export type {
  AgentEvent,
  AgentOptions,
  AgentState,
  AgentToolDescriptor,
  AgentToolResult,
  FinishReason,
  IAgentTool,
  ImagePart,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
} from "./types.ts";
