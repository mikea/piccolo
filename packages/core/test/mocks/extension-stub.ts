/**
 * Configurable mock IExtensionWorker for ExtensionRunner unit tests.
 *
 * Pass options to control what onEvent returns for each event type.
 * Set `shouldThrow: true` to make all handlers throw — useful for
 * error-isolation tests.
 *
 * Usage:
 *   const ext = createMockExtension({
 *     name: "ext-a",
 *     onInput: (e) => ({ action: "handled" }),
 *   });
 *
 * Spec ref: specs/api.md §8 IExtensionWorker
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

// Re-export for convenience in test files
export type { SystemPromptAddition } from "@piccolo/api";

// ── Narrow event types for handler callbacks ──────────────────────────────────

type InputEv = Extract<ExtensionEvent, { type: "input" }>;
type BeforeStartEv = Extract<ExtensionEvent, { type: "before_start" }>;
type ContextEv = Extract<ExtensionEvent, { type: "context" }>;
type ToolCallEv = Extract<ExtensionEvent, { type: "tool_call" }>;
type ToolResultEv = Extract<ExtensionEvent, { type: "tool_result" }>;
type BeforeCompactEv = Extract<ExtensionEvent, { type: "before_compact" }>;

export interface MockExtensionOptions {
  /** Extension name (informational, for debugging). */
  name: string;
  /** Tool descriptors returned by getTools(). Default: []. */
  tools?: Array<
    | ITool
    | {
        name: string;
        label: string;
        description: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
        inputSchema: Record<string, unknown>;
      }
  >;
  /** Commands returned by getCommands(). Default: []. */
  commands?: ICommand[];
  /** System prompt additions returned by getSystemPromptAdditions(). Default: []. */
  systemPromptAdditions?: SystemPromptAddition[];
  /** Handler for input events. Return undefined to behave as not-implemented. */
  onInput?: (event: InputEv) => InputResult | undefined;
  /** Handler for before_start events. */
  onBeforeStart?: (event: BeforeStartEv) => BeforeAgentStartResult | undefined;
  /** Handler for context events. */
  onContext?: (event: ContextEv) => ContextResult | undefined;
  /** Handler for tool_call events. */
  onToolCall?: (event: ToolCallEv) => ToolCallResult | undefined;
  /** Handler for tool_result events. */
  onToolResult?: (event: ToolResultEv) => ToolResultOverride | undefined;
  /** Handler for before_compact events. */
  onBeforeCompact?: (event: BeforeCompactEv) => BeforeCompactResult | undefined;
  /** Called when init(ctx) is invoked. */
  onInit?: (ctx: ISession) => void;
  /**
   * If true, onEvent throws "MockExtension error" instead of executing handlers.
   * Used for error-isolation tests.
   */
  shouldThrow?: boolean;
  /** Track calls made to the mock for assertion in tests. */
  calls?: {
    onInit: ISession[];
    onInput: InputEv[];
    onBeforeStart: BeforeStartEv[];
    onContext: ContextEv[];
    onToolCall: ToolCallEv[];
    onToolResult: ToolResultEv[];
    onBeforeCompact: BeforeCompactEv[];
    emit: ExtensionEvent[];
  };
}

function isToolInstance(
  value:
    | ITool
    | {
        name: string;
        label: string;
        description: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
        inputSchema: Record<string, unknown>;
      },
): value is ITool {
  return (
    typeof value === "object" &&
    value !== null &&
    "getDescriptor" in value &&
    "execute" in value &&
    typeof (value as ITool).execute === "function"
  );
}

export interface MockExtension extends IExtensionWorker {
  /** Access tracked calls for assertions. */
  readonly calls: NonNullable<MockExtensionOptions["calls"]>;
}

export function createMockExtension(options: MockExtensionOptions): MockExtension {
  const calls: NonNullable<MockExtensionOptions["calls"]> = options.calls ?? {
    onInit: [],
    onInput: [],
    onBeforeStart: [],
    onContext: [],
    onToolCall: [],
    onToolResult: [],
    onBeforeCompact: [],
    emit: [],
  };

  function maybeThrow(): never {
    throw new Error(`MockExtension(${options.name}) error`);
  }

  const tools: ITool[] = (options.tools ?? []).map((tool) => {
    if (isToolInstance(tool)) return tool;
    const desc = tool;
    return {
      getDescriptor: async () => desc,
      execute: async () => ({ content: [] }),
    } satisfies ITool;
  });

  const stub: MockExtension = {
    calls,

    async getTools(_ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      return tools;
    },

    async getCommands(_ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      return options.commands ?? [];
    },

    async getSystemPromptAdditions(_ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      return options.systemPromptAdditions ?? [];
    },

    async init(ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onInit.push(ctx);
      options.onInit?.(ctx);
    },

    async onEvent(event: ExtensionEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();

      calls.emit.push(event);

      switch (event.type) {
        case "input":
          calls.onInput.push(event);
          return options.onInput?.(event);

        case "before_start":
          calls.onBeforeStart.push(event);
          return options.onBeforeStart?.(event);

        case "context":
          calls.onContext.push(event);
          return options.onContext?.(event);

        case "tool_call":
          calls.onToolCall.push(event);
          return options.onToolCall?.(event);

        case "tool_result":
          calls.onToolResult.push(event);
          return options.onToolResult?.(event);

        case "before_compact":
          calls.onBeforeCompact.push(event);
          return options.onBeforeCompact?.(event);
      }
    },
  };

  return stub;
}

// ─── Minimal Env mock for extension discovery ─────────────────────────────────

/**
 * Minimal env-like object used by ExtensionRunner.initialize().
 *
 * Every key beginning with EXTENSION_ is treated as an extension binding.
 */
export function createMockExtensionEnv(
  extensionBindings: Record<string, IExtensionWorker>,
  extraBindings: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extraBindings,
    ...extensionBindings,
  };
}

// ─── Mock ISession ────────────────────────────────────────────────────────────

/**
 * Create a minimal ISession mock for use in unit tests.
 * Implements all ISession methods with no-op implementations.
 * Tests can override specific methods as needed.
 */
export function createMockSession(
  overrides: Omit<Partial<ISession>, "sessionId" | "userId"> & {
    sessionId?: string;
    userId?: string;
  } = {},
): ISession {
  const { sessionId: sessionIdStr, userId: userIdStr, ...sessionOverrides } = overrides;
  const sessionId = sessionIdStr ?? "test-session-id";
  const userId = userIdStr ?? "test-user-id";

  return {
    sessionId: async () => sessionId,
    userId: async () => userId,
    getUpdatedAt: async () => 0,
    getName: async () => undefined,
    setName: async () => {},
    prompt: async () => {
      throw new Error("not implemented in mock");
    },
    sendUserMessage: async () => {},
    steer: async () => {},
    followUp: async () => {},
    getCurrentTurn: async () => undefined,
    getModel: async () => "test/model",
    setModel: async () => {},
    listModels: async () => [],
    getActiveTools: async () => [],
    getEntries: async () => [],
    getContextUsage: async () => ({
      inputTokens: 0,
    }),
    compact: async () => {},
    getSystemPrompt: async () => "",
    fork: async () => {
      throw new Error("not implemented in mock");
    },
    delete: async () => {},
    ...sessionOverrides,
  } as ISession;
}
