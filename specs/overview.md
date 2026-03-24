# Piccolo — System Overview

## Purpose

Piccolo is a cloud-native AI agent platform built entirely on Cloudflare's infrastructure. It provides a minimal, extension-first agent core that runs as Cloudflare Workers and Durable Objects, and exposes user interfaces through typed JSRPC gateways.

---

## Components

Piccolo is composed of the following independently deployed Cloudflare Workers:

| Component | Kind | Description |
|---|---|---|
| `piccolo-agent` | npm package | Agent loop library used by piccolo-core |
| `piccolo-core` | Worker + DOs | Agent session orchestration; the JSRPC hub |
| Web UI gateway | Worker + DO | Browser chat interface |
| Telegram gateway | Worker + DO | Telegram bot interface |
| Extensions | Workers (dispatch namespace) | Tools, event handlers, custom capabilities |

LLM calls go through the **Cloudflare AI Gateway** unified API using the `ai` and `ai-gateway-provider` packages. There is no piccolo-owned LLM provider layer.

---

## Dependency Graph

```
Cloudflare AI Gateway  ◄── all LLM calls routed here
  ▲
  │  (ai + ai-gateway-provider)
  │
piccolo-agent
  ▲
  │
piccolo-core   (depends on piccolo-agent)
  ▲
  │
Extensions     (Workers in dispatch namespace; depend on piccolo-core via JSRPC)
  ▲
  │
Gateways       (Workers with service binding to piccolo-core)
```

---

## Component Roles

### Cloudflare AI Gateway + AI SDK (external dependencies, not piccolo packages)

All LLM calls are routed through the **Cloudflare AI Gateway** unified endpoint:
```
https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat
```

The gateway provides:
- A single OpenAI-compatible endpoint covering Anthropic, OpenAI, Google, Groq, Mistral, Workers AI, xAI, DeepSeek, Cerebras, and more
- Models addressed as `{provider}/{model-id}` (e.g. `anthropic/claude-sonnet-4-5`)
- Built-in observability, caching, rate limiting, and model fallback
- No per-provider API key management in piccolo code — keys are stored as CF AI Gateway secrets

The `ai` and `ai-gateway-provider` packages are the client libraries used to call the gateway. They handle streaming, tool calling, multi-step loops, and message history.

### `piccolo-agent` → [agent.md](agent.md)

Agent loop layer. Provides:
- An `Agent` class that orchestrates multi-turn LLM conversations via `streamText`
- `ITool` interface (`ToolDescriptor` + `execute`) for defining tools as Workers
- Steering (inject mid-turn) and follow-up (inject post-turn) message queues
- `AgentEvent` stream for gateways and extensions to observe turn progress

### `piccolo-core` → [core.md](core.md)

Session coordination layer. Provides:
- **Session persistence** backed by Cloudflare Durable Objects + D1
- **Context compaction** (LLM-based summarisation when context window fills)
- **Extension host**: loads extensions from the Workers for Platforms dispatch namespace, dispatches events via JSRPC
- **System prompt assembly** from registered skills, agent context, and tool guidelines
- **Model management**: active model stored per session, switchable at runtime
- **Auto-retry** with exponential backoff for transient LLM errors

Exposes `IPiccoloCore` and `ISession` as JSRPC surfaces. Gateways and extensions call it exclusively over JSRPC.

### Gateways → [gateway.md](gateway.md)

User-facing interface Workers. Each gateway connects a specific user channel to the piccolo-core JSRPC surface. Tools may provide custom rendering for a gateway via `getGatewayUI(gatewayId)`.

Two gateways are specified:

- **Web UI Gateway** ([web_gateway.md](web_gateway.md)) — browser-based chat UI served over HTTP + SSE; tools may provide `IWebUI` React components
- **Telegram Gateway** ([telegram_gateway.md](telegram_gateway.md)) — Telegram bot via webhook; tools may provide `ITelegramUI` message formatters

Additional gateways (Slack, CLI, API) can be added without modifying the core.

### Extensions

Independent Workers deployed into the piccolo dispatch namespace. Each extension implements the piccolo extension contract (a typed `WorkerEntrypoint` surface) and is invoked by the core via JSRPC. Extensions add tools, event handlers, compaction strategies, custom system prompt content, and more.

See [extension-system.md](extension-system.md) for the extension contract.

---

## Core Data Structures

