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
| typescript | ^6.0.2 |
| vitest | ^4.1.0 (minimum required by `@cloudflare/vitest-pool-workers`) |
| @cloudflare/vitest-pool-workers | ^0.13.4 |
| @biomejs/biome | ^2.4.8 |

#### Wrangler config format

All `wrangler.template.jsonc` files use the JSON format (not TOML), which is the Cloudflare recommendation for new projects as of Wrangler 3.91+. The `$schema` key points to `./node_modules/wrangler/config-schema.json` for IDE validation.

#### Durable Object migrations

All new Durable Objects (`AgentSessionDO`, `WebUiSessionDO`, `TelegramChatDO`) are declared with `new_sqlite_classes` (not the legacy `new_classes`). SQLite-backed DOs are the current Cloudflare default and provide built-in SQL storage.

#### Vitest Workers integration — updated API

The `@cloudflare/vitest-pool-workers` package now requires **Vitest 4.1+** and uses the `cloudflareTest()` plugin API:

```typescript
// vitest.config.ts (Workers packages)
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.template.jsonc" } })],
  test: { coverage: { provider: "v8", thresholds: { lines: 80, functions: 80, branches: 70 } } },
});
```

The older `defineWorkersConfig` API from the package's own exports is superseded by this plugin approach. `packages/core/test/` includes a `tsconfig.json` and `env.d.ts` as required by the latest CF Vitest docs.

#### TypeScript runtime types — migrated to `wrangler types`

