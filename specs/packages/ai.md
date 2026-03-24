# `@mariozechner/pi-ai` — Specification

**Package:** `packages/ai/`  
**npm name:** `@mariozechner/pi-ai`  
**Version:** lockstep with monorepo  
**Runtime:** Node.js ≥ 20, ESM only  

---

## Purpose

Unified multi-provider LLM streaming API. Normalizes 10+ LLM provider SDKs into a single streaming event protocol. Consumers call `stream()` or `streamSimple()` and receive an async-iterable `AssistantMessageEventStream` regardless of which provider is used.

---

## Directory Structure

```
src/
├── index.ts                   # Root barrel — all public exports
├── types.ts                   # ALL core domain types
├── api-registry.ts            # In-memory provider registry
├── stream.ts                  # Public streaming entry-points
├── models.ts                  # Model registry helpers + cost calculation
├── models.generated.ts        # Auto-generated model catalog (~14,000 lines)
├── env-api-keys.ts            # Provider→env-var resolution
├── oauth.ts                   # Re-export barrel for OAuth utilities
├── cli.ts                     # Thin CLI binary entry point
├── bedrock-provider.ts        # Side-loadable Bedrock module
├── providers/
│   ├── register-builtins.ts        # Lazy-loads all built-in providers
│   ├── simple-options.ts           # buildBaseOptions, clampReasoning
│   ├── transform-messages.ts       # Cross-provider message normalization
│   ├── github-copilot-headers.ts   # Copilot-specific header helpers
│   ├── anthropic.ts                # "anthropic-messages" provider
│   ├── openai-completions.ts       # "openai-completions" provider
│   ├── openai-responses.ts         # "openai-responses" provider
│   ├── openai-responses-shared.ts  # Shared Responses API processing
│   ├── openai-codex-responses.ts   # "openai-codex-responses" provider
│   ├── azure-openai-responses.ts   # "azure-openai-responses" provider
│   ├── google.ts                   # "google-generative-ai" provider
│   ├── google-shared.ts            # Shared Google conversion helpers
│   ├── google-gemini-cli.ts        # "google-gemini-cli" provider
│   ├── google-vertex.ts            # "google-vertex" provider
│   ├── amazon-bedrock.ts           # "bedrock-converse-stream" provider
│   └── mistral.ts                  # "mistral-conversations" provider
└── utils/
    ├── event-stream.ts             # EventStream<T,R> base class
    ├── json-parse.ts               # parseStreamingJson (tolerant partial JSON)
    ├── sanitize-unicode.ts         # sanitizeSurrogates
    ├── overflow.ts                 # isContextOverflow, getOverflowPatterns
    ├── validation.ts               # validateToolCall, validateToolArguments (AJV)
    ├── typebox-helpers.ts          # StringEnum helper
    ├── hash.ts                     # shortHash
    └── oauth/
        ├── types.ts                # OAuth types
        ├── index.ts                # OAuth registry
        ├── anthropic.ts            # Anthropic OAuth
        ├── github-copilot.ts       # GitHub Copilot OAuth
        ├── google-gemini-cli.ts    # Google Cloud Code Assist OAuth
        ├── google-antigravity.ts   # Antigravity OAuth
        ├── openai-codex.ts         # OpenAI Codex OAuth
        ├── oauth-page.ts           # Local HTTP callback server (PKCE)
        └── pkce.ts                 # PKCE helpers
```

---

## Core Types (`src/types.ts`)

### API Identifiers

```typescript
type KnownApi =
  | "openai-completions"
  | "mistral-conversations"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-gemini-cli"
  | "google-vertex";

// Extensible: allows custom string API IDs while preserving autocomplete
type Api = KnownApi | (string & {});
```

### Provider Names

```typescript
type KnownProvider =
  | "amazon-bedrock" | "anthropic" | "google" | "google-gemini-cli"
  | "google-antigravity" | "google-vertex" | "openai" | "azure-openai-responses"
  | "openai-codex" | "github-copilot" | "xai" | "groq" | "cerebras"
  | "openrouter" | "vercel-ai-gateway" | "zai" | "mistral" | "minimax"
  | "minimax-cn" | "huggingface" | "opencode" | "opencode-go" | "kimi-coding";

type Provider = KnownProvider | string;
```

