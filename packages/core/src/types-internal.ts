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

import type { ICommand } from "./types.ts";
export type CommandDescriptor = ICommand;

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
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Return the first model ID from the MODELS env var.
 * Used as the default model for new sessions.
 */
export function defaultModelId(modelsEnv: string): string {
  const first = parseModels(modelsEnv)[0];
  if (!first) throw new Error("MODELS env var is empty — at least one model ID is required");
  return first;
}
