# Pi Monorepo — System Overview

## Purpose

This repository is a monorepo of tools for building AI agents and managing LLM deployments. The primary product is **pi** (`@mariozechner/pi-coding-agent`), an interactive coding agent CLI. The remaining packages are either building blocks (used by pi) or standalone tools (Slack bot, GPU pod manager).

---

## Package Map

```
packages/
├── ai/           @mariozechner/pi-ai           Unified multi-provider LLM streaming API
├── agent/        @mariozechner/pi-agent-core   Agent loop: tool calling, state, conversation
├── tui/          @mariozechner/pi-tui          Terminal UI framework (differential rendering)
├── coding-agent/ @mariozechner/pi-coding-agent Interactive coding agent CLI (pi binary)
├── mom/          @mariozechner/pi-mom          Slack bot that delegates to the coding agent
├── pods/         @mariozechner/pi              CLI for managing vLLM deployments on GPU pods
└── web-ui/       @mariozechner/pi-web-ui       Web Components for AI chat interfaces
```

---

## Dependency Graph

```
pi-ai  ◄──────────────────────────────────────────────────────┐
  ▲                                                            │
  │                                                            │
pi-agent-core  (depends on pi-ai)                             │
  ▲                                                            │
  │                                                            │
pi-tui  (no ai/agent deps)                                    │
  ▲                                                            │
  │                                                            │
pi-coding-agent  (depends on pi-ai + pi-agent-core + pi-tui) ─┤
  ▲                                                            │
  │                                                            │
pi-mom  (depends on pi-ai + pi-agent-core + pi-coding-agent)  │
                                                               │
pi-web-ui  (depends on pi-ai + pi-agent-core + pi-tui) ───────┘

pi-pods  (standalone, no internal deps)
```

**Concrete dependency table:**

| Package | Depends On |
|---------|-----------|
| `pi-ai` | (none — external SDKs only) |
| `pi-agent-core` | `pi-ai` |
| `pi-tui` | (none — external only) |
| `pi-coding-agent` | `pi-ai`, `pi-agent-core`, `pi-tui` |
| `pi-mom` | `pi-ai`, `pi-agent-core`, `pi-coding-agent` |
| `pi-web-ui` | `pi-ai`, `pi-agent-core`, `pi-tui` |
| `pi-pods` | (none — pure SSH/CLI tool) |

---

## Package Roles

### `@mariozechner/pi-ai` → [packages/ai.md](packages/ai.md)

The foundation layer. Provides:
- A **unified streaming API** over 10+ LLM providers (Anthropic, OpenAI, Google, Bedrock, Mistral, etc.)
- A **provider registry** with lazy loading
- A **model catalog** (~14,000 auto-generated model entries)
- An **event stream protocol** (`AssistantMessageEvent`) that normalizes all provider responses
- **OAuth flows** for token-based providers (Claude Max, GitHub Copilot, Gemini CLI, OpenAI Codex)
- **TypeBox-based tool validation**

Consumers call `stream(model, context, options?)` or `streamSimple(model, context, options?)` and receive an async-iterable `AssistantMessageEventStream`.

### `@mariozechner/pi-agent-core` → [packages/agent.md](packages/agent.md)

The agent loop layer. Provides:
- An `Agent` class that orchestrates multi-turn LLM conversations with tool calling
- `AgentTool<TParams, TDetails>` interface for defining tools with TypeBox schemas
- Parallel and sequential tool execution modes
- `beforeToolCall` / `afterToolCall` hooks
- Steering (inject mid-turn) and follow-up (inject post-turn) message queues
- A proxy stream function for routing LLM calls through a backend server
- Low-level `agentLoop` / `agentLoopContinue` functions returning typed event streams

### `@mariozechner/pi-tui` → [packages/tui.md](packages/tui.md)

The terminal UI framework. Provides:
- A `Component` interface + `Container` base class for composable terminal widgets
- `TUI` class with **differential rendering** (only changed lines written to terminal)
- `ProcessTerminal` for raw-mode stdin/stdout
- **Kitty keyboard protocol** support for precise key disambiguation
- **Overlay system** for modal dialogs (anchored, sized, focused)
- 12 built-in components: `Text`, `Markdown`, `Editor`, `Input`, `SelectList`, `Loader`, `Image`, etc.
- **Keybinding system** with declaration-merging for type-safe action IDs
- ANSI-aware utilities: `visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth`
- Terminal image rendering (Kitty + iTerm2 protocols)
- Autocomplete with slash commands and file path completion

### `@mariozechner/pi-coding-agent` → [packages/coding-agent.md](packages/coding-agent.md)

