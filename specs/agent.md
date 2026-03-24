# `piccolo-agent` — Specification

## Purpose

Agent runtime layer. Orchestrates multi-turn, tool-calling conversations using the `ai` and `ai-gateway-provider` packages, routing all LLM calls through the **Cloudflare AI Gateway** unified API. Manages conversation state, tool execution, steering/follow-up queues, and abort handling.

Runs inside Cloudflare Workers / Durable Objects. No Node.js dependencies.

---

## LLM Backend: Cloudflare AI Gateway

piccolo-agent does **not** implement its own provider layer. All LLM calls go through the Cloudflare AI Gateway unified `/compat/chat/completions` endpoint using the `ai-gateway-provider` and `ai` packages.

### Gateway endpoint

```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat
```

### Model format

Models are addressed as `{provider}/{model-id}`, e.g.:
- `anthropic/claude-sonnet-4-5`
- `openai/gpt-4o`
- `google/gemini-2.5-pro`
- `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`

### Setup

```typescript
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { streamText, generateText, tool } from "ai";
import { z } from "zod";

// Constructed once per Worker instance from env bindings
function createGateway(env: Env) {
  return createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AI_GATEWAY_NAME,
    apiKey: env.CF_AI_GATEWAY_TOKEN,
  });
}

const unified = createUnified();
```

### Performing a streaming call

```typescript
const result = streamText({
  model: aigateway(unified("anthropic/claude-sonnet-4-5")),
  system: systemPrompt,
  messages,          // ModelMessage[] from AI SDK
  tools,             // Record<string, Tool> from AI SDK
  stopWhen: stepCountIs(maxSteps),
  abortSignal: signal,
  onStepFinish({ stepNumber, toolCalls, toolResults, finishReason, usage }) {
    // persist step to session storage
  },
  onFinish({ text, finishReason, totalUsage, response }) {
    // final persistence
  },
});
```

All provider differences (Anthropic thinking blocks, OpenAI reasoning, Google grounding, etc.) are handled by the AI Gateway — piccolo-agent receives a standard OpenAI-compatible streaming response regardless of which underlying provider is used.

---

## Key Concepts from `ai` + `ai-gateway-provider`

### `ModelMessage`

The message type from the `ai` package. Replaces piccolo's custom `Message` union:

```typescript
import type { ModelMessage } from "ai";

// Variants used in piccolo:
// { role: "user";      content: string | UserContent[] }
// { role: "assistant"; content: AssistantContent[] }
// { role: "tool";      content: ToolResultPart[] }
// { role: "system";    content: string }
```

### `Tool` (from `ai` package)

```typescript
import { tool } from "ai";
import { z } from "zod";

const myTool = tool({
  description: "...",
  inputSchema: z.object({ ... }),
  execute: async (input, { toolCallId, abortSignal }) => {
    return { result: "..." };
  },
});
```

Tools are defined using **Zod schemas** (not TypeBox). The AI SDK validates inputs automatically.

### `streamText` / `generateText`

Primary entry points from the `ai` package. `streamText` is used for all agent turns. `generateText` is used for compaction (single non-streaming call).

Multi-step tool calling is handled natively via `stopWhen: stepCountIs(N)` — no manual loop needed for the basic case.

---

## `ITool` Interface

`ITool` is defined in [api.md — Shared Types](api.md). It wraps the `tool()` helper from `ai` to add piccolo-specific metadata (`label`, `promptSnippet`, `promptGuidelines`).

`ITool` instances are converted to the `ToolSet` format (from `ai`) before each `streamText` call:

```typescript
function toAiSdkTools(tools: ITool[]): Record<string, Tool> {
  return Object.fromEntries(
    tools.map(t => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.inputSchema,
        execute: (input, opts) => t.execute(input, opts),
      }),
    ])
  );
}
```

---

## `AgentEvent`

`AgentEvent` is defined in [api.md — Shared Types](api.md). Events map directly onto `streamText`'s `onChunk`, `onStepFinish`, `onFinish`, and `onError` callbacks.

---

## `Agent` Class

### Constructor

```typescript
interface AgentOptions {
  gateway: ReturnType<typeof createAiGateway>;
  modelId: string;          // e.g. "anthropic/claude-sonnet-4-5"
  systemPrompt: string;
  tools?: ITool[];
  maxSteps?: number;        // default: 20
  steeringMode?: "one-at-a-time" | "all";
  followUpMode?: "one-at-a-time" | "all";
}

class Agent {
  constructor(options: AgentOptions);
}
```

### State

```typescript
interface AgentState {
  modelId: string;
  systemPrompt: string;
  tools: ITool[];         // see api.md Shared Types
  messages: ModelMessage[];   // from `ai` package
  isStreaming: boolean;
  error?: string;
}
```

`messages` is the canonical conversation history passed to and returned from `streamText` (via `response.messages`), persisted to storage after each turn.

### Public Methods

