/**
 * ExtensionRunner — discovers, initialises, and dispatches to extension Workers.
 *
 * initialize() reads the extension registry from CONFIG KV and obtains a
 * dispatch stub for each extension name. It does NOT call getTools(),
 * getCommands(), or getSystemPromptAdditions() — those are driven by the caller
 * (AgentSessionDO) outside blockConcurrencyWhile, passing ISession at call time.
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
  GatewayId,
  IAbortSignal,
  ICommand,
  IExtensionWorker,
  InputResult,
  ISession,
  ITextUI,
  ITool,
  SystemPromptAddition,
  ToolCallResult,
  ToolDescriptor,
  ToolResultOverride,
} from "@piccolo/api";

// ─── SafeToolWrapper ──────────────────────────────────────────────────────────

/**
 * Wraps a remote ITool stub (received over JSRPC from an extension Worker) so
 * that any RPC failure in getDescriptor(), execute(), or getGatewayUI() is
 * caught here and never propagates to the browser.
 *
 * The descriptor is resolved once at construction time (callers must use the
 * static factory). Tools whose descriptor cannot be fetched are dropped by
 * getTools() before they are ever returned to the caller.
 */
class SafeToolWrapper implements ITool {
  readonly #remote: ITool;
  readonly #extensionName: string;
  readonly #cachedDescriptor: ToolDescriptor;

  private constructor(remote: ITool, extensionName: string, cachedDescriptor: ToolDescriptor) {
    this.#remote = remote;
    this.#extensionName = extensionName;
    this.#cachedDescriptor = cachedDescriptor;
  }

  /**
   * Resolve the descriptor once. Returns null if the RPC call fails so the
   * caller can skip this tool rather than storing a broken wrapper.
   */
  static async create(
    remote: ITool,
    extensionName: string,
    safeCall: <T>(
      extensionName: string,
      operation: string,
      fn: () => Promise<T | undefined> | undefined,
    ) => Promise<T | undefined>,
  ): Promise<SafeToolWrapper | null> {
    const desc = await safeCall(extensionName, "getDescriptor", () => remote.getDescriptor());
    if (desc === undefined) return null;
    return new SafeToolWrapper(remote, extensionName, desc);
  }

  getDescriptor(): Promise<ToolDescriptor> {
    return Promise.resolve(this.#cachedDescriptor);
  }

  async execute(toolCallId: string, params: unknown, ctx: ISession, signal?: IAbortSignal) {
    try {
      return await this.#remote.execute(toolCallId, params, ctx, signal);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#extensionName} tool=${this.#cachedDescriptor.name} execute failed error=${formatError(error)}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Tool "${this.#cachedDescriptor.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  async getGatewayUI(gatewayId: GatewayId): Promise<ITextUI | undefined> {
    if (!this.#remote.getGatewayUI) return undefined;
    try {
      return await this.#remote.getGatewayUI(gatewayId);
    } catch (error) {
      console.warn(
        `[extensions] extension=${this.#extensionName} tool=${this.#cachedDescriptor.name} getGatewayUI failed error=${formatError(error)}`,
      );
      return undefined;
    }
  }
}

// ─── ExtensionEventResult ─────────────────────────────────────────────────────

/**
 * The union of all possible return values from emit().
 * Callers narrow by knowing which event type they dispatched.
 *
 * For fire-and-forget events (start, finish, turn_*, tool_*, compact,
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
 * Real ExtensionRunner — reads the extension registry from CONFIG KV and
 * dispatches to extension Workers via the EXTENSIONS dispatch namespace.
 *
 * initialize() only loads workers; it does not call getTools/getCommands/
 * getSystemPromptAdditions. Those are driven by the caller with ISession.
 *
 * Spec ref: specs/core.md §ExtensionRunner
 */
export class ExtensionRunner implements IExtensionRunner {
  static readonly CALL_TIMEOUT_MS = 5000;

  #extensions: Array<{ name: string; worker: IExtensionWorker }> = [];

  /**
   * Load the extension registry, build worker stubs, and fire init(ctx) on each.
   *
   * Does NOT call getTools(), getCommands(), or getSystemPromptAdditions() —
   * those pass ISession to remote workers which may call back into the session DO.
   * The caller (AgentSessionDO) drives those explicitly outside blockConcurrencyWhile
   * via #ensureTools() and #ensureSystemPrompt().
   *
   * Spec ref: specs/core.md §ExtensionRunner §initialize
   */
  async initialize(kv: KVNamespace, extensions: DispatchNamespace, ctx: ISession): Promise<void> {
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

    if (names.length === 0) return;

    for (const name of names) {
      try {
        const worker = extensions.get(name) as unknown as IExtensionWorker;
        console.debug("[extensions] ", worker, Object.keys(worker));
        this.#extensions.push({ name, worker });
      } catch (error) {
        console.warn(
          `[extensions] dispatch lookup failed extension=${name} error=${formatError(error)}`,
        );
      }
    }

    await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "session_start", () => worker.init?.(ctx)),
      ),
    );

    console.log(`[extensions] loaded=${this.#extensions.length}`);
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

  // ─── Registration methods (caller-driven, ctx passed at call time) ─────────

  /**
   * Collect tools from all extensions. Wraps each remote ITool stub in
   * SafeToolWrapper so RPC failures in execute() are isolated per tool.
   * Tools whose descriptor cannot be fetched are dropped.
   *
   * Must be called outside blockConcurrencyWhile.
   */
  async getTools(ctx: ISession): Promise<ITool[]> {
    const perExtension = await Promise.all(
      this.#extensions.map(async ({ name, worker }) => {
        const rawTools = await this.#safeCall(name, "getTools", () => worker.getTools?.(ctx));
        if (!rawTools) return [];
        const wrapped = await Promise.all(
          rawTools.map((t) => SafeToolWrapper.create(t, name, this.#safeCall.bind(this))),
        );
        return wrapped.filter((w): w is SafeToolWrapper => w !== null);
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
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "getCommands", () => worker.getCommands?.(ctx)),
      ),
    );
    return perExtension.flatMap((cmds) => cmds ?? []);
  }

  /**
   * Collect system prompt additions from all extensions.
   * Must be called outside blockConcurrencyWhile.
   */
  async getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[]> {
    const perExtension = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "getSystemPromptAdditions", () =>
          worker.getSystemPromptAdditions?.(ctx),
        ),
      ),
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
   *   before_compact   — first cancel=true wins; else first summary wins; else {}
   *   all others       — fire-and-forget (results discarded); returns undefined
   *
   * AgentEvent variants (start, finish, turn_*, tool_*, error) are
   * valid ExtensionEvents and fire-and-forget.
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
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "getCommands", () => worker.getCommands?.(ctx)),
      ),
    );
    const commands = commandsPerExtension.flatMap((cmds) => cmds ?? []);

    const parsed = parseCommand(event.text, commands);
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

  /** before_start — contextMessages concatenated; last systemPrompt wins. */
  async #dispatchBeforeStart(
    event: Extract<ExtensionEvent, { type: "before_start" }>,
    ctx: ISession,
  ): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "before_start", () => worker.onEvent?.(event, ctx)),
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
