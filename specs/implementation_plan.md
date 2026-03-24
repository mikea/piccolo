# Implementation Plan

High-level ordered plan for implementing piccolo from scratch. Each item is a self-contained milestone that can be expanded into a detailed todo list. Items are ordered bottom-up: no item depends on anything below it in the list.

All implementation must follow [code.md](code.md) at all times. All interfaces must match [api.md](api.md) exactly. After completing each item, run the verification checklist in [AGENTS.md](../AGENTS.md).

---

## 1. Project Setup ✅

Create the monorepo scaffold with all tooling configured before writing any production code.

**Deliverables:**
- `pnpm-workspace.yaml` with `packages/*`, `gateways/*`, `extensions/*`
- `tsconfig.base.json` with all strict settings from [code.md](code.md)
- `biome.json` with `noExplicitAny: error` and formatting rules
- Root `package.json` with `scripts: { check, test, lint, build }`
- `pnpm-lock.yaml` committed
- `.gitignore` covering `node_modules/`, `dist/`, `.wrangler/`
- Empty `packages/agent/`, `packages/core/`, `gateways/web/`, `gateways/telegram/`, `extensions/r2-tool/`, `extensions/d1-tool/`, `extensions/skills/`, `extensions/templates/` with their `package.json` and `tsconfig.json`
- CI skeleton: `.github/workflows/ci.yml` and `deploy.yml` (shell only, tests will be empty until code exists)
- Shared type stubs: `packages/core/src/types.ts` exporting all types from [api.md](api.md) Shared Types section as `TODO` placeholders — to be filled in as each piece is implemented

**Spec refs:** [code.md](code.md), [infrastructure.md](infrastructure.md)

### 1.1 Implementation Notes

**Status:** Complete. All deliverables present. `pnpm biome check .` and `pnpm -r exec tsc --noEmit` both pass with zero errors.

#### Tooling versions pinned

| Tool | Version |
|---|---|
| wrangler | ^4.0.0 |
| typescript | ^5.7.3 |
| vitest | ^4.1.0 (minimum required by `@cloudflare/vitest-pool-workers`) |
| @cloudflare/vitest-pool-workers | ^0.8.0 |
| @cloudflare/workers-types | ^4.20241230.0 (installed but not used in tsconfig — see conflict below) |
| @biomejs/biome | ^1.9.4 |

#### Wrangler config format

All `wrangler.jsonc` files use the JSON format (not TOML), which is the Cloudflare recommendation for new projects as of Wrangler 3.91+. The `$schema` key points to `./node_modules/wrangler/config-schema.json` for IDE validation.

#### Durable Object migrations

All new Durable Objects (`AgentSessionDO`, `WebUiSessionDO`, `TelegramChatDO`) are declared with `new_sqlite_classes` (not the legacy `new_classes`). SQLite-backed DOs are the current Cloudflare default and provide built-in SQL storage.

#### Vitest Workers integration — updated API

The `@cloudflare/vitest-pool-workers` package now requires **Vitest 4.1+** and uses the `cloudflareTest()` plugin API:

```typescript
// vitest.config.ts (Workers packages)
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { coverage: { provider: "v8", thresholds: { lines: 80, functions: 80, branches: 70 } } },
});
```

The older `defineWorkersConfig` API from the package's own exports is superseded by this plugin approach. `packages/core/test/` includes a `tsconfig.json` and `env.d.ts` as required by the latest CF Vitest docs.

#### TypeScript type conflict and resolution

**Conflict:** `@cloudflare/workers-types` uses `export = CloudflareWorkersModule` (CommonJS-style export assignment). This is structurally incompatible with `"module": "ES2022"` + `"verbatimModuleSyntax": true` from `code.md`, producing:

```
error TS2309: An export assignment cannot be used in a module with other exported elements.
```

**Resolution:** `@cloudflare/workers-types` is **not** referenced in any `tsconfig.json`. Instead:

- `tsconfig.base.json` uses `"lib": ["ES2022", "WebWorker"]`. The `WebWorker` lib provides all standard Web APIs used by the Workers runtime (`AbortSignal`, `ReadableStream`, `fetch`, `Request`, `Response`, `URL`, `crypto`, etc.) without requiring the CF package.
- Per-Worker packages will add CF-specific types (Durable Objects, KV, R2, D1 binding shapes) via **`wrangler types`**, which generates a `worker-configuration.d.ts` file whose declarations are compatible with ES module syntax. This file is gitignored and regenerated as part of each package's `types` script.
- `@cloudflare/workers-types` remains installed as a dev dependency at the root because it is still the recommended way to type shared/library packages (per CF docs), and is needed by `packages/agent` if it ever needs to reference a Workers type. It is not referenced via `tsconfig.json` `"types"` arrays anywhere in the current scaffold.

#### Biome JSONC handling

Biome's default JSON parser rejects comments in `.json` files. `tsconfig*.json` files use JSONC (comments + trailing commas). Fixed via a Biome `overrides` entry:

```json
"overrides": [
  {
    "include": ["tsconfig*.json", "**/tsconfig*.json"],
    "json": { "parser": { "allowComments": true, "allowTrailingCommas": true } }
  }
]
```

`wrangler.jsonc` files are not parsed by Biome (the `.jsonc` extension is not in Biome's default file list).

#### `packages/core/src/types.ts` — forward-reference strategy

`IExtensionContext` is referenced by `ITool.execute()` but is defined in item 8. To avoid a circular dependency at stub time, it is declared as `type IExtensionContext = unknown` with a `TODO(item-8)` comment. All other 14 Shared Types from `api.md` are fully shaped (field names, optionality, and inline comments match the spec exactly).

#### Placeholder `src/index.ts` files

Each package that has no source code yet contains a two-line `src/index.ts` with an `export {}` statement. This is required because `tsc` fails with `TS18003` ("No inputs were found") when the `include` glob matches an empty directory. These files will be replaced by real entry points as each milestone is implemented.

---

## 2. `piccolo-agent` — Core Agent Loop ✅

The agent loop library. Pure TypeScript, no Workers-specific globals. The most foundational package — everything else depends on it for LLM streaming.

**Deliverables:**
- `createAiGateway` and `createUnified` setup from `ai-gateway-provider`
- `Agent` class with full `AgentState`, constructor, `prompt()`, `continue()`, `abort()`
- `AgentEvent` union emitted from `streamText` callbacks
- Steering queue (`steer()`, `clearSteering()`) via `prepareStep`
- Follow-up queue (`followUp()`, `clearFollowUp()`) via `agent.continue()` after `onFinish`
- `setModel()`, `setTools()`, `setSystemPrompt()`, `replaceMessages()`, `appendMessages()`
- `subscribe()` / unsubscribe
- `toAiSdkTools()` — converts `IAgentTool[]` to AI SDK `ToolSet`
- `agentCompact()` — `generateText`-based compaction helper
- Unit tests: all state transitions, steering semantics, follow-up semantics, abort, tool execution paths, compaction split logic (50 tests, all passing)
- Mock AI Gateway: `createMockGateway()` in `test/mock-gateway.ts`

**Spec refs:** [agent.md](agent.md), [api.md — Shared Types](api.md), [code.md — Mocking](code.md)

### 2.1 Implementation Notes

**Status:** Complete. All deliverables present. `pnpm biome check .` and `pnpm -r exec tsc --noEmit` both pass with zero errors. 50 tests pass, coverage: lines 88%, functions 98%, branches 74%.

#### Genericity — minimal types in `packages/agent`

`packages/agent` defines only what the agent loop itself needs. Deliberately excluded from this package:
- Gateway IDs (`"web"`, `"telegram"`) and UI interfaces (`ITextUI`, `IWebUI`, `ITelegramUI`)
- System-prompt metadata (`label`, `promptSnippet`, `promptGuidelines`) — used by `SystemPromptAssembler` in core
- `ITool.getGatewayUI?` — gateway rendering method, not an agent-loop concern
- `details?` in `ToolResult` — stored in session entries by core
- Session/model/context types (`ModelInfo`, `SessionRecord`, `ContextUsage`)

`packages/core` defines the full `ITool` and `ToolDescriptor` that extend `IAgentTool`/`AgentToolDescriptor` from this package.

#### `skipLibCheck: true` added to `tsconfig.base.json`

The `ai` v6 package's `.d.ts` files have known incompatibilities with `exactOptionalPropertyTypes: true` and reference Node-only types (`Buffer`, `node:http`). Added `"skipLibCheck": true` to `tsconfig.base.json`. Our own code is fully type-checked; only third-party `.d.ts` files are skipped.

#### ai v6 API differences from spec

1. **`onChunk` does not include `tool-error`** — Tool errors must be detected from `onStepFinish`'s `content` array. The `_runStream()` method iterates `content` in `onStepFinish` and emits `tool_end` with `isError: true` for `tool-error` parts.

2. **`LanguageModelUsage` fields** — v6 uses `inputTokens`/`outputTokens`/`totalTokens` (not `promptTokens`/`completionTokens`).

3. **`prepareStep`** — Promoted from `experimental_prepareStep` to stable in v6.

4. **`stopWhen: stepCountIs(N)`** — Still present and unchanged in v6.

#### Mock model — no fetch interception

`createMockModel()` in `test/mock-gateway.ts` uses `MockLanguageModelV3` and `simulateReadableStream` from the official `ai/test` package. No `fetch` interception, no SSE format knowledge, no streaming detection heuristics required.

- `doStream` is used by `streamText` — returns `ReadableStream<LanguageModelV3StreamPart>`
- `doGenerate` is used by `generateText` — returns `LanguageModelV3GenerateResult`

Both share the same `MockModelOptions`.

#### `Agent` accepts `LanguageModel` directly — no `ai-gateway-provider` in `packages/agent`

`AgentOptions.model` is a `LanguageModel` (from `ai`) — not a `gateway + modelId` pair. The gateway/model construction (`createAiGateway`, `ai-gateway-provider`) is entirely a `piccolo-core` concern. `packages/agent` has **no dependency on `ai-gateway-provider`** and no `gateway.ts` file. In tests, pass `new MockLanguageModelV3(...)` directly.

#### `agentCompact` accepts `LanguageModel` directly

Same principle: `agentCompact(messages, keepRecentTokens, model)` takes the same `LanguageModel` as the `Agent`. No separate gateway argument.

#### `packages/core/src/types.ts` updated — extends agent types

`packages/core` now depends on `@piccolo/agent` (workspace dependency):
- `ToolDescriptor extends AgentToolDescriptor` — adds `label`, `promptSnippet`, `promptGuidelines`
- `ITool extends IAgentTool` — adds `descriptor: ToolDescriptor` and `getGatewayUI`
- `ToolResult extends AgentToolResult` — adds `details`
- `AgentEvent`, `IAgentTool`, `AgentToolDescriptor`, `AgentToolResult`, `ModelMessage`, `LanguageModel` etc. are re-exported from `@piccolo/agent` — no duplication.
- `ai` and `zod` remain direct dependencies of `packages/core` for non-agent types.

---

## 3. `piccolo-core` — D1 Schema and Migrations

Set up the database layer before any logic touches it. All subsequent core items depend on a working schema.

**Deliverables:**
- `packages/core/migrations/0001_initial.sql` — `sessions` and `entries` DDL from [core.md](core.md)
- `packages/core/src/db/schema.ts` — typed query helpers wrapping `D1Database` (prepared statements for all queries used in core.md)
- `packages/core/src/db/entry-types.ts` — all `EntryBase` subtypes with discriminated union
- Unit tests: schema helpers against `createMockD1()`, all entry type round-trips (serialise → insert → query → deserialise)
- `test/mocks/d1.ts` — functional in-memory D1 mock (runs real SQL via `@sqlite.org/sqlite-wasm` or similar)

**Spec refs:** [core.md — D1 Schema](core.md), [core.md — Entry Types](core.md), [code.md — Mocks](code.md)

---

## 4. `piccolo-core` — Session Persistence Layer

The stateless functions that read/write session data. No DO or Worker code yet — pure functions over D1 + the entry tree.

**Deliverables:**
- `buildSessionContext(entries, leafId)` — full reconstruction algorithm from [core.md](core.md)
- `appendEntry(entry, db)` — insert a single entry; update `sessions.leaf_id` and `updated_at`
- `flushPendingEntries(pending, db)` — batch-insert `EntryBase[]` to D1
- `createSession(options, db)` — lazy: returns a sessionId without writing to D1
- `commitSession(sessionId, userId, options, db)` — writes the D1 row on first assistant response
- `listSessions(userId, db)` — D1 query returning `SessionInfo[]`
- `forkSession(sessionId, fromEntryId, db)` — path copy with ID remapping
- `deleteSession(sessionId, db)` — `DELETE CASCADE`
- Unit tests: `buildSessionContext` with all entry type combinations, branch paths, compaction entries, empty sessions; all persistence functions against mock D1

**Spec refs:** [core.md — Context Reconstruction](core.md), [core.md — Persistence](core.md), [core.md — Fork Session](core.md)

---

## 5. `piccolo-core` — `AgentSessionDO`

The Durable Object that owns a live session. Wires `piccolo-agent` to persistence, manages the prompt pipeline, auto-retry, and compaction.

**Deliverables:**
- `AgentSessionDO extends DurableObject` with full `DOState`
- Cold start / rehydration: `initialize()` loading from D1 via `buildSessionContext`
- `prompt()` pipeline — all 8 steps from [core.md](core.md), returning `ReadableStream<AgentEvent>`
- `steer()`, `followUp()`, `abort()` delegating to `Agent`
- `getInfo()`, `getName()`, `setName()`, `getModel()`, `setModel()`, `getContextUsage()`, `branch()`, `compact()`, `delete()`, `fork()`
- `_handleAgentEvent()` — persistence, retry trigger, compaction trigger
- `checkRetry()` — exponential backoff with jitter, transient error detection
- `compact()` — threshold and overflow paths, `CompactionEntry` persistence
- Integration tests: full prompt → response cycle with mock AI Gateway + mock D1; cold start rehydration; retry; compaction trigger; abort; branch

**Spec refs:** [core.md — `AgentSessionDO`](core.md), [core.md — Auto-Retry](core.md), [core.md — Compaction](core.md)

---

## 6. `piccolo-core` — `ExtensionRunner`

The component that discovers, initialises, and dispatches to extension Workers.

**Deliverables:**
- `ExtensionRunner` class with `initialize(ctx)` loading from `CONFIG` KV
- All 6 emit methods with correct merge semantics from [core.md](core.md): `emitInput`, `emitBeforeAgentStart`, `emitContext`, `emitToolCall`, `emitToolResult`, `emitBeforeCompact`
- Fire-and-forget emit for all other events (`onAgentStart`, `onAgentEnd`, `onTurnStart`, etc.)
- `getSystemPromptAdditions()` — collect from all extensions, sort by priority
- `getCommands()` — collect all `CommandDescriptor[]` from extensions
- `parseCommand(text, commands)` — `/name args` parsing
- Unit tests: all merge rules with mock extension stubs; command parsing; empty extension list; single extension error isolation (one extension throws, others proceed)
- `test/mocks/extension-stub.ts` — configurable mock `IExtensionWorker`

**Spec refs:** [core.md — `ExtensionRunner`](core.md), [api.md §8](api.md)

---

## 7. `piccolo-core` — `SystemPromptAssembler`

Assembles the system prompt from the base constant and extension additions.

**Deliverables:**
- `PICCOLO_SYSTEM_PROMPT` constant — base system prompt text
- `SystemPromptAssembler.assemble(base, additions, activeTools, override?)` — full algorithm from [core.md](core.md)
- "Available Tools" section builder — one line per tool with `promptSnippet`
- "Tool Guidelines" section builder — bullet list from `promptGuidelines`
- Section ordering: `context → skills → guidelines → footer`
- Priority sorting within sections
- Unit tests: empty additions, all section types, tool guidelines, override, priority ordering

**Spec refs:** [core.md — `SystemPromptAssembler`](core.md)

---

## 8. `piccolo-core` — `IExtensionContext` Implementation

The `RpcTarget` stub passed to every extension handler call.

**Deliverables:**
- `ExtensionContextImpl extends RpcTarget` with all methods from [api.md §9](api.md)
- `sendUserMessage()` → `doStub.steer()`
- `sendFollowUp()` → push to `DOState.followUpQueue`
- `appendCustomMessage()` / `appendCustomEntry()` → `appendEntry()`
- `getEntries(customType?)` — walk current branch, filter custom entries
- `getModel()`, `setModel()`, `listModels()`
- `getActiveTools()` → `ToolDescriptor[]`, `setActiveTools()`
- `abort()`, `getContextUsage()`, `compact()`
- `getName()`, `setName()`, `getSystemPrompt()`
- Unit tests: each method delegates correctly; `getEntries` filtering; `setModel` writes entry

**Spec refs:** [core.md — `IExtensionContext`](core.md), [api.md §9](api.md)

---

## 9. `piccolo-core` — `IPiccoloCore` WorkerEntrypoint and `ISession` Stub

The public JSRPC surface that gateways connect to.

**Deliverables:**
- `PiccoloCore extends WorkerEntrypoint` implementing `IPiccoloCore` from [api.md §1](api.md)
- `newSession(options?)` → `Session` stub (lazy, no D1 write)
- `getSession(sessionId)` → `Session` stub
- `listSessions()` → query via `listSessions()` from item 4
- `listModels()` → static catalog from KV or hardcoded fallback
- `Session extends RpcTarget` implementing `ISession` from [api.md §2](api.md) — thin delegation to `AgentSessionDO`
- `Session.fork()` → creates new `Session` stub for the forked session
- `wrangler.jsonc` for `piccolo-core` with all bindings
- Integration tests: `newSession` → `session.prompt()` → stream events → `session.info()`; `listSessions`; `getSession` on non-existent → meaningful error

**Spec refs:** [api.md §1–2](api.md), [core.md — `IPiccoloCore`](core.md), [core.md — `ISession` stub](core.md)

---

## 10. Web UI Gateway — Cap'n Web RPC Server

The Worker that serves the Cap'n Web RPC endpoint and proxies to `piccolo-core`. No browser app yet — only the server-side.

**Deliverables:**
- `piccolo-web-gateway` Worker with service binding to `piccolo-core`
- `WebGatewayImpl extends RpcTarget` implementing `IWebGatewayApi`
- `WebGatewaySessionImpl extends RpcTarget` implementing `IWebGatewaySession`: all session methods, `prompt()` with `IAgentEventListener` callback and `IGatewayCallback` stub forwarding
- `TurnHandleImpl extends RpcTarget` implementing `ITurnHandle`: `abort()`, `done()`
- `AgentEvent` enrichment: call `tool.getGatewayUI("web")` per tool and attach `WebComponentDescriptor` to `tool_start`/`tool_end` events
- `IWebUiSessionDO` — `addConnection(request)`, `pushEvent(event)`, `getRecentEvents()`
- Static file serving: `GET /` → SPA shell, `GET /components/{id}.js` → component modules from R2
- Auth: CF Access JWT validation at WebSocket upgrade, `userId` bound into `WebGatewayImpl`
- `wrangler.jsonc` for web gateway with `CORE` service binding, `WEB_UI_SESSION` DO, `ASSETS` R2
- Integration tests: full `prompt()` cycle with mock core + mock `IAgentEventListener`; `IGatewayCallback` invocation; auth rejection; `IWebUiSessionDO` event fan-out; promise pipelining (newSession → prompt in one round trip)
- `test/mocks/piccolo-core.ts` — mock `IPiccoloCore` + `ISession`

**Spec refs:** [web_gateway.md](web_gateway.md), [api.md §6](api.md)

---

## 11. Telegram Gateway

The Worker that receives Telegram webhook updates and proxies to `piccolo-core`.

**Deliverables:**
- `piccolo-telegram-gateway` Worker with webhook handler at `POST /webhook/{token-hash}`
- `ITelegramChatDO` — `handleUpdate()` serialising concurrent updates per chat
- Chat → session mapping in KV: first message creates session, subsequent messages look up
- `AgentEvent` → Telegram message adaptation: typing indicator, throttled edits, message splitting, `tool_start`/`tool_end` status lines
- `IGatewayCallback` implementation: inline keyboards for `requestSelect`, `requestConfirm`; message-wait for `requestInput`
- `ITelegramUI` lookup: call `tool.getGatewayUI("telegram")` before rendering tool calls/results
- All gateway slash commands: `/new`, `/model`, `/models`, `/abort`, `/status`, `/compact`, `/help`
- Auth: bot token hash validation; KV allowlist
- `wrangler.jsonc` for telegram gateway
- Integration tests: webhook verification; chat→session mapping; `AgentEvent` rendering; slash command dispatch; `ITelegramChatDO` serialisation

**Spec refs:** [telegram_gateway.md](telegram_gateway.md), [api.md §5, §7](api.md)

---

## 12. `ext-r2-tool` — R2 Storage Tool

First provided tool. Validates the full `ITool` → extension Worker → dispatch namespace pipeline end-to-end.

**Deliverables:**
- `R2ToolExtension extends WorkerEntrypoint` implementing `IExtensionWorker`
- `getTools()` returning the R2 `ToolDescriptor` with full `inputSchema`
- `executeTool()` dispatching all 7 actions: `read`, `write`, `delete`, `list`, `stat`, `copy`, `move`
- All result `details` types: `R2ReadDetails`, `R2WriteDetails`, `R2DeleteDetails`, `R2ListDetails`, `R2StatDetails`, `R2CopyDetails`
- `wrangler.jsonc` with `BUCKET` R2 binding
- Unit tests: all 7 actions against `createMockR2()`; binary encoding/decoding; move atomicity (put succeeds, delete only after); error paths (not found, etc.)

**Spec refs:** [r2_tool.md](r2_tool.md), [tools.md](tools.md)

---

## 13. `ext-d1-tool` — D1 Database Tool

**Deliverables:**
- `D1ToolExtension extends WorkerEntrypoint` implementing `IExtensionWorker`
- `getTools()` returning the D1 `ToolDescriptor`
- `executeTool()` dispatching all 7 actions: `schema`, `select`, `insert`, `update`, `delete`, `schema_change`, `sql`
- All result `details` types: `D1SchemaDetails`, `D1SelectDetails`, `D1InsertDetails`, `D1UpdateDetails`, `D1DeleteDetails`, `D1SchemaChangeDetails`, `D1SqlDetails`
- `confirm: true` guard on `schema_change`
- `dryRun` path on `delete`
- `wrangler.jsonc` with `DB` D1 binding
- Unit tests: all 7 actions against `createMockD1()`; parameterised queries; batch insert; dry-run; schema_change guard; LIMIT injection

**Spec refs:** [d1_tool.md](d1_tool.md), [tools.md](tools.md)

---

## 14. `ext-skills` — Skills Extension

**Deliverables:**
- `SkillsExtension extends WorkerEntrypoint` implementing `IExtensionWorker`
- `onSessionStart`: fetch skills from source list, parse frontmatter, build registry
- `getSystemPromptAdditions()`: return `skills` section listing names + descriptions
- `getCommands()`: one `CommandDescriptor` per skill
- `onInput()`: handle `/skill:{name}` commands — fetch full content, optionally append args, return `transform`
- KV caching with TTL
- JSRPC admin endpoints: `addSource()`, `removeSource()`, `listSources()`, `reloadSkills()`, `listSkills()`, `getSkillContent()`
- Frontmatter validation per Agent Skills spec
- `wrangler.jsonc` with `SKILLS_CACHE` KV
- Unit tests: source loading, frontmatter parsing, validation rules, command registration, input transform, KV cache hit/miss

**Spec refs:** [skills_extension.md](skills_extension.md)

---

## 15. `ext-templates` — Prompt Templates Extension

**Deliverables:**
- `TemplatesExtension extends WorkerEntrypoint` implementing `IExtensionWorker`
- `onSessionStart`: fetch templates from source list, extract name + description
- `getSystemPromptAdditions()`: return `context` section listing templates
- `getCommands()`: one `CommandDescriptor` per template
- `onInput()`: handle `/template:{name}` commands — fetch content, substitute arguments, return `transform`
- Argument substitution: `$1`, `$2`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`
- Quoted argument parsing (shell-style)
- KV caching with TTL
- JSRPC admin endpoints: `addSource()`, `removeSource()`, `listSources()`, `reloadTemplates()`, `listTemplates()`, `getTemplateContent()`, `expandTemplate()`
- `wrangler.jsonc` with `TEMPLATES_CACHE` KV
- Unit tests: argument substitution (all forms), quoted parsing, unresolved placeholders, cache, command registration

**Spec refs:** [prompt_templates_extension.md](prompt_templates_extension.md)

---

## 16. Web UI SPA

The browser-side single-page application. Depends on the Web UI Gateway HTTP API (item 10) being stable.

**Deliverables:**
- Framework choice (React recommended — consistent with `IWebUI` component model)
- Vite project setup inside `gateways/web/app/`
- Message list rendering: user messages, assistant messages (streaming text, reasoning blocks), tool calls (pending + collapsed), error messages
- Incremental streaming: `text_delta` events appended without full re-render
- Input: multi-line, Enter to submit (configurable), attachment upload, abort button
- Session management: create, list, resume, delete, rename, fork
- Model picker: `GET /api/models`, `PUT /api/sessions/:id/model`
- Context usage indicator
- Slash command autocomplete: `/new`, `/model`, `/fork`, `/compact` + extension commands from `getCommands()`
- `IGatewayCallback` modal UI: select dialog, confirm dialog, text input dialog
- Custom tool component mounting: `IWebUI.getComponent()` → dynamic import by `componentId`
- Auth: pass Cloudflare Access JWT in requests
- Build output served from R2 or bundled into the Worker

**Spec refs:** [web_gateway.md — Browser SPA](web_gateway.md)

---

## 17. End-to-End Integration Tests

Full system smoke tests after all pieces are in place.

**Deliverables:**
- `tests/e2e/` — Vitest tests running against a locally deployed Miniflare stack (core + web gateway + r2-tool + d1-tool)
- Scenario: new session → prompt → streaming response → verify `AgentEvent` sequence
- Scenario: prompt → tool call (r2 read) → tool result → follow-up response
- Scenario: long conversation → compaction trigger → context reconstructed correctly after compaction
- Scenario: session fork → verify branched history is independent
- Scenario: extension permission gate blocking a tool call
- Scenario: skills extension expanding `/skill:test-skill` input
- Scenario: Telegram gateway webhook → session created → response sent (mock Telegram Bot API)
- CI gate: E2E tests run in `ci.yml` against Miniflare; skipped if `CF_AI_GATEWAY_TOKEN` is absent (use mock gateway)

**Spec refs:** all spec files

---

## Summary Table

| # | Item | Package/Worker | Key spec |
|---|---|---|---|
| 1 | Project setup | workspace | [code.md](code.md), [infrastructure.md](infrastructure.md) |
| 2 | `piccolo-agent` | `packages/agent` | [agent.md](agent.md) |
| 3 | D1 schema + migrations | `packages/core` | [core.md — D1 Schema](core.md) |
| 4 | Session persistence layer | `packages/core` | [core.md — Persistence](core.md) |
| 5 | `AgentSessionDO` | `packages/core` | [core.md — AgentSessionDO](core.md) |
| 6 | `ExtensionRunner` | `packages/core` | [core.md — ExtensionRunner](core.md) |
| 7 | `SystemPromptAssembler` | `packages/core` | [core.md — SystemPromptAssembler](core.md) |
| 8 | `IExtensionContext` impl | `packages/core` | [core.md — IExtensionContext](core.md) |
| 9 | `IPiccoloCore` + `ISession` | `packages/core` | [api.md §1–2](api.md) |
| 10 | Web UI Gateway HTTP API | `gateways/web` | [web_gateway.md](web_gateway.md) |
| 11 | Telegram Gateway | `gateways/telegram` | [telegram_gateway.md](telegram_gateway.md) |
| 12 | `ext-r2-tool` | `extensions/r2-tool` | [r2_tool.md](r2_tool.md) |
| 13 | `ext-d1-tool` | `extensions/d1-tool` | [d1_tool.md](d1_tool.md) |
| 14 | `ext-skills` | `extensions/skills` | [skills_extension.md](skills_extension.md) |
| 15 | `ext-templates` | `extensions/templates` | [prompt_templates_extension.md](prompt_templates_extension.md) |
| 16 | Web UI SPA | `gateways/web/app` | [web_gateway.md — SPA](web_gateway.md) |
| 17 | E2E integration tests | `tests/e2e` | all |
