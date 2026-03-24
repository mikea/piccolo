# `piccolo-agent` — Specification

## Purpose

Agent runtime layer. Orchestrates multi-turn, tool-calling conversations using the `ai` and `ai-gateway-provider` packages, routing all LLM calls through the **Cloudflare AI Gateway** unified API. Manages conversation state, tool execution, steering/follow-up queues, and abort handling.

Runs inside Cloudflare Workers / Durable Objects. No Node.js dependencies.

**Genericity principle:** `packages/agent` knows nothing about gateways, sessions, or extensions. It exposes only what the LLM loop itself needs: tool registration (`AgentToolDescriptor` / `IAgentTool`), event emission (`AgentEvent`), and conversation state (`AgentState`). All piccolo-core-specific types (`ToolDescriptor` with label/snippets, `ITool` with `getGatewayUI`, gateway IDs) are defined in `packages/core`. Gateway construction (`createAiGateway`, `ai-gateway-provider`) is a `piccolo-core` concern — `packages/agent` has no dependency on `ai-gateway-provider`.

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
// In piccolo-core (not in packages/agent):
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";

const gateway = createAiGateway({ accountId, gateway, apiKey });
const model = gateway(createUnified()("anthropic/claude-sonnet-4-5"));

// Then pass to the Agent — which has no knowledge of how the model was built:
import { Agent } from "@piccolo/agent";
const agent = new Agent({ model, systemPrompt, tools });
```

### Performing a streaming call

```typescript
const result = streamText({
  model,             // LanguageModel from createModel() or MockLanguageModelV3 in tests
  system: systemPrompt,
  messages,          // ModelMessage[] from AI SDK
  tools,             // ToolSet from AI SDK (built by toAiSdkTools())
  stopWhen: stepCountIs(maxSteps),
  abortSignal: signal,
  onStepFinish({ stepNumber, toolCalls, toolResults, finishReason, usage }) {
    // persist step to session storage
  },
  onFinish({ totalUsage, response }) {
    // final persistence — response.messages contains the full updated history
  },
});
await result.consumeStream();
```

All provider differences (Anthropic thinking blocks, OpenAI reasoning, Google grounding, etc.) are handled by the AI Gateway — piccolo-agent receives a standard OpenAI-compatible streaming response regardless of which underlying provider is used.

---

## ai v6 API Notes

This implementation targets `ai` v6.x. Key differences from v5:

### `onChunk` callback type (v6)

The `onChunk` callback in v6 only fires for a subset of stream parts:
`'text-delta' | 'reasoning-delta' | 'source' | 'tool-call' | 'tool-input-start' | 'tool-input-delta' | 'tool-result' | 'raw'`.

**Tool errors (`tool-error`)** do NOT appear in `onChunk`. They appear in `onStepFinish`'s `content` array as parts with `type === "tool-error"`. The `Agent._runStream()` method reads `content` in `onStepFinish` to detect and emit `tool_end` events with `isError: true`.

### `LanguageModelUsage` fields (v6)

Field names changed from v5:
- `inputTokens` (was `promptTokens`)
- `outputTokens` (was `completionTokens`)
- `totalTokens`

### `prepareStep` (v6)

`experimental_prepareStep` was promoted to stable `prepareStep`. The steering queue implementation uses this callback.

### `stopWhen: stepCountIs(N)` (v6)

This API is unchanged and available in v6. `generateText` defaults to `stopWhen: stepCountIs(1)`.

### `onFinish` shape (v6)

`onFinish` receives `OnFinishEvent<TOOLS>` which extends `StepResult<TOOLS>`. Access response messages via `event.response.messages`. Access total usage via `event.totalUsage`.

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

## `IAgentTool` Interface

The minimal tool interface used by `packages/agent`. Contains only what the agent loop needs: a descriptor for LLM registration and an `execute` method.

**NOT included at this layer:** `label`, `promptSnippet`, `promptGuidelines` (system-prompt concerns), `getGatewayUI` (gateway rendering concern). Those are added by `packages/core`'s `ITool` which extends `IAgentTool`.

```typescript
// packages/agent/src/types.ts
interface AgentToolDescriptor {
  name: string;         // snake_case, LLM-facing
  description: string;  // full description sent to LLM
  inputSchema: ZodObject<any>;
}

