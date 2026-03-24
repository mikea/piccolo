# Data Flows — Specification

End-to-end traces of how data moves through the system. Covers: prompt → LLM → response, streaming event sequence, cross-provider message normalization, context transformation pipeline, compaction flow, and session persistence.

---

## 1. User Prompt → LLM → Response (Interactive Mode)

### Full Trace

```
User types in Editor component (pi-tui)
        │
        ▼
Editor.onSubmit(text)
        │
        ▼
InteractiveMode._handleSubmit(text, attachments)
        │
        ▼
AgentSession.prompt(text, images?)
        │  ┌─────────────────────────────────────────────────────────┐
        │  │  PROMPT PROCESSING PIPELINE                             │
        │  │  1. Check for extension command (/name)                 │
        │  │  2. Emit "input" event → extension runner               │
        │  │  3. Expand /skill:name                                  │
        │  │  4. Expand /templatename                                │
        │  │  5. If streaming: queue as steer/followUp; return       │
        │  │  6. Validate model + API key                            │
        │  │  7. Check compaction threshold                          │
        │  │  8. Build UserMessage                                   │
        │  │  9. Inject nextTurn custom messages                     │
        │  │  10. Emit "before_agent_start" → extensions             │
        │  └─────────────────────────────────────────────────────────┘
        │
        ▼
agent.prompt(userMessages)
        │  ┌─────────────────────────────────────────────────────────┐
        │  │  AGENT LOOP (packages/agent runLoop)                    │
        │  │  - transformContext(messages, signal)                   │
        │  │    → extension "context" event can filter/inject        │
        │  │  - convertToLlm(messages)                               │
        │  │    → filters custom message types                       │
        │  │    → converts AgentMessage[] → Message[]                │
        │  │  - getApiKey(provider)                                  │
        │  └─────────────────────────────────────────────────────────┘
        │
        ▼
streamSimple(model, { systemPrompt, messages, tools }, options)
        │  ┌─────────────────────────────────────────────────────────┐
        │  │  packages/ai stream.ts                                  │
        │  │  1. Determine which provider handles model.api          │
        │  │  2. Retrieve registered ApiProvider                     │
        │  │  3. buildBaseOptions(model, simpleOptions)              │
        │  │     → maps reasoning level to provider budget tokens    │
        │  │  4. Call onPayload hook (before_provider_request)       │
        │  │  5. Call provider.streamSimple(model, context, opts)    │
        │  └─────────────────────────────────────────────────────────┘
        │
        ▼
provider.streamSimple(model, context, opts)
        │  ┌─────────────────────────────────────────────────────────┐
        │  │  PROVIDER LAYER (e.g., anthropic.ts)                   │
        │  │  1. transform-messages.ts:                              │
        │  │     - normalizeToolCallIds()                            │
        │  │     - injectSyntheticToolResults() for orphaned calls   │
        │  │     - handle thinking blocks per provider rules         │
        │  │  2. Convert Message[] to provider format                │
        │  │     (e.g., Anthropic SDK messages array)                │
        │  │  3. Add cache_control headers                           │
        │  │  4. Add thinking/reasoning parameters                   │
        │  │  5. Call provider SDK streaming API                     │
        │  └─────────────────────────────────────────────────────────┘
        │
        ▼
AssistantMessageEventStream (async iterable)
        │
        ▼
STREAMING EVENTS flow through the system:
        │
        ├── { type: "start", partial: AssistantMessage }
        │         → agent emits: message_start
        │         → AgentSession._agentEventQueue.push(event)
        │         → InteractiveMode._handleAgentEvent
        │         → streamingContainer.setMessage(message, false)  [RAF-batched]
        │
        ├── { type: "text_delta", delta: "Hello", ... }
        │         → agent emits: message_update
        │         → partial.content[n].text += delta
        │         → streamingContainer.setMessage(message, false)
        │
        ├── { type: "thinking_delta", delta: "..." }
        │         → same path as text_delta
        │
        ├── { type: "toolcall_end", toolCall: {...} }
        │         → partial.content[n] = complete ToolCall
        │
        └── { type: "done", message: AssistantMessage }
                  → agent emits: message_end
                  → AgentSession: persist to SessionManager
                  → InteractiveMode: streamingContainer.setMessage(null, true)
                  → MessageList re-renders with completed message
                  → agent executes tool calls (if any)
```

