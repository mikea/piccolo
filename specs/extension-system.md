# Extension System — Specification

Complete reference for writing, discovering, loading, and executing extensions in `@mariozechner/pi-coding-agent`.

---

## Overview

Extensions are TypeScript or JavaScript files that export a default function. They run at startup and register tools, commands, shortcuts, message renderers, flags, and event handlers. Extensions can also interact with the UI (in interactive mode) and with other extensions via the shared `EventBus`.

---

## Extension File Format

```typescript
// my-extension.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI): void | Promise<void> {
  // Registration phase — called once at startup
  pi.registerTool({ ... });
  pi.registerCommand("name", { handler: async (args, ctx) => {} });
  pi.registerShortcut("ctrl+x", { handler: async (ctx) => {} });
  pi.registerFlag("plan", { type: "boolean", default: false });
  pi.registerMessageRenderer("my-type", renderer);
  pi.registerProvider("my-provider", config);

  pi.on("agent_end", async (event, ctx) => {
    // event handler
  });
}
```

The default export is called during loading with the `ExtensionAPI` object. It may be `async`. All `pi.*` calls during this phase are registered synchronously.

---

## Discovery Algorithm

`discoverAndLoadExtensions(cwd, agentDir, settings, cliExtensions)`:

```
1. Collect paths from (in order):
   a. cwd/.pi/extensions/     (project-local)
   b. agentDir/extensions/    (~/.pi/agent/extensions/)
   c. settings.extensions[]   (configured paths)
   d. cliExtensions[]         (--extension / -e flags)

2. For each directory in the list:
   Scan for:
   a. *.ts / *.js files → load directly
   b. {dir}/index.ts / {dir}/index.js → load as entry point
   c. {dir}/package.json with "pi": { "extensions": [...] }
      → load each declared path

3. Deduplicate by resolved absolute path

4. Return: { paths: string[], allExtensionPaths: string[] }
```

---

## Loading (`loadExtensionModule`)

```typescript
async function loadExtensionModule(
  extensionPath: string,
  virtualModules: Map<string, unknown>,
): Promise<Extension>
```

Uses `@mariozechner/jiti` (TypeScript runtime) to execute `.ts` files in-process without a separate compilation step.

**Virtual modules available to extensions:**

| Module | What's provided |
|--------|----------------|
| `@sinclair/typebox` | `Type`, `Static`, `TSchema` |
| `@mariozechner/pi-agent-core` | `Agent`, `AgentTool`, `AgentEvent`, all types |
| `@mariozechner/pi-tui` | All TUI exports |
| `@mariozechner/pi-ai` | All AI API exports |
| `@mariozechner/pi-ai/oauth` | OAuth utilities |
| `@mariozechner/pi-coding-agent` | Full public SDK (everything in `index.ts`) |

For the Bun binary: virtual modules are mapped to bundled packages. For Node: `alias` maps to workspace packages.

---

## `Extension` Object

After loading, each extension is represented as:

```typescript
interface Extension {
  path: string;                                      // original discovery path
  resolvedPath: string;                              // absolute filesystem path
  sourceInfo: SourceInfo;
  handlers: Map<string, HandlerFn[]>;                // event name → handlers
  tools: Map<string, RegisteredTool>;                // tool name → definition
  messageRenderers: Map<string, MessageRenderer>;    // custom type → renderer
  commands: Map<string, RegisteredCommand>;          // slash command name → handler
  flags: Map<string, ExtensionFlag>;                 // flag name → definition
  shortcuts: Map<KeyId, ExtensionShortcut>;          // key → handler
}
```

---

## `ExtensionAPI` — Complete Interface

The object passed to the extension factory function:

### Event Subscription

