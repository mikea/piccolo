# `piccolo-core` — Specification

`piccolo-core` is the central Cloudflare Worker of the piccolo system. It is the JSRPC hub that gateways and extensions connect to. It owns session state, contains the agent loop, dispatches to extensions, assembles system prompts, and persists conversation history.

All public interfaces are defined in [api.md](api.md). This document specifies the internal implementation of those interfaces.

The agent loop (`AgentSessionDO`, `toAiSdkTools`, `agentCompact`) lives directly in `packages/core/src/` — there is no separate `packages/agent` library. The `ai` and `ai-gateway-provider` packages are used directly by piccolo-core.

---

## Responsibilities

| Responsibility | Mechanism |
|---|---|
| Expose `IPiccoloCore` and `ISession` to gateways | `WorkerEntrypoint` JSRPC |
| Own one `AgentSessionDO` per session | Durable Object |
| Run the agent loop | `AgentSessionDO` private methods + helpers in `compact.ts` / `agent-tools.ts` |
| Persist conversation history | D1 + DO storage |
| Dispatch events to extensions | `ExtensionRunner` via `EXTENSION_*` service bindings |
| Assemble the system prompt | `SystemPromptAssembler` |
| Manage model selection | Stored per session in D1 |
| Trigger and persist context compaction | `compact()` in `compact.ts`, called by DO |

---

## Bindings

Declared in `packages/core/wrangler.template.jsonc`:

```jsonc
{
  "name": "piccolo-core",
  "durable_objects": {
    "bindings": [
      { "name": "AGENT_SESSION", "class_name": "AgentSessionDO" }
    ]
  },
  "d1_databases": [
    { "binding": "SESSIONS_DB", "database_name": "piccolo-sessions", "database_id": "<D1_ID>" }
  ],
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "piccolo-assets" }
  ],
  "services": [
    { "binding": "EXTENSION_FETCH_TOOL", "service": "ext-fetch-tool" },
    { "binding": "EXTENSION_R2_TOOL", "service": "ext-r2-tool" },
    { "binding": "EXTENSION_INSTRUCTIONS", "service": "ext-instructions" }
  ],
  "vars": {
    "CF_ACCOUNT_ID": "<account_id>",
    "CF_AI_GATEWAY_NAME": "piccolo",
    "AGENT_NAME": "Piccolo",  // display name injected into the base system prompt
    "MODELS": "provider/model-id,provider/model-id2",  // comma-separated model IDs; authoritative list
    "COMPACT_TOKENS": "100000"    // token count threshold for context compaction
  }
  // Secrets (set via: pnpm wrangler secret put <NAME>):
  //   CF_AI_GATEWAY_TOKEN  — CF API token with AI Gateway Write permission
}
```

---

## D1 Schema

Database: `piccolo-sessions`

```sql
CREATE TABLE sessions (
  id          TEXT    PRIMARY KEY,          -- UUID v4
  user_id     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,             -- Unix ms
  updated_at  INTEGER NOT NULL,             -- Unix ms
  name        TEXT,
  cwd         TEXT,
  model_id    TEXT    NOT NULL,             -- no SQL default; callers always supply explicitly
  leaf_id     TEXT                          -- current active entry ID
);

CREATE TABLE entries (
  append_seq  INTEGER PRIMARY KEY AUTOINCREMENT,  -- canonical append order within DB
  id          TEXT    NOT NULL,             -- UUID v4; for message rows this also matches IMessage.id
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id   TEXT,                         -- null for root entry
  type        TEXT    NOT NULL,             -- discriminant (see Entry Types)
  timestamp   TEXT    NOT NULL,             -- ISO 8601
  data        TEXT    NOT NULL CHECK (json_valid(data)),  -- JSON payload; DB-level validity enforced
  UNIQUE (session_id, id)
);

CREATE INDEX entries_session     ON entries(session_id, append_seq);
CREATE INDEX entries_parent      ON entries(session_id, parent_id);
CREATE INDEX sessions_user       ON sessions(user_id, updated_at DESC);
```

