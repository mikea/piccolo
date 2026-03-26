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

import type { ICommand, ISession, ITool, SystemPromptAddition } from "@piccolo/api";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  ContextEvent,
  ContextResult,
  IExtensionRunner,
  IExtensionWorker,
  InputEvent,
  InputResult,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallResult,
  ToolResultEvent,
  ToolResultOverride,
} from "./extension-types.ts";

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

// Re-export so callers can import everything from extension-runner.ts
export type { SystemPromptAddition } from "@piccolo/api";
export type {
  AgentEndEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  CompactEvent,
  ContextEvent,
  ContextResult,
  IExtensionListener,
  IExtensionRunner,
  IExtensionWorker,
  InputEvent,
  InputResult,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallResult,
  ToolEndEvent,
  ToolResultEvent,
  ToolResultOverride,
  ToolStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "./extension-types.ts";

// ─── parseCommand ─────────────────────────────────────────────────────────────

/**
 * Parse a slash command from user input.
 *
 * Spec ref: specs/core.md §Command routing in emitInput
 */
export function parseCommand(
  text: string,
  commands: ICommand[],
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
  static readonly CALL_TIMEOUT_MS = 5000;

  #extensions: Array<{ name: string; worker: IExtensionWorker }> = [];
  #commands: ICommand[] = [];
  #systemPromptAdditions: SystemPromptAddition[] = [];
  /**
   * All tools provided directly by extension workers.
   */
  #tools: ITool[] = [];

  /**
   * Load the extension registry and bootstrap all extensions for a session.
   *
   * 1. Read extensions:registry from CONFIG KV → string[]
   * 2. For each name, obtain a dispatch stub via EXTENSIONS.get(name)
   * 3. In parallel: call getTools(ctx), getCommands(ctx), getSystemPromptAdditions(ctx)
   * 4. Wrap each tool in an ExtensionToolAdapter; store stubs and data
   * 5. Fire onSessionStart on all stubs (fire-and-forget)
   */
  async initialize(
    ctx: ISession,
    kv: KVNamespace,
    extensions: DispatchNamespace,
    modelId?: string,
  ): Promise<void> {
    console.debug("[extensions] initialize start");

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
    } catch (error) {
      console.warn(`[extensions] failed to parse extensions:registry error=${formatError(error)}`);
      // Malformed KV value — proceed with empty list
      names = [];
    }

    if (names.length === 0) {
      console.debug("[extensions] initialize skipped (empty registry)");
      return;
    }

    console.debug(`[extensions] registry size=${names.length} names=${JSON.stringify(names)}`);

    // 2. Bootstrap all extensions in parallel
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

    // 3. Store workers and collected data
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

    // 4. Fire onSessionStart (fire-and-forget)
    const startEvent: SessionStartEvent = {
      sessionId: await ctx.sessionId(),
      userId: ctx.userId,
      modelId: modelId ?? "",
    };
    await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "onSessionStart", () => worker.onSessionStart?.(startEvent, ctx)),
      ),
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

  // ─── Emit methods ─────────────────────────────────────────────────────────

  /**
   * Emit input event.
   * First parses command from text, attaches commandName/commandArgs to event.
   * Merge rule: first result with action !== "continue" wins; rest ignored.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitInput(event: InputEvent, ctx: ISession): Promise<InputResult> {
    // Parse command before dispatch
    const parsed = parseCommand(event.text, this.#commands);
    const enrichedEvent: InputEvent = parsed
      ? { ...event, commandName: parsed.commandName, commandArgs: parsed.commandArgs }
      : event;

    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "onInput", () => worker.onInput?.(enrichedEvent, ctx)),
      ),
    );
    const winner = results.find((result): result is InputResult => {
      return result !== undefined && result.action !== "continue";
    });
    return winner ?? { action: "continue" };
  }

  /**
   * Emit before-agent-start event.
   * Merge rule: all contextMessages concatenated; last non-undefined systemPrompt wins.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ISession,
  ): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "onBeforeAgentStart", () => worker.onBeforeAgentStart?.(event, ctx)),
      ),
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
  async emitContext(event: ContextEvent, ctx: ISession): Promise<ContextResult | undefined> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "onContext", () => worker.onContext?.(event, ctx)),
      ),
    );
    // Last non-void result wins
    const winning = [...results].reverse().find((result): result is ContextResult => {
      return result !== undefined;
    });
    return winning;
  }

  /**
   * Emit tool-call event.
   * Merge rule: first result with block === true wins; if none, call proceeds.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitToolCall(event: ToolCallEvent, ctx: ISession): Promise<ToolCallResult> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "onToolCall", () => worker.onToolCall?.(event, ctx)),
      ),
    );
    return results.find((result) => result?.block === true) ?? { block: false };
  }

  /**
   * Emit tool-result event.
   * Merge rule: results chained — each handler sees the previous handler's output.
   * Spec ref: specs/core.md §Dispatch and merge rules
   */
  async emitToolResult(
    event: ToolResultEvent,
    ctx: ISession,
  ): Promise<ToolResultOverride | undefined> {
    let current: ToolResultOverride | undefined;
    for (const { name, worker } of this.#extensions) {
      const chainedEvent: ToolResultEvent = current ? { ...event, output: current } : event;
      const result = await this.#safeCall(name, "onToolResult", () =>
        worker.onToolResult?.(chainedEvent, ctx),
      );
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
  async emitBeforeCompact(event: BeforeCompactEvent, ctx: ISession): Promise<BeforeCompactResult> {
    const results = await Promise.all(
      this.#extensions.map(({ name, worker }) =>
        this.#safeCall(name, "onBeforeCompact", () => worker.onBeforeCompact?.(event, ctx)),
      ),
    );
    const cancellation = results.find((result) => result?.cancel === true);
    if (cancellation) return cancellation as BeforeCompactResult;
    const withSummary = results.find((result) => result?.summary != null);
    if (withSummary) return withSummary as BeforeCompactResult;
    return {};
  }

  /**
   * Fire-and-forget: emit any agent-loop event to all extensions concurrently.
   * Results are discarded; errors are swallowed.
   * Spec ref: specs/core.md §Dispatch and merge rules (fire-and-forget events)
   */
  // biome-ignore lint/suspicious/noExplicitAny: event payload varies by event type
  async emit(eventType: string, event: any, ctx: ISession): Promise<void> {
    await Promise.all(
      this.#extensions.map(({ name, worker }) => {
        const handler = (worker as Record<string, unknown>)[eventType];
        if (typeof handler !== "function") return undefined;
        return (handler as (e: unknown, c: unknown) => Promise<void>)
          .call(worker, event, ctx)
          .catch((error: unknown) => {
            console.warn(
              `[extensions] extension=${name} op=${eventType} failed error=${formatError(error)}`,
            );
            return undefined;
          });
      }),
    );
  }
}