```typescript
// Each event type has a strongly-typed overload:
pi.on("session_start",           handler: (e: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>): void
pi.on("session_before_compact",  handler: (e: SessionBeforeCompactEvent, ctx) => SessionBeforeCompactResult | void): void
pi.on("session_compact",         handler: (e: SessionCompactEvent, ctx) => void): void
pi.on("session_before_switch",   handler: (e, ctx) => { cancel?: boolean } | void): void
pi.on("session_switch",          handler: (e, ctx) => void): void
pi.on("session_before_fork",     handler: (e, ctx) => { cancel?: boolean; skipConversationRestore?: boolean } | void): void
pi.on("session_fork",            handler: (e, ctx) => void): void
pi.on("session_before_tree",     handler: (e, ctx) => SessionBeforeTreeResult | void): void
pi.on("session_tree",            handler: (e, ctx) => void): void
pi.on("session_shutdown",        handler: (e, ctx) => void): void
pi.on("session_directory",       handler: (e, ctx) => { sessionDir?: string } | void): void
pi.on("resources_discover",      handler: (e, ctx) => ResourcesDiscoverResult | void): void

pi.on("context",                 handler: (e: ContextEvent, ctx) => ContextEventResult | void): void
pi.on("before_provider_request", handler: (e: BeforeProviderRequestEvent, ctx) => unknown): void
pi.on("before_agent_start",      handler: (e: BeforeAgentStartEvent, ctx) => BeforeAgentStartResult | void): void

pi.on("agent_start",             handler: (e, ctx) => void): void
pi.on("agent_end",               handler: (e: AgentEndEvent, ctx) => void): void
pi.on("turn_start",              handler: (e, ctx) => void): void
pi.on("turn_end",                handler: (e: TurnEndEvent, ctx) => void): void
pi.on("message_start",           handler: (e: MessageStartEvent, ctx) => void): void
pi.on("message_update",          handler: (e: MessageUpdateEvent, ctx) => void): void
pi.on("message_end",             handler: (e: MessageEndEvent, ctx) => void): void
pi.on("tool_execution_start",    handler: (e: ToolExecutionStartEvent, ctx) => void): void
pi.on("tool_execution_update",   handler: (e: ToolExecutionUpdateEvent, ctx) => void): void
pi.on("tool_execution_end",      handler: (e: ToolExecutionEndEvent, ctx) => void): void

pi.on("tool_call",               handler: (e: ToolCallEvent, ctx) => ToolCallEventResult | void): void
pi.on("tool_result",             handler: (e: ToolResultEvent, ctx) => ToolResultEventResult | void): void

pi.on("model_select",            handler: (e: ModelSelectEvent, ctx) => void): void
pi.on("user_bash",               handler: (e: UserBashEvent, ctx) => UserBashEventResult | void): void
pi.on("input",                   handler: (e: InputEvent, ctx) => InputEventResult | void): void
```

### Registration

```typescript
// Register a tool that the LLM can call
pi.registerTool<TParams, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): void

// Register a slash command (/name)
pi.registerCommand(name: string, options: {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}): void

// Register a keyboard shortcut in interactive mode
pi.registerShortcut(shortcut: KeyId, options: {
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
}): void

// Register a CLI flag (parsed in second pass)
pi.registerFlag(name: string, options: {
  type: "boolean" | "string";
  description?: string;
  default?: boolean | string;
  alias?: string;
}): void

// Register a renderer for custom message types
pi.registerMessageRenderer<T>(
  customType: string,
  renderer: MessageRenderer<T>,
): void

// Register a custom LLM provider
pi.registerProvider(name: string, config: ProviderConfig): void
pi.unregisterProvider(name: string): void
```

### Action Methods (active after bindCore())

```typescript
// Send messages
pi.sendMessage(message: AgentMessage, options?: SendMessageOptions): void
pi.sendUserMessage(content: UserMessageContent, options?: SendMessageOptions): void
pi.appendEntry<T>(customType: string, data?: T): void

// Session metadata
pi.setSessionName(name: string): void
pi.getSessionName(): string | undefined
pi.setLabel(entryId: string, label: string): void

// Execute system command
pi.exec(command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>

// Tool management
pi.getActiveTools(): string[]
pi.getAllTools(): ToolInfo[]
pi.setActiveTools(toolNames: string[]): void

// Slash command list
pi.getCommands(): SlashCommandInfo[]

// Model management
pi.setModel(model: Model<Api>): Promise<boolean>
pi.getThinkingLevel(): ThinkingLevel
pi.setThinkingLevel(level: ThinkingLevel): void

// Flag values
pi.getFlag(name: string): boolean | string | undefined

// Shared event bus between extensions
pi.events: EventBus
```

---

## `ExtensionContext` — Handler Parameter