---

The extension set is configured by core service bindings: every binding whose name starts with `EXTENSION_` is treated as an extension worker.

Changing the enabled extension set (adding/removing/renaming `EXTENSION_*` bindings) requires a `piccolo-core` redeploy.

---

## R2 Schema

Bucket bound as `ASSETS`:

| Key pattern | Contents |
|---|---|
| `sessions/{sessionId}/attachments/{attachmentId}` | User-uploaded file blobs |

---

## Entry Types

All entries share `EntryBase` and are stored as JSON in `entries.data`:

```typescript
interface EntryBase {
  id: string;              // UUID v4; assigned once and never changes
  sessionId: string;
  parentId: string | null;
  type: EntryType;
  timestamp: string;       // ISO 8601
  data: unknown;
}

type EntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "label"
  | "session_info";
```

### Entry type details

```typescript
// "message" — a single LLM message (user | assistant | tool | system)
interface MessageEntry extends EntryBase {
  type: "message";
  data: IMessage;
}

// "model_change" — active model switched
interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  data: { modelId: string };
}

// "thinking_level_change" — reserved for future thinking-level tracking
interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  data: { thinkingLevel: string };
}

// "compaction" — context was summarised; firstKeptEntryId marks resumption point
interface CompactionEntry extends EntryBase {
  type: "compaction";
  data: { summary: string; firstKeptEntryId: string | undefined; tokensBefore: number };
}

// "branch_summary" — summary of an abandoned branch stored at the fork point
interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  data: { summary: string; fromId: string; fromHook?: boolean };
}

// "label" — user bookmark on an entry
interface LabelEntry extends EntryBase {
  type: "label";
  data: { targetId: string; label: string | undefined };
}

// "session_info" — root entry storing session display metadata
interface SessionInfoEntry extends EntryBase {
  type: "session_info";
  data: { name?: string };
}
```

---

## Session Tree

Entries form an append-only tree. `parentId` links each entry to its predecessor. The active path from the current `leafId` back to the root is the conversation the agent sees.

```
null ← session_info  (root, parentId = null)
  └─ "a1b2"  message: user "Hello"
        └─ "b2c3"  message: assistant "Hi!"
              ├─ "c3d4"  message: user "try A"
              │     └─ "d4e5"  message: assistant  (branch A)
              └─ "e5f6"  message: user "try B"   ← leafId (active branch)
                    └─ "f6a7"  message: assistant
```

- **Append**: new entry → `parentId = leafId`, then `leafId = newEntry.id`
- **Branch**: `leafId = someOldEntryId` → next append diverges from there
- **Fork**: copy path from `fromEntryId` to root into a new session record
- No entries are ever deleted (immutable log)

---

## `IPiccoloCore` WorkerEntrypoint — Implementation

The `IPiccoloCore` Worker handles incoming JSRPC calls from gateways. It does minimal work itself, delegating everything session-specific to `AgentSessionDO`.

```typescript
class PiccoloCore extends WorkerEntrypoint<Env> {

  async fetch(_request: Request): Promise<Response> {
    // Minimal HTTP handler for health checks.
    return new Response("OK", { status: 200 });
  }

  async newSession(userId: string, options?: NewSessionOptions): Promise<ISession> {
    // 1. Generate sessionId = crypto.randomUUID()
    // 2. Resolve DO stub: env.AGENT_SESSION.idFromName(sessionId)
    // 3. Call stub.newSession(userId, options) — the DO initialises itself using
    //    its own name (sessionId) from ctx.id.name; returns the SessionImpl RpcTarget
    // Note: D1 row is NOT written here — lazy creation on first persisted entry
  }

  async getSession(sessionId: string): Promise<ISession> {
    // 1. Resolve DO stub: env.AGENT_SESSION.idFromName(sessionId)
    // 2. Return stub.getSession("") — the DO's own SessionImpl RpcTarget
    // Does NOT verify session exists — the DO will error on first method call if not
    // userId is NOT available without a D1 round-trip; callers needing it
    // should call session.info() and read info.userId.
  }

  async listSessions(userId: string): Promise<ISession[]> {
    // 1. Query D1 for session IDs ordered by updated_at DESC (via dbListSessions)
    // 2. Return a DO getSession() stub for each — gateways call session.info() for metadata
  }

  async listModels(): Promise<string[]> {
    // Parse env.MODELS (JSON array of model ID strings) and return it directly.
    // MODELS is the sole authoritative source — no KV lookup, no fallback.
  }
}
```

