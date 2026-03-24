# Piccolo — Public JSRPC API

All inter-component communication in piccolo uses Cloudflare Workers RPC (JSRPC). This document is the single source of truth for every public RPC interface, shared message type, and event union. Other spec documents reference these names without re-defining them.

---

## Shared Types

Types used across multiple API surfaces.

```typescript
import type { ModelMessage, LanguageModelUsage, FinishReason } from "ai";

// ─── Session ──────────────────────────────────────────────────────────────────

interface SessionRecord {
  id: string;          // UUID v4
  userId: string;
  createdAt: number;   // Unix ms
  updatedAt: number;   // Unix ms
  name?: string;
  cwd?: string;
}

// Lightweight summary returned by listSessions()
interface SessionInfo {
  id: string;
  userId: string;
  name?: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  firstMessage: string;   // preview of first user message
}

interface NewSessionOptions {
  name?: string;
  modelId?: string;
  cwd?: string;
}

// ─── Model ────────────────────────────────────────────────────────────────────

interface ModelInfo {
  id: string;       // "{provider}/{model-id}", e.g. "anthropic/claude-sonnet-4-5"
  label: string;    // human-readable display name
  provider: string;
}

// ─── Attachments ──────────────────────────────────────────────────────────────

interface Attachment {
  name: string;
  mimeType: string;
  data: string;    // base64 for binary; UTF-8 text otherwise
  size: number;
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

// Streamed from IAgentSessionDO → IPiccoloCore → gateways over JSRPC ReadableStream.
// Also dispatched to extensions via ExtensionRunner.
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end";       totalUsage: LanguageModelUsage }
  | { type: "turn_start";      stepNumber: number }
  | { type: "turn_end";        stepNumber: number; finishReason: FinishReason; usage: LanguageModelUsage }
  | { type: "text_delta";      delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start";      toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_end";        toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: "error";           message: string };

// ─── Tool ─────────────────────────────────────────────────────────────────────

import type { ZodObject } from "zod";

// Implementation layering note:
//   AgentToolDescriptor (packages/agent) — name, description, inputSchema
//   ToolDescriptor      (packages/core)  — extends AgentToolDescriptor; adds label, snippets
//
//   AgentToolResult     (packages/agent) — content, isError?
//   ToolResult          (packages/core)  — extends AgentToolResult; adds details?
//
//   IAgentTool          (packages/agent) — descriptor: AgentToolDescriptor, execute()
//   ITool               (packages/core)  — extends IAgentTool; adds getGatewayUI

// ToolDescriptor — pure data, no logic.
// Describes the tool to the LLM and to the piccolo core.
// Placed as a static property on every ITool Worker class.
// See tools.md for full authoring guidance.
interface ToolDescriptor {
  // Identifier the LLM uses to call this tool. Snake_case, unique within a session.
  name: string;

  // Human-readable display name shown in gateway UIs and logs.
  label: string;

  // Full description sent to the LLM in the system prompt. Be precise and complete —
  // the LLM knows only what you write here.
  description: string;

  // Optional one-line entry added to "Available tools" in the system prompt.
  // If omitted, the tool is not listed in that section.
  promptSnippet?: string;

  // Optional bullets appended to "Guidelines" while this tool is active.
  promptGuidelines?: string[];

  // Zod schema for the tool's input parameters.
  // Used for LLM function-calling schema generation and server-side validation.
  inputSchema: ZodObject<any>;
}

// ITool — the full interface every tool Worker must implement.
// ToolDescriptor is the static, logic-free description portion.
// ITool adds the execution contract on top of it.
// Tool Workers extend WorkerEntrypoint and implement ITool.
// See tools.md for the complete authoring guide.
interface ITool {
  // Static property — the tool's pure description, no logic.
  // The core reads this to register the tool with the agent.
  readonly descriptor: ToolDescriptor;

  // Called by the core when the LLM invokes this tool.
  // Throw to signal failure — the core sets isError: true automatically.
  execute(
    toolCallId: string,
    params: unknown,               // validated against descriptor.inputSchema before this is called
    ctx: ISession,
    signal?: AbortSignal,
  ): Promise<ToolResult>;

  // Optional. Called by a gateway before rendering a tool call or result.
  // Return an RpcTarget implementing the UI interface the gateway expects:
  //   "web"      → IWebUI      (see web_gateway.md)
  //   "telegram" → ITelegramUI (see telegram_gateway.md)
  //   any        → ITextUI     (shared minimal interface)
  // Return undefined to use the gateway's default rendering.
  getGatewayUI?(gatewayId: GatewayId): Promise<ITextUI | undefined>;
}

// Returned by tool execute() and extension executeTool() calls.
interface ToolResult {
  content: Array<
    | { type: "text";  text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  // Arbitrary metadata stored in the session entry for gateway UI rendering.
  // NOT sent to the LLM.
  details?: unknown;
  // Prefer throwing from execute() over setting isError manually.
  isError?: boolean;
}

// ─── Gateway UI ───────────────────────────────────────────────────────────────

// Well-known gateway identifiers.
type GatewayId = "web" | "telegram" | (string & {});

// ITextUI — minimal shared interface implemented by every gateway.
// Tools that only need text output use this.
// Returned by ITool.getGatewayUI("web") or getGatewayUI("telegram")
// when the tool does not need gateway-specific rendering.
interface ITextUI extends RpcTarget {
  // Render a line of status text while the tool is executing.
  showStatus(text: string): Promise<void>;

  // Replace the tool's result display with formatted text.
  // Called once when execute() completes.
  showResult(text: string): Promise<void>;

  // Show an error message in place of the result.
  showError(text: string): Promise<void>;
}

// ─── Context / Compaction ─────────────────────────────────────────────────────

interface ContextUsage {
  inputTokens: number;
  contextWindowTokens: number;  // model's context window size
  usedFraction: number;          // inputTokens / contextWindowTokens
}

interface CompactOptions {
  keepRecentTokens?: number;    // default: 20_000
}

// Entry returned by ISession.getEntries()
interface CustomEntry {
  id: string;
  customType: string;
  data: unknown;
  timestamp: string;   // ISO 8601
}
```

