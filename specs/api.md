# Piccolo — Public JSRPC API

All inter-component communication in piccolo uses Cloudflare Workers RPC (JSRPC). This document is the single source of truth for every public RPC interface, shared message type, and event union. Other spec documents reference these names without re-defining them.

---

## Shared Types

Types used across multiple API surfaces.

```typescript
import type { ModelMessage, LanguageModelUsage, FinishReason } from "ai";

// ─── Session ──────────────────────────────────────────────────────────────────

// Internal session record — used only by piccolo-core persistence layer.
// Not exposed to gateway clients.
interface SessionRecord {
  id: string;          // UUID v4
  userId: string;
  createdAt: number;   // Unix ms
  updatedAt: number;   // Unix ms
  name?: string;
  cwd?: string;
}

// SessionInfo is an internal D1 query result type, not a public interface.
// Kept here for reference only; clients always work with ISession stubs.
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

// ─── Attachments ──────────────────────────────────────────────────────────────

interface Attachment {
  name: string;
  mimeType: string;
  data: string;    // base64 for binary; UTF-8 text otherwise
  size: number;
}

// ─── Agent Events ─────────────────────────────────────────────────────────────

// Streamed from AgentSessionDO → gateways over JSRPC ReadableStream.
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

type JsonSchema7 = Record<string, unknown>;

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

  // Tool input schema (JSON Schema draft-07 style).
  // Must be RPC-serializable when returned by extension Workers.
  inputSchema: JsonSchema7;
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

// Returned by tool execute() calls.
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

// ITextUI — minimal shared interface implemented by tool Workers.
// Returned by ITool.getGatewayUI("web") or getGatewayUI("telegram")
// when the tool does not need gateway-specific rendering.
// The gateway calls these methods to pull rendering text FROM the tool
// (not to push text TO the tool). The tool provides its own display strings;
// the gateway decides how and when to render them.
interface ITextUI {
  // Return a line of status text to display while the tool is executing.
  getStatusText(): Promise<string>;

  // Return the formatted result text to display once execute() completes.
  getResultText(output: unknown): Promise<string>;

  // Return an error message to display when execute() throws.
  getErrorText(error: unknown): Promise<string>;
}

// ─── Context / Compaction ─────────────────────────────────────────────────────

interface ContextUsage {
  inputTokens: number;
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

// ─── History ──────────────────────────────────────────────────────────────────

// A single renderable entry in a session's conversation history.
// Returned by ISession.getHistory() — the canonical server-side view of the
// conversation. Gateways render this directly on load; no client-side state.
//
// Roles:
//   "user"      — a message typed by the user
//   "assistant" — text generated by the LLM (may still be streaming)
//   "tool"      — a tool invocation with its result
//   "error"     — an error that occurred during a turn
type HistoryEntry =
  | { type: "user";      id: string; content: string }
  | { type: "assistant"; id: string; content: string; isStreaming: boolean }
  | { type: "tool";      id: string; toolName: string; input: unknown; output: unknown; isError: boolean; isStreaming: boolean }
  | { type: "error";     id: string; message: string };

// ─── Session Status ───────────────────────────────────────────────────────────

// Snapshot of session-level state. Returned by ISession.getStatus().
// Gateways use this to render controls (e.g. disable send while streaming).
interface SessionStatus {
  isStreaming: boolean;   // true while a prompt() turn is in progress
  model: string;          // current model ID
  name: string | undefined;
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
  // userId is provided by the calling gateway after it has authenticated the user.
  newSession(userId: string, options?: NewSessionOptions): Promise<ISession>;

  // Retrieve an existing session by ID. Returns an ISession stub.
  getSession(sessionId: string): Promise<ISession>;

  // List sessions for a given user as live ISession RpcTargets.
  // Gateways call id(), getName(), getUpdatedAt() etc. on each stub directly.
  // userId is provided by the calling gateway after it has authenticated the user.
  listSessions(userId: string): Promise<ISession[]>;

  // ─── Global model registry ───────────────────────────────────────────────

  // List all model IDs available (sourced from the MODELS env var).
  listModels(): Promise<string[]>;
}
```

---

## 2. Session API — `ISession`

An `RpcTarget` stub returned by `IPiccoloCore.newSession()` and `IPiccoloCore.getSession()`. Represents one conversation session and exposes all per-session operations as instance methods — no `sessionId` parameter threading.