### `ISession` — the DO stub is the session

`AgentSessionDO extends DurableObject implements ISession`. The DO stub from
`env.AGENT_SESSION.get(idFromName(sessionId))` proxies all `ISession` method calls
directly to the DO instance. `UserImpl` initialises the DO via `stub.newSession(...)`,
then returns the stub cast to `ISession`. No wrapper class is needed.

`fork()` returns the new sessionId string; callers use `IUser.getSession(id)` to get the stub:

```typescript
async fork(fromEntryId?: string): Promise<string> {
  const newSessionId = await forkSession(...);
  const newStub = env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(newSessionId));
  await newStub.newSession(newSessionId, this.#userId, { modelId: this.#modelId });
  return newSessionId;
}
```

---

## `AgentSessionDO` — Durable Object Implementation

One DO instance per session. This is where all live session logic runs.

### Internal state

```typescript
interface DOState {
  sessionId: string;
  userId: string;
  modelId: string;
  leafId: string | null;
  name: string | undefined;
  createdAt: number;   // Unix ms; 0 = session not yet committed to D1
  updatedAt: number;

  // Inlined agent state (no separate Agent class)
  model: LanguageModel;
  error: string | undefined;
  steeringQueue: IMessage[];
  agentAbortController: AbortController | null;

  // Follow-up queue (filled by followUp())
  followUpQueue: string[];

  // Extension runner and system prompt infrastructure
  extensionRunner: ExtensionRunner;
  assembler: SystemPromptAssembler;
  assembledSystemPrompt: string;  // cached; populated lazily on first getSystemPrompt()
  tools: ITool[] | undefined;     // cached; populated lazily on first getSystemPrompt()

  // Token counts from the last completed agent turn.
  // lastInputTokens: updated from finish.totalUsage; used for compaction threshold.
  lastInputTokens: number;
}
```

### Cold start / rehydration

When the DO starts cold (evicted and restarted), `initialize()` runs before any method is served:

```
1. Read sessionId from DO storage (set on first prompt)
2. If not found: treat as a brand-new session, skip D1 load
3. Restore metadata (`userId`, `leafId`, `name`, timestamps)
4. Discover `EXTENSION_*` bindings and initialise `ExtensionRunner`
5. Runtime context is reconstructed from D1 per turn via `ContextIterator`
```

### `newSession()` (DO public RPC)

Called by `UserImpl.newSession()` to initialise the DO and return its `ISession` stub. Idempotent — if the session is already initialised, the second call is a no-op.

```typescript
async newSession(
  userId: string,
  options?: { name?: string; modelId?: string },
): Promise<ISession>
```

1. Calls private `#initSession(userId, options)`:
   a. If `state.sessionId !== ""` → return immediately (already initialised).
   b. Derive `sessionId = this.ctx.id.name` (the DO was named with `idFromName(uuid)`).
   c. Set `state.sessionId`, `state.userId`, `state.modelId`, `state.name` where `state.name = options.name ?? sessionId`.
   d. Persist `sessionId`, `modelId`, and `name` to DO storage for cold-start recovery.
   e. Reconstruct the `LanguageModel` via the internal `createModel(env, modelId)` helper in `agent-session-do.ts`.
2. Return `getSession(userId)` — the DO's own `SessionImpl` RpcTarget.

The D1 `sessions` row is **not** written here — it is written lazily on the first persisted entry append (see §Lazy session creation).

---

### `prompt()` pipeline