### Thinking/Reasoning

```typescript
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}
```

### Stream Options

```typescript
type CacheRetention = "none" | "short" | "long";
type Transport = "sse" | "websocket" | "auto";

interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
  headers?: Record<string, string>;
  maxRetryDelayMs?: number;   // default 60000; 0 = disable cap
  metadata?: Record<string, unknown>;
}

interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

// Provider-specific options extend StreamOptions and add provider-specific fields
type ProviderStreamOptions = StreamOptions & Record<string, unknown>;
```

### Content Types

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;  // Google thought signatures
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;  // opaque provider token for replay
  redacted?: boolean;          // Anthropic redacted thinking
}

interface ImageContent {
  type: "image";
  data: string;    // base64-encoded image data
  mimeType: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;  // Google: opaque replay token
}
```

### Message Types

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix milliseconds
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseId?: string;   // provider-specific response ID for caching
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

### Usage and Costs

```typescript
interface Usage {
  input: number;       // fresh input tokens (cached tokens subtracted)
  output: number;      // output tokens (includes reasoning tokens)
  cacheRead: number;   // tokens served from prompt cache
  cacheWrite: number;  // tokens written to prompt cache
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### Tools

```typescript
// Uses TypeBox for schema definition
import type { TSchema } from "@sinclair/typebox";

interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

### Model

```typescript
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };  // cost in USD per million tokens
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
         : TApi extends "openai-responses"   ? OpenAIResponsesCompat
         : never;
}
```

### OpenAI Completions Compatibility

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortMap?: Record<string, string>;  // ThinkingLevel -> provider string
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  openRouterRouting?: Record<string, unknown>;
  vercelGatewayRouting?: Record<string, unknown>;
  supportsStrictMode?: boolean;
}
```

### Streaming Event Types

```typescript
type AssistantMessageEvent =
  | { type: "start";          partial: AssistantMessage }
  | { type: "text_start";     contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta";     contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end";       contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end";   contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end";   contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done";  reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error";           error: AssistantMessage };
```

---

## Public API (`src/index.ts`)

### Streaming Functions

```typescript
// Full provider-specific options
function stream(model: Model<Api>, context: Context, options?: ProviderStreamOptions): AssistantMessageEventStream;
function complete(model: Model<Api>, context: Context, options?: ProviderStreamOptions): Promise<AssistantMessage>;

// Simplified: reasoning level + common options only
function streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
function completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
```

### Model Registry

```typescript
function getModel<TProvider extends KnownProvider, TModelId extends string>(
  provider: TProvider,
  modelId: TModelId
): Model<ApiForProviderModel<TProvider, TModelId>>;

function getProviders(): KnownProvider[];
function getModels(provider: KnownProvider): Model<Api>[];
function calculateCost(model: Model<Api>, usage: Usage): Usage["cost"];
function supportsXhigh(model: Model<Api>): boolean;  // true for GPT-5.2+, Opus-4.6+
function modelsAreEqual(a: Model<Api>, b: Model<Api>): boolean;  // compares id + provider
```

### Provider Registry

```typescript
interface ApiProvider<TApi extends Api, TOptions extends StreamOptions> {
  api: TApi;
  stream: (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
  streamSimple: (model: Model<TApi>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}

function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>,
  sourceId?: string
): void;

function getApiProvider(api: Api): ApiProvider<Api, StreamOptions> | undefined;
function getApiProviders(): ApiProvider<Api, StreamOptions>[];
function unregisterApiProviders(sourceId: string): void;
function clearApiProviders(): void;
```

### Built-in Provider Registration

```typescript
function registerBuiltInApiProviders(): void;  // registers all 10 providers
function resetApiProviders(): void;            // clear + re-register builtins
function setBedrockProviderModule(module: BedrockProviderModule): void;  // side-load Bedrock
```

### API Key Resolution

```typescript
function getEnvApiKey(provider: KnownProvider | string): string | undefined;
```