`ISession` is also the context object passed to every extension handler call and every tool `execute()` call. Extensions and tools receive the same full session interface — no separate "extension context" type. In `packages/agent`, the minimal subset needed by the agent loop is `IAgentSession` (see `agent.md`).

```typescript
interface ISession {

  // ─── Identity ─────────────────────────────────────────────────────────────

  // Stable session identifier (UUID v4). Use this to persist references.
  sessionId(): Promise<string>;

  // Unix ms timestamp of the last update (used for sorting).
  getUpdatedAt(): Promise<number>;

  // The user who owns this session.
  readonly userId: string;

  // ─── Metadata ─────────────────────────────────────────────────────────────

  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ─────────────────────────────────────────────────────────

  // Start a new agent turn. Returns an ITurn that owns the event stream for
  // this turn. Callers consume ITurn.getStream() to receive AgentEvents.
  // callback is the gateway's IGatewayCallback stub (see api.md §5).
  // It is stored on the turn for the duration of the prompt so tools can
  // call requestSelect / requestConfirm / requestInput mid-turn via ITurn.getCallback().
  // Pass undefined (or omit) when no interactive callback is available.
  prompt(text: string, attachments?: Attachment[], callback?: IGatewayCallback): Promise<ITurn>;

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

  // Return the active turn context (if a turn is in progress), or undefined if idle.
  // Gateways call this after getHistory() to reconnect to an in-progress turn
  // (e.g. after a page reload): call ITurn.getStream() on the result to receive
  // the remaining AgentEvents. Use ITurn.getCallback() for interactive mid-turn prompts.
  getCurrentTurn(): Promise<ITurn | undefined>;

  // ─── Model management ────────────────────────────────────────────────────

  getModel(): Promise<string>;
  setModel(modelId: string): Promise<void>;
  listModels(): Promise<string[]>;

  // ─── Tools ───────────────────────────────────────────────────────────────

  // Returns descriptors of all currently active tools.
  getActiveTools(): Promise<ToolDescriptor[]>;
  // Accepts IAgentTool RpcTargets directly over JSRPC.
  setActiveTools(tools: IAgentTool[]): Promise<void>;

  // ─── Custom session entries ───────────────────────────────────────────────

  // Appends an extension-defined message visible to the LLM.
  appendCustomMessage(customType: string, content: string, display: boolean): Promise<void>;

  // Appends an opaque entry to the session log (NOT sent to LLM).
  appendCustomEntry(customType: string, data?: unknown): Promise<void>;

  // Read back custom entries previously appended by this (or any) extension.
  // customType filters by entry type; omit to retrieve all custom entries.
  // Returns entries in chronological order along the current branch.
  getEntries(customType?: string): Promise<CustomEntry[]>;

  // ─── History & live subscription ────────────────────────────────────────

  // Return the full conversation history as renderable HistoryEntry items.
  // Gateways call this on load (including after page reload) to reconstruct
  // the visible chat. If a turn is currently streaming, the last entry will
  // be an assistant entry with isStreaming: true and the text accumulated so far.
  // Replaces client-side message state — the server is the single source of truth.
  getHistory(): Promise<HistoryEntry[]>;

  // Return a snapshot of session-level state (isStreaming, model, name).
  // Gateways use this to render controls without holding local state.
  getStatus(): Promise<SessionStatus>;

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

// ITurn — active turn context accessible from tool/extension execute() calls.
// Owns the AgentEvent stream for the turn and the optional gateway callback.
// The callback is a property of the turn (not the session) since it is bound
// to a specific prompt() invocation and is ephemeral.
// For refresh support, the active turn is also available via
// ISession.getCurrentTurn(), which returns undefined between turns.
interface ITurn {
  // Return the ReadableStream<AgentEvent> for this turn.
  // The stream emits all events for the turn in progress.
  getStream(): Promise<ReadableStream<AgentEvent>>;

  // Return the gateway's IGatewayCallback stub for this turn (if any).
  // Tools call this to request interactive input mid-turn (select, confirm, input).
  // Returns undefined if the gateway did not supply a callback for this turn.
  getCallback(): Promise<IGatewayCallback | undefined>;
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

## 4. `AgentSessionDO` — Durable Object

One Durable Object per session. `AgentSessionDO extends DurableObject` implements `ISession` directly — no wrapper class needed. The DO stub returned by `env.AGENT_SESSION.get(idFromName(sessionId))` proxies all `ISession` method calls to the DO instance.

Callers (gateways, tools) receive the DO stub and use it as an `ISession`. `UserImpl` initialises a new DO via `stub.newSession(sessionId, userId, options?)` then returns the stub cast to `ISession`.

> **Implementation:** see [core.md — `AgentSessionDO`](core.md#agentsessiondo--durable-object-implementation).

```typescript
// AgentSessionDO implements ISession directly.
// The DO stub (DurableObjectStub<AgentSessionDO>) is the ISession returned to callers.
class AgentSessionDO extends DurableObject implements ISession {
  // All ISession methods — see ISession above
  // Plus:
  newSession(sessionId: string, userId: string, options?: NewSessionOptions): Promise<void>;
}
```

---

## 5. Gateway Callback API — `IGatewayCallback`

Implemented by each gateway. An `RpcTarget` stub is passed into `ISession.prompt()` so the core can call back into the gateway for interactive prompts mid-turn.

```typescript
import { RpcTarget } from "cloudflare:workers";