```
.prompt(text, attachments?)
│
├─ 1. Emit InputEvent to ExtensionRunner
│     → InputResult { action: "handled" | "transform" | "continue"; text? }
│     If "handled": return empty stream immediately
│     If "transform": use result.text as the prompt text
│
├─ 2. Build UserMessage from (text, attachments)
│     Append to agent.messages and persist immediately
│
├─ 3. Emit BeforeAgentStartEvent to ExtensionRunner
│     → BeforeAgentStartResult { systemPrompt?, contextMessages? }
│     If contextMessages: prepend to agent.messages for this turn only (not persisted)
│     If systemPrompt: use as override for this turn only
│
├─ 4. Assemble system prompt (see SystemPromptAssembler)
│
├─ 5. Check compaction threshold:
│     If inputTokens > COMPACT_TOKENS (env var, default 100000): compact() before proceeding
│
├─ 6. agent.prompt(userMessages) → AgentTurn (synchronous)
│     A StreamBroadcaster<AgentEvent> is created and piped from AgentTurn.stream.
│     The DO drains bc.readable (primary drain) in #drainTurnStream():
│       - #onTurnEvent(event): in-flight tracking, token counts, extension dispatch
│       - #onTurnClose(): called on completion, schedules #handleAgentEnd() + clears #currentTurn
│     TurnImpl wraps the broadcaster; getStream() calls broadcaster.connect()
│
└─ 7. Return TurnImpl as ITurn to caller
       #currentTurn assigned once; cleared in #onTurnClose() finally block
       to preserve RpcTarget identity for reconnect (getCurrentTurn())
```

When `#drainTurnStream()` finishes (Agent stream closes normally or errors), `#onTurnClose()`
schedules `#handleAgentEnd()` via `ctx.waitUntil(...)` so persistence is not cut
off when the RPC call frame completes.

### Persistence

#### Per-message append

When a persistent entry is created (user/assistant/tool/system message, model change, compaction):

```
1. For each new ModelMessage in agent.state.messages since last persistence point:
   a. Create MessageEntry { id, sessionId, parentId: leafId, type: "message", ... }
   b. Ensure `sessions` row is committed (if first persistent append)
   c. INSERT entry into D1 immediately
   d. UPDATE sessions SET updated_at = ?, leaf_id = ? WHERE id = ?
```

#### Lazy session creation

The D1 `sessions` row is not written until the first persistent entry is appended. Before that point, session state lives only in the DO. On first append:

```
INSERT OR IGNORE INTO sessions (id, user_id, created_at, updated_at, name, model_id, leaf_id)
VALUES (?, ?, ?, ?, ?, ?, ?)
```

---

## `ExtensionRunner` — Implementation

Manages dispatch to all installed extension Workers.

Extension discovery order is deterministic: bindings are sorted lexicographically by binding name (for example `EXTENSION_10_GUARD` before `EXTENSION_20_SKILLS`). This order controls all "first wins" merge rules.

### Initialization (per session start)

`initialize()` only discovers extension bindings and builds worker stubs. It does **not** call
`getTools()`, `getCommands()`, or `getSystemPromptAdditions()` on extensions — those
calls pass `ISession` (an RPC stub) to remote Workers, which may call back into the
session DO. Calling them inside `blockConcurrencyWhile` would deadlock.

For each optional `IExtensionWorker` method (`init`, `getTools`, `getCommands`,
`getSystemPromptAdditions`, `onEvent`), `ExtensionRunner` probes support on first use via
`await worker.<method>`. The boolean result is cached per extension for the rest of the
session; methods determined to be unimplemented are never called again.

The caller (`AgentSessionDO`) drives registration explicitly, outside `blockConcurrencyWhile`:

