# `piccolo-core` — Specification

`piccolo-core` is the central Cloudflare Worker of the piccolo system. It is the JSRPC hub that gateways and extensions connect to. It owns session state, contains the agent loop, dispatches to extensions, assembles system prompts, and persists conversation history.

All public interfaces are defined in [api.md](api.md). This document specifies the internal implementation of those interfaces.

The agent loop (`Agent` class, `AgentTurn`, `toAiSdkTools`, `agentCompact`) lives directly in `packages/core/src/` — there is no separate `packages/agent` library. The `ai` and `ai-gateway-provider` packages are used directly by piccolo-core.

---

## Responsibilities

| Responsibility | Mechanism |
|---|---|
| Expose `IPiccoloCore` and `ISession` to gateways | `WorkerEntrypoint` JSRPC |
| Own one `AgentSessionDO` per session | Durable Object |
| Run the agent loop | `Agent` class (in `agent.ts`), called by `AgentSessionDO` |
| Persist conversation history | D1 + DO storage |
| Dispatch events to extensions | `ExtensionRunner` via dispatch namespace |
| Assemble the system prompt | `SystemPromptAssembler` |
| Manage model selection | Stored per session in D1 |
| Trigger and persist context compaction | `compact()` in `compaction.ts`, called by DO |

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
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "<KV_NAMESPACE_ID>" }
  ],
  "d1_databases": [
    { "binding": "SESSIONS_DB", "database_name": "piccolo-sessions", "database_id": "<D1_ID>" }
  ],
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "piccolo-assets" }
  ],
  "dispatch_namespaces": [
    { "binding": "EXTENSIONS", "namespace": "piccolo-extensions" }
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
  id          TEXT    NOT NULL,             -- 8-char hex
  session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id   TEXT,                         -- null for root entry
  type        TEXT    NOT NULL,             -- discriminant (see Entry Types)
  timestamp   TEXT    NOT NULL,             -- ISO 8601
  data        TEXT    NOT NULL CHECK (json_valid(data)),  -- JSON payload; DB-level validity enforced
  PRIMARY KEY (session_id, id)
);

CREATE INDEX entries_session     ON entries(session_id);
CREATE INDEX entries_parent      ON entries(session_id, parent_id);
CREATE INDEX sessions_user       ON sessions(user_id, updated_at DESC);
```

---

## KV Schema

Namespace bound as `CONFIG`:

| Key | Value | Description |
|---|---|---|
| `extensions:registry` | `string[]` JSON array | Ordered list of active extension Worker names |
| `extensions:meta:{name}` | `{ version, description }` JSON | Extension metadata |
| `settings:global` | JSON object | Global piccolo settings |
| `settings:user:{userId}` | JSON object | Per-user settings overrides |

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
  id: string;              // 8-char hex: crypto.getRandomValues → hex encode
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
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";
```

### Entry type details