interface IAgentTool {
  readonly descriptor: AgentToolDescriptor;
  execute(
    toolCallId: string,
    params: unknown,
    ctx: unknown,         // IExtensionContext — opaque at this layer
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

interface AgentToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}
```

`IAgentTool` instances are converted to the `ToolSet` format (from `ai`) before each `streamText` call:

```typescript
// packages/agent/src/tools.ts
function toAiSdkTools(tools: IAgentTool[]): ToolSet {
  return Object.fromEntries(
    tools.map(t => [
      t.descriptor.name,
      tool({
        description: t.descriptor.description,
        inputSchema: t.descriptor.inputSchema,
        execute: async (input, { toolCallId, abortSignal }) =>
          t.execute(toolCallId, input, undefined, abortSignal),
      }),
    ])
  );
}
```

Note: `ctx` is passed as `undefined` here. `piccolo-core` wraps tools in a closure that injects the real `IExtensionContext` before passing them to the `Agent`.

---

## `AgentEvent`

`AgentEvent` is defined in `packages/agent/src/types.ts` and re-exported from `packages/core/src/types.ts`. Events map directly onto `streamText`'s `onChunk`, `onStepFinish`, `onFinish`, and `onError` callbacks.

```typescript
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
```

Note: `turn_start` is emitted in the `prepareStep` callback, not from a direct stream event. `tool_end` with `isError: true` is emitted from `onStepFinish` content (not `onChunk`) due to ai v6 API constraints.

---

## `Agent` Class

### Constructor

```typescript
interface AgentOptions {
  model: LanguageModel;   // from ai package — createModel(env, modelId) or MockLanguageModelV3
  systemPrompt: string;
  tools?: IAgentTool[];
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
  model: LanguageModel;   // current model — replaced by setModel()
  systemPrompt: string;
  tools: IAgentTool[];
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
  setModel(model: LanguageModel): void;
  setTools(tools: IAgentTool[]): void;
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
  // 2. Call _runStream()
}

private async _runStream() {
  // 1. Create AbortController, set isStreaming = true, emit agent_start
  // 2. Build AI SDK tool set from this.state.tools via toAiSdkTools()
  // 3. Call streamText:

  const result = streamText({
    model: this._state.model,
    system: this.state.systemPrompt,
    messages: this.state.messages,
    tools: toolSet,
    stopWhen: stepCountIs(this._maxSteps),
    abortSignal: this._abortController.signal,

    prepareStep: ({ stepNumber, messages }) => {
      // After step 0, inject pending steering messages
      if (stepNumber > 0 && this._steeringQueue.length > 0) {
        const steering = this._dequeueSteer();
        return { messages: [...messages, ...steering] };
      }
      return undefined;
    },

    onChunk: ({ chunk }) => {
      if (chunk.type === "text-delta")    this._emit({ type: "text_delta", delta: chunk.text });
      if (chunk.type === "reasoning-delta") this._emit({ type: "reasoning_delta", delta: chunk.text });
      if (chunk.type === "tool-call")     this._emit({ type: "tool_start", ... });
      if (chunk.type === "tool-result")   this._emit({ type: "tool_end", isError: false, ... });
      // NOTE: tool-error is NOT in onChunk (ai v6) — handled in onStepFinish
    },

    onStepFinish: ({ stepNumber, finishReason, usage, content }) => {
      // Emit tool_end for tool errors (not available in onChunk in ai v6)
      for (const part of content) {
        if (part.type === "tool-error") {
          this._emit({ type: "tool_end", isError: true, ... });
        }
      }
      this._emit({ type: "turn_end", stepNumber, finishReason, usage });
    },

    onFinish: ({ totalUsage, response }) => {
      // Append response messages to state history
      this.state.messages.push(...response.messages);
      finalUsage = totalUsage;
    },

    onError: ({ error }) => {
      this._emit({ type: "error", message: ... });
    },

    onAbort: () => { aborted = true; },
  });

  await result.consumeStream();

  // 4. Emit agent_end (unless aborted)
  // 5. If follow-up queue non-empty and not aborted: call continue()
}
```

### Steering vs Follow-up Semantics

**Steering** uses `prepareStep` to inject messages mid-turn:

```typescript
prepareStep: ({ stepNumber, messages }) => {
  if (stepNumber > 0 && this._steeringQueue.length > 0) {
    const steering = this._dequeueSteer();
    return { messages: [...messages, ...steering] };
  }
  return undefined;
},
```

**Follow-up** is handled by calling `agent.continue()` (which calls `_runStream()` again with the follow-up messages appended) after `onFinish` fires and the follow-up queue is non-empty.

---

## Compaction

Context compaction uses `generateText` (non-streaming) with the same gateway and model:

```typescript
async function agentCompact(
  messages: ModelMessage[],
  keepRecentTokens: number,
  model: LanguageModel,   // same model as the Agent uses — no separate gateway needed
): Promise<{ summary: string; keptMessages: ModelMessage[] }> {
  // 1. Split messages: summarize early ones, keep recent ones
  const { toSummarize, toKeep } = splitForCompaction(messages, keepRecentTokens);

  // 2. If nothing to summarize, return immediately
  if (toSummarize.length === 0) return { summary: "", keptMessages: toKeep };

  // 3. Serialize messages to compact text
  const conversationText = serializeConversation(toSummarize);

  // 4. Call LLM for summary (non-streaming)
  const { text: summary } = await generateText({
    model,   // same LanguageModel as the Agent
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: conversationText }],
  });

  return { summary, keptMessages: toKeep };
}
```

Token estimation uses a heuristic of 4 characters per token. At least one message is always kept.

---

## Error Handling

- **LLM errors** — surface via `onError` callback → emit `{ type: "error" }` event; the DO handles retry logic.
- **Tool errors** — in ai v6, tool errors appear as `"tool-error"` parts in `onStepFinish`'s `content` array (NOT in `onChunk`). The agent emits `tool_end` with `isError: true`.
- **Context overflow** — detected by `finishReason === "length"`; triggers compaction in the DO.
- **Abort** — `agent.abort()` calls `abortController.abort()`; the AI SDK propagates the signal to the gateway fetch and to all tool `execute()` calls. `agent_end` is NOT emitted after abort.

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