Passed as the second argument to all event handlers:

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;     // UI operations (interactive mode only)
  hasUI: boolean;              // false in print/RPC mode

  cwd: string;
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model<Api> | undefined;

  isIdle(): boolean;           // true when agent is not streaming
  abort(): void;               // abort current agent operation
  hasPendingMessages(): boolean;
  shutdown(): void;            // gracefully shut down pi

  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}
```

### `ExtensionUIContext` (interactive mode only)

```typescript
interface ExtensionUIContext {
  // Prompts
  select(
    title: string,
    options: string[],
    opts?: { multiple?: boolean; defaultSelected?: string[] }
  ): Promise<string | undefined>;

  confirm(
    title: string,
    message: string,
    opts?: { timeout?: number }
  ): Promise<boolean>;

  input(
    title: string,
    placeholder?: string,
    opts?: { defaultValue?: string }
  ): Promise<string | undefined>;

  // Notifications
  notify(message: string, type?: "info" | "success" | "warning" | "error"): void;

  // Terminal input middleware
  onTerminalInput(handler: (data: string) => boolean | void): () => void;

  // Status bar
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;

  // Widget system
  setWidget(
    key: string,
    content: Component | ((theme: Theme) => Component) | undefined,
    options?: WidgetOptions
  ): void;

  // Layout customization
  setFooter(factory: ((theme: Theme) => Component) | undefined): void;
  setHeader(factory: ((theme: Theme) => Component) | undefined): void;
  setTitle(title: string): void;

  // Custom dialog
  custom<T>(
    factory: (resolve: (value: T) => void) => Component,
    options?: OverlayOptions
  ): Promise<T>;

  // Editor control
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(
    title: string,
    prefill?: string
  ): Promise<string | undefined>;
  setEditorComponent(factory: (() => EditorComponent) | undefined): void;

  // Theme
  theme: Theme;
  getAllThemes(): { name: string; path: string }[];
  getTheme(name: string): Theme | undefined;
  setTheme(theme: Theme): { success: boolean; error?: string };

  // Tool display
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}
```

---

## `ToolDefinition<TParams, TDetails, TState>` — Complete Interface

```typescript
interface ToolDefinition<
  TParams extends TSchema,
  TDetails,
  TState = undefined,
> {
  name: string;
  label: string;              // human-readable display name
  description: string;        // LLM-facing description in tool spec
  promptSnippet?: string;     // one-line system prompt entry ("Available tools" section)
  promptGuidelines?: string[]; // additional bullet points in "Tool Guidelines" section
  parameters: TParams;        // TypeBox schema for tool arguments

  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;

  // Optional: custom rendering in interactive mode
  renderCall?(
    args: Static<TParams>,
    theme: Theme,
    context: ToolRenderContext<TState>,
  ): Component;

  renderResult?(
    result: AgentToolResult<TDetails> | undefined,
    options: { isError: boolean; isPending: boolean },
    theme: Theme,
    context: ToolRenderContext<TState>,
  ): Component;
}

interface ToolRenderContext<TState> {
  toolCallId: string;
  state: TState;
  setState: (state: TState) => void;
  requestRender: () => void;
}
```

### Tool Wrapping (`wrapRegisteredTool`)

`ToolDefinition` is converted to `AgentTool` for use with the agent:

```typescript
function wrapRegisteredTool(
  definition: ToolDefinition<TSchema, unknown, unknown>,
  getContext: () => ExtensionContext,
): AgentTool
```

The wrapper:
1. Creates `AgentTool` with matching `name`, `label`, `description`, `parameters`
2. In `execute()`: calls `definition.execute(toolCallId, params, signal, onUpdate, getContext())`
3. Errors from `execute()` are caught and returned as `{ content: [{ type: "text", text: error.message }], details: {}, isError: true }`

---

## All Event Types

### Session Events

| Event | Fired when | Can return |
|-------|-----------|-----------|
| `resources_discover` | After session_start, before session init | `{ skillPaths?, promptPaths?, themePaths? }` |
| `session_directory` | Before SessionManager creation | `{ sessionDir?: string }` |
| `session_start` | On session load/creation | nothing |
| `session_before_switch` | Before session is switched | `{ cancel?: boolean }` |
| `session_switch` | After session switched | nothing |
| `session_before_fork` | Before session fork | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_fork` | After fork created | nothing |
| `session_before_compact` | Before compaction runs | `{ cancel?: boolean; compaction?: CompactionResult }` |
| `session_compact` | After compaction completes | nothing |
| `session_shutdown` | On process exit (SIGINT/SIGTERM) | nothing |
| `session_before_tree` | Before /tree navigation | `SessionBeforeTreeResult` |
| `session_tree` | After /tree navigation | nothing |

