# `@mariozechner/pi-agent-core` — Specification

**Package:** `packages/agent/`  
**npm name:** `@mariozechner/pi-agent-core`  
**Version:** lockstep with monorepo  
**Runtime:** Node.js ≥ 20, ESM only  
**Entry point:** `dist/index.js` (single export, no subpaths)

---

## Purpose

Agent runtime layer. Wraps `@mariozechner/pi-ai` streaming with a multi-turn, tool-calling agent loop. Manages conversation context, tool execution (parallel or sequential), steering/follow-up message queues, abort handling, and a proxy stream function for browser-to-backend routing.

---

## Directory Structure

```
src/
├── index.ts       # Re-exports everything from all source modules
├── types.ts       # All shared types and interfaces
├── agent.ts       # Agent class (stateful, high-level)
├── agent-loop.ts  # Low-level loop functions and event stream wrappers
└── proxy.ts       # Proxy stream function for browser/backend routing
```

---

## Core Types (`src/types.ts`)

### `StreamFn`

```typescript
type StreamFn = (
  ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;
```

The callable shape for any streaming backend — real or proxy. MUST never throw; errors must be encoded in the returned stream.

### `ToolExecutionMode`

```typescript
type ToolExecutionMode = "sequential" | "parallel";
```

- `"sequential"`: each tool call fully completes before the next begins
- `"parallel"` (default): validation runs sequentially; executions run concurrently; results are re-serialized back to assistant source order

### `ThinkingLevel`

```typescript
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

`"off"` → `reasoning: undefined` in `SimpleStreamOptions`. Other levels passed as `reasoning` to the underlying stream function.

### `AgentToolResult<TDetails>`

```typescript
interface AgentToolResult<TDetails> {
  content: (TextContent | ImageContent)[];  // sent to LLM
  details: TDetails;                         // UI/logging metadata
}
```

### `AgentToolUpdateCallback<T>`

```typescript
type AgentToolUpdateCallback<T = unknown> = (partialResult: AgentToolResult<T>) => void;
```

Optional streaming-progress callback passed to `execute()`. Called zero or more times before the final result.

### `AgentTool<TParameters, TDetails>`

```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
  label: string;  // human-readable display name for UI
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
```

Extends `Tool` from `@mariozechner/pi-ai` with `label` and the async `execute()` implementation.

### `AgentContext`

```typescript
interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool<unknown>[];
}
```

The mutable working context threaded through the loop. `messages` grows as turns are processed.

### `AgentState`

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<unknown>[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamMessage: AgentMessage | null;     // current partial assistant message during streaming
  pendingToolCalls: Set<string>;           // toolCallIds currently executing
  error?: string;
}
```

### `AgentMessage`

```typescript
// Declaration-merging extension point: downstream packages add roles here
interface CustomAgentMessages {}

type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

By default identical to `Message` from `@mariozechner/pi-ai`. Downstream packages (e.g., `pi-coding-agent`) extend `interface CustomAgentMessages` via declaration merging to add custom message roles. The `convertToLlm` function filters/converts these before each LLM call.

### `AgentEvent`

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start";  toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: AgentToolResult<unknown> }
  | { type: "tool_execution_end";    toolCallId: string; toolName: string; result: AgentToolResult<unknown>; isError: boolean };
```

### Tool Call Hooks

```typescript
interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;          // validated against tool's TypeBox schema
  context: AgentContext;
}

interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;  // shown as error text in tool result if block=true
}

interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  result: AgentToolResult<unknown>;
  isError: boolean;
  context: AgentContext;
}

interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];  // replaces content in full
  details?: unknown;                          // replaces details in full
  isError?: boolean;                          // replaces error flag
}
```

