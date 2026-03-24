# Data Flows — Specification

End-to-end traces of how data moves through piccolo at the system boundary. Internal implementation flows (session persistence, compaction, retry, extension dispatch) are specified in [core.md](core.md).

---

## 1. User Prompt → LLM → Response

```
User sends message via gateway (HTTP POST or Telegram update)
        │
        ▼
Gateway Worker
  - Authenticates user
  - Resolves sessionId (cookie / KV lookup)
  - session = await env.CORE.getSession(sessionId)
  - stream  = await session.prompt(text, attachments?)
        │
        ▼
IPiccoloCore.getSession() → ISession stub
ISession.prompt() → delegates to IAgentSessionDO.prompt()
        │
        ▼
IAgentSessionDO.prompt()  [see core.md — prompt() pipeline]
  1. Emit InputEvent  → ExtensionRunner  (may handle/transform)
  2. Build user message
  3. Emit BeforeAgentStartEvent → ExtensionRunner  (may inject context/system prompt)
  4. Assemble system prompt
  5. Check compaction threshold
  6. agent.prompt(messages) → begins streaming
        │
        ▼
streamText({ model: aigateway(unified(modelId)), system, messages, tools, ... })
  - Constructs request: POST /v1/{account}/{gateway}/compat/chat/completions
  - model format: "{provider}/{model-id}"
  - Streams SSE response via onChunk callback
        │
        ▼
CF AI Gateway
  - Routes to correct provider (Anthropic, OpenAI, Google, Groq, …)
  - Applies caching, rate limiting, logging, fallback
  - Normalises to OpenAI-compat SSE format
        │
        ▼
AgentEvents stream back up through IAgentSessionDO → ISession → gateway:
  - Web UI:  each AgentEvent pushed to IWebUiSessionDO → fan-out to SSE clients
  - Telegram: events buffered; throttled editMessageText to Telegram Bot API
```

---

## 2. AgentEvent Streaming Sequence

Events emitted by `piccolo-agent` during a single turn:

```
agent_start

  turn_start (stepNumber=0)
    text_delta  [0..N per step]
    reasoning_delta  [0..N, optional]
    tool_start  [0..N per step]
    tool_end    [0..N per step]
  turn_end (stepNumber=0, finishReason, usage)

  [turn_start / turn_end repeat for each tool-calling step]

agent_end (totalUsage)

  OR on error:
error (message)
```

Each `AgentEvent` is forwarded to:
1. The `ReadableStream` returned to the gateway
2. `ExtensionRunner` (fire-and-forget)
3. `IAgentSessionDO` internal handlers (persistence, retry, compaction)

---

## 3. Context Transformation (per LLM call)

```
IAgentSessionDO.messages  (ModelMessage[])
        │
        ▼
Step 1: ExtensionRunner.emitContext(messages)
        - Extensions may filter or inject messages
        - Last extension returning non-void messages wins
        → ModelMessage[]
        │
        ▼
Step 2: Filter non-LLM entries
        - Remove entries with custom roles not understood by the LLM
        - Convert "custom_message" display entries to user messages
        → ModelMessage[]
        │
        ▼
Step 3: CF AI Gateway normalisation (handled transparently by ai-gateway-provider)
        - Tool call ID format reconciliation per provider
        - Provider-specific thinking block handling
        → normalised ModelMessage[]  (OpenAI-compat)
```

---

## 4. Tool Execution Flow

```
LLM response contains tool call(s)
        │
        ▼
ai package (multi-step mode via stopWhen: stepCountIs(N))
  For each tool call in the step:
    │
    ├─ ExtensionRunner.emitToolCall(event)
    │   → ToolCallResult { block, reason }
    │   If block: inject tool-error result, skip execute()
    │
    ├─ Validate params against descriptor.inputSchema (Zod)
    │   → invalid: inject tool-error result, skip execute()
    │
    ├─ tool.execute(toolCallId, validatedParams, ctx, signal)
    │   → Called via JSRPC on the extension Worker
    │   → ToolResult { content, details }
    │   → on throw: ToolResult { isError: true, content: [error message] }
    │
    ├─ ExtensionRunner.emitToolResult(event)
    │   → ToolResultOverride (chained across extensions)
    │
    └─ Tool result appended to messages, persisted as MessageEntry
```

---

## Internal Flows

The following flows are fully specified in [core.md](core.md):

| Flow | Location in core.md |
|---|---|
| Session persistence (D1 flush, lazy creation) | [Persistence](#persistence) |
| Cold start / DO rehydration | [Cold start / rehydration](#cold-start--rehydration) |
| Context compaction (threshold + overflow) | [Context Compaction](#context-compaction----implementation) |
| Extension event dispatch and merge rules | [ExtensionRunner](#extensionrunner----implementation) |
| Auto-retry with exponential backoff | [Auto-Retry](#auto-retry----implementation) |
| Fork session | [Fork Session](#fork-session----implementation) |