**Environment variable mapping:**

| Provider | Environment Variable(s) |
|----------|------------------------|
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `google-gemini-cli` | OAuth credentials (not from `getEnvApiKey`) |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY`, or `<authenticated>` when ADC file + `GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` are present |
| `amazon-bedrock` | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (or profile/IRSA) |
| `groq` | `GROQ_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `minimax-cn` | `MINIMAX_CN_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `opencode` / `opencode-go` | `OPENCODE_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN` |

### Validation

```typescript
function validateToolCall(tools: Tool[], toolCall: ToolCall): { valid: boolean; errors?: string[] };
function validateToolArguments(tool: Tool, toolCall: ToolCall): { valid: boolean; errors?: string[] };
```

### Utilities

```typescript
function parseStreamingJson<T>(partialJson: string): T | undefined;
function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean;
function getOverflowPatterns(): RegExp[];

// TypeBox helper
function StringEnum<T extends string[]>(values: [...T], options?: SchemaOptions): TStringEnum<T>;
```

### EventStream

```typescript
class EventStream<T, R> {
  push(event: T): void;
  end(result?: R): void;
  result(): Promise<R>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  // Same as EventStream but typed specifically
}

function createAssistantMessageEventStream(): AssistantMessageEventStream;
```

---

## Package.json Subpath Exports

```
"."                          → dist/index.js         (all core APIs)
"./anthropic"                → dist/providers/anthropic.js
"./azure-openai-responses"   → dist/providers/azure-openai-responses.js
"./google"                   → dist/providers/google.js
"./google-gemini-cli"        → dist/providers/google-gemini-cli.js
"./google-vertex"            → dist/providers/google-vertex.js
"./mistral"                  → dist/providers/mistral.js
"./openai-codex-responses"   → dist/providers/openai-codex-responses.js
"./openai-completions"       → dist/providers/openai-completions.js
"./openai-responses"         → dist/providers/openai-responses.js
"./oauth"                    → dist/oauth.js
"./bedrock-provider"         → dist/bedrock-provider.js
```

**Rationale:** The root `"."` import registers all providers lazily. Provider subpaths allow direct import of a specific provider (e.g., for tree-shaking or direct use). `"./oauth"` separates OAuth code. `"./bedrock-provider"` is a pre-built shim for side-loading Bedrock in environments that can't use dynamic imports.

---

## Provider Architecture

### Registry Pattern

Module-level `Map<string, RegisteredApiProvider>` keyed by `api` string. Each entry:

```typescript
interface ApiProviderInternal {
  api: Api;
  sourceId?: string;
  stream: (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream;
  streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
}
```

### Lazy Loading Pattern (`src/providers/register-builtins.ts`)

```typescript
// Pattern used for every provider:
let anthropicModule: Promise<typeof import("./anthropic.js")> | undefined;

function loadAnthropicModule() {
  return (anthropicModule ||= import("./anthropic.js"));
}

// Lazy stream wrapper — returns stream synchronously, loads module async
function createLazyStream<TApi, TOptions>(
  loadModule: () => Promise<{ stream: StreamFunction }>,
  api: TApi
): StreamFunction<TApi, TOptions> {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    loadModule().then(mod => {
      // pipe events from real stream into eventStream
    }).catch(err => {
      eventStream.push({ type: "error", reason: "error", error: createErrorMessage(err) });
      eventStream.end();
    });
    return eventStream;
  };
}
```

**Special case — Bedrock:** Uses `importNodeOnlyProvider()` because `@aws-sdk` is Node.js-only. In browser/Bun environments, call `setBedrockProviderModule(module)` to inject the implementation.

`registerBuiltInApiProviders()` is called at module evaluation time at the bottom of `register-builtins.ts`. Importing `stream.ts` or `index.ts` automatically registers all providers.

### Stream Function Contract

```typescript
type StreamFunction<TApi extends Api, TOptions extends StreamOptions> =
  (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
```

**Rules:**
1. MUST return stream synchronously
2. MUST NEVER throw — all failures encoded as `{ type: "error", ... }` events
3. Terminal event is EITHER `{ type: "done" }` OR `{ type: "error" }` — never both
4. MUST call `.end()` after the terminal event
5. AbortSignal must be checked; on abort emit `{ type: "error", reason: "aborted" }`

### Message Normalization (`src/providers/transform-messages.ts`)

Before calling any provider, messages are normalized:

1. **ID normalization**: Tool call IDs that don't match provider format are remapped. For Anthropic: IDs must match `[a-zA-Z0-9_-]+` (max 64 chars). For OpenAI Responses: prefix with `fc_` if missing. A stable map of `originalId → normalizedId` is built and used to match results.

2. **Orphaned tool calls**: If an `AssistantMessage` contains `ToolCall` entries with no corresponding `ToolResultMessage` in subsequent messages, synthetic tool results are injected: `{ role: "toolResult", content: [{ type: "text", text: "Tool result not available" }], isError: false }`.

3. **Thinking block handling**: Provider-specific thinking content in `AssistantMessage.content` may be stripped, converted to text, or passed through depending on the `compat` settings.

4. **Cross-provider replay**: When messages from provider A are fed to provider B, `thinkingSignature`/`textSignature`/`thoughtSignature` fields are carried along to support thought replay on providers that require it (Google, OpenAI reasoning).

---

## Provider Specifications

### Anthropic (`"anthropic-messages"`)

**SDK:** `@anthropic-ai/sdk`  
**Supported providers:** `anthropic`, `github-copilot`, any `anthropic-messages` model

```typescript
interface AnthropicOptions extends StreamOptions {
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: "low" | "medium" | "high" | "max";
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  client?: Anthropic;  // inject custom Anthropic client
}
```

**Thinking behavior:**
- Opus 4.6 / Sonnet 4.6 models: use `extended_thinking: { type: "adaptive" }` with `output_config: { effort }` (effort maps: minimal→"low", low→"low", medium→"medium", high→"high", xhigh→"max")
- Older models: `{ type: "enabled", budget_tokens: N }` (budget from `ThinkingBudgets`) or `{ type: "disabled" }` if `thinkingEnabled: false`
- Interleaved thinking (Anthropic beta `interleaved-thinking-2025-05-14`): enabled by default for non-adaptive models when thinking is active; disabled for adaptive models

**Caching:**
- Adds `cache_control: { type: "ephemeral" }` to system prompt block and last user message content
- `"long"` cache retention uses `ttl: "1h"` but only on `api.anthropic.com` (not on Copilot)

**OAuth (Claude Max/Pro):**
- Detects token starting with `sk-ant-oat`
- Adds betas: `claude-code-20250219`, `oauth-2025-04-20`, plus others
- Adds Claude Code version headers
- Enforces "You are Claude Code" system prompt prefix
- Maps tool names to/from Claude Code canonical casing (e.g. `read` ↔ `Read`)

**GitHub Copilot:**
- Uses `authToken` as Bearer header
- Selective betas (excludes fine-grained-tool-streaming)
- Adds `X-Initiator` header and optional `Copilot-Vision-Request` header

**Redacted thinking blocks:**
- `type: "redacted_thinking"` with opaque `data` field stored in `thinkingSignature`

---

### OpenAI Completions (`"openai-completions"`)

**SDK:** `openai`  
**Supported providers:** `openai`, `github-copilot`, `xai`, `groq`, `cerebras`, `openrouter`, `vercel-ai-gateway`, `zai`, `opencode`, `huggingface`, `minimax`, `kimi-coding`, and any `openai-completions` model

```typescript
interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}
```

**Compat detection:**
- Auto-detected from `model.provider` and `model.baseUrl` via `detectCompat()`
- `model.compat` fields override auto-detection on a per-field basis

**Thinking format modes (`thinkingFormat`):**
- `"openai"`: standard `reasoning_effort` parameter
- `"openrouter"`: nested `{ reasoning: { effort: "..." } }` in request body
- `"zai"` / `"qwen"`: `enable_thinking: bool` top-level parameter
- `"qwen-chat-template"`: `chat_template_kwargs.enable_thinking`

**Tool results with images:**
- Images in `ToolResultMessage.content` forwarded as a synthetic user message after the tool message (not all providers accept images in tool results directly)

**Reasoning tokens:**
- `completion_tokens_details.reasoning_tokens` added to `usage.output`
- `prompt_tokens_details.cached_tokens` subtracted from `usage.input`

**OpenRouter Anthropic models:**
- Injects `cache_control: { type: "ephemeral" }` on the last user/assistant message

---

### OpenAI Responses (`"openai-responses"`)

**SDK:** `openai` (Responses API — `client.responses.create()`)  
**Supported providers:** `openai`, `github-copilot`, `opencode`

```typescript
interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: "default" | "flex" | "priority";
}
```

**Tool call IDs:** Compound format `{call_id}|{item_id}` — split on `|` to get both parts.

**Reasoning replay:**
- `params.include: ["reasoning.encrypted_content"]` to get encrypted reasoning for replay
- `reasoning.effort` + `reasoning.summary` parameters

**Caching:**
- `prompt_cache_key = sessionId`
- `prompt_cache_retention = "24h"` for long retention on `api.openai.com`
- Service tier: `"flex"` = 0.5× cost, `"priority"` = 2× cost

**Token counting:**
- `input_tokens_details.cached_tokens` subtracted from `usage.input`

---

### Azure OpenAI Responses (`"azure-openai-responses"`)

**SDK:** `openai` (`AzureOpenAI` client)  
**Supported providers:** `azure-openai-responses`

```typescript
interface AzureOpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  azureApiVersion?: string;
  azureResourceName?: string;
  azureBaseUrl?: string;
  azureDeploymentName?: string;
}
```

**Resolution order for base URL:**
1. `options.azureBaseUrl`
2. `AZURE_OPENAI_BASE_URL` env var
3. `options.azureResourceName` → `https://{name}.openai.azure.com/`
4. `model.baseUrl`