### Agent Loop Events

| Event | Fired when | Can return |
|-------|-----------|-----------|
| `context` | Before each LLM call (message list ready) | `{ messages?: AgentMessage[] }` |
| `before_provider_request` | Before raw API payload sent | modified payload |
| `before_agent_start` | User submits prompt; after processing | `BeforeAgentStartResult` |
| `agent_start` | Agent loop starts | nothing |
| `agent_end` | Agent loop ends | nothing |
| `turn_start` | Each LLM turn starts | nothing |
| `turn_end` | Each LLM turn ends | nothing |
| `message_start` | Message stream begins | nothing |
| `message_update` | Token arrives | nothing |
| `message_end` | Message stream complete | nothing |
| `tool_execution_start` | Tool begins executing | nothing |
| `tool_execution_update` | Tool streaming progress | nothing |
| `tool_execution_end` | Tool finishes | nothing |

### Interception Events

| Event | Fired when | Can return |
|-------|-----------|-----------|
| `tool_call` | Before tool.execute() is called | `{ block?: boolean; reason?: string }` |
| `tool_result` | After tool.execute() returns | `{ content?, details?, isError? }` |
| `input` | User submits any prompt | `{ action: "handled"\|"transform"\|"continue"; text?: string }` |
| `user_bash` | User runs `!command` in editor | `{ operations?, result? }` |
| `model_select` | Model changed | nothing |

### `BeforeAgentStartResult`

```typescript
interface BeforeAgentStartResult {
  message?: {
    systemPrompt?: string;
    contextMessages?: AgentMessage[];  // injected before user message
  };
}
```

### `SessionBeforeTreeResult`

```typescript
interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: string;                        // custom branch summary
  customInstructions?: string;             // for branch summary LLM call
  replaceInstructions?: boolean;
  reserveTokens?: number;
  skipSummarization?: boolean;
}
```

---

## `ProviderConfig` — Custom LLM Providers

Extensions can register custom LLM providers that appear alongside built-in providers:

```typescript
interface ProviderConfig {
  displayName: string;
  api: Api;                     // which API format to use
  baseUrl: string;              // endpoint URL
  models: CustomModelConfig[];
  authType?: "apiKey" | "oauth" | "none";
  apiKeyEnvVar?: string;        // environment variable for API key
  apiKeyStorageKey?: string;    // key in auth.json storage
}

interface CustomModelConfig {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number };
}
```

---

## `EventBus`

Shared publish/subscribe between extensions. Extensions can communicate without knowing about each other.

```typescript
interface EventBus {
  on<T>(event: string, handler: (data: T) => void | Promise<void>): () => void;
  off(event: string, handler: Function): void;
  emit<T>(event: string, data: T): Promise<void>;
}
```

**Usage:**

```typescript
// In extension A
pi.events.on("my-custom-event", (data: MyData) => {
  console.log("Received:", data);
});

// In extension B
await pi.events.emit("my-custom-event", { value: 42 });
```

---

## `ExtensionRunner` — Internal Dispatch

The `ExtensionRunner` manages all loaded extensions and dispatches events to them.

### Construction

```typescript
const runner = new ExtensionRunner(extensions, runtime);
runner.bindCore(coreBindings);  // binds action methods after AgentSession is created
```

### Dispatch Methods

