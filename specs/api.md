# Piccolo — Public JSRPC API (`@piccolo/api`)

All inter-component communication in piccolo uses Cloudflare Workers RPC (JSRPC). This document is the single source of truth for every public RPC interface, shared message type, and event union. Other spec documents reference these names without re-defining them.

These types are implemented in the `@piccolo/api` npm workspace package (`packages/api/src/index.ts`). Extensions and gateways import from `@piccolo/api` directly — they do NOT depend on `@piccolo/core`. `piccolo-core` implements the interfaces defined here.

**Dependency rule:**
```
extensions → @piccolo/api  (NOT @piccolo/core)
gateways   → @piccolo/api  (NOT @piccolo/core)
piccolo-core depends on @piccolo/api and implements its interfaces
```

---

## Shared Types

Types used across multiple API surfaces.

```typescript
import type { ModelMessage, LanguageModelUsage, FinishReason } from "ai";

// ─── Session ──────────────────────────────────────────────────────────────────

// NOTE: SessionRecord is an internal piccolo-core type (D1 row shape).
// It lives in packages/core/src/types.ts, not in @piccolo/api.
// Clients always work with ISession stubs — they never see SessionRecord.

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

// Pushed from AgentSessionDO → gateways via IObservable<AgentEvent>.
// Also dispatched to extensions via ExtensionRunner.
type AgentEvent =
  | { type: "start" }
  | { type: "finish";       totalUsage: LanguageModelUsage }
  | { type: "step-start";      stepNumber: number }
  | { type: "step-finish";        stepNumber: number; finishReason: FinishReason; usage: LanguageModelUsage }
  | { type: "text-delta";      delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call";      toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result";        toolCallId: string; toolName: string; output: unknown; isError: boolean }
  | { type: "error";           message: string };

// ─── Tool ─────────────────────────────────────────────────────────────────────

type JsonSchema7 = Record<string, unknown>;

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
// No base IAgentTool type — all fields live directly here.
// Tool Workers extend WorkerEntrypoint and implement ITool.
// See tools.md for the complete authoring guide.
interface ITool {
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

`ISession` is also the context object passed to every extension handler call and every tool `execute()` call. Extensions and tools receive the same full session interface — no separate "extension context" type.

```typescript
// ISession extends IObservable<AgentEvent>: all AgentEvents from all turns flow
// through the session's subscribe() method. Gateways subscribe once on mount
// and receive events for the full session lifetime.
interface ISession extends IObservable<AgentEvent> {

  // ─── Identity ─────────────────────────────────────────────────────────────

  // Stable session identifier (UUID v4). Use this to persist references.
  sessionId(): Promise<string>;

  // Unix ms timestamp of the last update (used for sorting).
  getUpdatedAt(): Promise<number>;

  // The user who owns this session.
  userId(): Promise<string>;

  // ─── Metadata ─────────────────────────────────────────────────────────────

  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ─────────────────────────────────────────────────────────

  // Start a new agent turn. Returns an ITurn carrying the optional callback for
  // interactive mid-turn prompts. AgentEvents are delivered via ISession.subscribe().
  // callback is the gateway's IGatewayCallback stub (see api.md §5).
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
  // Returns undefined when idle; non-undefined means a turn is in progress.
  // Use ITurn.getCallback() for interactive mid-turn prompts.
  // AgentEvents always arrive via ISession.subscribe() regardless of turn state.
  // A non-undefined return value also means a turn is currently streaming —
  // gateways should use this check instead of a separate isStreaming flag.
  getCurrentTurn(): Promise<ITurn | undefined>;

  // ─── Model management ────────────────────────────────────────────────────

  getModel(): Promise<string>;
  setModel(modelId: string): Promise<void>;
  listModels(): Promise<string[]>;

  // ─── Tools ───────────────────────────────────────────────────────────────

  // Returns descriptors of all currently active tools.
  getActiveTools(): Promise<ToolDescriptor[]>;
  // Accepts ITool RpcTargets directly over JSRPC.
  setActiveTools(tools: ITool[]): Promise<void>;

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

// IObserver<T> / IObservable<T> — push-based event delivery over JSRPC.
// Using IObservable instead of ReadableStream avoids the Workers RPC restriction
// that only byte-oriented streams can be transferred across RPC boundaries.
interface IObserver<T> {
  onNext(value: T): Promise<void>;
  onError(error: unknown): Promise<void>;
  onComplete(): Promise<void>;
}

interface IObservable<T> {
  // Subscribe to receive events. Already-emitted events are replayed to late
  // subscribers (supports reconnect after page reload).
  subscribe(observer: IObserver<T>): Promise<void>;
}

// ITurn — returned by ISession.prompt(). Carries only the optional gateway
// callback for interactive mid-turn prompts. AgentEvents are delivered via
// ISession.subscribe() — the session is the observable, not the turn.
// getCurrentTurn() returns undefined between turns; non-undefined means active.
interface ITurn {
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
`ISession extends IObservable<AgentEvent>`: the browser calls `session.subscribe(observer)` once on mount and receives all `AgentEvent`s for the session lifetime. `ISession.prompt()` returns an `ITurn` carrying only the optional callback.

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

// IExtensionListener — handles interception events that require return values.
// AgentEvents are no longer dispatched here; extensions observe them by calling
// ctx.subscribe() inside init().
interface IExtensionListener {
  onEvent?(event: ExtensionEvent, ctx: ISession): Promise<
    | InputResult | BeforeAgentStartResult | ContextResult
    | ToolCallResult | ToolResultOverride | BeforeCompactResult
    | undefined
  >;
}

class IExtensionWorker extends WorkerEntrypoint implements IExtensionListener {
  // Called once at session start with the full ISession.
  // Extension may call ctx.subscribe() to observe AgentEvents for the session lifetime.
  init?(ctx: ISession): Promise<void>;

  // Called once at session start. Returns ITool instances this extension provides.
  getTools?(ctx: ISession): Promise<ITool[] | undefined>;

  // Called once during system prompt assembly. Returns additions to the system prompt.
  getSystemPromptAdditions?(ctx: ISession): Promise<SystemPromptAddition[] | undefined>;

  // Called at session start. Returns commands this extension exposes.
  getCommands?(ctx: ISession): Promise<ICommand[] | undefined>;
}
```

All methods are optional.

### ExtensionEvent — interception only

```typescript
type ExtensionEvent =
  | { type: "input"; text: string; attachments: Attachment[]; source: "user";
      commandName?: string; commandArgs?: string }
  | { type: "before_start"; text: string; attachments: Attachment[]; systemPrompt: string }
  | { type: "context"; messages: ModelMessage[] }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string;
      input: unknown; output: unknown; isError: boolean }
  | { type: "before_compact"; messages: ModelMessage[]; keepRecentTokens: number };
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
