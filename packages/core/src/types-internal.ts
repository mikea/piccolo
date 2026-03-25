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

// ─── Model list ───────────────────────────────────────────────────────────────

/**
 * Parse the MODELS env var (comma-separated model IDs) into a string array.
 *
 * MODELS is the sole authoritative source of available model IDs.
 * No hardcoded fallback, no KV lookup.
 *
 * Spec ref: specs/api.md §IPiccoloCore.listModels
 */
export function parseModels(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