Per the [Cloudflare migration guide](https://developers.cloudflare.com/workers/languages/typescript/#generate-types), `@cloudflare/workers-types` has been **removed** from the project. All runtime types (Web APIs + CF binding shapes) now come from `wrangler types`-generated `worker-configuration.d.ts` files.

- `@cloudflare/workers-types` is **not** installed.
- `tsconfig.base.json` uses `"lib": ["ES2022"]` only — no `WebWorker`. Worker packages get Web APIs + CF types from `worker-configuration.d.ts`.
- `packages/agent` (pure library, no wrangler) overrides to `"lib": ["ES2022", "WebWorker"]` in its own tsconfig to retain Web API types.
- Each Worker package has a `types` script: `wrangler types src/worker-configuration.d.ts --config wrangler.template.jsonc`. The generated file is committed (not gitignored) so CI does not need to regenerate it on every run.
- Worker package `tsconfig.json` files reference the generated file via `"types": ["./src/worker-configuration.d.ts"]`.

#### Biome JSONC handling

Biome's default JSON parser rejects comments in `.json` files. `tsconfig*.json` files use JSONC (comments + trailing commas). Fixed via a Biome `overrides` entry (now `overrides[].includes` in Biome 2):

```json
"overrides": [
  {
    "includes": ["tsconfig*.json", "**/tsconfig*.json"],
    "json": { "parser": { "allowComments": true, "allowTrailingCommas": true } }
  }
]
```

`wrangler.template.jsonc` files are not parsed by Biome (the `.jsonc` extension is not in Biome's default file list).

#### `packages/core/src/types.ts` — forward-reference strategy

The session/context type was originally declared as `type IExtensionContext = unknown` with a `TODO(item-8)` comment to avoid a circular dependency. Item 8 resolved this: `IExtensionContext` was eliminated entirely; `ISession extends IAgentSession` is the single unified interface for gateways, extensions, and tools. All other Shared Types from `api.md` were fully shaped from the start.

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

## 4. `piccolo-core` — Session Persistence Layer ✅

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

### 4.1 Implementation Notes

**Status:** Complete. All deliverables present. `pnpm biome check .` and `pnpm -r exec tsc --noEmit` both pass with zero errors. 114 tests pass (30 context + 26 persistence + 58 carried from step 3), coverage: statements 100%, functions 100%, lines 100%, branches 94.66%.

#### File layout

| File | Contents |
|---|---|
| `packages/core/src/session/context.ts` | `walkToRoot`, `buildSessionContext`, `DEFAULT_MODEL_ID` |
| `packages/core/src/session/persistence.ts` | `createSession`, `commitSession`, `appendEntry`, `flushPendingEntries`, `listSessions`, `forkSession`, `deleteSession` |
| `packages/core/src/session/index.ts` | Re-exports from both modules |
| `packages/core/test/session/context.test.ts` | 30 tests for context reconstruction |
| `packages/core/test/session/persistence.test.ts` | 26 tests against real Miniflare D1 |

#### `createSession` signature — no `db` argument

`createSession()` takes no arguments (not even `db`) because it is purely lazy — it only returns `crypto.randomUUID()` without touching D1. The `db` argument listed in the plan deliverables was dropped as unnecessary.

#### `forkSession` signature — additional required arguments

`forkSession` requires `currentLeafId`, `userId`, and `modelId` in addition to `sessionId`, `fromEntryId`, and `db`. These are needed to create the new session row and to resolve the active leaf when `fromEntryId` is omitted.

#### Compaction layout and message ordering

The compaction entry in the tree sits **after** its `firstKeptEntryId` in the parent-child chain:
```
... firstKeptEntry → compactionEntry → nextEntry ...
```
`buildSessionContext` emits the synthetic summary message first, then `firstKeptEntry` onward (skipping the compaction entry node itself, which was already represented by the summary). This matches the spec output: `[ summaryMsg, firstKeptMsg, ..., nextMsg ]`.

---

## 5. `piccolo-core` — `AgentSessionDO` ✅

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

### 5.1 Implementation Notes

**Status:** Complete. 158 tests pass, 71.36% branch coverage (threshold: 70%). `tsc --noEmit` passes with zero errors.

#### Files created

| File | Purpose |
|---|---|
| `packages/core/src/do/agent-session.ts` | `AgentSessionDO` class — full DO implementation |
| `packages/core/src/do/compaction.ts` | `compact()` helper; creates `CompactionEntry`, calls `agentCompact()` |
| `packages/core/src/do/retry.ts` | `checkRetry()` with exponential backoff, transient/overflow classification |
| `packages/core/src/do/gateway.ts` | `createModel()` — wraps `ai-gateway-provider` with env bindings |
| `packages/core/src/do/system-prompt.ts` | `buildBasePrompt(agentName)` — renders the base prompt template |
| `packages/core/src/do/stubs.ts` | `ExtensionRunnerStub`, `SystemPromptAssemblerStub` — no-op stubs for steps 6–7 |
| `packages/core/src/do/types-internal.ts` | `SystemPromptAddition`, `MODEL_CATALOG`, `resolveModel()` |
| `packages/core/test/do/agent-session.test.ts` | 26 integration tests using Miniflare + `runInDurableObject` |
| `packages/core/test/do/mock-model.ts` | `createMockModel()` — Workers-compatible mock for `LanguageModel` |
| `packages/core/test/do/retry.test.ts` | 9 unit tests for retry classification and backoff logic |
| `packages/core/test/do/system-prompt.test.ts` | 7 unit tests for `buildBasePrompt` and `resolveModel` |

#### Key design decisions

**`AGENT_NAME` var**: The agent's display name (e.g. `"Piccolo"`) is sourced from `env.AGENT_NAME` (set in `wrangler.template.jsonc`). `buildBasePrompt(agentName)` renders it into the base system prompt. Steps 6–7 will extend this further.

**Model creation deferred**: `createModel(env, modelId)` is called at construction time (in `#initialize()`) and on `initSession()`. Tests override the model via `_setModelForTest(mock)` before calling `initSession()` — the `modelOverridden` flag prevents `initSession` from replacing the mock.

**`waitForFlush()` pattern**: `_handleAgentEnd()` is triggered from the agent's subscribe callback (fire-and-forget). A `#flushPromise` field stores the in-flight promise. Tests call `await instance.waitForFlush()` after draining the event stream to ensure D1 writes complete before assertions.

**`TransformStream` streaming**: `prompt()` returns a `ReadableStream<AgentEvent>` constructed via `TransformStream`. The agent's `subscribe()` listener writes events to the writable side; the readable side is returned to the caller. Compatible with Cloudflare DO JSRPC `ReadableStream` return values.

**Context usage**: Computed as `lastInputTokens + heuristicDelta`. `lastInputTokens` is updated from the real AI SDK `totalUsage` on `agent_end`. `heuristicDelta` estimates tokens for any messages added since the last turn using chars/4.

**`compaction.ts` no-op guard**: If `agentCompact` returns `summary: ""` (nothing to summarize — `toSummarize` was empty), `compact()` returns without writing a `CompactionEntry`. This prevents spurious entries on over-large `keepRecentTokens` budgets.

---

## 6. `piccolo-core` — `ExtensionRunner` ✅

The component that discovers, initialises, and dispatches to extension Workers.

**Deliverables:**
- `ExtensionRunner` class with `initialize(ctx)` loading from `CONFIG` KV
- All 6 emit methods with correct merge semantics from [core.md](core.md): `emitInput`, `emitBeforeAgentStart`, `emitContext`, `emitToolCall`, `emitToolResult`, `emitBeforeCompact`
- Fire-and-forget emit for all other events (`onAgentStart`, `onAgentEnd`, `onTurnStart`, etc.)
- `getSystemPromptAdditions()` — collect from all extensions, sort by priority
- `getCommands()` — collect all `CommandDescriptor[]` from extensions
- `getToolDescriptors()` — collect all `ToolDescriptorLike[]` from extensions
- `parseCommand(text, commands)` — `/name args` parsing
- Unit tests: all merge rules with mock extension stubs; command parsing; empty extension list; single extension error isolation (one extension throws, others proceed)
- `test/mocks/extension-stub.ts` — configurable mock `IExtensionWorker`

**Spec refs:** [core.md — `ExtensionRunner`](core.md), [api.md §8](api.md)

### 6.1 Implementation Notes

**Status:** Complete. 207 tests pass (49 new: 40 ExtensionRunner + 9 carried from mock). Coverage: statements 86.31%, functions 84.28%, branches 75.63% — all above thresholds (80/80/70). `pnpm biome check .` and `pnpm -r exec tsc --noEmit` both pass with zero errors (1 pre-existing `noNonNullAssertion` warning in agent-session.test.ts, not introduced by step 6).

#### File layout

| File | Contents |
|---|---|
| `packages/core/src/do/extension-runner.ts` | `ExtensionRunner` class; all event/result types; `IExtensionRunner` interface; `IExtensionWorkerLike` interface; `parseCommand()` |
| `packages/core/src/do/stubs.ts` | `SystemPromptAssemblerStub` only (removed in step 7; `IExtensionContextLike` removed in step 8) |
| `packages/core/src/do/compaction.ts` | Updated to use `IExtensionRunner` interface (not `ExtensionRunnerStub`) |
| `packages/core/src/do/agent-session.ts` | Updated to instantiate and call `ExtensionRunner`; `DOState.extensionRunner` typed as `ExtensionRunner` |
| `packages/core/test/do/extension-runner.test.ts` | 40 unit tests covering all merge rules, error isolation, command parsing |
| `packages/core/test/mocks/extension-stub.ts` | `createMockExtension()`, `createMockKv()`, `createMockDispatchNamespace()` |

#### Key design decisions

**`IExtensionRunner` interface**: Both `ExtensionRunner` (real) and any future stub implement this interface. `CompactionState.extensionRunner` is typed as `IExtensionRunner` so the compaction function remains decoupled from the concrete class.

**`emitContext` included**: Although the current `prompt()` pipeline does not yet call `emitContext` (no `prepareStep` hook yet), the method is present on `ExtensionRunner` and fully tested. Wiring it into the agent loop's `prepareStep` is deferred to step 8 or step 9 when the full pipeline is assembled.

**`getToolDescriptors()`**: Collects `ToolDescriptorLike[]` from all extensions during `initialize()`. `AgentSessionDO` passes these to `assembler.assemble()` for system prompt construction. Tool execution routing via `executeTool` is not yet wired (step 9).

**Error isolation in `initialize()`**: `getTools()`, `getCommands()`, and `getSystemPromptAdditions()` are all individually `.catch()`-wrapped. A throwing extension's registration data is skipped; the extension stub is NOT added to `#stubs`, so fire-and-forget emit calls also skip it.

**`onSessionStart` timing**: Called during `initialize()` after all registration data is collected. Fire-and-forget — errors from `onSessionStart` are swallowed so they do not block DO startup.

**`DispatchNamespace` in Miniflare**: The Miniflare test environment does not support `DispatchNamespace` locally (warning emitted at test startup). `AgentSessionDO.#initialize()` calls `extensionRunner.initialize()` with the real `env.EXTENSIONS` binding, which Miniflare stubs as a no-op that returns no stubs. This means existing agent-session integration tests are unaffected: the extension list is empty, and all emit calls return their neutral defaults — identical to the prior `ExtensionRunnerStub` behaviour.

---

## 7. `piccolo-core` — `SystemPromptAssembler` ✅

Assembles the system prompt from the base constant and extension additions.

**Deliverables:**
- `buildBasePrompt(agentName)` renders the base prompt template (already implemented in step 5); step 7 wires `SystemPromptAssembler` to use it
- `SystemPromptAssembler.assemble(base, additions, activeTools, override?)` — full algorithm from [core.md](core.md)
- "Available Tools" section builder — one line per tool with `promptSnippet`
- "Tool Guidelines" section builder — bullet list from `promptGuidelines`
- Section ordering: `context → skills → guidelines → footer`
- Priority sorting within sections
- Unit tests: empty additions, all section types, tool guidelines, override, priority ordering

**Spec refs:** [core.md — `SystemPromptAssembler`](core.md)

### 7.1 Implementation Notes

**Status:** Complete. 233 tests pass (26 new assembler tests). Coverage: statements 86.81%, functions 85.23%, branches 76.21% — all above thresholds (80/80/70). `pnpm biome check .` and `pnpm -r exec tsc --noEmit` both pass with zero errors.

#### File layout

| File | Contents |
|---|---|
| `packages/core/src/do/system-prompt-assembler.ts` | `SystemPromptAssembler` class |
| `packages/core/src/do/stubs.ts` | `SystemPromptAssemblerStub` removed; `IExtensionContextLike` re-export also removed in step 8 |
| `packages/core/src/do/agent-session.ts` | Import and type updated to use `SystemPromptAssembler` |
| `packages/core/test/do/system-prompt-assembler.test.ts` | 26 unit tests covering all assembly cases |

#### Key design decisions

**`ToolDescriptorLike[]` instead of `ITool[]`**: The `assemble()` method takes `ToolDescriptorLike[]` (the duck-typed shape from `ExtensionRunner`) rather than `ITool[]` (the full `piccolo-core` interface defined in step 12). Only `promptSnippet` and `promptGuidelines` are accessed — both present on `ToolDescriptorLike`. When step 12 implements real `ITool` / `ToolDescriptor`, the type is structurally compatible with no changes needed to the assembler.

**Section ordering**: `base → context → skills → available-tools → guidelines → tool-guidelines → footer`. The "Available Tools" section (from `promptSnippet`) is placed between skills and guidelines additions, matching the spec's intent that tool discovery information comes before usage guidelines.

**Override short-circuit**: If `override` is truthy, it is returned verbatim. All additions and tool processing are skipped entirely — consistent with spec.

**Priority default of 100**: Additions without an explicit `priority` field are sorted as if `priority === 100`. This places them after items with `priority < 100` and before items with `priority > 100`.

**Empty section filtering**: `parts.filter(Boolean)` removes any empty strings before joining with `\n\n`, so sections that produce no output (e.g. no tools with snippets) leave no blank separators in the output.

---

## 8. `piccolo-core` — `ISession` as unified context ✅

Implements the full `ISession` interface as the context object passed to every
extension handler call and every tool `execute()` call. Eliminates the former
`IExtensionContext` / `IExtensionContextLike` concept — there is one interface
(`ISession`) serving both gateways and extensions/tools.

**Deliverables:**
- `IAgentSession` — minimal empty interface in `packages/agent`; typed as `ctx` in `IAgentTool.execute()`
- `Agent.setContext(ctx: IAgentSession)` + `toAiSdkTools(tools, ctx)` — threads session into tool execute calls
- `ISession extends IAgentSession` in `packages/core/src/types.ts` — full unified surface; all extension-specific methods merged in (`sendUserMessage`, `appendCustomMessage`, `appendCustomEntry`, `getEntries`, `getSystemPrompt`, `listModels`, `getActiveTools`, `setActiveTools`)
- `packages/core/src/do/do-state.ts` — extracted `DOState` interface; adds `branchEntries: AnyEntry[]` and `session: ISession | null`
- `packages/core/src/do/context.ts` — `SessionImpl extends RpcTarget implements ISession`; holds live `DOState` reference; delegates all methods; no D1 flush (flush at `agent_end`)
- `ExtensionToolAdapter` in `extension-runner.ts` — wraps extension tool descriptors into full `IAgentTool` instances that dispatch via `executeTool()` with live `ISession` as `ctx`
- `getToolsByNames(names)` on `ExtensionRunner` — used by `ISession.setActiveTools()`
- `AgentSessionDO` wired: creates `SessionImpl` before `extensionRunner.initialize()`, stores in `doState.session`, calls `agent.setContext(session)` at start of each `prompt()`
- `doState.branchEntries` populated from D1 on cold start; `appendCustomEntry`/`appendCustomMessage` append to both `pendingEntries` and `branchEntries`; `getEntries()` reads from `branchEntries` (no D1 roundtrip)
- `test/mocks/extension-stub.ts` — `createMockSession()` helper; all `ctx` params updated to `ISession`
- 38 unit tests for `SessionImpl` in `test/do/context.test.ts`

**Key design decisions:**
- **No `*Impl` references in public signatures** — all call sites use `ISession`; only `context.ts` knows `SessionImpl`
- **`ISession` = gateway context = extension context = tool context** — one interface, passed by JSRPC across Worker boundaries
- **`DOState` extracted** to `do-state.ts` to break the `agent-session.ts` ↔ `context.ts` circular import
- **`followUp()` queues to `doState.followUpQueue`** — drained by `AgentSessionDO` at `agent_end` (not by `SessionImpl` directly)

**Spec refs:** [core.md — `ISession`](core.md), [api.md §2](api.md), [agent.md §IAgentSession](agent.md)

### 8.1 Implementation Notes

**Status:** Complete. 267 tests pass in `packages/core`, 50 in `packages/agent`. Coverage: statements 85.69%, functions 86.47%, branches 72.5% — all above thresholds (80/80/70). `pnpm biome check .` and `pnpm -r exec tsc --noEmit` both pass with zero errors.

#### File layout

| File | Contents |
|---|---|
| `packages/agent/src/types.ts` | `IAgentSession` interface (empty), updated `IAgentTool.execute(ctx: IAgentSession)` |
| `packages/agent/src/tools.ts` | `toAiSdkTools(tools, ctx: IAgentSession)` threads ctx through to tool execute |
| `packages/agent/src/agent.ts` | `_ctx: IAgentSession`, `setContext()`, passes to `toAiSdkTools` |
| `packages/core/src/types.ts` | `ISession extends IAgentSession` — full unified interface (replaces `IExtensionContext = unknown`) |
| `packages/core/src/do/do-state.ts` | New: `DOState` interface with `branchEntries` and `session: ISession \| null` |
| `packages/core/src/do/session-impl.ts` | New: `SessionImpl extends RpcTarget implements ISession` |
| `packages/core/src/do/extension-runner.ts` | `ExtensionToolAdapter`, `getToolsByNames()`, all ctx params → `ISession` |
| `packages/core/src/do/agent-session.ts` | Wires `SessionImpl`, `branchEntries`, `agent.setContext()` |
| `packages/core/src/do/compaction.ts` | `ctx: ISession` |
| `packages/core/test/do/context.test.ts` | New: 38 unit tests for `SessionImpl` |
| `packages/core/test/mocks/extension-stub.ts` | `createMockSession()` added; all `ctx: ISession` |

#### `ISession` is one interface serving three roles

| Caller | Receives | Purpose |
|---|---|---|
| Gateways (step 9) | `ISession` via `IPiccoloCore.newSession()` | Start prompts, manage session metadata |
| Extension handlers | `ISession` as `ctx` param | React to events, append entries, steer messages |
| Tool `execute()` | `ISession` as `ctx` param (via `agent.setContext`) | Access session state, append custom entries |

#### `IAgentSession` rationale

`packages/agent` cannot depend on `packages/core`. The agent loop needs to pass
`ctx` opaquely to tools without knowing what a session can do. `IAgentSession` is
an intentionally empty interface — a stable type anchor. At runtime the value is
always a full `ISession`. Tools cast to `ISession` inside `execute()`.

#### `branchEntries` and cold start

On cold start, `AgentSessionDO.#initialize()` calls `walkToRoot(allEntries, leafId)`
and stores the result in `doState.branchEntries`. New entries from
`appendCustomEntry`/`appendCustomMessage`/`setName`/`setModel` are pushed to both
`pendingEntries` (for D1 flush) and `branchEntries` (for `getEntries()` queries).
This avoids a D1 roundtrip on every `getEntries()` call.

#### `ExtensionToolAdapter` and JSRPC tool dispatch

When `ExtensionRunner.initialize()` collects tools via `stub.getTools()`, each
`ToolDescriptorLike` is wrapped in an `ExtensionToolAdapter implements IAgentTool`.
The adapter's `execute()` calls `stub.executeTool(name, toolCallId, params, ctx)`
where `ctx` is the live `ISession` — a real `RpcTarget` that crosses the Worker
dispatch boundary. This is the correct JSRPC pattern: the extension Worker
receives a callable stub back to the session, not a plain data object.

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
- `wrangler.template.jsonc` for `piccolo-core` with all bindings
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
- `wrangler.template.jsonc` for web gateway with `CORE` service binding, `WEB_UI_SESSION` DO, `ASSETS` R2
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
- `wrangler.template.jsonc` for telegram gateway
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
- `wrangler.template.jsonc` with `BUCKET` R2 binding
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
- `wrangler.template.jsonc` with `DB` D1 binding
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
- `wrangler.template.jsonc` with `SKILLS_CACHE` KV
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
- `wrangler.template.jsonc` with `TEMPLATES_CACHE` KV
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
| 8 | `ISession` as unified context | `packages/core`, `packages/agent` | [api.md §2](api.md), [agent.md §IAgentSession](agent.md) |
| 9 | `IPiccoloCore` + `ISession` | `packages/core` | [api.md §1–2](api.md) |
| 10 | Web UI Gateway HTTP API | `gateways/web` | [web_gateway.md](web_gateway.md) |
| 11 | Telegram Gateway | `gateways/telegram` | [telegram_gateway.md](telegram_gateway.md) |
| 12 | `ext-r2-tool` | `extensions/r2-tool` | [r2_tool.md](r2_tool.md) |
| 13 | `ext-d1-tool` | `extensions/d1-tool` | [d1_tool.md](d1_tool.md) |
| 14 | `ext-skills` | `extensions/skills` | [skills_extension.md](skills_extension.md) |
| 15 | `ext-templates` | `extensions/templates` | [prompt_templates_extension.md](prompt_templates_extension.md) |
| 16 | Web UI SPA | `gateways/web/app` | [web_gateway.md — SPA](web_gateway.md) |
| 17 | E2E integration tests | `tests/e2e` | all |
