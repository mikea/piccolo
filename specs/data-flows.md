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
  - turn    = await session.prompt(text, attachments?)
  - stream  = await turn.getStream()
        │
        ▼
IPiccoloCore.getSession() → ISession stub
ISession.prompt() → delegates to AgentSessionDO.prompt()
        │
        ▼
AgentSessionDO.prompt()  [see core.md — prompt() pipeline]
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
AgentEvents stream back up through AgentSessionDO → gateway:
  - Web UI:  ReadableStream<AgentEvent> consumed directly by the browser over the WebSocket RPC connection
  - Telegram: events buffered; throttled editMessageText to Telegram Bot API
```

---

## 2. AgentEvent Streaming Sequence

Events emitted by `piccolo-agent` during a single turn:

```
start

  step-start (stepNumber=0)
    text-delta  [0..N per step]
    reasoning-delta  [0..N, optional]
    tool-call  [0..N per step]
    tool-result    [0..N per step]
  step-finish (stepNumber=0, finishReason, usage)

  [step-start / step-finish repeat for each tool-calling step]

finish (totalUsage)

  OR on error:
error (message)
```

Each `AgentEvent` is forwarded to:
1. The `ReadableStream` returned to the gateway
2. `ExtensionRunner` (fire-and-forget)
3. `AgentSessionDO` internal handlers (persistence, retry, compaction)

---

## 3. Context Transformation (per LLM call)

```
AgentSessionDO internal message state  (ModelMessage[])
        │
        ▼
Step 1: ExtensionRunner.emitContext(messages)
        - Extensions may filter or inject messages
        - Last extension returning non-void messages wins
        → ModelMessage[]
        │
        ▼
Step 2: Filter non-LLM entries
        - Keep only persisted IMessage entries from D1 context reconstruction
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
    ├─ Validate params against descriptor.inputSchema (JSON Schema)
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
