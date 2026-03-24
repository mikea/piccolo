/**
 * Internal types used by piccolo-core's DO layer.
 *
 * These are types that appear in both step-5 stubs and the eventual real
 * implementations (steps 6–8). Defined here to avoid circular imports and
 * to keep them available from the moment step 5 is written.
 *
 * All shapes must exactly match specs/api.md.
 *
 * Spec ref: specs/api.md §8 (SystemPromptAddition, CommandDescriptor)
 */

// ─── System prompt contributions ─────────────────────────────────────────────

/**
 * A snippet contributed by an extension to the assembled system prompt.
 * Spec ref: specs/api.md §8 §System prompt
 */
export interface SystemPromptAddition {
  /** Where in the system prompt to insert this snippet. */
  section: "skills" | "guidelines" | "context" | "footer";
  /** The text to insert. Markdown supported. */
  content: string;
  /** Relative weight for ordering within the section. Lower = earlier. Default: 100. */
  priority?: number;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * A command registered by an extension.
 * Spec ref: specs/api.md §8 §Commands
 */
export interface CommandDescriptor {
  /** Command name without the leading /. E.g. "skill:brave-search". */
  name: string;
  /** One-line description shown in gateway autocomplete and /help. */
  description: string;
  /** If true, gateway autocomplete lists this command. Default: true. */
  showInAutocomplete?: boolean;
}

// ─── Model catalog ────────────────────────────────────────────────────────────

/**
 * Static model catalog used by AgentSessionDO.getModel() and listModels().
 * Step 9 will load this from CONFIG KV; for steps 5–8 a hardcoded list is used.
 *
 * Spec ref: specs/api.md §Shared Types §ModelInfo
 */
export const MODEL_CATALOG: Array<{ id: string; label: string; provider: string }> = [
  { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5", provider: "anthropic" },
  { id: "openai/gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", provider: "openai" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google" },
  { id: "groq/llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", provider: "groq" },
];

/** Look up a ModelInfo from the catalog by modelId. Falls back to a synthetic entry. */
export function resolveModel(modelId: string): { id: string; label: string; provider: string } {
  const found = MODEL_CATALOG.find((m) => m.id === modelId);
  if (found) return found;
  // Unknown model — synthesise a ModelInfo from the ID
  const provider = modelId.split("/")[0] ?? modelId;
  return { id: modelId, label: modelId, provider };
}