```typescript
// Generic event dispatch — returns array of results from all handlers
runner.emit<T>(event: ExtensionEvent): Promise<T[]>

// Tool call interception
runner.emitToolCall(event: ToolCallEvent): Promise<{ block?: boolean; reason?: string }>

// Tool result modification
runner.emitToolResult(event: ToolResultEvent): Promise<{ content?, details?, isError? } | undefined>

// Before agent start — inject context messages / modify system prompt
runner.emitBeforeAgentStart(
  prompt: string,
  images: ImageContent[],
  systemPrompt: string
): Promise<BeforeAgentStartResult>

// Before provider request — rewrite raw API payload
runner.emitBeforeProviderRequest(payload: unknown): Promise<unknown>

// Context transformation — filter/transform message list
runner.emitContext(messages: AgentMessage[]): Promise<AgentMessage[]>

// Input handling
runner.emitInput(
  text: string,
  images: ImageContent[],
  source: "user" | "steer" | "followUp"
): Promise<InputEventResult>

// Resource discovery — extensions provide skill/prompt/theme paths
runner.emitResourcesDiscover(cwd: string, reason: string): Promise<{
  skillPaths: string[];
  promptPaths: string[];
  themePaths: string[];
}>
```

---

## Extension Examples

### Minimal tool registration

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "get_weather",
    label: "Get Weather",
    description: "Get the current weather for a location",
    parameters: Type.Object({
      location: Type.String({ description: "City name or coordinates" }),
    }),
    async execute(toolCallId, params, signal) {
      const response = await fetch(
        `https://api.weather.example.com?q=${params.location}`,
        { signal }
      );
      const data = await response.json();
      return {
        content: [{ type: "text", text: `Weather in ${params.location}: ${data.description}` }],
        details: data,
      };
    },
  });
}
```

### Event handler with UI

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const usage = event.messages
      .filter(m => m.role === "assistant")
      .reduce((acc, m) => acc + (m.usage?.cost?.total ?? 0), 0);

    if (usage > 1.0) {
      ctx.ui.notify(`Warning: This session cost $${usage.toFixed(2)}`, "warning");
    }
  });
}
```

### Slash command

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("report", {
    description: "Generate a progress report",
    handler: async (args, ctx) => {
      pi.sendMessage({
        role: "user",
        content: [{ type: "text", text: `Please generate a ${args || "summary"} report of our session so far.` }],
        timestamp: Date.now(),
      });
    },
  });
}
```

### Keyboard shortcut

```typescript
import { Key } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut(Key.ctrl("k"), {
    description: "Clear conversation",
    handler: async (ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Clear conversation",
        "Are you sure you want to start a new session?"
      );
      if (confirmed) {
        await ctx.sessionManager.newSession();
      }
    },
  });
}
```

### Custom message renderer

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface NotificationMessage {
  role: "notification";
  text: string;
  level: "info" | "warning" | "error";
  timestamp: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer<NotificationMessage>("notification", {
    render(message, theme) {
      const color = message.level === "error"
        ? theme.fg("error", message.text)
        : message.level === "warning"
          ? theme.fg("warning", message.text)
          : theme.fg("info", message.text);
      return new Text(`[${message.level.toUpperCase()}] ${color}`);
    },
  });
}
```

---

## RPC Mode Extension UI

When running in `--mode rpc`, extensions calling `ctx.ui.*` methods trigger RPC protocol messages instead of rendering UI directly.

**Extension calls `ctx.ui.select(title, options)`:**

```
pi → client (stdout):
  { "type": "extension_ui_request", "id": "req-123", "method": "select",
    "title": "Choose option", "options": ["a", "b", "c"] }
```

**client → pi (stdin):**
```
{ "type": "extension_ui_response", "id": "req-123", "value": "b" }
```

**Extension calls `ctx.ui.confirm(title, message)`:**

```
pi → client:
  { "type": "extension_ui_request", "id": "req-456", "method": "confirm",
    "title": "Confirm?", "message": "Are you sure?" }

client → pi:
  { "type": "extension_ui_response", "id": "req-456", "confirmed": true }
```

**Extension calls `ctx.ui.input(title, placeholder)`:**

```
pi → client:
  { "type": "extension_ui_request", "id": "req-789", "method": "input",
    "title": "Enter value", "placeholder": "Type here..." }

client → pi:
  { "type": "extension_ui_response", "id": "req-789", "value": "user input" }
  OR
  { "type": "extension_ui_response", "id": "req-789", "cancelled": true }
```

**Timeout:** If no response after 30 seconds, the extension context times out and `ctx.ui.*` returns `undefined`.