**API version resolution:**
1. `options.azureApiVersion`
2. `AZURE_OPENAI_API_VERSION` env var
3. `"v1"` (default)

**Deployment name resolution:**
1. `options.azureDeploymentName`
2. `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` env var — comma-separated `modelId=deploymentName` pairs
3. `model.id`

Uses the same `processResponsesStream` shared code as `openai-responses`.

---

### OpenAI Codex Responses (`"openai-codex-responses"`)

**Transport:** Custom SSE or WebSocket  
**Endpoint:** `https://chatgpt.com/backend-api/codex/responses`  
**Auth:** JWT bearer token with `chatgpt-account-id` extracted from JWT claims

```typescript
interface OpenAICodexResponsesOptions extends StreamOptions {
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
  textVerbosity?: "low" | "medium" | "high";
}
```

**Transport selection:**
- `transport: "sse"` — forced SSE
- `transport: "websocket"` — forced WebSocket (fails if unavailable)
- `transport: "auto"` (default) — tries WebSocket, falls back to SSE on failure

**WebSocket caching:**
- Connections cached per `sessionId`, reused for 5 minutes
- Cache key is the `sessionId` option value

**Reasoning effort clamping:**
- GPT-5.1: caps at `"high"`
- GPT-5.1-codex-mini: caps at `"medium"`

