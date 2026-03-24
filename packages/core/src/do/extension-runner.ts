/**
 * ExtensionRunner — discovers, initialises, and dispatches to extension Workers.
 *
 * On session start (initialize()), reads the extension registry from CONFIG KV,
 * obtains a dispatch stub for each extension name, and collects tools, commands,
 * and system prompt additions.
 *
 * All emit methods run all registered extension stubs in parallel (Promise.all)
 * and apply spec-correct merge semantics. Every individual stub call is wrapped
 * in .catch(() => undefined) so a broken extension does not prevent others from
 * being called.
 *
 * Spec refs:
 *   specs/core.md §ExtensionRunner
 *   specs/api.md  §8 (IExtensionWorker, event/result types)
 */

import type { ModelMessage } from "@piccolo/agent";
import type { CommandDescriptor, SystemPromptAddition } from "./types-internal.ts";

// Re-export so callers can import everything from extension-runner.ts
export type { CommandDescriptor, SystemPromptAddition } from "./types-internal.ts";

// ─── Extension event types ────────────────────────────────────────────────────
// Mirror specs/api.md §8 exactly.

export interface InputEvent {
  text: string;
  attachments: unknown[];
  source: "user";
  /** Set when text starts with /{name} matching a registered CommandDescriptor. */
  commandName?: string;
  /** Arguments following the command name, if commandName is set. */
  commandArgs?: string;
}

export interface InputResult {
  action: "handled" | "transform" | "continue";
  text?: string; // replacement text when action === "transform"
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

export interface ContextEvent {
  messages: ModelMessage[];
}

export interface ContextResult {
  messages: ModelMessage[];
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

// ─── IExtensionContext minimal shape ──────────────────────────────────────────
// The full IExtensionContext is implemented in step 8.
// ExtensionRunner only needs sessionId/userId to pass to extension calls.
export interface IExtensionContextLike {
  readonly sessionId: string;
  readonly userId: string;
}

// ─── IExtensionWorkerLike ─────────────────────────────────────────────────────
// The duck-typed shape of an extension stub obtained via dispatch namespace.
// All methods are optional — the core checks existence before dispatching.
// Spec ref: specs/api.md §8 IExtensionWorker

export interface ToolDescriptorLike {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  inputSchema: unknown;
}

export interface IExtensionWorkerLike {
  getTools?(): Promise<ToolDescriptorLike[]>;
  getCommands?(ctx: IExtensionContextLike): Promise<CommandDescriptor[] | undefined>;
  getSystemPromptAdditions?(
    ctx: IExtensionContextLike,
  ): Promise<SystemPromptAddition[] | undefined>;
  onSessionStart?(event: SessionStartEvent, ctx: IExtensionContextLike): Promise<void>;
  onSessionShutdown?(event: SessionShutdownEvent, ctx: IExtensionContextLike): Promise<void>;
  onBeforeAgentStart?(
    event: BeforeAgentStartEvent,
    ctx: IExtensionContextLike,
  ): Promise<BeforeAgentStartResult | undefined>;
  onAgentStart?(event: AgentStartEvent, ctx: IExtensionContextLike): Promise<void>;
  onAgentEnd?(event: AgentEndEvent, ctx: IExtensionContextLike): Promise<void>;
  onTurnStart?(event: TurnStartEvent, ctx: IExtensionContextLike): Promise<void>;
  onTurnEnd?(event: TurnEndEvent, ctx: IExtensionContextLike): Promise<void>;
  onToolStart?(event: ToolStartEvent, ctx: IExtensionContextLike): Promise<void>;
  onToolEnd?(event: ToolEndEvent, ctx: IExtensionContextLike): Promise<void>;
  onContext?(event: ContextEvent, ctx: IExtensionContextLike): Promise<ContextResult | undefined>;
  onToolCall?(
    event: ToolCallEvent,
    ctx: IExtensionContextLike,
  ): Promise<ToolCallResult | undefined>;
  onToolResult?(
    event: ToolResultEvent,
    ctx: IExtensionContextLike,
  ): Promise<ToolResultOverride | undefined>;
  onInput?(event: InputEvent, ctx: IExtensionContextLike): Promise<InputResult | undefined>;
  onBeforeCompact?(
    event: BeforeCompactEvent,
    ctx: IExtensionContextLike,
  ): Promise<BeforeCompactResult | undefined>;
  onCompact?(event: CompactEvent, ctx: IExtensionContextLike): Promise<void>;
}

// ─── Additional event types (fire-and-forget) ─────────────────────────────────

export interface SessionStartEvent {
  sessionId: string;
  userId: string;
  modelId: string;
}

export interface SessionShutdownEvent {
  sessionId: string;
}

export interface AgentStartEvent {
  sessionId: string;
}

export interface AgentEndEvent {
  sessionId: string;
  messages: ModelMessage[];
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface TurnStartEvent {
  stepNumber: number;
}

export interface TurnEndEvent {
  stepNumber: number;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface ToolStartEvent {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolEndEvent {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}

export interface CompactEvent {
  summary: string;
  keptMessageCount: number;
}

// ─── IExtensionRunner interface ───────────────────────────────────────────────
// Shared by ExtensionRunner (real) and ExtensionRunnerStub (step 5 no-op).
// Both DOState and CompactionState reference this interface.

export interface IExtensionRunner {
  emitInput(event: InputEvent, ctx: IExtensionContextLike): Promise<InputResult>;
  emitBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: IExtensionContextLike,
  ): Promise<BeforeAgentStartResult>;
  emitContext(event: ContextEvent, ctx: IExtensionContextLike): Promise<ContextResult | undefined>;
  emitToolCall(event: ToolCallEvent, ctx: IExtensionContextLike): Promise<ToolCallResult>;
  emitToolResult(
    event: ToolResultEvent,
    ctx: IExtensionContextLike,
  ): Promise<ToolResultOverride | undefined>;
  emitBeforeCompact(
    event: BeforeCompactEvent,
    ctx: IExtensionContextLike,
  ): Promise<BeforeCompactResult>;
  // biome-ignore lint/suspicious/noExplicitAny: event payload varies by type
  emit(eventType: string, event: any, ctx: IExtensionContextLike): Promise<void>;
  getSystemPromptAdditions(): SystemPromptAddition[];
  getCommands(): CommandDescriptor[];
  getToolDescriptors(): ToolDescriptorLike[];
}

// ─── parseCommand ─────────────────────────────────────────────────────────────

/**
 * Parse a slash command from user input.
 *
 * Spec ref: specs/core.md §Command routing in emitInput
 */
export function parseCommand(
  text: string,
  commands: CommandDescriptor[],
): { commandName: string; commandArgs: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  // "/command arg1 arg2" → parts[0] = "/command", rest = ["arg1", "arg2"]
  const parts = text.split(/\s+/);
  const commandToken = parts[0];
  const cmd = commands.find((c) => `/${c.name}` === commandToken);
  if (!cmd) return undefined;
  const commandArgs = parts.slice(1).join(" ");
  return { commandName: cmd.name, commandArgs };
}

// ─── ExtensionRunner ──────────────────────────────────────────────────────────

/**
 * Real ExtensionRunner — reads the extension registry from CONFIG KV and
 * dispatches to extension Workers via the EXTENSIONS dispatch namespace.
 *
 * Spec ref: specs/core.md §ExtensionRunner
 */
export class ExtensionRunner implements IExtensionRunner {
  #stubs: IExtensionWorkerLike[] = [];
  #commands: CommandDescriptor[] = [];
  #systemPromptAdditions: SystemPromptAddition[] = [];
  #toolDescriptors: ToolDescriptorLike[] = [];