```typescript
class Agent {
  readonly state: AgentState;

  // Start a new turn with user input
  async prompt(text: string, images?: ImagePart[]): Promise<void>;
  async prompt(messages: ModelMessage[]): Promise<void>;

  // Resume after compaction / retry without new user input
  async continue(): Promise<void>;

  // Abort the current streaming turn
  abort(): void;

  // Inject a message mid-turn (after next tool batch, before next LLM call)
  steer(message: ModelMessage): void;

  // Inject a message when the loop would otherwise stop
  followUp(message: ModelMessage): void;

  clearSteering(): ModelMessage[];
  clearFollowUp(): ModelMessage[];

  // Synchronous state mutations
  setModel(modelId: string): void;
  setTools(tools: ITool[]): void;
  setSystemPrompt(prompt: string): void;
  appendMessages(messages: ModelMessage[]): void;
  replaceMessages(messages: ModelMessage[]): void;

  // Subscribe to agent events; returns unsubscribe fn
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

### `prompt()` Implementation

```typescript
async prompt(input: string | ModelMessage[], images?: ImagePart[]) {
  // 1. Build user message(s) and append to this.state.messages
  // 2. Build AI SDK tool set from this.state.tools
  // 3. Check for steering / follow-up messages to prepend
  // 4. Call streamText:

  const result = streamText({
    model: this.gateway(unified(this.state.modelId)),
    system: this.state.systemPrompt,
    messages: this.state.messages,
    tools: toAiSdkTools(this.state.tools),
    stopWhen: stepCountIs(this.maxSteps),
    abortSignal: this.abortController.signal,

    onChunk: ({ chunk }) => {
      if (chunk.type === "text-delta")       this._emit({ type: "text_delta", delta: chunk.text });
      if (chunk.type === "reasoning-delta")  this._emit({ type: "reasoning_delta", delta: chunk.text });
      if (chunk.type === "tool-call")        this._emit({ type: "tool_start", toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.input });
      if (chunk.type === "tool-result")      this._emit({ type: "tool_end", toolCallId: chunk.toolCallId, toolName: chunk.toolName, output: chunk.output, isError: false });
    },

    onStepFinish: ({ stepNumber, finishReason, usage }) => {
      this._emit({ type: "turn_end", stepNumber, finishReason, usage });
    },

    onFinish: ({ totalUsage, response }) => {
      // Append all response messages to state (AI SDK returns full updated history)
      this.state.messages.push(...response.messages);
      this._emit({ type: "agent_end", totalUsage });
    },

    onError: ({ error }) => {
      this._emit({ type: "error", message: String(error) });
    },
  });

  // Consume stream to drive execution
  await result.consumeStream();
}
```

### Steering vs Follow-up Semantics

piccolo-agent implements steering and follow-up on top of the AI SDK's `prepareStep` callback:

```typescript
prepareStep: async ({ stepNumber, messages }) => {
  // After a tool-use step, dequeue steering messages
  if (stepNumber > 0 && this._steeringQueue.length > 0) {
    const steering = this._dequeueSteer();
    return { messages: [...messages, ...steering] };
  }
  return {};
},
```

Follow-up is handled by calling `agent.continue()` (which calls `streamText` again with the follow-up messages appended) after `onFinish` fires and the follow-up queue is non-empty.

---

## Compaction

Context compaction uses `generateText` (non-streaming) with the same gateway and model:

```typescript
async function compact(
  messages: ModelMessage[],
  keepRecentTokens: number,
  gateway: ReturnType<typeof createAiGateway>,
  modelId: string,
): Promise<{ summary: string; keptMessages: ModelMessage[] }> {
  // 1. Split messages: summarize early ones, keep recent ones
  const { toSummarize, toKeep } = splitForCompaction(messages, keepRecentTokens);

  // 2. Serialize messages to compact text
  const conversationText = serializeConversation(toSummarize);

  // 3. Call LLM for summary
  const { text: summary } = await generateText({
    model: gateway(unified(modelId)),
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: conversationText }],
  });

  return { summary, keptMessages: toKeep };
}
```

---

## Error Handling

- **LLM errors** — surface via `onError` callback → emit `{ type: "error" }` event; the DO handles retry logic.
- **Tool errors** — the `ai` package catches tool `execute()` exceptions and adds `tool-error` parts to the step, which are sent back to the LLM in the next step automatically (multi-step mode). Extension hooks (`onToolCall` / `onToolResult`) can override this.
- **Context overflow** — detected by checking `finishReason === "length"` or provider error patterns; triggers compaction in the DO.
- **Abort** — `agent.abort()` calls `abortController.abort()`; the AI SDK propagates the signal to the gateway fetch and to all tool `execute()` calls.

---

## Supported Providers (via AI Gateway)

All providers accessible through the CF AI Gateway unified endpoint:

| Provider prefix | Examples |
|---|---|
| `anthropic/` | `claude-opus-4-5`, `claude-sonnet-4-5` |
| `openai/` | `gpt-4o`, `gpt-4o-mini` |
| `google/` | `gemini-2.5-pro`, `gemini-2.5-flash` |
| `groq/` | `llama-3.3-70b-versatile` |
| `mistral/` | `mistral-large-latest` |
| `workers-ai/` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `grok/` | `grok-4` |
| `deepseek/` | `deepseek-chat` |
| `cerebras/` | `llama3.1-70b` |

Model selection (which provider/model to use for a session) is stored in the session record in D1 and managed by `piccolo-core`. `piccolo-agent` receives a `modelId` string and passes it straight to the gateway — it has no model catalog of its own.