```typescript
class ExtensionRunner {
  // Only discovers env bindings and builds worker stubs. No ISession involved.
  async initialize(env: Record<string, unknown>): Promise<void> {
    // 1. Enumerate Object.entries(env)
    // 2. Keep entries where bindingName starts with "EXTENSION_"
    // 3. Sort by bindingName lexicographically
    // 4. Treat each binding value as an extension worker and push to #extensions list
  }

  // Called by AgentSessionDO outside blockConcurrencyWhile.
  // ISession is passed at call time — not stored.
  async getTools(ctx: ISession): Promise<ITool[]>
  async getCommands(ctx: ISession): Promise<ICommand[]>
  async getSystemPromptAdditions(ctx: ISession): Promise<SystemPromptAddition[]>

  // Fires init(ctx) on all loaded extension workers.
  // Called by AgentSessionDO outside blockConcurrencyWhile.
  async init(ctx: ISession): Promise<void>
}
```

No adapter layer is used. Extension workers return `ITool[]` directly.

### Dispatch and merge rules

All dispatch calls are `Promise.all` across all extension workers. Each method follows specific merge semantics:

| Method | Merge rule |
|---|---|
| `emitInput` | First result with `action !== "continue"` wins; rest ignored |
| `emitBeforeAgentStart` | All `contextMessages` arrays concatenated; last non-undefined `systemPrompt` wins |
| `emitContext` | Last extension that returns a non-void `ContextResult.messages` wins |
| `emitToolCall` | First result with `block === true` wins; if none, call proceeds |
| `emitToolResult` | Results chained: each handler sees previous handler's output |
| `emitBeforeCompact` | First result with `cancel === true` wins; or first with a `summary` string wins |
| All fire-and-forget events | All stubs called concurrently; results discarded |

```typescript
// All emit methods accept the full SessionImpl (not a minimal stub).
// This is the live RpcTarget that extensions call back on over JSRPC.
// Current DO limitation: AgentSessionDO passes a self-stub capability
// (via env.AGENT_SESSION.get(ctx.id)) rather than `this` directly,
// because DurableObject instances are not serializable across dispatch RPC.
class ExtensionRunner {
  async emitInput(event: InputEvent, ctx: SessionImpl): Promise<InputResult> {
    const results = await Promise.all(
      this.extensions.map(({ worker }) => worker.onInput?.(event, ctx).catch(() => undefined))
    );
    return results.find(r => r && r.action !== "continue")
      ?? { action: "continue" };
  }

  async emitToolCall(event: ToolCallEvent, ctx: SessionImpl): Promise<ToolCallResult> {
    const results = await Promise.all(
      this.extensions.map(({ worker }) => worker.onToolCall?.(event, ctx).catch(() => undefined))
    );
    return results.find(r => r?.block)
      ?? { block: false };
  }

  async emitToolResult(event: ToolResultEvent, ctx: SessionImpl): Promise<ToolResultOverride | undefined> {
    // Chain: each handler receives the output of the previous
    let current: ToolResultOverride | undefined;
    for (const { worker } of this.extensions) {
      const result = await worker.onToolResult?.(
        current ? { ...event, output: current } : event, ctx
      ).catch(() => undefined);
      if (result) current = result;
    }
    return current;
  }

  async emitBeforeAgentStart(event: BeforeAgentStartEvent, ctx: SessionImpl): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.extensions.map(({ worker }) => worker.onBeforeAgentStart?.(event, ctx).catch(() => undefined))
    );
    return {
      contextMessages: results.flatMap(r => r?.contextMessages ?? []),
      systemPrompt: results.filter(r => r?.systemPrompt).at(-1)?.systemPrompt,
    };
  }
}
```

### Command routing in `emitInput`

Before dispatching to extensions, the DO checks if the input text matches a registered command:

```typescript
function parseCommand(text: string, commands: ICommand[]): {
  commandName: string; commandArgs: string
} | undefined {
  if (!text.startsWith("/")) return undefined;
  const [, name, ...rest] = text.split(/\s+/);
  const cmd = commands.find(c => `/${c.name}` === name);
  if (!cmd) return undefined;
  return { commandName: cmd.name, commandArgs: rest.join(" ") };
}
```

The parsed `commandName` and `commandArgs` are attached to the `InputEvent` before dispatch.

---

## `SystemPromptAssembler` — Implementation