  /**
   * Load the extension registry and bootstrap all extensions for a session.
   *
   * 1. Read extensions:registry from CONFIG KV → string[]
   * 2. For each name, obtain a dispatch stub via EXTENSIONS.get(name)
   * 3. In parallel: call getTools(), getCommands(ctx), getSystemPromptAdditions(ctx)
   * 4. Store stubs, flatten commands and tool descriptors
   * 5. Fire onSessionStart on all stubs (fire-and-forget)
   */
  async initialize(
    ctx: IExtensionContextLike,
    kv: KVNamespace,
    extensions: DispatchNamespace,
    modelId?: string,
  ): Promise<void> {
    // 1. Read registry
    let names: string[] = [];
    try {
      const raw = await kv.get("extensions:registry");
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          names = parsed.filter((n): n is string => typeof n === "string");
        }
      }
    } catch {
      // Malformed KV value — proceed with empty list
      names = [];
    }

    if (names.length === 0) return;

    // 2. Bootstrap all extensions in parallel
    const results = await Promise.all(
      names.map(async (name) => {
        let stub: IExtensionWorkerLike;
        try {
          stub = extensions.get(name) as unknown as IExtensionWorkerLike;
        } catch {
          return null;
        }

        const [tools, commands, additions] = await Promise.all([
          stub.getTools?.().catch(() => undefined),
          stub.getCommands?.(ctx).catch(() => undefined),
          stub.getSystemPromptAdditions?.(ctx).catch(() => undefined),
        ]);

        return { stub, tools, commands, additions };
      }),
    );

    // 3. Store stubs and collected data
    for (const result of results) {
      if (result === null) continue;
      const { stub, tools, commands, additions } = result;
      this.#stubs.push(stub);
      if (tools) this.#toolDescriptors.push(...tools);
      if (commands) this.#commands.push(...commands);
      if (additions) this.#systemPromptAdditions.push(...additions);
    }