---

## 2. Streaming Event Sequence (Complete)

### From Provider to Consumer

Every provider emits this exact sequence of `AssistantMessageEvent` types:

```
start
  text_start (contentIndex=0)
    text_delta (delta="...")   [repeated N times]
  text_end (contentIndex=0, content="full text")

  thinking_start (contentIndex=1)      [optional, if thinking enabled]
    thinking_delta (delta="...")
  thinking_end (contentIndex=1, content="full thinking")

  toolcall_start (contentIndex=2)      [optional, if tool use]
    toolcall_delta (delta='{"arg": "')  [partial JSON]
    toolcall_delta (delta='value"}')
  toolcall_end (contentIndex=2, toolCall={id,name,arguments:{...}})

  [additional text/thinking/toolcall blocks at increasing contentIndex]

done (reason="stop"|"length"|"toolUse", message=AssistantMessage)
  OR
error (reason="aborted"|"error", error=AssistantMessage)
```

### `partial` Field

Each event carries a `partial: AssistantMessage` that represents the current accumulated state. The `partial` is built up progressively:

```
After start:       partial.content = []
After text_start:  partial.content = [{ type: "text", text: "" }]
After text_delta:  partial.content = [{ type: "text", text: "Hel" }]
After text_delta:  partial.content = [{ type: "text", text: "Hello" }]
After text_end:    partial.content = [{ type: "text", text: "Hello" }]  (same, now complete)
After done:        partial === message  (final complete AssistantMessage)
```

---

## 3. Context Transformation Pipeline (per LLM call)

Before each call to `streamSimple()`, messages go through several transformation layers:

```
state.messages (AgentMessage[])
        │
        ▼
Step 1: transformContext(messages, signal)
        [in packages/agent AgentLoopConfig]
        - Optional: provided by AgentSession
        - Can prune messages, inject context
        - Emits "context" event to extension runner
        - Extensions can filter/transform message list
        - AgentSession uses this to:
          * Inject branch summary messages
          * Apply compaction results
        → returns modified AgentMessage[]
        │
        ▼
Step 2: convertToLlm(messages)
        [in packages/agent AgentLoopConfig]
        - Required: provided by AgentSession
        - Filters out custom message types (role: "custom", "notification", etc.)
        - Converts UserMessageWithAttachments → UserMessage (inline attachments)
        - Converts ArtifactMessage (web-ui) → skipped (client-only)
        - Converts custom_message entries → user messages
        → returns Message[] (only user/assistant/toolResult)
        │
        ▼
Step 3: buildLlmContext(messages)
        [in packages/ai transform-messages.ts]
        - normalizeToolCallIds():
          * Build stable ID map: originalId → normalizedId
          * Anthropic: max 64 chars, only [a-zA-Z0-9_-]
          * OpenAI Responses: must start with "fc_"
          * Apply normalization to ToolCall.id and ToolResultMessage.toolCallId
        - injectSyntheticToolResults():
          * Find ToolCall entries with no matching ToolResultMessage
          * Inject { role: "toolResult", content: [{ type: "text", text: "Tool result not available" }], isError: false }
        - handleThinkingBlocks():
          * Per compat settings: strip, convert to text, or pass through
          * Preserve thinkingSignature/textSignature for cross-provider replay
        → returns Message[] (provider-safe)
```

---

## 4. Tool Execution Data Flow

```
AssistantMessage.content contains ToolCall entries
        │
        ▼
executeToolCalls(toolCalls, assistantMessage, context, config, signal, emit)
        │
        ▼ [for each ToolCall, in parallel or sequential per config]
        │
        ├── emit tool_execution_start
        │
        ├── prepareToolCall(toolCall, context):
        │     1. Find tool by name in context.tools
        │        → not found: ImmediateOutcome { isError: true, content: ["Tool not found"] }
        │     2. validateToolArguments(tool, toolCall)  [AJV TypeBox validation]
        │        → invalid: ImmediateOutcome { isError: true, content: ["Invalid arguments"] }
        │     3. beforeToolCall(context, signal)  [hook]
        │        → block: ImmediateOutcome { isError: true, content: [reason] }
        │     4. return PreparedToolCall { tool, validatedArgs }
        │
        ├── tool.execute(toolCallId, validatedArgs, signal, onUpdate):
        │     - onUpdate calls: emit tool_execution_update
        │     → returns AgentToolResult { content, details }
        │     → on throw: createErrorToolResult(err.message)
        │
        ├── afterToolCall(context, signal)  [hook]
        │     - can replace content/details/isError
        │
        ├── emit tool_execution_end
        │
        └── create ToolResultMessage:
              {
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: result.content,      // sent to LLM
                details: result.details,       // UI/logging only
                isError: result.isError,
                timestamp: Date.now()
              }
              → append to context.messages
              → persist to SessionManager
```

