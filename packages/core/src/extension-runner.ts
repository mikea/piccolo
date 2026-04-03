/**
 * ExtensionRunner — discovers, initialises, and dispatches to extensions.
 *
 * initialize() discovers extension bindings from the core Worker environment
 * (all bindings named EXTENSION_<something>). It does NOT call getTools(),
 * getCommands(), or getSystemPromptAdditions() — those are driven by the caller
 * (AgentSessionDO) outside blockConcurrencyWhile, passing ISession at call time.
 *
 * Extensions implement IExtension.onEvent(). The ExtensionRunner handles
 * all merge semantics internally, keyed on event.type.
 *
 * There is a single emit(event, ctx) method — the caller passes an ExtensionEvent
 * and receives the merged result for that event type. before_compact is
 * notification-only through emit().
 *
 * Spec refs:
 *   specs/core.md §ExtensionRunner
 *   specs/api.md  §8 (IExtension, ExtensionEvent)
 */

import type {
  BeforeAgentStartResult,
  CompactResult,
  ContextResult,
  ExtensionEvent,
  IAbortSignal,
  ICommand,
  IExtension,
  IMessage,
  InputResult,
  ISession,
  ITool,
  SystemPromptAddition,
  ToolCallResult,
  ToolDescriptor,
  ToolResultOverride,
} from "@piccolo/api";
import type { LanguageModel } from "ai";
import { builtinExtensions } from "./builtin-extensions.ts";

// ─── SafeToolWrapper ──────────────────────────────────────────────────────────

/**
 * Wraps a remote ITool stub (received over JSRPC from an extension Worker) so
 * that any RPC failure in getDescriptor() or execute() is
 * caught here and never propagates to the browser.
 */
class SafeToolWrapper implements ITool {
  readonly #remote: ITool;
  readonly #extensionName: string;
  readonly #fallbackDescriptor: ToolDescriptor;
  readonly #timeoutMs: number;
  #lastKnownDescriptor: ToolDescriptor | undefined;

