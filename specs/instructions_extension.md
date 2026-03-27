# Instructions Extension — Specification

The instructions extension maintains a persistent list of user-authored instructions that are automatically appended to the system prompt every session. Instructions are scoped to `everyone`, a specific `user`, or a specific `session`, and are managed through a single in-session LLM tool.

---

## Extension Worker

**Name:** `ext-instructions`
**Implements:** `IExtensionWorker` (see [api.md §8](api.md))
**Bindings required:** D1 database (`env.INSTRUCTIONS_DB`)

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-instructions",
  "d1_databases": [
    { "binding": "INSTRUCTIONS_DB", "database_name": "piccolo-instructions", "database_id": "<INSTRUCTIONS_DB_ID>" }
  ]
}
```

---

## D1 Schema

Database: `piccolo-instructions` (separate from `piccolo-sessions`).
Migration: `extensions/instructions/migrations/0001_initial.sql`.

```sql
CREATE TABLE instructions (
  id         TEXT    PRIMARY KEY,   -- UUID v4
  scope_type TEXT    NOT NULL CHECK (scope_type IN ('everyone', 'user', 'session')),
  scope_id   TEXT    NOT NULL,      -- '' for everyone, userId for user, sessionId for session
  content    TEXT    NOT NULL,      -- the instruction text
  created_at INTEGER NOT NULL       -- Unix ms
);

CREATE INDEX instructions_lookup ON instructions(scope_type, scope_id);
```

### Scope rules

| `scope_type` | `scope_id` value | Applies to |
|---|---|---|
| `everyone` | `''` (empty string) | Every user, every session |
| `user` | userId string | All sessions belonging to that user |
| `session` | sessionId string | Only that specific session |

---

## Visible Instructions Query

All instructions visible in a given session are fetched with a **single query**:

```sql
SELECT * FROM instructions
WHERE (scope_type = 'everyone' AND scope_id = '')
   OR (scope_type = 'user'     AND scope_id = ?)
   OR (scope_type = 'session'  AND scope_id = ?)
ORDER BY created_at ASC
```

Bound with `[userId, sessionId]`. This query is used both in `getSystemPromptAdditions()` and in the `list` action of the tool.

---

## System Prompt Injection

`getSystemPromptAdditions()` is called once at session start. It:

1. Resolves `userId` and `sessionId` from `ctx`.
2. Issues the visible instructions query (see above).
3. If no instructions exist, returns `[]` (no addition).
4. Otherwise returns a single `SystemPromptAddition`:

```typescript
{
  section: "context",
  content: "## Instructions\n\n" + rows.map(r => `- ${r.content}`).join("\n"),
  priority: 10,
}
```

Priority 10 places instructions near the top of the `context` section, before most other extension additions.

---

## Tool: `instructions`

One tool with an `action` discriminator. Registered via `getTools(ctx)`.

### Descriptor

```typescript
{
  name: "instructions",
  label: "Instructions",
  description: "...",   // see implementation
  promptSnippet: "Manage persistent instructions that are appended to the system prompt",
  inputSchema: { ... }, // zod-derived, see below
}
```

### Actions

#### `list`

Returns all instructions currently visible in this session (all three scopes combined), displayed as a table with columns: `id`, `scope_type`, `scope_id`, `content`.

Input:
```typescript
{ action: "list" }
```

Output (text for LLM):
```
id                                    scope_type  scope_id  content
--------------------------------------------------------------------
<uuid>                                everyone              Always respond in English.
<uuid>                                user        user-123  Prefer concise answers.
<uuid>                                session     sess-456  Focus on TypeScript today.
```

Returns an empty message if no instructions exist.

#### `add`

Inserts a new instruction. `scope_type` is always required — no default.

Input:
```typescript
{ action: "add"; scope_type: "everyone" | "user" | "session"; content: string }
```

- `scope_id` is resolved automatically from `ctx`:
  - `everyone` → `''`
  - `user` → `ctx.userId()`
  - `session` → `ctx.sessionId()`

Output (text for LLM): confirmation with the new instruction's `id`.

#### `remove`

Deletes an instruction by its UUID. Returns an error if the ID does not exist.

Input:
```typescript
{ action: "remove"; id: string }
```

Output (text for LLM): confirmation of deletion, or error if not found.

---

## `db.ts` — Typed D1 Helpers

```typescript
type ScopeType = "everyone" | "user" | "session";

interface InstructionRow {
  id: string;
  scope_type: ScopeType;
  scope_id: string;
  content: string;
  created_at: number;
}

// One query — all 3 scopes visible in this session
function listVisible(db: D1Database, userId: string, sessionId: string): Promise<InstructionRow[]>

// Insert a new instruction row; generates UUID v4 internally; returns new id
function addInstruction(db: D1Database, scopeType: ScopeType, scopeId: string, content: string): Promise<string>

// Delete by id; returns false if the row did not exist
function removeInstruction(db: D1Database, id: string): Promise<boolean>
```

---

## File Layout

```
extensions/instructions/
├── package.json                     (@piccolo/ext-instructions)
├── tsconfig.json
├── vitest.config.ts
├── wrangler.template.jsonc
├── migrations/
│   └── 0001_initial.sql
└── src/
    ├── index.ts                     (default export = InstructionsExtension)
    ├── extension.ts                 (InstructionsTool RpcTarget + InstructionsExtension WorkerEntrypoint)
    ├── db.ts                        (listVisible, addInstruction, removeInstruction)
    └── worker-configuration.d.ts    (generated by wrangler types)
└── test/
    ├── tsconfig.json
    ├── env.d.ts
    └── extension.test.ts
```

---

## Deployment

```bash
# Create the D1 database
wrangler d1 create piccolo-instructions

# Run migrations
wrangler d1 migrations apply piccolo-instructions

# Deploy the extension Worker
wrangler deploy --name ext-instructions --dispatch-namespace piccolo-extensions

# Register in the extension registry
wrangler kv key put --binding CONFIG \
  extensions:registry '["ext-instructions", "...other extensions..."]'
```

No piccolo-core redeploy required.
