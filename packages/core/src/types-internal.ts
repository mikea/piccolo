/**
 * Internal utility types and functions for piccolo-core's DO layer.
 *
 * Spec ref: specs/api.md
 */

import type { ICommand } from "@piccolo/api";

/** Alias for ICommand — kept for historical naming in core internals. */
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