**Retry on error:**
- 429/5xx: exponential backoff, max 3 retries

**Internal SSE parsing:**
- `parseSSE()` generator: reads `data:` lines from response body
- `parseWebSocket()` generator: reads WebSocket frames
- Both map to `ResponseStreamEvent` via `mapCodexEvents()`
- Then processed by shared `processResponsesStream()`

---

### Google Generative AI (`"google-generative-ai"`)

**SDK:** `@google/genai`  
**Supported providers:** `google`

```typescript
interface GoogleOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
}

type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
```

**Thinking behavior by model family:**

| Model family | Disable thinking | Enable thinking |
|---|---|---|
| Gemini 2.x | `thinkingBudget: 0` | `thinkingBudget: N` tokens |
| Gemini 3.x Flash | `thinkingLevel: "MINIMAL"` | `thinkingLevel: "LOW/MEDIUM/HIGH"` |
| Gemini 3.x Pro | `thinkingLevel: "LOW"` (min) | `thinkingLevel: "LOW/HIGH"` (only 2 levels) |

**Tool call ID uniqueness:**
- Generated as `{name}_{Date.now()}_{counter}` when missing or duplicated
- Counter increments per assistant message

**Thought signatures:**
- `retainThoughtSignature()` preserves signatures across streaming deltas
- Signatures stored in `thoughtSignature` field of `ToolCall`