    // 4. Fire onSessionStart (fire-and-forget)
    const startEvent: SessionStartEvent = {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      modelId: modelId ?? "",
    };
    await Promise.all(
      this.#stubs.map((s) => s.onSessionStart?.(startEvent, ctx).catch(() => undefined)),
    );
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getSystemPromptAdditions(): SystemPromptAddition[] {
    return this.#systemPromptAdditions;
  }

  getCommands(): CommandDescriptor[] {
    return this.#commands;
  }

  getToolDescriptors(): ToolDescriptorLike[] {
    return this.#toolDescriptors;
  }

  // ─── Emit methods ─────────────────────────────────────────────────────────

  /**
   * Emit input event.
   * First parses command from text, attaches commandName/commandArgs to event.
   * Merge rule: first result with action !== "continue" wins; rest ignored.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitInput(event: InputEvent, ctx: IExtensionContextLike): Promise<InputResult> {
    // Parse command before dispatch
    const parsed = parseCommand(event.text, this.#commands);
    const enrichedEvent: InputEvent = parsed
      ? { ...event, commandName: parsed.commandName, commandArgs: parsed.commandArgs }
      : event;

    const results = await Promise.all(
      this.#stubs.map((s) => s.onInput?.(enrichedEvent, ctx).catch(() => undefined)),
    );
    return results.find((r) => r != null && r.action !== "continue") ?? { action: "continue" };
  }

  /**
   * Emit before-agent-start event.
   * Merge rule: all contextMessages concatenated; last non-undefined systemPrompt wins.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: IExtensionContextLike,
  ): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.#stubs.map((s) => s.onBeforeAgentStart?.(event, ctx).catch(() => undefined)),
    );
    const contextMessages = results.flatMap((r) => r?.contextMessages ?? []);
    const lastSystemPrompt = results.filter((r) => r?.systemPrompt != null).at(-1)?.systemPrompt;
    const merged: BeforeAgentStartResult = { contextMessages };
    if (lastSystemPrompt != null) merged.systemPrompt = lastSystemPrompt;
    return merged;
  }

  /**
   * Emit context event (called before each LLM call).
   * Merge rule: last extension that returns a non-void ContextResult wins.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitContext(
    event: ContextEvent,
    ctx: IExtensionContextLike,
  ): Promise<ContextResult | undefined> {
    const results = await Promise.all(
      this.#stubs.map((s) => s.onContext?.(event, ctx).catch(() => undefined)),
    );
    // Last non-void result wins
    const winning = [...results].reverse().find((r) => r != null && "messages" in r);
    return winning as ContextResult | undefined;
  }

  /**
   * Emit tool-call event.
   * Merge rule: first result with block === true wins; if none, call proceeds.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitToolCall(event: ToolCallEvent, ctx: IExtensionContextLike): Promise<ToolCallResult> {
    const results = await Promise.all(
      this.#stubs.map((s) => s.onToolCall?.(event, ctx).catch(() => undefined)),
    );
    return results.find((r) => r?.block === true) ?? { block: false };
  }

  /**
   * Emit tool-result event.
   * Merge rule: results chained — each handler sees the previous handler's output.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitToolResult(
    event: ToolResultEvent,
    ctx: IExtensionContextLike,
  ): Promise<ToolResultOverride | undefined> {
    let current: ToolResultOverride | undefined;
    for (const stub of this.#stubs) {
      const chainedEvent: ToolResultEvent = current ? { ...event, output: current } : event;
      const result = await stub.onToolResult?.(chainedEvent, ctx).catch(() => undefined);
      if (result != null) current = result;
    }
    return current;
  }

  /**
   * Emit before-compact event.
   * Merge rule: first result with cancel === true wins;
   *             or first result with a summary string wins.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitBeforeCompact(
    event: BeforeCompactEvent,
    ctx: IExtensionContextLike,
  ): Promise<BeforeCompactResult> {
    const results = await Promise.all(
      this.#stubs.map((s) => s.onBeforeCompact?.(event, ctx).catch(() => undefined)),
    );
    const cancellation = results.find((r) => r?.cancel === true);
    if (cancellation) return cancellation as BeforeCompactResult;
    const withSummary = results.find((r) => r?.summary != null);
    if (withSummary) return withSummary as BeforeCompactResult;
    return {};
  }

  /**
   * Fire-and-forget: emit any agent-loop event to all extensions concurrently.
   * Results are discarded; errors are swallowed.
   * Spec ref: specs/core.md §Dispatch and merge rules (fire-and-forget events)
   */
  // biome-ignore lint/suspicious/noExplicitAny: event payload varies by event type
  async emit(eventType: string, event: any, ctx: IExtensionContextLike): Promise<void> {
    await Promise.all(
      this.#stubs.map((s) => {
        const handler = (s as Record<string, unknown>)[eventType];
        if (typeof handler !== "function") return undefined;
        return (handler as (e: unknown, c: unknown) => Promise<void>)
          .call(s, event, ctx)
          .catch(() => undefined);
      }),
    );
  }
}