---

## 5. Cross-Provider Message Normalization

When replaying a conversation history from provider A into provider B, these transformations apply:

### Thinking Blocks

| From | To | Transformation |
|------|-----|---------------|
| Anthropic | OpenAI | `type:"thinking"` → `type:"text"` (if `requiresThinkingAsText`) OR dropped |
| Anthropic | OpenAI Responses | signature preserved in reasoning item |
| Google | Anthropic | `thoughtSignature` → opaque field in assistant message |
| OpenAI Responses | Anthropic | encrypted reasoning content → dropped |
| Any | Any | `thinkingSignature` passed through as metadata |

### Tool Call IDs

Each provider has ID format requirements:

| Provider | Format requirement | Normalization |
|----------|------------------|---------------|
| Anthropic | `[a-zA-Z0-9_-]+`, max 64 chars | Strip invalid chars, truncate |
| OpenAI Responses | must start with `fc_` | Prefix with `fc_` if missing |
| Bedrock | alphanumeric | Strip special chars |
| Google | any string | Generate as `{name}_{timestamp}_{counter}` |
| Mistral | max 9 chars alphanumeric | `shortHash(originalId)` |

A stable mapping `originalId → normalizedId` is built per LLM call. This mapping is reversed when matching tool results to tool calls.

### Images in Tool Results

Not all providers accept images inside `ToolResultMessage.content`:

| Provider | Supports image in tool results | Workaround |
|----------|-------------------------------|-----------|
| OpenAI Completions | No | Synthetic user message after tool message |
| OpenAI Responses | Yes | Direct |
| Anthropic | Yes | Direct |
| Google | Yes | Direct (separate parts) |
| Bedrock | Yes | Direct |

---

## 6. Session Persistence Data Flow

### On Every Completed Message

```
agent emits message_end(message)
        │
        ▼
AgentSession._agentEventQueue processes:
        │
        ▼
sessionManager.appendMessage(message)
        │
        ▼ (if first flush)
Write header to JSONL file:
  { type: "session", id: uuid, timestamp: ISO, cwd: "/project" }
        │
        ▼ (always)
Append entry to JSONL file:
  { type: "message", id: hex8, parentId: prevId|null, timestamp: ISO, message: {...} }
```

### On Conversation Load (resuming session)

```
SessionManager.buildSessionContext(leafId?)
        │
        ▼
Walk tree from leafId to root:
  pathEntries = []
  current = entries.find(e => e.id === leafId)
  while current:
    pathEntries.push(current)
    current = entries.find(e => e.id === current.parentId)
  pathEntries.reverse()  // root first
        │
        ▼
Extract metadata from path:
  thinkingLevel = last thinkingLevelChange.level || "medium"
  model = last modelChange.model || last assistantMessage.provider/model
        │
        ▼
Build messages:
  if compaction entry exists in path:
    messages = [
      createCompactionSummaryMessage(compactionEntry.summary),
      ...kept entries from firstKeptEntryId to compactionEntry,
      ...entries after compactionEntry
    ]
  else:
    messages = all message entries in path

return SessionContext { messages, model, thinkingLevel }
```

---

## 7. Compaction Data Flow