**Token counting:**
- `thoughtsTokenCount` added to `output`
- `cachedContentTokenCount` = `cacheRead`
- For Gemini CLI: `input = promptTokenCount - cachedContentTokenCount`

---

### Google Gemini CLI / Antigravity (`"google-gemini-cli"`)

**Transport:** Manual `fetch` with SSE response  
**Endpoint (Gemini CLI):** `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`  
**Endpoint (Antigravity):** 3 endpoints tried in order: daily → autopush → prod

```typescript
interface GoogleGeminiCliOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
  projectId?: string;
}
```

**Authentication:**
- `Authorization: Bearer <oauth_access_token>`
- API key format for CLI: plain OAuth token
- API key format with project: JSON string `{token: string, projectId: string}`

**Retry algorithm:**
1. Parse `Retry-After` header or extract delay from error body (patterns: `18h31m10s`, `retryDelay` JSON field)
2. If delay > `maxRetryDelayMs` (default 60000ms): throw immediately with delay in error message
3. Sleep, retry up to 3 total attempts
4. Retryable: 429, 5xx. Non-retryable: 403, 404

**Empty stream retry:**
- If SSE stream yields zero content blocks: retry up to 2 times

**Antigravity specifics:**
- Tries 3 endpoints in sequence
- 403/404 → skip to next endpoint without delay
- Injects system instruction to impersonate Antigravity agent
- For Claude models: adds `anthropic-beta: interleaved-thinking-2025-05-14` header

**`extractRetryDelay(error)` parsing:**
1. `Retry-After: 120` (seconds)
2. Duration string: `18h31m10s` → total milliseconds
3. JSON body field: `{"retryDelay": "120s"}`

---

### Google Vertex AI (`"google-vertex"`)

**SDK:** `@google/genai` (with `vertexai: true` option)  
**Supported providers:** `google-vertex`

```typescript
interface GoogleVertexOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
    level?: GoogleThinkingLevel;
  };
  project?: string;
  location?: string;
}
```

**Authentication modes:**

1. **API key:** `GOOGLE_CLOUD_API_KEY` env var → `createClientWithApiKey(model, apiKey)`
2. **ADC (Application Default Credentials):** placeholder API key (starts with `<`) or no key → `createClient(model, project, location)` using `gcloud auth application-default login` credentials
3. Project: `options.project` → `GOOGLE_CLOUD_PROJECT` env var → `model.baseUrl` parse
4. Location: `options.location` → `GOOGLE_CLOUD_LOCATION` env var → `"us-central1"` default

Stream processing identical to `google.ts`.

---

### Amazon Bedrock (`"bedrock-converse-stream"`)

**SDK:** `@aws-sdk/client-bedrock-runtime` (`ConverseStreamCommand`)  
**Module:** Side-loadable — must call `setBedrockProviderModule()` in Bun/browser environments

```typescript
interface BedrockOptions extends StreamOptions {
  region?: string;
  profile?: string;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
  interleavedThinking?: boolean;
  requestMetadata?: Record<string, string>;  // AWS cost allocation tags
}
```

