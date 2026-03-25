# `piccolo-core` — Specification

`piccolo-core` is the central Cloudflare Worker of the piccolo system. It is the JSRPC hub that gateways and extensions connect to. It owns session state, orchestrates the agent loop, dispatches to extensions, assembles system prompts, and persists conversation history.

All public interfaces are defined in [api.md](api.md). This document specifies the internal implementation of those interfaces.

---

## Responsibilities

| Responsibility | Mechanism |
|---|---|
| Expose `IPiccoloCore` and `ISession` to gateways | `WorkerEntrypoint` JSRPC |
| Own one `IAgentSessionDO` per session | Durable Object |
| Persist conversation history | D1 + DO storage |
| Dispatch events to extensions | `ExtensionRunner` via dispatch namespace |
| Assemble the system prompt | `SystemPromptAssembler` |
| Manage model selection | Stored per session in D1 |
| Auto-retry transient LLM errors | Retry loop inside `IAgentSessionDO` |
| Trigger and persist context compaction | `CompactionManager` inside DO |

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
    "MODELS": "provider/model-id,provider/model-id2"  // comma-separated model IDs; authoritative list
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

  async newSession(userId: string, options?: NewSessionOptions): Promise<ISession> {
    // 1. Generate sessionId = crypto.randomUUID()
    // 2. Resolve DO stub: env.AGENT_SESSION.idFromName(sessionId)
    // 3. Call stub.initSession(sessionId, userId, options) to initialise the DO
    // 4. Return stub.getSession(userId) — the DO's own SessionImpl RpcTarget
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

### `ISession` — gateway-facing RpcTarget

`PiccoloCore` returns the DO's own `SessionImpl` directly to the gateway. Because `SessionImpl extends RpcTarget`, Workers JSRPC serialises it transparently across the WorkerEntrypoint → gateway boundary — no separate wrapper class is needed.

`AgentSessionDO` exposes a `getSession(userId): ISession` method for this purpose:

```typescript
// On AgentSessionDO:
getSession(userId: string): ISession {
  // Creates or re-uses the SessionImpl for this DO, stamping userId.
  // Returns it as ISession — same instance used by tools and extensions.
}
```

The `fork()` method on `SessionImpl` (called by a gateway via this RpcTarget) creates the forked session's DO stub and returns its `SessionImpl` the same way:

```typescript
async fork(fromEntryId?: string): Promise<ISession> {
  const newSessionId = await forkSession(...);
  return env.AGENT_SESSION
    .get(env.AGENT_SESSION.idFromName(newSessionId))
    .getSession(this.doState.userId);
}

  async appendCustomMessage(customType: string, content: string, display: boolean) {
    return this.#doStub.appendCustomMessage(customType, content, display);
  }
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
  // lastContextWindowTokens: model's declared context window size (default 200_000).
  lastInputTokens: number;
  lastContextWindowTokens: number;

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

### `initSession()`

Called by `IPiccoloCore.newSession()` (step 9) to initialise the DO before the first `prompt()` call. Idempotent — if `sessionId` is already set, it is a no-op.

```typescript
async initSession(
  sessionId: string,
  userId: string,
  options?: { name?: string; modelId?: string },
): Promise<void>
```

1. If `state.sessionId !== ""` → return immediately (already initialised).
2. Set `state.sessionId`, `state.userId`, `state.modelId`, `state.name`.
3. Persist `sessionId` to DO storage (`ctx.storage.put("sessionId", sessionId)`) for cold-start recovery.
4. Reconstruct the `LanguageModel` from `env` via `createModel(env, modelId)` and call `state.agent.setModel(model)`.

The D1 `sessions` row is **not** written here — it is written lazily on the first `agent_end` (see §Lazy session creation).

---

### `prompt()` pipeline

```
IAgentSessionDO.prompt(text, attachments?)
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
│     If inputTokens / contextWindowTokens > 0.8: compact() before proceeding
│
├─ 6. Set up ReadableStream<AgentEvent> + subscriber
│
├─ 7. agent.prompt(userMessages) → streaming begins
│     Each AgentEvent from agent:
│       - Forward to ReadableStream pushed to caller
│       - Emit to ExtensionRunner (fire-and-forget)
│       - On "agent_end": flushPendingEntries(), checkRetry()
│
└─ 8. Return ReadableStream<AgentEvent> to IPiccoloCore
```

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
  async initialize(ctx: SessionImpl): Promise<void> {
    // 1. Read extensions:registry from CONFIG KV → string[]
    // 2. For each name:
    //    stub = env.EXTENSIONS.get(name)
    //    tools = await stub.getTools()           // wrapped in ExtensionToolAdapter
    //    commands = await stub.getCommands(ctx)  // store for onInput routing
    //    sysPromptAdditions = await stub.getSystemPromptAdditions(ctx)
    // 3. Store stubs as IAgentTool[] (via ExtensionToolAdapter), commands, sysPromptAdditions
  }
}
```

### `ExtensionToolAdapter`

Each tool descriptor returned by `getTools()` is wrapped in an `ExtensionToolAdapter` that implements `IAgentTool`. When the LLM calls a tool, the adapter dispatches to the extension Worker via `executeTool()`, passing the full `SessionImpl` as `ctx`:

```typescript
class ExtensionToolAdapter implements IAgentTool {
  readonly descriptor: AgentToolDescriptor; // ToolDescriptorLike satisfies AgentToolDescriptor

  constructor(
    private readonly stub: IExtensionWorkerLike,
    descriptorLike: ToolDescriptorLike,
  ) {
    this.descriptor = descriptorLike;
  }

  async execute(toolCallId, params, ctx, signal?) {
    // ctx is the live SessionImpl, injected by agent.setContext()
    return await this.stub.executeTool?.(
      this.descriptor.name, toolCallId, params as Record<string, unknown>,
      ctx as SessionImpl,
    ) ?? { content: [] };
  }
}
```

### `getToolsByNames`

```typescript
getToolsByNames(names: string[]): IAgentTool[]
```

Filters the stored `IAgentTool[]` list by `descriptor.name`. Used by `ISession.setActiveTools(names)`.

### Dispatch and merge rules

All dispatch calls are `Promise.all` across all extension stubs. Each method follows specific merge semantics:

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
class ExtensionRunner {
  async emitInput(event: InputEvent, ctx: SessionImpl): Promise<InputResult> {
    const results = await Promise.all(
      this.stubs.map(s => s.onInput?.(event, ctx).catch(() => undefined))
    );
    return results.find(r => r && r.action !== "continue")
      ?? { action: "continue" };
  }

  async emitToolCall(event: ToolCallEvent, ctx: SessionImpl): Promise<ToolCallResult> {
    const results = await Promise.all(
      this.stubs.map(s => s.onToolCall?.(event, ctx).catch(() => undefined))
    );
    return results.find(r => r?.block)
      ?? { block: false };
  }

  async emitToolResult(event: ToolResultEvent, ctx: SessionImpl): Promise<ToolResultOverride | undefined> {
    // Chain: each handler receives the output of the previous
    let current: ToolResultOverride | undefined;
    for (const stub of this.stubs) {
      const result = await stub.onToolResult?.(
        current ? { ...event, output: current } : event, ctx
      ).catch(() => undefined);
      if (result) current = result;
    }
    return current;
  }

  async emitBeforeAgentStart(event: BeforeAgentStartEvent, ctx: SessionImpl): Promise<BeforeAgentStartResult> {
    const results = await Promise.all(
      this.stubs.map(s => s.onBeforeAgentStart?.(event, ctx).catch(() => undefined))
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
function parseCommand(text: string, commands: CommandDescriptor[]): {
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

1. **Threshold**: `contextUsage.usedFraction > 0.8` checked at the start of every `prompt()` call
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

## Auto-Retry — Implementation

Triggered when `AgentEvent { type: "error" }` fires and the error is transient.

```typescript
const TRANSIENT_ERROR_RE = /overloaded|rate.?limit|429|503|504|timeout/i;
const CONTEXT_OVERFLOW_RE = /context.?length|too.?many.?token|prompt.?too.?long/i;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

async function checkRetry(
  errorMessage: string,
  agent: Agent,
  signal: AbortSignal,
  // Called when error is a context-length overflow so the caller can trigger compaction.
  // Returns false after invoking the callback (not a retryable error).
  onContextOverflow: () => Promise<void>,
): Promise<boolean> {
  if (CONTEXT_OVERFLOW_RE.test(errorMessage)) {
    // Not a transient error — invoke compaction callback and return false
    await onContextOverflow();
    return false;
  }
  if (!TRANSIENT_ERROR_RE.test(errorMessage)) {
    return false;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    const jittered = delay * (0.8 + Math.random() * 0.4);
    await sleep(jittered, signal);

    // Remove the failed assistant message before retrying
    agent.replaceMessages(
      agent.state.messages.filter((_, i) => i < agent.state.messages.length - 1)
    );
    await agent.continue();

    if (!agent.state.error) return true;  // success
  }
  return false;
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

`AgentSessionDO.prompt()` calls `state.agent.setContext(session)` immediately after creating the session (typed as `ISession`). The agent stores it as `IAgentSession` and passes it to `toAiSdkTools(tools, ctx)`, which threads it into every tool `execute()` call. This is the JSRPC-correct approach: the full `RpcTarget` crosses the Worker dispatch boundary with the tool call.

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
  ).bind(newSessionId, userId, Date.now(), Date.now(), undefined, modelId, path.at(-1)?.id ?? null).run();

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
    name: r.name ?? undefined,
    cwd: r.cwd ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
    firstMessage: truncate(r.first_message ?? "", 100),
  }));
}
```