```
Trigger: context threshold exceeded OR overflow error
        │
        ▼
AgentSession._checkCompaction():
        │
        ├── OVERFLOW path:
        │     Remove error assistant message from state
        │     compact() → then continue()
        │
        └── THRESHOLD path:
              compact() → no retry
        │
        ▼
compact(customInstructions?):
        │
        ▼ Emit "session_before_compact" to extensions
  └── if extension returns { cancel: true }: abort
  └── if extension returns { compaction: ... }: use provided summary
        │
        ▼
prepareCompaction(pathEntries, settings):
  Walk messages from END to START:
    keep last keepRecentTokens tokens' worth of messages
    everything before = messagesToSummarize

  return {
    messagesToSummarize: Message[],
    messagesToKeep: Message[],
    firstKeptEntryId: string
  }
        │
        ▼
serializeConversation(messagesToSummarize) → string
  Format:
    USER: <text>
    ASSISTANT: <text>
    TOOL CALL: <name>({args})
    TOOL RESULT: <content>
        │
        ▼
completeSimple(model, {
  systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
  messages: [{
    role: "user",
    content: serializedConversation + "\n\n" + customInstructions
  }]
}) → AssistantMessage
        │
        ▼
CompactionResult {
  summary: assistantMessage.content[0].text,
  firstKeptEntryId,
  tokensBefore
}
        │
        ▼
sessionManager.appendCompaction(result)
  → writes: { type: "compaction", id, parentId, summary, firstKeptEntryId, timestamp }
        │
        ▼
agent.replaceMessages(rebuiltMessages)
  rebuiltMessages = buildSessionContext().messages
  = [CompactionSummaryMessage, ...keptMessages]
        │
        ▼
AgentSession emits "session_compact" to extensions
```

---

## 8. Auto-Retry Data Flow

```
agent emits agent_end
        │
        ▼
AgentSession._checkRetry(assistantMessage):
        │
        ├── if stopReason !== "error": skip
        ├── if isContextOverflow(message): skip (handled by compaction)
        ├── if errorMessage matches retryPatterns: proceed
        │   patterns: /overloaded|rate.?limit|429|50[0-4]|service.?unavailable|timeout/i
        │
        ▼
Retry loop:
  attempt = 1
  while attempt <= maxRetries:
    delay = min(baseDelay * 2^(attempt-1), maxDelay)
    delay *= (0.8 + Math.random() * 0.4)  // ±20% jitter

    emit "auto_retry_start" event with { attempt, delay }
    sleep(delay, signal)

    lastMessage = state.messages[last]
    if lastMessage.role === "assistant" && lastMessage.stopReason === "error":
      agent.replaceMessages(state.messages.slice(0, -1))  // remove error message
    agent.continue()

    if agent stopped with success: break
    attempt++
```

---

## 9. Extension Event Dispatch Flow

```
AgentSession._emitExtensionEvent(agentEvent):
        │
        ▼
ExtensionRunner.emit(mappedExtensionEvent):
  For each loaded extension:
    For each handler registered for this event type:
      result = await handler(event, extensionContext)
      collect result
        │
        ▼
  Merge results:
    "tool_call" → { block, reason } from first non-undefined result
    "tool_result" → { content, details, isError } merged from all results
    "before_agent_start" → { message, systemPrompt } merged from all results
    "context" → { messages } from last result that returned messages
    "input" → { action, text } from first "handled" or "transform" result
    "session_before_compact" → { cancel, compaction } from first result
        │
        ▼
Return merged result to AgentSession
```

---

## 10. Web UI Streaming Architecture

```
Agent.subscribe(listener)
        │
        ▼ event: message_update { message: AssistantMessage (partial) }
        │
        ▼
AgentInterface receives event
        │
        ▼
StreamingMessageContainer.setMessage(message, false):
  if (pendingRaf === null):
    pendingRaf = requestAnimationFrame(() => {
      this._message = structuredClone(message)  // deep copy for immutability
      this.requestUpdate()
      pendingRaf = null
    })
  // else: RAF already queued, next tick will pick up latest message
        │
        ▼ (on RAF tick, ~16ms)
StreamingMessageContainer.render():
  Returns LitElement template with current _message
  → AssistantMessageComponent renders content blocks
  → ThinkingBlock (if thinking content)
  → ToolMessage (if tool calls in progress)
        │
        ▼ event: message_end { message: AssistantMessage (complete) }
        │
        ▼
AgentInterface receives event:
  streamingContainer.setMessage(null, true)  // immediate clear (synchronous)
  this.requestUpdate()  // re-render full interface
        │
        ▼
AgentInterface.render():
  MessageList re-renders with appended complete message
  StreamingMessageContainer renders empty state
```

**RAF batching purpose:** During fast streaming (token-per-token), events may arrive faster than the display can render (typically at 1-2 events per millisecond). RAF batching ensures we only re-render at display frame rate (~60fps), preventing UI lockup while maintaining visual smoothness.