### `AgentLoopConfig`

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<Api>;

  // Required: converts AgentMessage[] (may include custom types) to Message[] (LLM-compatible)
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  // Optional: context transformation before each LLM call (pruning, injection)
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  // Optional: resolve API key per provider dynamically
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  // Optional: dequeue steering messages after tool execution
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  // Optional: dequeue follow-up messages when loop would otherwise stop
  getFollowUpMessages?: () => Promise<AgentMessage[]>;

  // Tool execution mode (default: "parallel")
  toolExecution?: ToolExecutionMode;

  // Optional hook: called before each tool execution
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

  // Optional hook: called after each tool execution
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}
```

---

## `Agent` Class (`src/agent.ts`)

### Constructor Options

```typescript
interface AgentOptions {
  initialState?: Partial<AgentState>;
  streamFn?: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  toolExecution?: ToolExecutionMode;
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
  transport?: Transport;
  thinkingBudgets?: ThinkingBudgets;
  maxRetryDelayMs?: number;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  sessionId?: string;
}
```

**Default state:**
```typescript
{
  model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
  thinkingLevel: "off",
  tools: [],
  messages: [],
  isStreaming: false,
  streamMessage: null,
  pendingToolCalls: new Set(),
  error: undefined,
}
```

### Public Methods

```typescript
class Agent {
  readonly state: AgentState;

  // Prompting — creates user message(s) and runs agent loop
  async prompt(text: string): Promise<void>;
  async prompt(text: string, images: ImageContent[]): Promise<void>;
  async prompt(message: AgentMessage): Promise<void>;
  async prompt(messages: AgentMessage[]): Promise<void>;

  // Continue — resumes from existing context without new input
  async continue(): Promise<void>;

  // Abort — signals AbortController; marks stream as aborted
  abort(): void;

  // Wait for current streaming to complete
  async waitForIdle(): Promise<void>;

  // Steering — inject message after current tool execution, before next LLM call
  // Does not block; message is queued
  steer(message: AgentMessage): void;

  // Follow-up — inject message when agent loop would otherwise stop
  // Does not block; message is queued
  followUp(message: AgentMessage): void;

  // Clear pending queues
  clearSteering(): AgentMessage[];
  clearFollowUp(): AgentMessage[];

  // State mutations (synchronous, no streaming)
  setModel(model: Model<Api>): void;
  setTools(tools: AgentTool<unknown>[]): void;
  setSystemPrompt(prompt: string): void;
  setThinkingLevel(level: ThinkingLevel): void;
  appendMessage(message: AgentMessage): void;
  replaceMessages(messages: AgentMessage[]): void;
  reset(): void;

  // Hooks
  setBeforeToolCall(handler: AgentLoopConfig["beforeToolCall"]): void;
  setAfterToolCall(handler: AgentLoopConfig["afterToolCall"]): void;