Called once per `prompt()` call (or once at session start and cached until reload).

The `PICCOLO_SYSTEM_PROMPT` constant is a template that accepts an `agentName` parameter
(sourced from the `AGENT_NAME` environment variable, default `"Piccolo"`).
`buildBasePrompt(agentName)` renders the template before passing it to `assemble()`.

```typescript
class SystemPromptAssembler {
  assemble(
    base: string,                           // rendered by buildBasePrompt(env.AGENT_NAME)
    additions: SystemPromptAddition[],      // from ExtensionRunner.getSystemPromptAdditions()
    activeTools: ITool[],                   // registered tools
    override?: string,                      // from BeforeAgentStartResult.systemPrompt
  ): string {

    if (override) return override;

    // Group additions by section, sort by priority within section
    const sections: Record<string, SystemPromptAddition[]> = {
      skills: [], guidelines: [], context: [], footer: []
    };
    for (const a of additions) {
      sections[a.section].push(a);
    }
    for (const s of Object.values(sections)) {
      s.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }

    // Build tool guidelines section from active tools
    const toolGuidelines = activeTools
      .flatMap(t => t.descriptor.promptGuidelines ?? [])
      .map(g => `- ${g}`)
      .join("\n");

    // Assemble in order: base → context → skills → guidelines (+ tool guidelines) → footer
    const parts = [
      base,
      ...sections.context.map(a => a.content),
      ...sections.skills.map(a => a.content),
      ...sections.guidelines.map(a => a.content),
      toolGuidelines ? `## Tool Guidelines\n\n${toolGuidelines}` : "",
      ...sections.footer.map(a => a.content),
    ];

    return parts.filter(Boolean).join("\n\n");
  }
}
```

### Available tools section

Each active tool whose `descriptor.promptSnippet` is set contributes a line to the system prompt:

```
## Available Tools