The coding agent CLI (`pi` binary). Provides:
- `AgentSession` — the central coordination class wrapping `Agent` with session persistence, compaction, retry, extensions, and model management
- 6 built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`
- An **extension system** for loading custom tools, UI, commands, and event hooks from `.ts`/`.js` files
- **Session persistence** in JSONL tree format with branching, forking, and `/tree` navigation
- **Context compaction** (LLM-based summarization when context window fills)
- Three run modes: interactive TUI, print (non-interactive), RPC (JSON stdin/stdout protocol)
- **Model cycling** across multiple configured providers
- A public **SDK** (`createAgentSession()`) for programmatic use

### `@mariozechner/pi-mom` → [packages/mom.md](packages/mom.md)

A Slack bot that delegates channel messages to a pi coding agent instance. Each Slack channel gets its own persistent agent session. Features:
- Socket Mode (WebSocket) Slack integration
- Per-channel message queue preventing concurrent agent runs
- File attachment download and injection
- Scheduled/immediate/periodic events via watched JSON files
- Host and Docker sandbox execution modes

### `@mariozechner/pi` (pods) → [packages/pods.md](packages/pods.md)

A CLI (`pi-pods` binary) for managing vLLM model servers on remote GPU machines accessed via SSH. Features:
- Pod provisioning (installs Python, vLLM, configures credentials)
- GPU inventory detection via `nvidia-smi`
- Model server lifecycle (start, stop, health check, logs)
- GPU and port allocation algorithms
- Hardcoded configs for known models (Qwen, GPT-OSS, GLM, Kimi-K2)

### `@mariozechner/pi-web-ui` → [packages/web-ui.md](packages/web-ui.md)

A Web Components (Lit-based) library for browser AI chat interfaces. Provides:
- `<agent-interface>` — full chat UI with streaming, tool calls, model selector
- `<artifacts-panel>` — tabbed artifact viewer (HTML, Markdown, SVG, PDF, Excel, DOCX)
- `SandboxedIframe` — sandboxed HTML execution with `postMessage` runtime API
- IndexedDB-backed storage (sessions, settings, provider keys, custom providers)
- CORS proxy support for providers that block browser requests
- Tool renderer registry for custom tool call visualizations

---

## Core Data Structures

These types flow through nearly every package and must be implemented exactly.

### `Message` (from `pi-ai`)

```typescript
type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
```

### `AssistantMessageEvent` (from `pi-ai`)

The streaming event protocol. Every provider normalizes to this.

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

### `AgentEvent` (from `pi-agent-core`)

Events emitted by the agent loop.

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

### `Model<TApi>` (from `pi-ai`)

```typescript
interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };  // $/million tokens
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}
```

---

## Configuration Directory Layout

```
~/.pi/
├── agent/                           # pi coding agent global config
│   ├── auth.json                    # API keys and OAuth tokens
│   ├── settings.json                # Global settings
│   ├── models.json                  # Custom model/provider definitions
│   ├── keybindings.json             # Keybinding overrides
│   ├── extensions/                  # Global extensions (.ts/.js)
│   ├── skills/                      # Global skills (SKILL.md files)
│   ├── prompts/                     # Global prompt templates (.md)
│   ├── themes/                      # Custom themes (.json)
│   ├── bin/                         # Managed binaries: fd, rg
│   ├── sessions/                    # JSONL session files per project
│   │   └── --path-to-project--/
│   │       └── TIMESTAMP_UUID.jsonl
│   ├── AGENTS.md                    # Global context injected to all system prompts
│   ├── SYSTEM.md                    # Custom system prompt (replaces default)
│   └── APPEND_SYSTEM.md             # Appended to system prompt
│
├── pods.json                        # pi-pods configuration
└── mom/                             # pi-mom configuration
    └── auth.json                    # Anthropic key for mom bot
```

```
{project-root}/.pi/                  # Project-local config (overrides global)
├── settings.json
├── extensions/
├── skills/
├── prompts/
├── themes/
├── SYSTEM.md
└── APPEND_SYSTEM.md

{project-root}/AGENTS.md             # Project context (walked up from cwd)
```

---

## Versioning

All packages share **lockstep versioning** — they always have identical version numbers. Current version: `0.62.0`. Releases bump all packages simultaneously. See [infrastructure.md](infrastructure.md) for the release process.

---

## Development Workflow

```bash
npm install          # Install all deps (npm workspaces links inter-package refs)
npm run build        # Build all packages in dependency order
npm run check        # Lint (biome) + type-check (tsgo) + browser smoke test
./test.sh            # Run tests with all API keys stripped (offline safe)
./pi-test.sh         # Run pi from source (interactive)
```

**Note:** `npm run check` requires `npm run build` first. TypeScript paths in the root `tsconfig.json` resolve `@mariozechner/*` directly to `packages/*/src/index.ts` during type-checking, but the build output in `dist/` is needed for the web-ui type check.

---

## Document Index

| Document | Contents |
|----------|----------|
| [packages/ai.md](packages/ai.md) | LLM provider API: types, streaming protocol, all 10 providers, model registry, OAuth |
| [packages/agent.md](packages/agent.md) | Agent loop: tool execution, state management, proxy support |
| [packages/tui.md](packages/tui.md) | Terminal UI: components, rendering, keybindings, layout |
| [packages/coding-agent.md](packages/coding-agent.md) | Coding agent CLI: tools, extensions, sessions, compaction, modes |
| [packages/mom.md](packages/mom.md) | Slack bot: event routing, agent integration, sandbox |
| [packages/pods.md](packages/pods.md) | GPU pod management: vLLM provisioning, model lifecycle |
| [packages/web-ui.md](packages/web-ui.md) | Web components: chat UI, artifacts, sandbox runtime, storage |
| [infrastructure.md](infrastructure.md) | Monorepo: build system, CI/CD, testing, release |
| [data-flows.md](data-flows.md) | End-to-end flows: prompt → LLM → response → UI |
| [extension-system.md](extension-system.md) | Extension API: events, tool definitions, UI integration |
| [session-format.md](session-format.md) | JSONL session format: entry types, tree structure, compaction |