  constructor(remote: ITool, extensionName: string, timeoutMs: number, toolIndex: number) {
    this.#remote = remote;
    this.#extensionName = extensionName;
    this.#timeoutMs = timeoutMs;
    const fallbackName = `unavailable_${extensionName.toLowerCase()}_${toolIndex}`;
    this.#fallbackDescriptor = {
      name: fallbackName,
      label: fallbackName,
      description: `Fallback descriptor for ${extensionName} tool #${toolIndex}`,
      inputSchema: {},
    };
  }

  async getDescriptor(): Promise<ToolDescriptor> {
    try {
      const descriptor = await withTimeout(
        this.#extensionName,
        "getDescriptor",
        this.#remote.getDescriptor(),
        this.#timeoutMs,
      );
      if (descriptor === undefined) {
        return this.#lastKnownDescriptor ?? this.#fallbackDescriptor;
      }
      this.#lastKnownDescriptor = descriptor;
      return descriptor;
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#extensionName} op=getDescriptor failed error=${formatError(error)}`,
      );
      return this.#lastKnownDescriptor ?? this.#fallbackDescriptor;
    }
  }

  async execute(toolCallId: string, params: unknown, ctx: ISession, signal?: IAbortSignal) {
    try {
      return await this.#remote.execute(toolCallId, params, ctx, signal);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#extensionName} tool=${this.#lastKnownDescriptor?.name ?? this.#fallbackDescriptor.name} execute failed error=${formatError(error)}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool "${this.#lastKnownDescriptor?.name ?? this.#fallbackDescriptor.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}

// ─── ExtensionEventResult ─────────────────────────────────────────────────────

/**
 * The union of all possible return values from emit().
 * Callers narrow by knowing which event type they dispatched.
 *
 * before_compact via emit() is notification-only and returns undefined.
 */
export type ExtensionEventResult =
  | InputResult
  | BeforeAgentStartResult
  | ContextResult
  | ToolCallResult
  | ToolResultOverride
  | undefined;

async function withTimeout<T>(
  extensionName: string,
  operation: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | undefined>([
      promise,
      new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
          console.warn(
            `[extensions] extension=${extensionName} op=${operation} timed out after ${timeoutMs}ms`,
          );
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

class ExtensionWrapper implements IExtension {
  readonly #bindingName: string;
  readonly #remote: IExtension;
  readonly #timeoutMs: number;

  #hasInit: boolean | undefined;
  #hasGetTools: boolean | undefined;
  #hasGetCommands: boolean | undefined;
  #hasGetSystemPromptAdditions: boolean | undefined;
  #hasOnEvent: boolean | undefined;
  #hasCompact: boolean | undefined;

  constructor(bindingName: string, remote: IExtension, timeoutMs: number) {
    this.#bindingName = bindingName;
    this.#remote = remote;
    this.#timeoutMs = timeoutMs;
  }

  get bindingName(): string {
    return this.#bindingName;
  }

  async init(ctx: ISession): Promise<void> {
    if (this.#hasInit === undefined) {
      try {
        const candidate = await this.#remote.init;
        this.#hasInit = typeof candidate === "function";
      } catch (error) {
        console.warn(
          `[extensions] extension=${this.#bindingName} op=init_probe failed error=${formatError(error)}`,
        );
        this.#hasInit = false;
      }
    }
    if (!this.#hasInit) return;

    try {
      const result = this.#remote.init?.(ctx);
      if (result === undefined) return;
      await withTimeout(this.#bindingName, "session_start", result, this.#timeoutMs);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#bindingName} op=session_start failed error=${formatError(error)}`,
      );
    }
  }

  async getTools(ctx: ISession): Promise<ITool[] | undefined> {
    if (this.#hasGetTools === undefined) {
      try {
        const candidate = await this.#remote.getTools;
        this.#hasGetTools = typeof candidate === "function";
      } catch (error) {
        console.warn(
          `[extensions] extension=${this.#bindingName} op=getTools_probe failed error=${formatError(error)}`,
        );
        this.#hasGetTools = false;
      }
    }
    if (!this.#hasGetTools) return undefined;

    try {
      const result = this.#remote.getTools?.(ctx);
      if (result === undefined) return undefined;
      return await withTimeout(this.#bindingName, "getTools", result, this.#timeoutMs);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#bindingName} op=getTools failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }

  async getCommands(ctx: ISession): Promise<ICommand[] | undefined> {
    if (this.#hasGetCommands === undefined) {
      try {
        const candidate = await this.#remote.getCommands;
        this.#hasGetCommands = typeof candidate === "function";
      } catch (error) {
        console.warn(
          `[extensions] extension=${this.#bindingName} op=getCommands_probe failed error=${formatError(error)}`,
        );
        this.#hasGetCommands = false;
      }
    }
    if (!this.#hasGetCommands) return undefined;

    try {
      const result = this.#remote.getCommands?.(ctx);
      if (result === undefined) return undefined;
      return await withTimeout(this.#bindingName, "getCommands", result, this.#timeoutMs);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#bindingName} op=getCommands failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }

  async getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[] | undefined> {
    if (this.#hasGetSystemPromptAdditions === undefined) {
      try {
        const candidate = await this.#remote.getSystemPromptAdditions;
        this.#hasGetSystemPromptAdditions = typeof candidate === "function";
      } catch (error) {
        console.warn(
          `[extensions] extension=${this.#bindingName} op=getSystemPromptAdditions_probe failed error=${formatError(error)}`,
        );
        this.#hasGetSystemPromptAdditions = false;
      }
    }
    if (!this.#hasGetSystemPromptAdditions) return undefined;

    try {
      const result = this.#remote.getSystemPromptAdditions?.(ctx);
      if (result === undefined) return undefined;
      return await withTimeout(
        this.#bindingName,
        "getSystemPromptAdditions",
        result,
        this.#timeoutMs,
      );
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#bindingName} op=getSystemPromptAdditions failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }

  async onEvent(event: ExtensionEvent, ctx: ISession): Promise<ExtensionEventResult> {
    if (this.#hasOnEvent === undefined) {
      try {
        const candidate = await this.#remote.onEvent;
        this.#hasOnEvent = typeof candidate === "function";
      } catch (error) {
        console.warn(
          `[extensions] extension=${this.#bindingName} op=onEvent_probe failed error=${formatError(error)}`,
        );
        this.#hasOnEvent = false;
      }
    }
    if (!this.#hasOnEvent) return undefined;

    try {
      const result = this.#remote.onEvent?.(event, ctx);
      if (result === undefined) return undefined;
      return await withTimeout(this.#bindingName, event.type, result, this.#timeoutMs);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#bindingName} op=${event.type} failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }

  async compact(
    ctx: ISession,
    messages: IMessage[],
    keepRecentTokens: number,
  ): Promise<CompactResult | undefined> {
    if (this.#hasCompact === undefined) {
      try {
        const candidate = await this.#remote.compact;
        this.#hasCompact = typeof candidate === "function";
      } catch (error) {
        console.warn(
          `[extensions] extension=${this.#bindingName} op=compact_probe failed error=${formatError(error)}`,
        );
        this.#hasCompact = false;
      }
    }
    if (!this.#hasCompact) return undefined;

    try {
      const result = this.#remote.compact?.(ctx, messages, keepRecentTokens);
      if (result === undefined) return undefined;
      return await withTimeout(this.#bindingName, "compact", result, this.#timeoutMs);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#bindingName} op=compact failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }
}

// ─── IExtensionRunner ─────────────────────────────────────────────────────────

/**
 * IExtensionRunner — core-internal interface for dispatching to extensions.
 * Implemented by ExtensionRunner. NOT part of the JSRPC API surface.
 *
 * Registration methods (getTools, getCommands, getSystemPromptAdditions) are
 * async and receive ISession at call time — they call into remote extension
 * workers on demand. The caller (AgentSessionDO) invokes these outside
 * blockConcurrencyWhile to avoid deadlocks on reverse RPC into the session DO.
 *
 * A single emit() handles all event types. The merge semantics are
 * determined by event.type inside the implementation.
 */
export interface IExtensionRunner {
  emit(event: ExtensionEvent, ctx: ISession): Promise<ExtensionEventResult>;
  compact(
    ctx: ISession,
    messages: IMessage[],
    keepRecentTokens: number,
  ): Promise<CompactResult | undefined>;
  getTools(ctx: ISession): Promise<ITool[]>;
  getCommands(ctx: ISession): Promise<ICommand[]>;
  getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[]>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ─── parseCommand ─────────────────────────────────────────────────────────────

/**
 * Parse a slash command from user input.
 * Spec ref: specs/core.md §Command routing
 */
export function parseCommand(
  text: string,
  commands: ICommand[],
): { commandName: string; commandArgs: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const parts = text.split(/\s+/);
  const commandToken = parts[0];
  const cmd = commands.find((c) => `/${c.name}` === commandToken);
  if (!cmd) return undefined;
  const commandArgs = parts.slice(1).join(" ");
  return { commandName: cmd.name, commandArgs };
}

// ─── ExtensionRunner ──────────────────────────────────────────────────────────

/**
 * Real ExtensionRunner — discovers external extensions from env bindings named
 * EXTENSION_<something>, then appends built-in extensions.
 *
 * initialize() only loads workers; it does not call getTools/getCommands/
 * getSystemPromptAdditions. Those are driven by the caller with ISession.
 *
 * Spec ref: specs/core.md §ExtensionRunner
 */
export class ExtensionRunner implements IExtensionRunner {
  static readonly CALL_TIMEOUT_MS = 5000;

  readonly #getModel: (() => LanguageModel) | undefined;
  #extensions: ExtensionWrapper[] = [];

  constructor(getModel?: () => LanguageModel) {
    this.#getModel = getModel;
  }

  /**
   * Discover extension bindings, build worker stubs, and fire init(ctx) on each.
   *
   * Does NOT call getTools(), getCommands(), or getSystemPromptAdditions() —
   * those pass ISession to remote workers which may call back into the session DO.
   * The caller (AgentSessionDO) drives those explicitly outside blockConcurrencyWhile
   * via #ensureTools() and #ensureSystemPrompt().
   *
   * Bindings are discovered by enumerating env keys with the EXTENSION_ prefix
   * and sorting them lexicographically for deterministic ordering.
   *
   * Spec ref: specs/core.md §ExtensionRunner §initialize
   */
  async initialize(env: Record<string, unknown>, ctx: ISession): Promise<void> {
    const discovered = Object.entries(env)
      .filter(([bindingName, binding]) => bindingName.startsWith("EXTENSION_") && binding != null)
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [bindingName, binding] of discovered) {
      this.#extensions.push(
        new ExtensionWrapper(bindingName, binding as IExtension, ExtensionRunner.CALL_TIMEOUT_MS),
      );
    }

    this.#extensions.push(
      ...builtinExtensions(this.#getModel).map(
        ({ bindingName, extension }) =>
          new ExtensionWrapper(bindingName, extension, ExtensionRunner.CALL_TIMEOUT_MS),
      ),
    );

    if (this.#extensions.length === 0) return;

    await Promise.all(this.#extensions.map((extension) => extension.init(ctx)));

    console.log(`[extensions] loaded=${this.#extensions.length}`);
  }

  compact(
    ctx: ISession,
    messages: IMessage[],
    keepRecentTokens: number,
  ): Promise<CompactResult | undefined> {
    return this.#dispatchCompact(ctx, messages, keepRecentTokens);
  }

  // ─── Registration methods (caller-driven, ctx passed at call time) ─────────

  /**
   * Collect tools from all extensions. Wraps each remote ITool stub in
   * SafeToolWrapper so RPC failures in execute() are isolated per tool.
   *
   * Must be called outside blockConcurrencyWhile.
   */
  async getTools(ctx: ISession): Promise<ITool[]> {
    const perExtension = await Promise.all(
      this.#extensions.map(async (extension) => {
        const rawTools = await extension.getTools(ctx);
        if (!rawTools) return [];
        return rawTools.map(
          (t, index) =>
            new SafeToolWrapper(t, extension.bindingName, ExtensionRunner.CALL_TIMEOUT_MS, index),
        );
      }),
    );
    return perExtension.flat();
  }

  /**
   * Collect commands from all extensions.
   * Must be called outside blockConcurrencyWhile.
   */
  async getCommands(ctx: ISession): Promise<ICommand[]> {
    const perExtension = await Promise.all(
      this.#extensions.map((extension) => extension.getCommands(ctx)),
    );
    return perExtension.flatMap((cmds) => cmds ?? []);
  }

  /**
   * Collect system prompt additions from all extensions.
   * Must be called outside blockConcurrencyWhile.
   */
  async getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[]> {
    const perExtension = await Promise.all(
      this.#extensions.map((extension) => extension.getSystemPromptAdditions(ctx)),
    );
    return perExtension.flatMap((additions) => additions ?? []);
  }

  // ─── emit ─────────────────────────────────────────────────────────────────

  /**
   * Dispatch an ExtensionEvent to all extensions and return the merged result.
   *
   * Merge semantics by event type:
   *   input            — first non-continue InputResult wins; default { action: "continue" }
   *   before_start — contextMessages concatenated; last systemPrompt wins
   *   context          — last non-void ContextResult wins
   *   tool_call        — first block=true wins; default { block: false }
   *   tool_result      — chained: each extension sees previous output
   *   before_compact   — notification-only; return ignored
   *   all others       — event-specific merge rules above
   *
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emit(event: ExtensionEvent, ctx: ISession): Promise<ExtensionEventResult> {
    switch (event.type) {
      case "input":
        return this.#dispatchInput(event, ctx);
      case "before_start":
        return this.#dispatchBeforeStart(event, ctx);
      case "context":
        return this.#dispatchContext(event, ctx);
      case "tool_call":
        return this.#dispatchToolCall(event, ctx);
      case "tool_result":
        return this.#dispatchToolResult(event, ctx);
      case "before_compact":
        return this.#dispatchBeforeCompact(event, ctx);
    }
  }

  // ─── Interception dispatch ────────────────────────────────────────────────

  /**
   * input — first non-continue result wins.
   * Command is parsed and attached before dispatch.
   */
  async #dispatchInput(
    event: Extract<ExtensionEvent, { type: "input" }>,
    ctx: ISession,
  ): Promise<InputResult> {
    // Commands list is built on demand from the current extensions.
    // For routing we need the full list — call synchronously from each worker.
    const commandsPerExtension = await Promise.all(
      this.#extensions.map((extension) => extension.getCommands(ctx)),
    );
    const commands = commandsPerExtension.flatMap((cmds) => cmds ?? []);

    const parsed = parseCommand(event.text, commands);
    const enrichedEvent: Extract<ExtensionEvent, { type: "input" }> = parsed
      ? { ...event, commandName: parsed.commandName, commandArgs: parsed.commandArgs }
      : event;

    const results = await Promise.all(
      this.#extensions.map((extension) => extension.onEvent(enrichedEvent, ctx)),
    );
    const winner = results.find(
      (r): r is InputResult =>
        r !== undefined &&
        r !== null &&
        typeof r === "object" &&
        "action" in r &&
        (r as InputResult).action !== "continue",
    );
    return winner ?? { action: "continue" };
  }

  /** before_start — contextMessages concatenated; last systemPrompt wins. */
  async #dispatchBeforeStart(
    event: Extract<ExtensionEvent, { type: "before_start" }>,
    ctx: ISession,
  ): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.#extensions.map((extension) => extension.onEvent(event, ctx)),
    );
    const typed = results.filter(
      (r): r is BeforeAgentStartResult =>
        r !== undefined &&
        r !== null &&
        typeof r === "object" &&
        ("contextMessages" in r || "systemPrompt" in r),
    );
    const contextMessages = typed.flatMap((r) => r.contextMessages ?? []);
    const lastSystemPrompt = typed.filter((r) => r.systemPrompt != null).at(-1)?.systemPrompt;
    const merged: BeforeAgentStartResult = { contextMessages };
    if (lastSystemPrompt != null) merged.systemPrompt = lastSystemPrompt;
    return merged;
  }

  /** context — last non-void ContextResult wins. */
  async #dispatchContext(
    event: Extract<ExtensionEvent, { type: "context" }>,
    ctx: ISession,
  ): Promise<ContextResult | undefined> {
    const results = await Promise.all(
      this.#extensions.map((extension) => extension.onEvent(event, ctx)),
    );
    return [...results]
      .reverse()
      .find(
        (r): r is ContextResult =>
          r !== undefined && r !== null && typeof r === "object" && "messages" in r,
      );
  }

  /** tool_call — first block=true wins; default { block: false }. */
  async #dispatchToolCall(
    event: Extract<ExtensionEvent, { type: "tool_call" }>,
    ctx: ISession,
  ): Promise<ToolCallResult> {
    const results = await Promise.all(
      this.#extensions.map((extension) => extension.onEvent(event, ctx)),
    );
    const blocked = results.find(
      (r): r is ToolCallResult =>
        r !== undefined &&
        r !== null &&
        typeof r === "object" &&
        "block" in r &&
        Boolean((r as ToolCallResult).block),
    );
    return blocked ?? { block: false };
  }

  /** tool_result — chained: each extension sees previous output. */
  async #dispatchToolResult(
    event: Extract<ExtensionEvent, { type: "tool_result" }>,
    ctx: ISession,
  ): Promise<ToolResultOverride | undefined> {
    let current: ToolResultOverride | undefined;
    for (const extension of this.#extensions) {
      const chainedEvent: Extract<ExtensionEvent, { type: "tool_result" }> = current
        ? { ...event, output: current }
        : event;
      const result = await extension.onEvent(chainedEvent, ctx);
      if (
        result != null &&
        typeof result === "object" &&
        !("block" in result) &&
        !("action" in result) &&
        !("messages" in result) &&
        !("cancel" in result) &&
        !("compaction" in result)
      ) {
        current = result as ToolResultOverride;
      }
    }
    return current;
  }

  /** before_compact — notification-only; all extension return values ignored. */
  async #dispatchBeforeCompact(
    event: Extract<ExtensionEvent, { type: "before_compact" }>,
    ctx: ISession,
  ): Promise<undefined> {
    await Promise.all(this.#extensions.map((extension) => extension.onEvent(event, ctx)));
    return undefined;
  }

  /** compact — ask extensions in registration order; first cancel/compaction wins. */
  async #dispatchCompact(
    ctx: ISession,
    messages: IMessage[],
    keepRecentTokens: number,
  ): Promise<CompactResult | undefined> {
    for (const extension of this.#extensions) {
      const result = await extension.compact(ctx, messages, keepRecentTokens);
      if (result?.cancel === true) return { cancel: true };
      if (result?.compaction !== undefined) return result;
    }
    return undefined;
  }
}
