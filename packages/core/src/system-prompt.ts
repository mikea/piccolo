/**
 * Base system prompt for piccolo-core.
 *
 * `buildBasePrompt(agentName)` renders the template using the agent name sourced
 * from the `AGENT_NAME` environment variable (set in `wrangler.template.jsonc`).
 * The rendered string is the "base" passed to `SystemPromptAssembler.assemble()`.
 *
 * Extension additions (context, skills, guidelines, footer) are appended by the
 * assembler (step 7). This file only owns the base template.
 *
 * Spec refs:
 *   specs/core.md §SystemPromptAssembler — base system prompt
 *   specs/core.md §Bindings — AGENT_NAME var
 */

/** Default agent name used when AGENT_NAME is absent (e.g. in tests). */
export const DEFAULT_AGENT_NAME = "Piccolo";

/**
 * Render the base system prompt using the provided agent name.
 *
 * @param agentName  Value of `env.AGENT_NAME` — the display name for this agent
 *                   instance. Defaults to "Piccolo" if empty.
 */
export function buildBasePrompt(agentName: string): string {
  const name = agentName.trim() || DEFAULT_AGENT_NAME;
  return `You are ${name}, a helpful AI assistant powered by Cloudflare Workers.

You have access to tools that can help you accomplish tasks. Use them when they will help you provide a better answer. Always be honest about what you know and what you don't know.

When using tools:
- Only call tools when they are necessary to answer the question.
- Prefer a single well-targeted tool call over multiple speculative ones.
- Always report back what you found or did.`;
}