interface IGatewayCallback {

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

Full spec in [web_gateway.md](web_gateway.md).

```typescript
import type { IUser } from "@piccolo/core";
import { RpcTarget } from "capnweb";

// Root interface. Browser connects via newWebSocketRpcSession<IWebGateway>(url).
interface IWebGateway {
  // Return the IUser stub for this connection's authenticated user.
  getUser(): IUser;
}
```

The browser calls `getUser()` once and then uses `IUser` and `ISession` directly.
`ISession.prompt()` returns an `ITurn`; the browser calls `ITurn.getStream()` to consume the `ReadableStream<AgentEvent>`.

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

interface IExtensionListener {
  onSessionStart(event: SessionStartEvent, ctx: ISession): Promise<void>;
  onSessionShutdown(event: SessionShutdownEvent, ctx: ISession): Promise<void>;
  onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ISession): Promise<BeforeAgentStartResult | void>;
  onAgentStart(event: AgentStartEvent, ctx: ISession): Promise<void>;
  onAgentEnd(event: AgentEndEvent, ctx: ISession): Promise<void>;
  onTurnStart(event: TurnStartEvent, ctx: ISession): Promise<void>;
  onTurnEnd(event: TurnEndEvent, ctx: ISession): Promise<void>;
  onToolStart(event: ToolStartEvent, ctx: ISession): Promise<void>;
  onToolEnd(event: ToolEndEvent, ctx: ISession): Promise<void>;
  onContext(event: ContextEvent, ctx: ISession): Promise<ContextResult | void>;
  onToolCall(event: ToolCallEvent, ctx: ISession): Promise<ToolCallResult | void>;
  onToolResult(event: ToolResultEvent, ctx: ISession): Promise<ToolResultOverride | void>;
  onInput(event: InputEvent, ctx: ISession): Promise<InputResult | void>;
  onBeforeCompact(event: BeforeCompactEvent, ctx: ISession): Promise<BeforeCompactResult | void>;
  onCompact(event: CompactEvent, ctx: ISession): Promise<void>;
}

class IExtensionWorker extends WorkerEntrypoint implements IExtensionListener {
  // Called once at session start. Returns the ITool instances this extension provides.
  getTools(ctx: ISession): Promise<ITool[] | void>;

  // Called once during system prompt assembly (at session start and after /reload).
  getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[] | void>;

  // Called at session start. Returns commands this extension exposes.
  getCommands(ctx: ISession): Promise<ICommand[] | void>;
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
  // Set when input starts with /{name} matching a registered ICommand.
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

interface ICommand {
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
| `IUser` | `RpcTarget` | Gateways | `piccolo-core` Worker |
| `ISession` | `DurableObject` stub | Gateways, extensions, tools | `AgentSessionDO` in `piccolo-core` |
| `ITextUI` | `RpcTarget` | Gateways | Each tool Worker (optional) |
| `IWebUI` | `RpcTarget` | Web UI Gateway | Each tool Worker (optional) |
| `ITelegramUI` | `RpcTarget` | Telegram Gateway | Each tool Worker (optional) |
| `IGatewayCallback` | `RpcTarget` | `AgentSessionDO` | Each gateway Worker |
| `IWebGateway` | `RpcTarget` (capnweb) | Browser | Web UI Gateway Worker |
| `ITelegramChatDO` | `DurableObject` | Telegram Gateway Worker | Telegram Gateway Worker |
| `IExtensionWorker` | `WorkerEntrypoint` | `ExtensionRunner` (core) | Each extension Worker |
| `ITool` | Worker class | `IExtensionWorker` (via core) | Each tool Worker |
