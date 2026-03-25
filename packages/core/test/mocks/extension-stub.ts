/**
 * Configurable mock IExtensionWorker for ExtensionRunner unit tests.
 *
 * Pass options to control what each handler returns. Set `shouldThrow: true`
 * to make all handlers throw — useful for error-isolation tests.
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
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforeCompactEvent,
  BeforeCompactResult,
  CompactEvent,
  ContextEvent,
  ContextResult,
  IExtensionWorkerLike,
  InputEvent,
  InputResult,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallResult,
  ToolDescriptorLike,
  ToolResultEvent,
  ToolResultOverride,
} from "../../src/extension-runner.ts";
import type { ISession } from "../../src/types.ts";
import type { CommandDescriptor, SystemPromptAddition } from "../../src/types-internal.ts";

// Re-export types for convenience in test files
export type { CommandDescriptor, SystemPromptAddition } from "../../src/types-internal.ts";

export interface MockExtensionOptions {
  /** Extension name (informational, for debugging). */
  name: string;
  /** Tool descriptors returned by getTools(). Default: []. */
  tools?: ToolDescriptorLike[];
  /** Commands returned by getCommands(). Default: []. */
  commands?: CommandDescriptor[];
  /** System prompt additions returned by getSystemPromptAdditions(). Default: []. */
  systemPromptAdditions?: SystemPromptAddition[];
  /** Handler for onInput. Return undefined to behave as not-implemented. */
  onInput?: (event: InputEvent) => InputResult | undefined;
  /** Handler for onBeforeAgentStart. */
  onBeforeAgentStart?: (event: BeforeAgentStartEvent) => BeforeAgentStartResult | undefined;
  /** Handler for onContext. */
  onContext?: (event: ContextEvent) => ContextResult | undefined;
  /** Handler for onToolCall. */
  onToolCall?: (event: ToolCallEvent) => ToolCallResult | undefined;
  /** Handler for onToolResult. */
  onToolResult?: (event: ToolResultEvent) => ToolResultOverride | undefined;
  /** Handler for onBeforeCompact. */
  onBeforeCompact?: (event: BeforeCompactEvent) => BeforeCompactResult | undefined;
  /** Handler for onCompact (fire-and-forget). */
  onCompact?: (event: CompactEvent) => void;
  /**
   * If true, all handler methods throw "MockExtension error" instead of
   * executing their handlers. Used for error-isolation tests.
   */
  shouldThrow?: boolean;
  /** Track calls made to the mock for assertion in tests. */
  calls?: {
    onSessionStart: SessionStartEvent[];
    onInput: InputEvent[];
    onBeforeAgentStart: BeforeAgentStartEvent[];
    onContext: ContextEvent[];
    onToolCall: ToolCallEvent[];
    onToolResult: ToolResultEvent[];
    onBeforeCompact: BeforeCompactEvent[];
    onCompact: CompactEvent[];
    emit: Array<{ type: string; event: unknown }>;
  };
}

export interface MockExtension extends IExtensionWorkerLike {
  /** Access tracked calls for assertions. */
  readonly calls: NonNullable<MockExtensionOptions["calls"]>;
}

export function createMockExtension(options: MockExtensionOptions): MockExtension {
  const calls: NonNullable<MockExtensionOptions["calls"]> = options.calls ?? {
    onSessionStart: [],
    onInput: [],
    onBeforeAgentStart: [],
    onContext: [],
    onToolCall: [],
    onToolResult: [],
    onBeforeCompact: [],
    onCompact: [],
    emit: [],
  };

  function maybeThrow(): never {
    throw new Error(`MockExtension(${options.name}) error`);
  }

  const stub: MockExtension = {
    calls,

    async getTools() {
      if (options.shouldThrow) maybeThrow();
      return options.tools ?? [];
    },

    async getCommands(_ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      return options.commands ?? [];
    },

    async getSystemPromptAdditions(_ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      return options.systemPromptAdditions ?? [];
    },

    async onSessionStart(event: SessionStartEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onSessionStart.push(event);
    },

    async onInput(event: InputEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onInput.push(event);
      return options.onInput?.(event);
    },

    async onBeforeAgentStart(event: BeforeAgentStartEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onBeforeAgentStart.push(event);
      return options.onBeforeAgentStart?.(event);
    },

    async onContext(event: ContextEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onContext.push(event);
      return options.onContext?.(event);
    },

    async onToolCall(event: ToolCallEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onToolCall.push(event);
      return options.onToolCall?.(event);
    },

    async onToolResult(event: ToolResultEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onToolResult.push(event);
      return options.onToolResult?.(event);
    },

    async onBeforeCompact(event: BeforeCompactEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onBeforeCompact.push(event);
      return options.onBeforeCompact?.(event);
    },

    async onCompact(event: CompactEvent, _ctx: ISession) {
      if (options.shouldThrow) maybeThrow();
      calls.onCompact.push(event);
      options.onCompact?.(event);
    },
  };

  return stub;
}

// ─── Minimal KV mock ──────────────────────────────────────────────────────────

/**
 * Minimal KVNamespace mock that stores a registry string.
 * Passes to ExtensionRunner.initialize() in unit tests.
 */
export function createMockKv(registry?: string[]): KVNamespace {
  const store = new Map<string, string>();
  if (registry !== undefined) {
    store.set("extensions:registry", JSON.stringify(registry));
  }
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
    async getWithMetadata(key: string) {
      return { value: store.get(key) ?? null, metadata: null };
    },
  } as unknown as KVNamespace;
}

/**
 * Minimal DispatchNamespace mock.
 * Returns pre-registered stubs by name.
 */
export function createMockDispatchNamespace(
  stubs: Record<string, IExtensionWorkerLike>,
): DispatchNamespace {
  return {
    get(name: string) {
      const stub = stubs[name];
      if (!stub) throw new Error(`No stub registered for extension: ${name}`);
      return stub as unknown as Fetcher;
    },
  } as unknown as DispatchNamespace;
}

// ─── Mock ISession ────────────────────────────────────────────────────────────

/**
 * Create a minimal ISession mock for use in unit tests.
 * Implements all ISession methods with no-op implementations.
 * Tests can override specific methods as needed.
 */
export function createMockSession(
  overrides: Partial<ISession> & { sessionId?: string; userId?: string } = {},
): ISession {
  const sessionId = overrides.sessionId ?? "test-session-id";
  const userId = overrides.userId ?? "test-user-id";

  return {
    userId,
    id: async () => sessionId,
    info: async () => ({ id: sessionId, userId, createdAt: 0, updatedAt: 0 }),
    getName: async () => undefined,
    setName: async () => {},
    prompt: async () => {
      throw new Error("not implemented in mock");
    },
    sendUserMessage: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    getCurrentTurn: async () => undefined,
    getModel: async () => "test/model",
    setModel: async () => {},
    listModels: async () => [],
    getActiveTools: async () => [],
    setActiveTools: async () => {},
    appendCustomMessage: async () => {},
    appendCustomEntry: async () => {},
    getEntries: async () => [],
    getContextUsage: async () => ({
      inputTokens: 0,
      contextWindowTokens: 200_000,
      usedFraction: 0,
    }),
    compact: async () => {},
    getSystemPrompt: async () => "",
    branch: async () => {},
    fork: async () => {
      throw new Error("not implemented in mock");
    },
    delete: async () => {},
    ...overrides,
  } as ISession;
}