  // Event subscription — returns unsubscribe function
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

### `prompt()` Guard

If `state.isStreaming === true`, throws:
```
Error: Agent is already streaming. Wait for current stream to complete.
```

### `continue()` Validation

Validates before resuming:
1. `!state.isStreaming` — throws if already running
2. `state.messages.length > 0` — throws if no messages
3. Last message is NOT `"assistant"` role — if it is, only continues if there are queued steering messages (dequeues one/all based on mode, calls `_runLoop` with them and `{ skipInitialSteeringPoll: true }`)

### Internal Loop (`_runLoop`)

```typescript
private async _runLoop(
  messages?: AgentMessage[],
  options?: { skipInitialSteeringPoll?: boolean }
): Promise<void>
```

**Execution sequence:**
1. Set `isStreaming = true`, create fresh `AbortController`
2. Build `AgentContext` snapshot from current state
3. Build `AgentLoopConfig` wiring in `getSteeringMessages` and `getFollowUpMessages` from internal queues
4. Call `runAgentLoop(messages, context, config, _processLoopEvent, signal, streamFn)`
5. On exception: synthesize error `AssistantMessage`, emit `agent_end`
6. In `finally`: reset `isStreaming`, `streamMessage`, `pendingToolCalls`

### Event Processing (`_processLoopEvent`)

Called synchronously for every `AgentEvent` before tool preflight begins (barrier model):

| Event | State mutation |
|-------|---------------|
| `message_start` | `state.streamMessage = event.message` |
| `message_update` | `state.streamMessage = event.message` |
| `message_end` | `state.streamMessage = null`; append to `state.messages` |
| `tool_execution_start` | add `toolCallId` to `state.pendingToolCalls` |
| `tool_execution_end` | remove `toolCallId` from `state.pendingToolCalls` |
| `turn_end` | extract `errorMessage` from assistant message if present |
| `agent_end` | `state.isStreaming = false`; clear `streamMessage` |

Then fans out to all subscribers.

### Steering vs Follow-up Semantics

**Steering** (`agent.steer(msg)`):
- Added to internal `steeringQueue`
- Dequeued by `getSteeringMessages()` AFTER tool calls of the current turn finish, BEFORE the next LLM call
- Mode `"one-at-a-time"`: dequeues one message per check
- Mode `"all"`: dequeues entire queue at once

**Follow-up** (`agent.followUp(msg)`):
- Added to internal `followUpQueue`
- Dequeued by `getFollowUpMessages()` only when the inner loop has exhausted tool calls AND steering — i.e., when agent would otherwise stop
- Same `"one-at-a-time"` / `"all"` mode semantics
- Causes the outer loop to restart with the follow-up messages

---

## Low-Level Loop API (`src/agent-loop.ts`)

### `AgentEventSink`

```typescript
type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
```

### `agentLoop`

```typescript
function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>
```

Returns an `EventStream`. Iterate with `for await (const event of stream)`. Call `.result()` to get `AgentMessage[]` of all NEW messages added during the run (not the pre-existing context messages).

### `agentLoopContinue`

```typescript
function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]>
```

Same as `agentLoop` but without a new prompt. Validates:
- `context.messages.length > 0`
- Last message role is NOT `"assistant"`

Returns only new messages.

### `runAgentLoop` / `runAgentLoopContinue`

```typescript
async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]>

async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]>
```

Async imperative versions. The `emit` function is called synchronously (acts as a barrier) for state-mutation consumers like `Agent._processLoopEvent`.

### Inner Loop Algorithm (`runLoop`)

```
emit agent_start

pendingMessages = initial prompts

OUTER LOOP:
  INNER LOOP:
    if pendingMessages.length > 0:
      for each msg in pendingMessages:
        emit message_start(msg)
        context.messages.push(msg)
        emit message_end(msg)
      pendingMessages = []

    transformed = await transformContext(context.messages, signal)
    llmMessages = await convertToLlm(transformed)
    apiKey = await getApiKey(model.provider)

    emit turn_start

    assistantMsg = await streamAssistantResponse(
      model, { systemPrompt, messages: llmMessages, tools },
      { ...options, apiKey, signal, onPayload }
    )

    emit message_start(assistantMsg)
    // (message_update events fired during streaming)
    emit message_end(assistantMsg)

    if assistantMsg.stopReason === "error" | "aborted":
      emit turn_end(assistantMsg, [])
      emit agent_end(newMessages)
      return newMessages

    toolCalls = assistantMsg.content.filter(c => c.type === "toolCall")
    toolResults = await executeToolCalls(toolCalls, assistantMsg, context, config, signal, emit)

    for each result in toolResults:
      emit message_start(result)
      context.messages.push(result)
      emit message_end(result)

    emit turn_end(assistantMsg, toolResults)

    if toolCalls.length > 0:
      steeringMessages = await getSteeringMessages()
      pendingMessages = steeringMessages
      continue INNER LOOP

    // no tool calls — inner loop would stop
    pendingMessages = await getFollowUpMessages()
    if pendingMessages.length > 0:
      continue OUTER LOOP
    break OUTER LOOP

emit agent_end(newMessages)
return newMessages
```

### Tool Execution Pipeline

#### Parallel Mode (default)

```
Step 1 — Sequential validation for all tool calls:
  for each toolCall in batch:
    emit tool_execution_start(toolCallId, toolName, args)
    prepared = prepareToolCall(toolCall, context, signal)
    if prepared.immediate:
      immediateOutcomes.push(prepared.outcome)
    else:
      runnables.push(prepared)

Step 2 — Start all executable calls concurrently:
  promises = runnables.map(r => executePreparedToolCall(r, signal, onUpdate))

Step 3 — Collect results in SOURCE ORDER:
  for each (immediate | promise) in original order:
    result = immediate.outcome | await promise
    afterResult = await afterToolCall(context)  // may modify content/details/isError
    emit tool_execution_end(toolCallId, toolName, result, isError)
    toolResultMessages.push(createToolResultMessage(result))
```

#### Sequential Mode

```
for each toolCall in batch:
  emit tool_execution_start
  prepared = prepareToolCall(toolCall, context, signal)
  if prepared.immediate: use immediate outcome
  else: result = await executePreparedToolCall(prepared, signal, onUpdate)
  afterResult = await afterToolCall(context)
  emit tool_execution_end
  toolResultMessages.push(createToolResultMessage(result))
```

#### `prepareToolCall(toolCall, context, config, signal)`

```
1. Find tool by name in context.tools
   → NOT FOUND: return ImmediateOutcome { content: ["Tool not found: {name}"], isError: true }

2. validateToolArguments(tool, toolCall)
   → INVALID: return ImmediateOutcome { content: ["Invalid arguments: {errors}"], isError: true }

3. beforeToolCall(context) if configured
   → result.block === true: return ImmediateOutcome { content: [result.reason], isError: true }

4. return PreparedToolCall { tool, validatedArgs }
```

#### `executePreparedToolCall(prepared, signal, onUpdate)`

```
try:
  result = await tool.execute(toolCallId, validatedArgs, signal, onUpdate)
  return { result, isError: false }
catch err:
  return { result: createErrorToolResult(err.message), isError: true }
```

#### `createToolResultMessage(outcome, toolCall, toolName)`

```typescript
{
  role: "toolResult",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  content: outcome.content,
  details: outcome.details,
  isError: outcome.isError,
  timestamp: Date.now(),
}
```

---

## Error Handling

### LLM errors
After `streamAssistantResponse`, check `message.stopReason`:
- `"error"` or `"aborted"` → emit `turn_end` + `agent_end`, return immediately without processing tool calls

### Tool errors
- All exceptions from `tool.execute()` caught → `createErrorToolResult(message)` → `isError: true` tool result message sent to LLM
- Validation errors → immediate `isError: true` result without calling `execute()`

### Uncaught exceptions in `Agent._runLoop`
```
try { ... }
catch (err) {
  syntheticMessage = {
    role: "assistant",
    content: [],
    usage: { input: 0, output: 0, ... },
    stopReason: err instanceof AbortError ? "aborted" : "error",
    errorMessage: String(err),
    timestamp: Date.now(),
  }
  state.messages.push(syntheticMessage)
  state.error = String(err)
  emit({ type: "agent_end", messages: [syntheticMessage] })
}
```

### Abort

`agent.abort()` calls `abortController.abort()`. AbortSignal passed to:
- `streamFn` (provider cancels HTTP)
- `transformContext`
- `beforeToolCall` / `afterToolCall` hooks
- All tool `execute()` calls

---

## Proxy Support (`src/proxy.ts`)

### Purpose

Allows browser clients to route LLM calls through a backend server (avoiding CORS and keeping API keys server-side).

### `ProxyAssistantMessageEvent`

A bandwidth-optimized version of `AssistantMessageEvent` with the `partial` field stripped. The client reconstructs the partial message locally from deltas.

```typescript
type ProxyAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start";     contentIndex: number }
  | { type: "text_delta";     contentIndex: number; delta: string }
  | { type: "text_end";       contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end";   contentIndex: number; thinkingSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end";   contentIndex: number }
  | { type: "done";  reason: StopReason;   usage: Usage }
  | { type: "error"; reason: "aborted" | "error"; errorMessage?: string; usage: Usage };
```

### `ProxyStreamOptions`

```typescript
interface ProxyStreamOptions extends SimpleStreamOptions {
  authToken: string;
  proxyUrl: string;  // base URL of proxy server, e.g. "https://myapp.com"
}
```

### `streamProxy`

```typescript
function streamProxy(
  model: Model<Api>,
  context: Context,
  options: ProxyStreamOptions,
): AssistantMessageEventStream
```

**Implementation:**
1. POST `${proxyUrl}/api/stream` with body `{ model, context, options }` and header `Authorization: Bearer ${authToken}`
2. Read SSE lines (`data: {...}`)
3. Parse each as `ProxyAssistantMessageEvent`
4. Reconstruct full `AssistantMessage` incrementally via `processProxyEvent()`
5. Emit standard `AssistantMessageEvent` events (with reconstructed `partial`)
6. Wire abort: cancel `ReadableStream` reader on `signal` abort

**Usage pattern:**
```typescript
const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "my-token",
      proxyUrl: "https://my-backend.com",
    }),
});
```

### `processProxyEvent(event, partial)` Algorithm

Maintains a mutable `AssistantMessage` (`partial`):

```
"start":
  reset partial to empty AssistantMessage

"text_start" at contentIndex:
  partial.content[contentIndex] = { type: "text", text: "" }

"text_delta":
  partial.content[contentIndex].text += delta

"text_end":
  if contentSignature: partial.content[contentIndex].textSignature = contentSignature

"thinking_start" at contentIndex:
  partial.content[contentIndex] = { type: "thinking", thinking: "" }

"thinking_delta":
  partial.content[contentIndex].thinking += delta

"thinking_end":
  if thinkingSignature: partial.content[contentIndex].thinkingSignature = thinkingSignature

"toolcall_start":
  partial.content[contentIndex] = { type: "toolCall", id, name: toolName, arguments: {} }
  // arguments accumulated as raw JSON string delta

"toolcall_delta":
  accumulate raw JSON string at contentIndex

"toolcall_end":
  parse accumulated JSON → partial.content[contentIndex].arguments

"done":
  partial.stopReason = reason
  partial.usage = usage
  emit { type: "done", reason, message: partial }

"error":
  partial.stopReason = reason
  partial.errorMessage = errorMessage
  partial.usage = usage
  emit { type: "error", reason, error: partial }
```

---

## Integration with `@mariozechner/pi-ai`

### Imports used

| Symbol | Used for |
|--------|----------|
| `streamSimple` | Default `StreamFn` |
| `getModel` | Default model in `Agent` constructor |
| `validateToolArguments` | Tool call validation in `prepareToolCall` |
| `EventStream` | Base class for `ProxyMessageEventStream` |
| `parseStreamingJson` | Incremental tool call JSON parsing in proxy |
| `Model`, `Context`, `SimpleStreamOptions`, `Transport`, `ThinkingBudgets` | Types |
| `AssistantMessage`, `AssistantMessageEvent`, `Message`, `UserMessage`, `ToolResultMessage`, `ToolCall`, `TextContent`, `ImageContent`, `StopReason`, `Usage` | Message/content types |
| `Tool` | Base interface for `AgentTool` |

### Data flow boundary

`AgentMessage[]` (may contain custom types) → `convertToLlm()` → `Message[]` (LLM-compatible) → passed to `streamSimple()`. After the LLM call, the returned `AssistantMessage` (from `pi-ai`) is stored directly as an `AgentMessage`.