**Credential resolution order:**
1. `AWS_PROFILE` env var → named profile credentials
2. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` → static credentials
3. `AWS_BEARER_TOKEN_BEDROCK` → bearer token auth
4. ECS task role (EC2 instance profile)
5. IRSA (IAM Roles for Service Accounts)
6. `AWS_BEDROCK_SKIP_AUTH=1` → injects dummy creds (for proxy scenarios)

**Proxy support:**
- `HTTP_PROXY` / `HTTPS_PROXY` env vars → dynamically loads `@smithy/node-http-handler` + `proxy-agent`
- `AWS_BEDROCK_FORCE_HTTP1=1` → forces HTTP/1.1 (needed for some proxies)

**Thinking behavior:**
- Claude 4.6 models: adaptive thinking `{ type: "AUTO" }` with effort parameter
- Older Claude models: budget-based `{ type: "ENABLED", budget_tokens: N }`
- Non-Claude models: no thinking content (prevents API rejection)

**Prompt caching:**
- Supported Claude models: 3.5 Haiku, 3.7 Sonnet, 4.x
- Adds `CachePoint` blocks on system prompt and last user message
- `AWS_BEDROCK_FORCE_CACHE=1` → forces caching even for application inference profiles

**Streaming event types handled:**
- `messageStart`, `contentBlockStart`, `contentBlockDelta`, `contentBlockStop`
- `messageStop` (maps stop reason)
- `metadata` (token usage)
- Server exceptions: `internalServerException`, `throttlingException`, `validationException`, `serviceUnavailableException`, `modelStreamErrorException`

---

### Mistral (`"mistral-conversations"`)

**SDK:** `@mistralai/mistralai`  
**Supported providers:** `mistral`

```typescript
interface MistralOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
  promptMode?: "reasoning";
}
```

**Tool call IDs:**
- Normalized to 9-character alphanumeric IDs via `shortHash()` with collision avoidance
- Mistral IDs contain special characters (`-`) that cause problems with some consumers

**Session caching:**
- `x-affinity` header set to `sessionId` for connection affinity

**SDK retry:**
- Retries disabled: `retries: { strategy: "none" }` (retry logic handled externally)

**Error format:**
- Includes HTTP status code from SDK's `statusCode` property
- Truncated at 4000 characters

**Thinking:**
- `promptMode: "reasoning"` → enables reasoning mode
- Thinking content: Mistral `type: "thinking"` chunks ↔ `ThinkingContent`

---

## Token Counting Per Provider

| Provider | `input` | `output` | `cacheRead` | `cacheWrite` |
|----------|---------|----------|-------------|--------------|
| Anthropic | `inputTokens - cacheReadTokens - cacheCreationTokens` | `outputTokens` | `cacheReadInputTokens` | `cacheCreationInputTokens` |
| OpenAI Completions | `promptTokens - cachedTokens` | `completionTokens + reasoningTokens` | `promptTokensDetails.cachedTokens` | 0 |
| OpenAI Responses | `inputTokens - cachedTokens` | `outputTokens` | `inputTokensDetails.cachedTokens` | 0 |
| Google | `promptTokenCount - cachedContentTokenCount` | `candidatesTokenCount + thoughtsTokenCount` | `cachedContentTokenCount` | 0 |
| Gemini CLI | `promptTokenCount - cachedContentTokenCount` | `candidatesTokenCount + thoughtsTokenCount` | `cachedContentTokenCount` | 0 |
| Bedrock | direct from metadata event | direct | direct | direct |
| Mistral | `promptTokens` | `completionTokens` | 0 | 0 |

---

## Context Overflow Detection

`isContextOverflow(message, contextWindow?)` — returns `true` if:

1. Message has `stopReason === "error"` AND `errorMessage` matches any of 15+ provider-specific patterns:
   - `"context_length_exceeded"`, `"maximum context length"`, `"too many tokens"`, `"context window"`, `"prompt is too long"`, etc.
2. **Silent overflow (z.ai):** `stopReason === "stop"` AND `usage.input + usage.cacheRead > contextWindow`

---

## Error Handling

**Universal rule:** Stream functions NEVER throw. All errors:
```typescript
stream.push({ type: "error", reason: "error" | "aborted", error: AssistantMessage });
stream.end();
// where AssistantMessage has stopReason: "error" | "aborted", errorMessage: string
```

**Lazy load failure:**
```typescript
// On dynamic import failure:
stream.push({ type: "error", reason: "error", error: createLazyLoadErrorMessage(err) });
stream.end();
```

**Provider-specific error encodings:**

| Provider | Error source |
|----------|-------------|
| Anthropic | SDK exceptions; `pause_turn` → `"stop"`; `sensitive/refusal` → `"error"` |
| OpenAI Completions | `content_filter`, `network_error` finish reasons; OpenRouter `error.metadata.raw` |
| OpenAI Responses | `response.failed`, `error` events; `status: "failed"/"cancelled"` |
| Bedrock | `internalServerException`, `throttlingException`, `modelStreamErrorException`, etc. |
| Gemini CLI | HTTP errors with retry logic; `maxRetryDelayMs` enforcement |
| Mistral | SDK `statusCode` + `body` (truncated at 4000 chars) |

---

## OAuth System (`src/utils/oauth/`)

### Types

```typescript
interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;   // Unix ms
  tokenType?: string;
}

