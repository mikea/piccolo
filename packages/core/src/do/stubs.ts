/**
 * Stub implementations for ExtensionRunner and SystemPromptAssembler.
 *
 * These stubs are used by AgentSessionDO at step 5 in place of the real
 * implementations (step 6 = ExtensionRunner, step 7 = SystemPromptAssembler).
 * Each stub's interface exactly matches the shapes declared in specs/core.md so
 * that the real implementations can be swapped in later without changing the DO.
 *
 * When steps 6 and 7 are complete:
 *   1. Replace `ExtensionRunnerStub` with the real `ExtensionRunner` class.
 *   2. Replace `SystemPromptAssemblerStub` with the real `SystemPromptAssembler`.
 *   3. Update the field types in `DOState` accordingly.
 *   4. No changes to the AgentSessionDO method bodies are required.
 *
 * Spec refs:
 *   specs/core.md §ExtensionRunner
 *   specs/core.md §SystemPromptAssembler
 *   specs/api.md §8 (IExtensionWorker / extension event types)
 */

import type { ModelMessage } from "@piccolo/agent";
import type { SystemPromptAddition } from "./types-internal.ts";

// ─── Extension event / result types ──────────────────────────────────────────
// These mirror the shapes in specs/api.md §8 exactly.

export interface InputEvent {
  text: string;
  attachments: unknown[];
  source: "user";
  commandName?: string;
  commandArgs?: string;
}

export interface InputResult {
  action: "handled" | "transform" | "continue";
  text?: string;
}

export interface BeforeAgentStartEvent {
  text: string;
  attachments: unknown[];
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  contextMessages?: ModelMessage[];
}

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCallResult {
  block: boolean;
  reason?: string;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

export interface ToolResultOverride {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface BeforeCompactEvent {
  messages: ModelMessage[];
  keepRecentTokens: number;
}

export interface BeforeCompactResult {
  cancel?: boolean;
  summary?: string;
}

// ─── IExtensionContext (minimal forward reference) ────────────────────────────
// The full IExtensionContext is implemented in step 8.
// AgentSessionDO needs to construct one and pass it to extension calls.
// At step 5, we use an opaque type that is structurally compatible.
export interface IExtensionContextLike {
  readonly sessionId: string;
  readonly userId: string;
}

// ─── ExtensionRunnerStub ──────────────────────────────────────────────────────

/**
 * No-op stub for ExtensionRunner.
 *
 * All emitX methods return neutral defaults:
 *   - emitInput → { action: "continue" }
 *   - emitBeforeAgentStart → {}
 *   - emitToolCall → { block: false }
 *   - emitToolResult → undefined
 *   - emitBeforeCompact → {}
 *   - emit (fire-and-forget) → no-op
 *
 * getSystemPromptAdditions() returns an empty array.
 *
 * Step 6 will replace this with ExtensionRunner which reads the extension
 * registry from CONFIG KV and dispatches to real extension Workers.
 */
export class ExtensionRunnerStub {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async emitInput(_event: InputEvent, _ctx: IExtensionContextLike): Promise<InputResult> {
    return { action: "continue" };
  }

  async emitBeforeAgentStart(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _event: BeforeAgentStartEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: IExtensionContextLike,
  ): Promise<BeforeAgentStartResult> {
    return {};
  }

  async emitToolCall(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _event: ToolCallEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: IExtensionContextLike,
  ): Promise<ToolCallResult> {
    return { block: false };
  }

  async emitToolResult(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _event: ToolResultEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: IExtensionContextLike,
  ): Promise<ToolResultOverride | undefined> {
    return undefined;
  }

  async emitBeforeCompact(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _event: BeforeCompactEvent,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: IExtensionContextLike,
  ): Promise<BeforeCompactResult> {
    return {};
  }

  /** Fire-and-forget: emit any agent loop event to all extensions. */
  // biome-ignore lint/suspicious/noExplicitAny: event payload varies by type
  async emit(_eventType: string, _event: any, _ctx: IExtensionContextLike): Promise<void> {
    // no-op at step 5
  }

  getSystemPromptAdditions(): SystemPromptAddition[] {
    return [];
  }
}

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