- **r2**: Read, write, list, and manage files in R2 object storage
- **d1**: Query and modify the D1 SQLite database
- **skill:brave-search**: Web search via Brave Search API
```

---

## Context Compaction — Implementation

### Trigger conditions

Compaction is triggered in two cases:

1. **Threshold**: `contextUsage.inputTokens > env.COMPACT_TOKENS` checked at the start of every `prompt()` call
2. **Overflow**: `agent.onError` fires with a context-length error (detected by `finishReason === "length"` or the error message matching `/context.?length|too.?many.?token|prompt.?too.?long/i`)

### Compaction algorithm

Compaction is implemented by `compact()` in `packages/core/src/compact.ts`, called by `AgentSessionDO.compact()`. The DO first reconstructs context from D1, then compacts that reconstructed message list.

```
1. Emit before_compact to extensions → BeforeCompactResult
   - If cancel: return (no entry written)
   - If summary provided: use it, skip LLM call
   - Otherwise: call agentCompact(reconstructedMessages, keepRecentTokens, #model)

2. If summary === "" and no extension summary: return (nothing to summarise)

3. Set `firstKeptEntryId` from `toKeep[0]?.id`

4. Build CompactionEntry, persist immediately, advance #leafId

5. Persist the compaction entry immediately (no deferred flush)
```

No deferred flush is required — compaction entries are persisted immediately.

---

## `ISession` — Core-Side Implementation

`AgentSessionDO extends DurableObject implements ISession` directly. There is no separate `SessionImpl` wrapper. All `ISession` methods are implemented as public async methods on the DO class itself.

`SessionTarget extends RpcTarget` is a thin JSRPC-serialisable proxy that delegates every `ISession` method to the owning `AgentSessionDO`. One `SessionTarget` is created per DO lifetime (in `#initialize()`) and stored as `#rpcCtx`. It is passed to extension workers and threaded into tool `execute()` calls — this is the JSRPC-correct approach since `DurableObject` instances cannot be passed directly over dispatch RPC.

All persistent mutations (model changes, custom entries, messages, compaction) write directly to D1 as soon as they are created. There is no persistent in-memory message cache.

### Context injection into tool execute()

`#rpcCtx` (the live `SessionTarget`) is passed to `toAiSdkTools(#tools, #rpcCtx)` before each turn, threading it into every tool `execute()` call. The same `#rpcCtx` instance is reused for all extension calls throughout the DO's lifetime.

---

## Context Reconstruction — `ContextIterator` + `buildSessionContextFromDb`

Context is reconstructed directly from D1 whenever needed (`prompt()`, `getEntries()`, `compact()`, `getContextUsage()`).

```typescript
class ContextIterator implements AsyncIterable<AnyEntry> {
  // Pages path rows from D1 using recursive CTE, newest -> oldest, ordered by append_seq DESC.
  // When a branch_summary entry is seen, jumps to branch_summary.data.fromId and starts a new query.
}

async function buildSessionContextFromDb(...): Promise<{ messages: IMessage[]; modelId: string }> {
  // 1. Iterate newest -> oldest via ContextIterator.
  // 2. Stop when one of:
  //    - root/end reached
  //    - context token budget reached
  //    - compaction entry encountered
  // 3. If compaction encountered, keep reading until firstKeptEntryId is reached
  //    (or path end if missing).
  // 4. Convert selected entries to IMessage[] in root -> leaf order.
  // 5. Emit a synthetic summary message for compaction entries.
}
```

---

## Fork Session — Implementation

```typescript
async function forkSession(
  sessionId: string,
  fromEntryId: string | undefined,
  db: D1Database,
): Promise<string> {
  // 1. Load all entries for session
  const entries = await db.prepare(
    "SELECT * FROM entries WHERE session_id = ?"
  ).bind(sessionId).all<EntryBase>();

  // 2. Walk path from fromEntryId (or current leafId) to root
  const path = walkToRoot(entries.results, fromEntryId ?? currentLeafId);

  // 3. Create new session record
  const newSessionId = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, updated_at, name, model_id, leaf_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(newSessionId, userId, Date.now(), Date.now(), newSessionId, modelId, path.at(-1)?.id ?? null).run();

  // 4. Copy all path entries with new IDs into new session
  // Remap parentId references: old ID → new ID
  // Also remap internal references in entry payloads:
  //   message.data.id, compaction.data.firstKeptEntryId,
  //   branch_summary.data.fromId, label.data.targetId
  const idMap = new Map<string, string>();
  const newEntries = path.map(e => {
    const newId = generateEntryId();
    idMap.set(e.id, newId);
    return { ...e, id: newId, sessionId: newSessionId, parentId: e.parentId ? idMap.get(e.parentId) ?? null : null };
  });
  await db.batch(newEntries.map(e =>
    db.prepare("INSERT INTO entries (id, session_id, parent_id, type, timestamp, data) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(e.id, e.sessionId, e.parentId, e.type, e.timestamp, JSON.stringify(e.data))
  ));

  return newSessionId;
}
```

---

## Session Listing — Implementation

```typescript
async function listSessions(userId: string, db: D1Database): Promise<SessionInfo[]> {
  const rows = await db.prepare(`
    SELECT
      s.id, s.user_id, s.name, s.cwd, s.created_at, s.updated_at, s.model_id,
      COUNT(CASE WHEN e.type = 'message' THEN 1 END) AS message_count,
      MIN(CASE WHEN e.type = 'message' AND json_extract(e.data, '$.role') = 'user'
               THEN json_extract(e.data, '$.content') END) AS first_message
    FROM sessions s
    LEFT JOIN entries e ON e.session_id = s.id
    WHERE s.user_id = ?
    GROUP BY s.id
    ORDER BY s.updated_at DESC
  `).bind(userId).all<SessionRow>();

  return rows.results.map(r => ({
    id: r.id,
    userId: r.user_id,
    name: r.name ?? r.id,
    cwd: r.cwd ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    firstMessage: truncate(r.first_message ?? "", 100),
  }));
}
```

---

## Agent Loop — Implementation

The agent loop is implemented directly inside `AgentSessionDO` in `packages/core/src/agent-session-do.ts`, with helper functions in `packages/core/src/compact.ts` and `packages/core/src/agent-tools.ts`.

The DO does not keep a persistent in-memory conversation cache. For each turn it reconstructs context from D1, keeps only turn-local streaming state in memory, and discards it after persistence.

### `#startTurn()`

Creates an `AbortController` stored as `#agentAbortController`, and registers the stream with the Workers runtime via `ctx.waitUntil(this.#runStream(ac.signal, turnMessages))`.

### `#runStream(signal, turnMessages)`

Core LLM loop. Validates messages, calls `streamText(...)` from the `ai` SDK, and dispatches every AI SDK callback to `#emitTurnEvent(event)`. In the `finally` block (non-abort path) it emits the `finish` event and registers `#onAgentEnd()` via `ctx.waitUntil`.

Key callbacks:
- `prepareStep` — emits `step-start`; on step > 0 dequeues one steering message from `#steeringQueue` via `#dequeueSteer()`
- `onChunk` — emits `text-delta`, `reasoning-delta`, `tool-call`, `tool-result`
- `onStepFinish` — emits `tool-result` for tool errors, then `step-finish`
- `onFinish` — captures `totalUsage`, persists generated messages directly to D1
- `onError` / catch — emits `error`, clears `#agentAbortController`

### `#emitTurnEvent(event)`

Calls `#onTurnEvent(event)` (side effects) then `#observable.emit(event)` (subscriber delivery).

### `#onTurnEvent(event)`

Called synchronously for every `AgentEvent`. Handles:

1. **In-flight history** — accumulates `#streamingAssistantText` for streaming UI events mid-turn
2. **Token counts** — updates `#lastInputTokens` from `step-finish.usage` and `finish.totalUsage`; emits a `usage` event after each
3. **Listener dispatch** — calls `#notifyListeners(event)` (extension runner etc.)

### `#onAgentEnd()`

Called via `ctx.waitUntil` when finish fires, then:
- If `#followUpQueue` is non-empty: dequeues one text, persists it immediately as a user message, rebuilds context from D1, calls `#startTurn()`, and returns without clearing `#currentTurn`
- Otherwise: sets `#currentTurn = null`, fires `turn_flushed` to listeners

### `getSystemPrompt()` — lazy assembly

```typescript
async getSystemPrompt(): Promise<string> {
  if (!this.#assembledSystemPrompt) {
    if (!this.#tools) {
      this.#tools = await this.#extensionRunner.getTools(this.#rpcCtx);
    }
    const additions = await this.#extensionRunner.getSystemPromptAdditions(this.#rpcCtx);
    this.#assembledSystemPrompt = await this.#assembler.assemble(
      buildBasePrompt(this.env.AGENT_NAME), additions, this.#tools,
    );
  }
  return this.#assembledSystemPrompt;
}
```

Called at the start of every `prompt()` call; is a no-op after the first call per DO lifetime.

### `toAiSdkTools(tools: ITool[], ctx: ISession): ToolSet`

Converts `ITool[]` to the AI SDK `ToolSet` format. `ctx` (the live `ISession` via `#rpcCtx`) is threaded into every tool `execute()` call. `jsonSchema()` from `ai` is used to wrap the `JSONSchema7` descriptor.

### `agentCompact(messages, keepRecentTokens, model): Promise<{ summary, toKeep }>`

Uses `generateText` (non-streaming) with the same `LanguageModel` as the DO. Calls `splitForCompaction()` to determine which messages to summarise. Returns the summary text and the messages to keep verbatim. Called by `#compact()` on the DO.

### LLM Backend

All LLM calls go through the **Cloudflare AI Gateway** unified endpoint. `createModel(env, modelId)` in `agent-session-do.ts` constructs the `LanguageModel` via `ai-gateway-provider`. Models are addressed as `{provider}/{model-id}` (e.g. `anthropic/claude-sonnet-4-5`). `piccolo-core` constructs the model; the `Agent` class has no knowledge of how it was built.