---

## 1. Core API — `IPiccoloCore`

Exposed by the `piccolo-core` Worker. Gateways call this via service binding.

`IPiccoloCore` is the entry point only — it creates or retrieves sessions and lists global state. All per-session operations are performed on the `ISession` stub returned by `newSession()` / `getSession()`.

> **Implementation:** see [core.md — `IPiccoloCore` WorkerEntrypoint](core.md#ipicclocore-workerentrypoint--implementation) and [core.md — `ISession` stub](core.md#isession-stub).

```typescript
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";

class IPiccoloCore extends WorkerEntrypoint {

  // ─── Session lifecycle ────────────────────────────────────────────────────

  // Create a new session. Returns an ISession stub bound to the new session.
  newSession(options?: NewSessionOptions): Promise<ISession>;

  // Retrieve an existing session by ID. Returns an ISession stub.
  getSession(sessionId: string): Promise<ISession>;

  // List sessions accessible to the authenticated caller.
  listSessions(): Promise<SessionInfo[]>;

  // ─── Global model registry ───────────────────────────────────────────────

  // List all models available through the CF AI Gateway.
  listModels(): Promise<ModelInfo[]>;
}
```

---

## 2. Session API — `ISession`

An `RpcTarget` stub returned by `IPiccoloCore.newSession()` and `IPiccoloCore.getSession()`. Represents one conversation session and exposes all per-session operations as instance methods — no `sessionId` parameter threading.

`ISession` is also the context object passed to every extension handler call and every tool `execute()` call. Extensions and tools receive the same full session interface — no separate "extension context" type. In `packages/agent`, the minimal subset needed by the agent loop is `IAgentSession` (see `agent.md`).

```typescript
class ISession extends RpcTarget {

  // ─── Identity ─────────────────────────────────────────────────────────────

  // Stable session identifier (UUID v4). Use this to persist references.
  id(): Promise<string>;

  // Full session record including timestamps and metadata.
  info(): Promise<SessionRecord>;

  // The user who owns this session.
  readonly userId: string;

  // ─── Metadata ─────────────────────────────────────────────────────────────

  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ─────────────────────────────────────────────────────────

  // Start a new agent turn. Returns a stream of AgentEvents for this turn.
  prompt(text: string, attachments?: Attachment[]): Promise<ReadableStream<AgentEvent>>;

  // Inject a user-role message into the conversation (visible to the LLM).
  // If a turn is active, delivered as a steer (mid-turn injection).
  // Use this from extension handlers to inject programmatic messages.
  sendUserMessage(content: string): Promise<void>;

  // Inject text mid-turn (after the next tool batch, before the next LLM call).
  steer(text: string): Promise<void>;

  // Queue text to be sent when the current turn finishes naturally.
  // Use this from onAgentEnd or background tasks to chain follow-on turns
  // without interrupting an active turn.
  followUp(text: string): Promise<void>;

  // Abort the current streaming turn immediately.
  abort(): Promise<void>;

  // ─── Model management ────────────────────────────────────────────────────

  getModel(): Promise<ModelInfo>;
  setModel(modelId: string): Promise<void>;
  listModels(): Promise<ModelInfo[]>;

  // ─── Tools ───────────────────────────────────────────────────────────────

  // Returns descriptors of all currently active tools.
  getActiveTools(): Promise<ToolDescriptor[]>;
  setActiveTools(toolNames: string[]): Promise<void>;

  // ─── Custom session entries ───────────────────────────────────────────────

  // Appends an extension-defined message visible to the LLM.
  appendCustomMessage(customType: string, content: string, display: boolean): Promise<void>;

  // Appends an opaque entry to the session log (NOT sent to LLM).
  appendCustomEntry(customType: string, data?: unknown): Promise<void>;

  // Read back custom entries previously appended by this (or any) extension.
  // customType filters by entry type; omit to retrieve all custom entries.
  // Returns entries in chronological order along the current branch.
  getEntries(customType?: string): Promise<CustomEntry[]>;

  // ─── Context usage ───────────────────────────────────────────────────────

  getContextUsage(): Promise<ContextUsage>;

  // Trigger context compaction immediately.
  compact(options?: CompactOptions): Promise<void>;

  // ─── System prompt ────────────────────────────────────────────────────────

  getSystemPrompt(): Promise<string>;

  // ─── Session tree / branching ────────────────────────────────────────────

  // Set the active leaf to a prior entry. Next prompt branches from there.
  branch(entryId: string): Promise<void>;

  // Fork this session from a given entry (or current leaf).
  // Returns a new ISession stub for the forked session.
  fork(fromEntryId?: string): Promise<ISession>;

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  delete(): Promise<void>;
}
```

---

## 3. Gateway UI Interfaces

Gateway UI interfaces allow tools to provide custom rendering for specific gateways. Each gateway defines its own UI interface extending `ITextUI`. Full details in [web_gateway.md](web_gateway.md) and [telegram_gateway.md](telegram_gateway.md).

```typescript
// IWebUI — Web UI Gateway rendering interface.
// Returned by ITool.getGatewayUI("web").
// Full spec in web_gateway.md.
interface IWebUI extends ITextUI {
  // Return a component descriptor for custom React rendering.
  // componentId must be a stable string registered by the tool's extension Worker.
  // The gateway loads the component and mounts it in the tool call/result slot.
  getComponent(phase: "call" | "result"): Promise<WebComponentDescriptor | undefined>;
}

interface WebComponentDescriptor {
  componentId: string;         // stable identifier, e.g. "r2-file-tree"
  props: Record<string, unknown>; // serialisable props passed to the component
}

// ITelegramUI — Telegram Gateway rendering interface.
// Returned by ITool.getGatewayUI("telegram").
// Full spec in telegram_gateway.md.
interface ITelegramUI extends ITextUI {
  // Return custom MarkdownV2 text for the tool call summary sent to Telegram.
  formatCall(toolName: string, input: unknown): Promise<string | undefined>;

  // Return custom MarkdownV2 text for the tool result sent to Telegram.
  formatResult(toolName: string, output: unknown, isError: boolean): Promise<string | undefined>;

  // Return custom inline keyboard buttons to attach to the result message.
  getInlineKeyboard(toolName: string, output: unknown): Promise<TelegramInlineKeyboard | undefined>;
}

interface TelegramInlineKeyboard {
  rows: Array<Array<{ text: string; callbackData: string }>>;
}
```

---

## 4. Agent Session DO API — `IAgentSessionDO`

One Durable Object per session. Called by `IPiccoloCore` internally — not directly accessible to gateways. Implements the stateful runtime behind `ISession`.

> **Implementation:** see [core.md — `AgentSessionDO`](core.md#agentsessiondo--durable-object-implementation).

```typescript
import { DurableObject } from "cloudflare:workers";

class IAgentSessionDO extends DurableObject {

  // ─── Conversation ─────────────────────────────────────────────────────────

  prompt(text: string, attachments?: Attachment[]): Promise<ReadableStream<AgentEvent>>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;

  // ─── Accessors ────────────────────────────────────────────────────────────

  getInfo(): Promise<SessionRecord>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;
  getModel(): Promise<ModelInfo>;
  setModel(modelId: string): Promise<void>;
  getContextUsage(): Promise<ContextUsage>;

  // ─── Session control ──────────────────────────────────────────────────────

  branch(entryId: string): Promise<void>;
  compact(options?: CompactOptions): Promise<void>;
  delete(): Promise<void>;
}
```

---

## 5. Gateway Callback API — `IGatewayCallback`

Implemented by each gateway. An `RpcTarget` stub is passed into `ISession.prompt()` so the core can call back into the gateway for interactive prompts mid-turn.

```typescript
import { RpcTarget } from "cloudflare:workers";

class IGatewayCallback extends RpcTarget {

  requestSelect(
    title: string,
    options: string[],
    multiple?: boolean,
  ): Promise<string[] | null>;
  // null → user dismissed / gateway does not support interactive prompts

  requestConfirm(title: string, message: string): Promise<boolean>;
  // false → user denied or gateway does not support

  requestInput(title: string, placeholder?: string): Promise<string | null>;
  // null → user dismissed

  notify(
    message: string,
    level: "info" | "success" | "warning" | "error",
  ): Promise<void>;
}
```

---

## 6. Web UI Gateway API

The Web UI Gateway exposes three browser-facing interfaces over Cap'n Web (`capnweb`), plus a Durable Object for connection durability. Full spec in [web_gateway.md](web_gateway.md).

```typescript
import { RpcTarget } from "capnweb";

// Root interface. Browser connects via newWebSocketRpcSession<IWebGatewayApi>(url).
interface IWebGatewayApi extends RpcTarget {
  newSession(options?: NewSessionOptions): IWebGatewaySession;
  getSession(sessionId: string): IWebGatewaySession;
  listSessions(): Promise<SessionInfo[]>;
  listModels(): Promise<ModelInfo[]>;
}

// Per-session interface. Wraps ISession with browser-facing additions.
interface IWebGatewaySession extends RpcTarget {
  id(): Promise<string>;
  info(): Promise<SessionRecord>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // Start a turn. Server calls listener.onEvent() for each AgentEvent.
  // callback is the browser's IGatewayCallback stub for mid-turn interactive prompts.
  prompt(
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallback,
    attachments?: Attachment[],
  ): ITurnHandle;

  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  getModel(): Promise<ModelInfo>;
  setModel(modelId: string): Promise<void>;
  getContextUsage(): Promise<ContextUsage>;
  compact(options?: CompactOptions): Promise<void>;
  branch(entryId: string): Promise<void>;
  fork(fromEntryId?: string): IWebGatewaySession;
  delete(): Promise<void>;
  uploadAttachment(attachment: Attachment): Promise<string>;
}

// Implemented by the browser. Server calls onEvent() for each AgentEvent.
interface IAgentEventListener extends RpcTarget {
  onEvent(event: AgentEvent): Promise<void>;
}

// Handle for an active turn. Returned by IWebGatewaySession.prompt().
interface ITurnHandle extends RpcTarget {
  abort(): Promise<void>;
  done(): Promise<void>;
}
```

### `IWebUiSessionDO`

Durable Object for connection durability and event buffering across Worker evictions:

```typescript
import { DurableObject } from "cloudflare:workers";

class IWebUiSessionDO extends DurableObject {
  // Register a new browser tab WebSocket connection.
  addConnection(request: Request): Promise<Response>;

  // Fan event out to all connected browser tabs via their IAgentEventListener stubs.
  pushEvent(event: AgentEvent): Promise<void>;

  // Return recent events for reconnecting clients.
  getRecentEvents(): Promise<AgentEvent[]>;
}
```

---

## 7. Telegram Chat DO API — `ITelegramChatDO`

Internal to the Telegram Gateway. Serialises concurrent Telegram updates per chat.

```typescript
import { DurableObject } from "cloudflare:workers";

class ITelegramChatDO extends DurableObject {

  // Processes a single Telegram Update object.
  // Internally queues, dispatches to core, and replies via Telegram Bot API.
  handleUpdate(update: TelegramUpdate): Promise<void>;
}
```

---

## 8. Extension API — `IExtensionWorker`

Implemented by each extension Worker. Called by `ExtensionRunner` inside `piccolo-core` via the Workers for Platforms dispatch namespace.

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";

class IExtensionWorker extends WorkerEntrypoint {

  // ─── Tool registration ───────────────────────────────────────────────────

  // Called once at session start. Returns the ToolDescriptor for each ITool this extension provides.
  // The core reads each tool Worker's static `descriptor` property to build this list.
  getTools(): Promise<ToolDescriptor[]>;

  // Called by the core when the LLM invokes one of this extension's tools.
  executeTool(
    name: string,
    toolCallId: string,
    params: Record<string, unknown>,
    ctx: ISession,
  ): Promise<ToolResult>;

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  onSessionStart(event: SessionStartEvent, ctx: ISession): Promise<void>;
  onSessionShutdown(event: SessionShutdownEvent, ctx: ISession): Promise<void>;

  // ─── Agent loop events ───────────────────────────────────────────────────

  onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ISession): Promise<BeforeAgentStartResult | void>;
  onAgentStart(event: AgentStartEvent, ctx: ISession): Promise<void>;
  onAgentEnd(event: AgentEndEvent, ctx: ISession): Promise<void>;

  onTurnStart(event: TurnStartEvent, ctx: ISession): Promise<void>;
  onTurnEnd(event: TurnEndEvent, ctx: ISession): Promise<void>;

  onToolStart(event: ToolStartEvent, ctx: ISession): Promise<void>;
  onToolEnd(event: ToolEndEvent, ctx: ISession): Promise<void>;

  // ─── Interception ────────────────────────────────────────────────────────

  // Called before each LLM call. May filter or inject messages.
  onContext(event: ContextEvent, ctx: ISession): Promise<ContextResult | void>;

  // Called before a tool's execute(). May block execution.
  onToolCall(event: ToolCallEvent, ctx: ISession): Promise<ToolCallResult | void>;

  // Called after a tool's execute(). May override the result.
  onToolResult(event: ToolResultEvent, ctx: ISession): Promise<ToolResultOverride | void>;

  // Called on every user input. May handle, transform, or pass through.
  onInput(event: InputEvent, ctx: ISession): Promise<InputResult | void>;

  // ─── Compaction ──────────────────────────────────────────────────────────

  // Called before compaction runs. May cancel or provide a pre-built summary.
  onBeforeCompact(event: BeforeCompactEvent, ctx: ISession): Promise<BeforeCompactResult | void>;

  onCompact(event: CompactEvent, ctx: ISession): Promise<void>;

  // ─── System prompt contributions ─────────────────────────────────────────

  // Called once during system prompt assembly (at session start and after /reload).
  // Returns snippets that the core appends to the assembled system prompt.
  // Used by skills, prompt templates, tool guideline extensions, etc.
  getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[] | void>;

  // ─── Command registration ────────────────────────────────────────────────

  // Called at session start. Returns commands this extension exposes.
  // Gateways use these for slash-command autocomplete and help text.
  // Commands are invoked via onInput when the user types /{name}.
  getCommands(ctx: ISession): Promise<CommandDescriptor[] | void>;
}
```

All methods are optional. The core checks method existence before dispatching.

### Extension Event Types

```typescript
// ─── Lifecycle ────────────────────────────────────────────────────────────────

interface SessionStartEvent    { sessionId: string; userId: string; modelId: string }
interface SessionShutdownEvent { sessionId: string }

// ─── Agent loop ───────────────────────────────────────────────────────────────

interface BeforeAgentStartEvent { text: string; attachments: Attachment[]; systemPrompt: string }
interface AgentStartEvent       { sessionId: string }
interface AgentEndEvent         { sessionId: string; messages: ModelMessage[]; totalUsage: LanguageModelUsage }
interface TurnStartEvent        { stepNumber: number }
interface TurnEndEvent          { stepNumber: number; finishReason: FinishReason; usage: LanguageModelUsage }
interface ToolStartEvent        { toolCallId: string; toolName: string; input: unknown }
interface ToolEndEvent          { toolCallId: string; toolName: string; output: unknown; isError: boolean }

// ─── Interception ─────────────────────────────────────────────────────────────

interface ContextEvent          { messages: ModelMessage[] }
interface ToolCallEvent         { toolCallId: string; toolName: string; input: unknown }
interface ToolResultEvent       { toolCallId: string; toolName: string; input: unknown; output: unknown; isError: boolean }
interface InputEvent {
  text: string;
  attachments: Attachment[];
  source: "user";
  // Set when input starts with /{name} matching a registered CommandDescriptor.
  // Extension onInput handlers use this to route command invocations.
  commandName?: string;
  // Arguments following the command name, if commandName is set.
  commandArgs?: string;
}

// ─── Compaction ───────────────────────────────────────────────────────────────

interface BeforeCompactEvent    { messages: ModelMessage[]; keepRecentTokens: number }
interface CompactEvent          { summary: string; keptMessageCount: number }
```

### Extension Result Types

```typescript
interface BeforeAgentStartResult {
  systemPrompt?: string;
  contextMessages?: ModelMessage[];   // injected before the user message
}

interface ContextResult {
  messages: ModelMessage[];            // replacement message list
}

interface ToolCallResult {
  block: boolean;
  reason?: string;
}

interface ToolResultOverride {
  content?: ToolResult["content"];
  details?: unknown;
  isError?: boolean;
}

interface InputResult {
  action: "handled" | "transform" | "continue";
  text?: string;   // replacement text when action === "transform"
}

interface BeforeCompactResult {
  cancel?: boolean;
  summary?: string;   // provide a ready-made summary to skip LLM compaction call
}

// ─── System prompt ────────────────────────────────────────────────────────────

interface SystemPromptAddition {
  // Where in the system prompt to insert this snippet.
  section: "skills" | "guidelines" | "context" | "footer";

  // The text to insert. Markdown supported.
  content: string;

  // Relative weight for ordering within the section. Lower = earlier. Default: 100.
  priority?: number;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

interface CommandDescriptor {
  // Command name without the leading /. E.g. "skill:brave-search", "template:review".
  // Must be unique across all extensions. Convention: "{extension-prefix}:{name}".
  name: string;

  // One-line description shown in gateway autocomplete and /help.
  description: string;

  // If true, gateway autocomplete lists this command.
  // Default: true.
  showInAutocomplete?: boolean;
}
```

### Tool Contract (`ITool` and `ToolDescriptor`)

Every tool Worker implements `ITool` (defined in Shared Types above). `ToolDescriptor` is the pure-data, logic-free description portion of `ITool` — it is what the core reads to register the tool with the agent and build the LLM system prompt. The `execute` method is the runtime logic.

Full authoring guide in [tools.md](tools.md). Provided tool specs: [r2_tool.md](r2_tool.md), [d1_tool.md](d1_tool.md). Gateway UI integration: [web_gateway.md](web_gateway.md), [telegram_gateway.md](telegram_gateway.md).

---

## API Surface Summary

| Interface | Kind | Called by | Implemented by |
|---|---|---|---|
| `IPiccoloCore` | `WorkerEntrypoint` | Gateways | `piccolo-core` Worker |
| `ISession` | `RpcTarget` | Gateways, extensions, tools | `piccolo-core` Worker |
| `IAgentSessionDO` | `DurableObject` | `IPiccoloCore` | `piccolo-core` Worker |
| `ITextUI` | `RpcTarget` | Gateways | Each tool Worker (optional) |
| `IWebUI` | `RpcTarget` | Web UI Gateway | Each tool Worker (optional) |
| `ITelegramUI` | `RpcTarget` | Telegram Gateway | Each tool Worker (optional) |
| `IGatewayCallback` | `RpcTarget` | `IAgentSessionDO` | Each gateway Worker |
| `IWebGatewayApi` | `RpcTarget` (capnweb) | Browser | Web UI Gateway Worker |
| `IWebGatewaySession` | `RpcTarget` (capnweb) | Browser | Web UI Gateway Worker |
| `IAgentEventListener` | `RpcTarget` (capnweb) | Web UI Gateway Worker | Browser |
| `ITurnHandle` | `RpcTarget` (capnweb) | Browser | Web UI Gateway Worker |
| `IWebUiSessionDO` | `DurableObject` | Web UI Gateway Worker | Web UI Gateway Worker |
| `ITelegramChatDO` | `DurableObject` | Telegram Gateway Worker | Telegram Gateway Worker |
| `IExtensionWorker` | `WorkerEntrypoint` | `ExtensionRunner` (core) | Each extension Worker |
| `ITool` | Worker class | `IExtensionWorker` (via core) | Each tool Worker |