```typescript
// "message" — a single LLM message (user | assistant | tool | system)
interface MessageEntry extends EntryBase {
  type: "message";
  data: ModelMessage;  // from `ai` package
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
  data: { summary: string; firstKeptEntryId: string; tokensBefore: number };
}

// "branch_summary" — summary of an abandoned branch stored at the fork point
interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  data: { summary: string; fromId: string; fromHook?: boolean };
}

// "custom" — opaque extension state, NOT sent to LLM
interface CustomEntry extends EntryBase {
  type: "custom";
  data: { customType: string; payload?: unknown };
}

// "custom_message" — extension-defined content sent to LLM
interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  data: { customType: string; content: string | UserContent; display: boolean; details?: unknown };
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
    // Note: D1 row is NOT written here — lazy creation on first assistant response
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

  // In-memory message list; rebuilt from D1 on cold start
  messages: ModelMessage[];

  // Pending entries not yet flushed to D1
  pendingEntries: AnyEntry[];

  // Active agent instance
  agent: Agent;
  abortController: AbortController | null;

  // Follow-up queue (filled by ctx.sendFollowUp())
  followUpQueue: string[];

  // Extension runner (stub at step 5, real ExtensionRunner from step 6)
  extensionRunner: ExtensionRunner;

  // System prompt assembler (stub at step 5, real SystemPromptAssembler from step 7)
  assembler: SystemPromptAssembler;

  // The assembled system prompt for the current session
  assembledSystemPrompt: string;

  // In-memory cache of all AnyEntry objects on the current branch path (root→leaf order).
  // Populated on cold start from D1. New custom/custom_message entries appended here
  // when SessionImpl.appendCustomEntry/appendCustomMessage are called.
  // Used by ISession.getEntries() to avoid a D1 round-trip.
  branchEntries: AnyEntry[];

  // The live ISession for the current turn. Set at the start of prompt(), null when idle.
  // Also passed to agent.setContext() so tools receive it via execute().
  // Typed as ISession — implementation is SessionImpl, but DOState never references the Impl class.
  session: ISession | null;

  // Maps ModelMessage object reference → entry ID.
  // Used by compact() to locate firstKeptEntryId without an extra D1 round-trip.
  messageToEntryId: Map<ModelMessage, string>;

  // Token counts from the last completed agent turn.
  // lastInputTokens: updated from agent_end.totalUsage; used for compaction threshold.
  lastInputTokens: number;

  // Count of agent.state.messages at the start of the current prompt() call.
  // _handleAgentEnd() slices from this index to find new messages to persist.
  messagesAtTurnStart: number;
}
```

### Cold start / rehydration

When the DO starts cold (evicted and restarted), `initialize()` runs before any method is served:

```
1. Read sessionId from DO storage (set on first prompt)
2. If not found: treat as a brand-new session, skip D1 load
3. Query D1: SELECT * FROM entries WHERE session_id = ? ORDER BY timestamp ASC
4. buildSessionContext(entries, leafId):
   a. Walk from leafId → root via parentId links; reverse to root-first order
   b. Find the last "compaction" entry on the path
   c. If compaction found:
      - messages = [ synthetic summary UserMessage, ...entries after firstKeptEntryId ]
   d. Else:
      - messages = all "message" and "custom_message" entries on path, in order
   e. Extract modelId from last "model_change" entry, or sessions.model_id
5. Restore agent.messages = reconstructed messages
6. Restore agent.modelId
7. Load extension registry and initialise ExtensionRunner
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
   e. Reconstruct the `LanguageModel` via `createModel(env, modelId)`.
2. Return `getSession(userId)` — the DO's own `SessionImpl` RpcTarget.

The D1 `sessions` row is **not** written here — it is written lazily on the first `agent_end` (see §Lazy session creation).

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
│     Append to agent.messages + pendingEntries
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

When `AgentEvent.type === "agent_end"` fires:

```
1. For each new ModelMessage in agent.state.messages since last flush:
   a. Create MessageEntry { id, sessionId, parentId: leafId, type: "message", ... }
   b. Append to DO storage (synchronous)
   c. leafId = newEntry.id
   d. Add to pendingEntries

2. Flush pendingEntries to D1:
   INSERT INTO entries (id, session_id, parent_id, type, timestamp, data)
   VALUES ... (batch insert, all pending entries)

3. UPDATE sessions SET updated_at = ?, leaf_id = ?, model_id = ? WHERE id = ?

