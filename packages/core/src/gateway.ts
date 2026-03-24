/**
 * AI Gateway / model construction for piccolo-core.
 *
 * `createModel(env, modelId)` is the single factory used by `AgentSessionDO`
 * to create a `LanguageModel` for the agent. All LLM calls are routed through
 * the Cloudflare AI Gateway unified endpoint.
 *
 * Model IDs use the "{provider}/{model-id}" format, e.g.
 *   "anthropic/claude-sonnet-4-5"
 *   "openai/gpt-4o"
 *
 * Spec refs:
 *   specs/agent.md §LLM Backend: Cloudflare AI Gateway
 *   specs/core.md  §Bindings (CF_ACCOUNT_ID, CF_AI_GATEWAY_NAME, CF_AI_GATEWAY_TOKEN)
 */

import type { LanguageModel } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";

/**
 * Construct a LanguageModel routed through the Cloudflare AI Gateway.
 *
 * Reads gateway credentials from the Worker env:
 *   env.CF_ACCOUNT_ID       — Cloudflare account ID (var)
 *   env.CF_AI_GATEWAY_NAME  — AI Gateway name / slug (var)
 *   env.CF_AI_GATEWAY_TOKEN — AI Gateway API token (secret)
 *
 * @param env       Worker environment bindings
 * @param modelId   "{provider}/{model-id}" string, e.g. "anthropic/claude-sonnet-4-5"
 */
export function createModel(env: Env, modelId: string): LanguageModel {
  const gateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AI_GATEWAY_NAME,
    apiKey: env.CF_AI_GATEWAY_TOKEN,
  });
  // createUnified() returns an OpenAI-compatible provider that accepts
  // "{provider}/{model-id}" as the model string.
  return gateway(createUnified()(modelId)) as LanguageModel;
}
