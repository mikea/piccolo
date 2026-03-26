/**
 * ExtensionRunner — discovers, initialises, and dispatches to extension Workers.
 *
 * On session start (initialize()), reads the extension registry from CONFIG KV,
 * obtains a dispatch stub for each extension name, and collects tools, commands,
 * and system prompt additions.
 *
 * Extensions implement IExtensionWorker.onEvent(). The ExtensionRunner handles
 * all merge semantics internally, keyed on event.type.
 *
 * There is a single emit(event, ctx) method — the caller passes any ExtensionEvent
 * (including AgentEvent variants) and receives the merged result for that event
 * type. For fire-and-forget events the result is undefined.
 *
 * Spec refs:
 *   specs/core.md §ExtensionRunner
 *   specs/api.md  §8 (IExtensionWorker, ExtensionEvent)
 */

import type {
  BeforeAgentStartResult,
  BeforeCompactResult,
  ContextResult,
  ExtensionEvent,
  ICommand,
  IExtensionWorker,
  InputResult,
  ISession,
  ITool,
  SystemPromptAddition,
  ToolCallResult,
  ToolResultOverride,
} from "@piccolo/api";

// ─── ExtensionEventResult ─────────────────────────────────────────────────────

/**
 * The union of all possible return values from emit().
 * Callers narrow by knowing which event type they dispatched.
 *
 * For fire-and-forget events (agent_start, agent_end, turn_*, tool_*, compact,
 * session_start, session_shutdown) the result is always undefined.
 */
export type ExtensionEventResult =
  | InputResult
  | BeforeAgentStartResult
  | ContextResult
  | ToolCallResult
  | ToolResultOverride
  | BeforeCompactResult
  | undefined;

// ─── IExtensionRunner ─────────────────────────────────────────────────────────

/**
 * IExtensionRunner — core-internal interface for dispatching to extensions.
 * Implemented by ExtensionRunner. NOT part of the JSRPC API surface.
 *
 * A single emit() handles all event types. The merge semantics are
 * determined by event.type inside the implementation.
 */
export interface IExtensionRunner {
  emit(event: ExtensionEvent, ctx: ISession): Promise<ExtensionEventResult>;
  getSystemPromptAdditions(): SystemPromptAddition[];
  getCommands(): ICommand[];
  getTools(): ITool[];
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
 * Real ExtensionRunner — reads the extension registry from CONFIG KV and
 * dispatches to extension Workers via the EXTENSIONS dispatch namespace.
 *
 * Spec ref: specs/core.md §ExtensionRunner
 */
export class ExtensionRunner implements IExtensionRunner {
  static readonly CALL_TIMEOUT_MS = 5000;

  #extensions: Array<{ name: string; worker: IExtensionWorker }> = [];
  #commands: ICommand[] = [];
  #systemPromptAdditions: SystemPromptAddition[] = [];
  #tools: ITool[] = [];

  /**
   * Load the extension registry and bootstrap all extensions for a session.
   * Spec ref: specs/core.md §ExtensionRunner §initialize
   */
  async initialize(
    ctx: ISession,
    kv: KVNamespace,
    extensions: DispatchNamespace,
    modelId?: string,
  ): Promise<void> {
    console.debug("[extensions] initialize start");

    let names: string[] = [];
    try {
      const raw = await kv.get("extensions:registry");
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          names = parsed.filter((n): n is string => typeof n === "string");
        }
      }
    } catch (error) {
      console.warn(`[extensions] failed to parse extensions:registry error=${formatError(error)}`);
      names = [];
    }

    if (names.length === 0) {
      console.debug("[extensions] initialize skipped (empty registry)");
      return;
    }

    console.debug(`[extensions] registry size=${names.length} names=${JSON.stringify(names)}`);