4. Clear pendingEntries
```

#### Lazy session creation

The D1 `sessions` row is not written until the first assistant response is committed. Before that point, session state lives only in the DO. On first flush:

```
INSERT OR IGNORE INTO sessions (id, user_id, created_at, updated_at, name, model_id, leaf_id)
VALUES (?, ?, ?, ?, ?, ?, ?)
```

---

## `ExtensionRunner` — Implementation

Manages dispatch to all installed extension Workers.

### Initialization (per session start)

```typescript
class ExtensionRunner {
  async initialize(ctx: SessionImpl, ctxStub: ISession, kv: KVNamespace, extensions: DispatchNamespace, modelId?: string): Promise<void> {
    // Two session references are required:
    //   ctx     — the real local session object. Used only to read sessionId()/userId()
    //             without going through the RPC Proxy, which would fail on private-field
    //             brand checks.
    //   ctxStub — the RPC-serialisable Proxy stub. Passed to remote extension workers
    //             so they can call back into the session over JSRPC.
    //
    // Logs start/end and per-extension bootstrap failures at [extensions] scope.
    // 1. Read extensions:registry from CONFIG KV → string[]
    // 2. For each name:
    //    worker = env.EXTENSIONS.get(name)
    //    tools = await worker.getTools(ctxStub)
    //    commands = await worker.getCommands(ctxStub)  // store for onInput routing
    //    sysPromptAdditions = await worker.getSystemPromptAdditions(ctxStub)
    // 3. Store tools directly as ITool[], plus commands and sysPromptAdditions
    // 4. Fire session_start using identity from ctx (not ctxStub), pass ctxStub to extensions
  }
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

`compact()` takes a `CompactionState` struct rather than individual parameters, so all the mutable DO state it needs to update (leafId, pendingEntries) is passed as a bundle.

```typescript
interface CompactionState {
  sessionId: string;
  leafId: string | null;
  agent: Agent;
  extensionRunner: ExtensionRunner;
  /** Maps ModelMessage object reference → entry ID for firstKeptEntryId lookup. */
  messageToEntryId: Map<ModelMessage, string>;
  /** Accumulated entries not yet flushed to D1. Compaction entry is appended here. */
  pendingEntries: AnyEntry[];
  /** Last known input token count — used for CompactionEntry.tokensBefore. */
  lastInputTokens: number;
}

async function compact(
  state: CompactionState,
  ctx: ISession,
  options: CompactOptions = {},
): Promise<void> {
  const keepRecentTokens = options.keepRecentTokens ?? 20_000;

  // 1. Let extensions cancel or provide a pre-built summary
  const extResult = await state.extensionRunner.emitBeforeCompact(
    { messages: state.agent.state.messages, keepRecentTokens }, ctx
  );
  if (extResult?.cancel) return;

  let summary: string;
  let keptMessages: ModelMessage[];

  if (extResult?.summary) {
    // Extension provided a ready-made summary — skip LLM call
    summary = extResult.summary;
    keptMessages = splitForCompaction(state.agent.state.messages, keepRecentTokens).toKeep;
  } else {
    // Use piccolo-agent's agentCompact() (generateText call)
    ({ summary, keptMessages } = await agentCompact(
      state.agent.state.messages,
      keepRecentTokens,
      state.agent.state.model,
    ));
  }

  // Guard: if nothing was summarised (toSummarize was empty), skip writing an entry.
  if (summary === "" && !extResult?.summary) return;

  // 2. Build and queue CompactionEntry
  const firstKeptMessage = keptMessages[0];
  const firstKeptEntryId = firstKeptMessage
    ? (state.messageToEntryId.get(firstKeptMessage) ?? "")
    : "";
  const compactionEntry: CompactionEntry = {
    id: generateEntryId(),
    sessionId: state.sessionId,
    parentId: state.leafId,
    type: "compaction",
    timestamp: new Date().toISOString(),
    data: {
      summary,
      firstKeptEntryId,
      tokensBefore: state.lastInputTokens,
    },
  };
  state.pendingEntries.push(compactionEntry);
  state.leafId = compactionEntry.id;

  // 3. Rebuild agent message list
  const summaryMessage: ModelMessage = {
    role: "user",
    content: `[Conversation Summary]\n\n${summary}`,
  };
  state.agent.replaceMessages([summaryMessage, ...keptMessages]);

  // 4. Notify extensions (fire-and-forget)
  await state.extensionRunner.emit("onCompact",
    { summary, keptMessageCount: keptMessages.length }, ctx
  );
}
```

---

## `ISession` — Core-Side Implementation

`SessionImpl extends RpcTarget` holds a **live reference to `DOState`**. All mutations (model changes, custom entries, etc.) write directly into `doState.pendingEntries` / `doState.branchEntries`. No D1 flush happens here — flushing occurs at `agent_end` as usual.

One instance is created per `prompt()` call and stored in `doState.session` (typed as `ISession`). It is also passed to `agent.setContext(session)` so the agent can inject it into every tool `execute()` call. `DOState.session` is always typed as `ISession` — no code outside `session-impl.ts` references `SessionImpl` directly.

```typescript
class SessionImpl extends RpcTarget implements ISession {
  // Constructor receives a live DOState reference and env bindings.
  constructor(private readonly doState: DOState, private readonly env: Env) { super(); }

  // ISession.id() and ISession.userId resolved from doState

  // Messaging
  async sendUserMessage(content: string) {
    doState.agent.steer({ role: "user", content });
  }
  async sendFollowUp(content: string) {
    doState.followUpQueue.push(content);
  }
  async appendCustomMessage(customType, content, display) {
    // Creates CustomMessageEntry, pushes to pendingEntries + branchEntries, updates leafId.
    // No D1 flush — flush happens at agent_end.
  }
  async appendCustomEntry(customType, data?) {
    // Creates CustomEntry, pushes to pendingEntries + branchEntries, updates leafId.
    // No D1 flush — flush happens at agent_end.
  }
  async getEntries(customType?) {
    // Filter doState.branchEntries by type === "custom" and optional customType match.
    return doState.branchEntries
      .filter(e => e.type === "custom" && (!customType || (e.data as { customType: string }).customType === customType))
      .map(e => ({ id: e.id, customType: (e.data as { customType: string; payload?: unknown }).customType, data: (e.data as { payload?: unknown }).payload, timestamp: e.timestamp }));
  }

  // Model
  async getModel()           { return doState.modelId; }
  async setModel(modelId)    {
    doState.modelId = modelId;
    doState.agent.setModel(createModel(env, modelId));
    // Pushes ModelChangeEntry to pendingEntries + branchEntries, updates leafId.
  }
  async listModels()         { return JSON.parse(env.MODELS) as string[]; }

  // Tools
  async getActiveTools()     { return doState.agent.state.tools.map(t => t.descriptor) as ToolDescriptor[]; }
  async setActiveTools(tools: IAgentTool[]){ doState.agent.setTools(tools); }

  // Session control
  async abort()              { doState.abortController?.abort(); }
  async getContextUsage()    { return computeContextUsage(doState); }
  async compact(opts?)       { await compact(compactionState, this, opts); }

  // Metadata
  async getName()            { return doState.name; }
  async setName(name)        {
    doState.name = name;
    // Pushes SessionInfoEntry to pendingEntries + branchEntries, updates leafId.
  }
  async getSystemPrompt()    { return doState.assembledSystemPrompt; }
}
```

### Context injection into tool execute()

`AgentSessionDO.prompt()` calls `state.agent.setContext(session)` immediately after creating the session (typed as `ISession`). The agent stores it as `IAgentSession` and passes it to `toAiSdkTools(tools, ctx)`, which threads it into every tool `execute()` call. This is the JSRPC-correct approach: an `ISession` `RpcTarget` capability crosses the Worker dispatch boundary with the tool call.

For extension dispatch calls, `AgentSessionDO` currently passes a raw self DO stub (`env.AGENT_SESSION.get(ctx.id)`) instead of passing `this` directly, due a temporary runtime limitation where `AgentSessionDO` instances cannot be serialized over dispatch RPC.

---

## Context Reconstruction — `buildSessionContext`

Called on cold start and after forking. Produces the `ModelMessage[]` list the agent receives.

```typescript
function buildSessionContext(
  entries: EntryBase[],
  leafId: string | null,
): { messages: ModelMessage[]; modelId: string } {
  // 1. Walk from leafId → root collecting entry IDs, then reverse
  const path = walkToRoot(entries, leafId).reverse();

  // 2. Find the most recent compaction entry on the path
  const lastCompaction = [...path].reverse().find(e => e.type === "compaction") as CompactionEntry | undefined;

  // 3. Determine which entries to include
  const relevant = lastCompaction
    ? path.filter(e => e.id === lastCompaction.id || comesAfter(e, lastCompaction, path))
    : path;

  // 4. Convert to ModelMessage[]
  const messages: ModelMessage[] = [];
  for (const entry of relevant) {
    if (entry.type === "compaction") {
      // Replace all summarised history with a single synthetic user message
      messages.push({ role: "user", content: `[Conversation Summary]\n\n${entry.data.summary}` });
    } else if (entry.type === "message") {
      messages.push(entry.data as ModelMessage);
    } else if (entry.type === "custom_message" && entry.data.display) {
      messages.push({ role: "user", content: entry.data.content });
    } else if (entry.type === "branch_summary") {
      messages.push({ role: "assistant", content: `[Previous branch summary]\n\n${entry.data.summary}` });
    }
    // All other entry types skipped
  }

  // 5. Extract most recent modelId from model_change entries
  const lastModelChange = [...path].reverse().find(e => e.type === "model_change") as ModelChangeEntry | undefined;
  const modelId = lastModelChange?.data.modelId ?? DEFAULT_MODEL_ID;

  return { messages, modelId };
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

The agent loop is implemented in `packages/core/src/agent.ts`. It orchestrates multi-turn, tool-calling conversations via the `ai` SDK's `streamText`. It has no Workers-specific globals and no knowledge of sessions, persistence, or extensions — those are all DO concerns.

### `AgentTurn`

```typescript
interface AgentTurn {
  /** Single-consumer ReadableStream of AgentEvents for this turn. */
  readonly stream: ReadableStream<AgentEvent>;
  /** Abort this turn immediately. No-op after the turn completes. */
  abort(): void;
}
```

`AgentTurn` is returned synchronously by `Agent.prompt()`. The stream starts filling immediately in the background. `abort()` cancels the underlying `AbortController` and propagates to the AI SDK and all tool `execute()` calls.

### `AgentOptions` / `AgentState`

```typescript
interface AgentOptions {
  model: LanguageModel;   // from ai package
  systemPrompt: string;
  tools?: ITool[];
  maxSteps?: number;        // default: 20
  steeringMode?: "one-at-a-time" | "all";
}

interface AgentState {
  model: LanguageModel;
  systemPrompt: string;
  tools: ITool[];
  messages: ModelMessage[];
  isStreaming: boolean;
  error?: string;
}
```

### `Agent` Public API

```typescript
class Agent {
  readonly state: AgentState;

