/**
 * Stub implementations used during incremental construction of piccolo-core.
 *
 * ExtensionRunnerStub has been replaced by the real ExtensionRunner (step 6).
 * This file now only contains:
 *   - IExtensionContextLike: minimal ctx shape used until step 8 (ExtensionContextImpl)
 *   - SystemPromptAssemblerStub: no-op assembler used until step 7
 *
 * Step 7 will replace SystemPromptAssemblerStub with the real SystemPromptAssembler.
 *
 * Spec refs:
 *   specs/core.md §SystemPromptAssembler
 *   specs/api.md §8 (IExtensionWorker / extension event types)
 */

import type { SystemPromptAddition } from "./types-internal.ts";

// Re-export IExtensionContextLike from extension-runner so all importers find it here
export type { IExtensionContextLike } from "./extension-runner.ts";

// ─── SystemPromptAssemblerStub ────────────────────────────────────────────────

/**
 * No-op stub for SystemPromptAssembler.
 *
 * Returns the base prompt unchanged — no extension additions are applied.
 *
 * Step 7 will replace this with SystemPromptAssembler which groups additions
 * by section, sorts by priority, appends tool guidelines, and inserts the
 * "Available Tools" section.
 */
export class SystemPromptAssemblerStub {
  assemble(
    base: string,
    _additions: SystemPromptAddition[],
    _activeTools: unknown[],
    override?: string,
  ): string {
    return override ?? base;
  }
}