interface OAuthProviderInterface {
  id: OAuthProviderId;
  name: string;
  login(credentials?: Partial<OAuthCredentials>, callbacks?: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refresh?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey?(credentials: OAuthCredentials): Promise<string> | string;
}

type OAuthProviderId =
  | "anthropic" | "github-copilot" | "google-gemini-cli"
  | "google-antigravity" | "openai-codex";
```

### Registry API (from `"./oauth"` subpath)

```typescript
function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined;
function registerOAuthProvider(provider: OAuthProviderInterface): void;
function unregisterOAuthProvider(id: OAuthProviderId): void;
function resetOAuthProviders(): void;
function getOAuthProviders(): OAuthProviderInterface[];
function getOAuthApiKey(providerId: OAuthProviderId, credentials: OAuthCredentials): Promise<string>;
```

### Per-provider exports (from `"./oauth"`)

| Provider | Login function | Refresh function | Provider object |
|----------|---------------|-----------------|----------------|
| Anthropic | `loginAnthropic` | `refreshAnthropicToken` | `anthropicOAuthProvider` |
| GitHub Copilot | `loginGitHubCopilot` | `refreshGitHubCopilotToken` | `githubCopilotOAuthProvider` |
| Gemini CLI | `loginGeminiCli` | `refreshGoogleCloudToken` | `geminiCliOAuthProvider` |
| Antigravity | `loginAntigravity` | `refreshAntigravityToken` | `antigravityOAuthProvider` |
| OpenAI Codex | `loginOpenAICodex` | `refreshOpenAICodexToken` | `openaiCodexOAuthProvider` |

### PKCE Flow (`src/utils/oauth/pkce.ts`)

```typescript
function generateCodeVerifier(): string;   // 128-char random base64url
function generateCodeChallenge(verifier: string): Promise<string>;  // SHA-256 S256
```

### Local HTTP Callback Server (`src/utils/oauth/oauth-page.ts`)

Starts a temporary HTTP server on `localhost:PORT` to receive OAuth redirect. Waits for `?code=` parameter, then shuts down.

```typescript
function waitForOAuthCallback(port: number, timeout?: number): Promise<{ code: string; state?: string }>;
```

---

## Model Catalog

### Generation (`scripts/generate-models.ts`)

Sources:
1. `https://models.dev/api.json` — Anthropic, OpenAI, xAI, Groq, Cerebras, MiniMax, GitHub Copilot, Hugging Face
2. `https://openrouter.ai/api/v1/models` — all tool-capable models with pricing
3. `https://ai-gateway.vercel.sh/v1/models` — Vercel AI Gateway models
4. Manual hardcoded entries for: Amazon Bedrock, Google (all variants), Mistral, OpenAI Codex, Azure OpenAI, OpenCode, Kimi

Output: `src/models.generated.ts` — `const MODELS` object with 14,000+ entries.

### Structure

```typescript
// models.generated.ts
export const MODELS: {
  [provider: string]: {
    [modelId: string]: Model<Api>
  }
} = {
  "anthropic": {
    "claude-opus-4-6": {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      contextWindow: 200000,
      maxTokens: 32000,
    },
    // ...
  },
  // ... all other providers
};
```

### `supportsXhigh(model)` Logic

Returns `true` if `model.id` matches (case-insensitive):
- `gpt-5.2`, `gpt-5.3`, `gpt-5.4`
- `opus-4-6`, `opus-4.6`