### `ModelMessage` (from the `ai` package)

The canonical message type throughout piccolo. Imported directly from the `ai` package:

```typescript
import type { ModelMessage } from "ai";

// Variants used:
// { role: "user";      content: string | UserContent[] }
// { role: "assistant"; content: AssistantContent[] }
// { role: "tool";      content: ToolResultPart[] }
// { role: "system";    content: string }
```

All session storage, agent state, and extension event payloads use `ModelMessage[]`.

### `AgentEvent` (from `piccolo-agent`)

See [api.md — Shared Types](api.md) for the full `AgentEvent` union. Events stream from `IAgentSessionDO` → `IPiccoloCore` → gateways and extensions.

---

## Infrastructure Summary

| Concern | Cloudflare primitive |
|---|---|
| LLM routing + observability | CF AI Gateway (external, managed) |
| LLM client library | `ai` + `ai-gateway-provider` packages |
| Agent session compute | Durable Objects |
| Session / conversation storage | Durable Objects storage + D1 |
| Extension registry | Workers KV |
| Extension code | Workers for Platforms dispatch namespace |
| Config and settings | Workers KV |
| LLM API keys | CF AI Gateway secrets (not in Workers env) |
| File / asset storage | R2 |
| Gateway compute | Workers |
| Gateway streaming state | Durable Objects |
| Scheduled tasks | Cron Triggers |
| Inter-component communication | Workers RPC (JSRPC) |

---

## Document Index

| Document | Contents |
|---|---|
| [api.md](api.md) | **All public JSRPC/capnweb APIs**: `IPiccoloCore`, `ISession`, `IAgentSessionDO`, `IWebGatewayApi`, `IWebGatewaySession`, `IAgentEventListener`, `ITurnHandle`, `IWebUiSessionDO`, `ITelegramChatDO`, `ITextUI`, `IWebUI`, `ITelegramUI`, `IGatewayCallback`, `IExtensionWorker`, `IExtensionContext`, `ITool`, `ToolDescriptor`, shared types |
| [core.md](core.md) | **piccolo-core implementation**: `AgentSessionDO`, `ExtensionRunner`, `SystemPromptAssembler`, session tree, entry types, D1/KV schema, compaction, retry, fork, listing |
| [agent.md](agent.md) | `piccolo-agent`: AI SDK + CF AI Gateway, `Agent` class, steering/follow-up, compaction |
| [tools.md](tools.md) | Tool authoring contract (`ITool` / `ToolDescriptor`), gateway UI integration, deployment, checklist |
| [r2_tool.md](r2_tool.md) | R2 tool (provided): read, write, delete, list, stat, copy, move |
| [d1_tool.md](d1_tool.md) | D1 tool (provided): schema, select, insert, update, delete, schema_change, sql |
| [gateway.md](gateway.md) | Gateway concept, `ITextUI`/`IWebUI`/`ITelegramUI` resolution, comparison table |
| [web_gateway.md](web_gateway.md) | Web UI gateway: Cap'n Web RPC, `IWebGatewayApi`, `IWebGatewaySession`, `IAgentEventListener`, `IWebUI`, SPA spec |
| [telegram_gateway.md](telegram_gateway.md) | Telegram gateway: `ITelegramUI`, webhook handler, `ITelegramChatDO` |
| [extension-system.md](extension-system.md) | Extension use-cases, 12 examples, dispatch, provided extensions |
| [skills_extension.md](skills_extension.md) | Skills extension: load from URLs, `/skill:name` commands, Agent Skills standard |
| [prompt_templates_extension.md](prompt_templates_extension.md) | Prompt templates extension: load from URLs, `/template:name` with argument substitution |
| [session-format.md](session-format.md) | Redirect → core.md (session schema now in core.md) |
| [data-flows.md](data-flows.md) | External flows: gateway→core→LLM→response; internal flows redirect to core.md |
| [infrastructure.md](infrastructure.md) | Deployment topology, CI/CD, gateway bindings, extension namespace |
| [code.md](code.md) | TypeScript standards, `any` policy, pnpm, Vite/Vitest, mocking patterns, naming |
| [piccolo_differences.md](piccolo_differences.md) | Design differences from pi: minimal core, cloud-native, CF infra, JSRPC, extension model |
| [implementation_plan.md](implementation_plan.md) | Ordered high-level implementation plan |