  // Turn lifecycle
  prompt(text: string, images?: ImagePart[]): AgentTurn;  // throws if turn active
  prompt(messages: ModelMessage[]): AgentTurn;
  getCurrentTurn(): AgentTurn | null;  // synchronous
  abort(): void;                       // delegates to getCurrentTurn()?.abort()

  // Synchronous mutations
  setModel(model: LanguageModel): void;
  setTools(tools: ITool[]): void;
  setContext(ctx: ISession): void;     // called by DO before each prompt()
  setSystemPrompt(prompt: string): void;
  appendMessages(messages: ModelMessage[]): void;
  replaceMessages(messages: ModelMessage[]): void;

  // Steering queue
  steer(message: ModelMessage): void;
  clearSteering(): ModelMessage[];
}
```

**Key design decisions:**

- `prompt()` is **synchronous** — it creates the `AgentTurn` and `ReadableStream`, then kicks off `_runStream()` asynchronously via `void`. Events flow into the stream as the AI SDK produces them.
- There is **no `continue()` method**. The DO handles follow-up turns by calling `agent.prompt(text)` directly.
- There is **no `subscribe()` method**. All event observation is done by reading `AgentTurn.stream`.
- `_ctx: ISession | null` is set via `setContext()` and threaded into every tool `execute()` call by `toAiSdkTools()`.

### `prompt()` implementation

```typescript
prompt(input: string | ModelMessage[], images?: ImagePart[]): AgentTurn {
  if (this._currentTurn !== null) {
    throw new Error("A turn is already in progress. Call abort() first.");
  }
  // Build messages, push to this._state.messages
  // ...
  return this._startTurn();
}

private _startTurn(): AgentTurn {
  const ac = new AbortController();
  let controller!: ReadableStreamDefaultController<AgentEvent>;
  const stream = new ReadableStream<AgentEvent>({ start(c) { controller = c; } });
  const turn: AgentTurn = { stream, abort: () => ac.abort() };
  this._currentTurn = turn;
  void this._runStream(controller, ac.signal);
  return turn;
}
```

`_runStream()` calls `streamText(...)` from the `ai` package, enqueues events via `controller.enqueue()`, and in the `finally` block sets `_currentTurn = null` and calls `controller.close()`.

### `StreamBroadcaster<T>`

`packages/core/src/stream-broadcaster.ts` — a `TransformStream<T, T>` that fans out every chunk to zero or more subscriber streams:

```typescript
class StreamBroadcaster<T> extends TransformStream<T, T> {
  connect(): ReadableStream<T>  // new subscriber stream from this point forward
  abort(reason: unknown): void  // error all subscribers (call on source error)
  closed: boolean               // true after writable side closes
  aborted: boolean              // true after abort() is called
}
```

- `bc.readable` (inherited) is the primary drain — must be consumed by the DO to drive backpressure.
- Each `connect()` call returns an independent `ReadableStream<T>` receiving chunks from that point forward.
- `connect()` after close → immediately closed stream. After abort → immediately errored stream.
- Broken subscriber controllers (enqueue/close/error throws) are silently removed and never affect other subscribers.

### `AgentSessionDO.#onTurnEvent()`

Called synchronously for every event as the DO drains the turn stream. Contains all four peek reasons:

1. **In-flight history** — accumulates `#streamingAssistantText` and `#streamingToolCalls` for `getHistory()` mid-turn
2. **Token counts** — updates `#lastInputTokens` from `turn_end.usage` and `agent_end.totalUsage`
3. **Extension dispatch** — `extensionRunner.emit(event.type, event, ctx)` fire-and-forget

### `AgentSessionDO.#onTurnClose()`

Called from `#drainTurnStream()` when the agent stream closes (normally or on error). Schedules `#handleAgentEnd()` via `ctx.waitUntil()`, and clears `#currentTurn` in the `finally` block — after all follow-up processing completes, preserving `TurnImpl` `RpcTarget` identity for the duration of the logical turn.

### `AgentSessionDO.prompt()` pipeline

```
agent.prompt([userMessage])
  → AgentTurn { stream: ReadableStream<AgentEvent>, abort() }

broadcaster = new StreamBroadcaster<AgentEvent>()
TurnImpl(broadcaster, callback)  ← #currentTurn

ctx.waitUntil(#drainTurnStream(agentTurn.stream, broadcaster, ctx))
  → pipes agentTurn.stream through broadcaster
  → drains bc.readable (primary drain)
  → calls #onTurnEvent() per chunk
  → calls #onTurnClose() on completion

getStream() → broadcaster.connect()  ← each caller gets a fresh subscriber stream
```

### Follow-up turns

Inside `#handleAgentEnd()`, after D1 flush. Follow-up turns are internal — no broadcaster needed:

```typescript
while (this.#followUpQueue.length > 0) {
  const text = this.#followUpQueue.shift()!;
  this.#messagesAtTurnStart = this.#agent.state.messages.length;
  const followUpTurn = this.#agent.prompt(text);

  const reader = followUpTurn.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    this.#onTurnEvent(value, ctx);
  }
  reader.releaseLock();

  await this.#persistNewMessages();
}
```

### `toAiSdkTools(tools: ITool[], ctx: ISession): ToolSet`

Converts `ITool[]` to the AI SDK `ToolSet` format. `ctx` (the live `ISession`) is threaded into every tool `execute()` call. `jsonSchema()` from `ai` is used to wrap the `JSONSchema7` descriptor.

### `agentCompact(messages, keepRecentTokens, model): Promise<{ summary, keptMessages }>`

Uses `generateText` (non-streaming) with the same `LanguageModel` as the Agent. Calls `splitForCompaction()` to determine which messages to summarise. Returns the summary text and the messages to keep verbatim. Called by `compact()` in `compaction.ts`.

### LLM Backend

All LLM calls go through the **Cloudflare AI Gateway** unified endpoint. `createModel(env, modelId)` in `gateway.ts` constructs the `LanguageModel` via `ai-gateway-provider`. Models are addressed as `{provider}/{model-id}` (e.g. `anthropic/claude-sonnet-4-5`). `piccolo-core` constructs the model; the `Agent` class has no knowledge of how it was built.