    const results = await Promise.all(
      names.map(async (name) => {
        let worker: IExtensionWorker;
        try {
          worker = extensions.get(name) as unknown as IExtensionWorker;
        } catch (error) {
          console.warn(
            `[extensions] dispatch lookup failed extension=${name} error=${formatError(error)}`,
          );
          return null;
        }

        const [tools, commands, additions] = await Promise.all([
          this.#safeCall(name, "getTools", () => worker.getTools?.(ctx)),
          this.#safeCall(name, "getCommands", () => worker.getCommands?.(ctx)),
          this.#safeCall(name, "getSystemPromptAdditions", () =>
            worker.getSystemPromptAdditions?.(ctx),
          ),
        ]);

        return { name, worker, tools, commands, additions };
      }),
    );

    for (const result of results) {
      if (result === null) continue;
      const { name, worker, tools, commands, additions } = result;
      this.#extensions.push({ name, worker });
      if (tools) this.#tools.push(...tools);
      if (commands) this.#commands.push(...commands);
      if (additions) this.#systemPromptAdditions.push(...additions);
      console.debug(
        `[extensions] loaded extension=${name} tools=${tools?.length ?? 0} commands=${commands?.length ?? 0} additions=${additions?.length ?? 0}`,
      );
    }

    // Fire session_start
    await this.emit(
      {
        type: "session_start",
        sessionId: await ctx.sessionId(),
        userId: ctx.userId,
        modelId: modelId ?? "",
      },
      ctx,
    );

    console.debug(
      `[extensions] initialize done loaded=${this.#extensions.length} tools=${this.#tools.length} commands=${this.#commands.length} additions=${this.#systemPromptAdditions.length}`,
    );
  }

  async #safeCall<T>(
    extensionName: string,
    operation: string,
    fn: () => Promise<T | undefined> | undefined,
  ): Promise<T | undefined> {
    try {
      const result = fn();
      if (result === undefined) return undefined;
      return await this.#withTimeout(extensionName, operation, result);
    } catch (error) {
      console.warn(
        `[extensions] extension=${extensionName} op=${operation} failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }

  async #withTimeout<T>(
    extensionName: string,
    operation: string,
    promise: Promise<T>,
  ): Promise<T | undefined> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<T | undefined>([
        promise,
        new Promise<undefined>((resolve) => {
          timeoutHandle = setTimeout(() => {
            console.warn(
              `[extensions] extension=${extensionName} op=${operation} timed out after ${ExtensionRunner.CALL_TIMEOUT_MS}ms`,
            );
            resolve(undefined);
          }, ExtensionRunner.CALL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getSystemPromptAdditions(): SystemPromptAddition[] {
    return this.#systemPromptAdditions;
  }

  getCommands(): ICommand[] {
    return this.#commands;
  }

  getTools(): ITool[] {
    return this.#tools;
  }

  // ─── emit ─────────────────────────────────────────────────────────────────

  /**
   * Dispatch an ExtensionEvent to all extensions and return the merged result.
   *
   * Merge semantics by event type:
   *   input            — first non-continue InputResult wins; default { action: "continue" }
   *   before_agent_start — contextMessages concatenated; last systemPrompt wins
   *   context          — last non-void ContextResult wins
   *   tool_call        — first block=true wins; default { block: false }
   *   tool_result      — chained: each extension sees previous output
   *   before_compact   — first cancel=true wins; else first summary wins; else {}
   *   all others       — fire-and-forget (results discarded); returns undefined
   *
   * AgentEvent variants (agent_start, agent_end, turn_*, tool_*, error) are
   * valid ExtensionEvents and fire-and-forget.
   *
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emit(event: ExtensionEvent, ctx: ISession): Promise<ExtensionEventResult> {
    switch (event.type) {
      case "input":
        return this.#dispatchInput(event, ctx);
      case "before_agent_start":
        return this.#dispatchBeforeAgentStart(event, ctx);
      case "context":
        return this.#dispatchContext(event, ctx);
      case "tool_call":
        return this.#dispatchToolCall(event, ctx);
      case "tool_result":
        return this.#dispatchToolResult(event, ctx);
      case "before_compact":
        return this.#dispatchBeforeCompact(event, ctx);
      default:
        // Fire-and-forget: dispatch concurrently, discard results
        await Promise.all(
          this.#extensions.map(({ name, worker }) =>
            this.#safeCall(name, event.type, () => worker.onEvent?.(event, ctx)),
          ),
        );
        return undefined;
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
    const parsed = parseCommand(event.text, this.#commands);
    const enrichedEvent: Extract<ExtensionEvent, { type: "input" }> = parsed
      ? { ...event, commandName: parsed.commandName, commandArgs: parsed.commandArgs }
      : event;

    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "input", () => worker.onEvent?.(enrichedEvent, ctx)),
      ),
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

  /** before_agent_start — contextMessages concatenated; last systemPrompt wins. */
  async #dispatchBeforeAgentStart(
    event: Extract<ExtensionEvent, { type: "before_agent_start" }>,
    ctx: ISession,
  ): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "before_agent_start", () => worker.onEvent?.(event, ctx)),
      ),
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
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "context", () => worker.onEvent?.(event, ctx)),
      ),
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
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "tool_call", () => worker.onEvent?.(event, ctx)),
      ),
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
    for (const { name, worker } of this.#extensions) {
      const chainedEvent: Extract<ExtensionEvent, { type: "tool_result" }> = current
        ? { ...event, output: current }
        : event;
      const result = await this.#safeCall(name, "tool_result", () =>
        worker.onEvent?.(chainedEvent, ctx),
      );
      if (
        result != null &&
        typeof result === "object" &&
        !("block" in result) &&
        !("action" in result) &&
        !("messages" in result) &&
        !("cancel" in result) &&
        !("summary" in result)
      ) {
        current = result as ToolResultOverride;
      }
    }
    return current;
  }

  /** before_compact — first cancel=true wins; else first summary wins; else {}. */
  async #dispatchBeforeCompact(
    event: Extract<ExtensionEvent, { type: "before_compact" }>,
    ctx: ISession,
  ): Promise<BeforeCompactResult> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "before_compact", () => worker.onEvent?.(event, ctx)),
      ),
    );
    const typed = results.filter(
      (r): r is BeforeCompactResult =>
        r !== undefined && r !== null && typeof r === "object" && ("cancel" in r || "summary" in r),
    );
    const cancellation = typed.find((r) => r.cancel === true);
    if (cancellation) return cancellation;
    const withSummary = typed.find((r) => r.summary != null);
    if (withSummary) return withSummary;
    return {};
  }
}
