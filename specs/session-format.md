# Session Format — Specification

Complete specification for the JSONL session file format used by `@mariozechner/pi-coding-agent`.

---

## Overview

Sessions are stored as **JSONL** (newline-delimited JSON) files. Each line is a JSON object representing one entry. Entries form a **tree** via `parentId` references, allowing session branching, forking, and `/tree` navigation without deleting any history.

---

## File Location

```
~/.pi/agent/sessions/{encoded-cwd}/{TIMESTAMP}_{UUID}.jsonl
```

- `{encoded-cwd}` = cwd path with `/` replaced by `--`  
  Example: `/home/user/myproject` → `--home--user--myproject`
- `{TIMESTAMP}` = ISO 8601 date at session creation, filesystem-safe  
  Example: `2026-03-23T14-30-00`
- `{UUID}` = UUID v4

Example path:  
`~/.pi/agent/sessions/--home--user--myproject/2026-03-23T14-30-00_a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl`

---

## File Structure

```
Line 1:   SessionHeader   (always first)
Line 2:   SessionEntry    (any entry type)
Line 3:   SessionEntry
...
Line N:   SessionEntry
```

Entries are appended; never modified or deleted. An empty file (after the header) is valid.

---

## Current Version

`version: 3`

---

## `SessionHeader`

Always the first line of every session file.

```typescript
interface SessionHeader {
  type: "session";
  version?: number;         // current: 3; absent = v1 (pre-tree)
  id: string;               // UUID v4 — the session's unique identifier
  timestamp: string;        // ISO 8601 creation time
  cwd: string;              // working directory at session creation
  parentSession?: string;   // absolute path to parent session (for forks)
}
```

**Example:**
```json
{"type":"session","version":3,"id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","timestamp":"2026-03-23T14:30:00.000Z","cwd":"/home/user/myproject"}
```

---

## Common Entry Fields

All session entries have these fields:

```typescript
interface SessionEntryBase {
  type: string;             // discriminant
  id: string;               // 8-character hex (e.g., "a1b2c3d4")
  parentId: string | null;  // parent entry's id, or null for root entries
  timestamp: string;        // ISO 8601
}
```

`id` generation: `crypto.randomBytes(4).toString("hex")` → 8 hex chars.

---

## Entry Types

### `SessionMessageEntry`

Stores a single LLM message (user, assistant, or toolResult).

```typescript
interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: Message;  // from @mariozechner/pi-ai
}
```

The `message` field is the full `UserMessage`, `AssistantMessage`, or `ToolResultMessage` object.

**Example — user message:**
```json
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-03-23T14:30:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello"}],"timestamp":1742736601000}}
```

**Example — assistant message:**
```json
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2026-03-23T14:30:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-opus-4-6","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.00015,"output":0.000375,"cacheRead":0,"cacheWrite":0,"total":0.000525}},"stopReason":"stop","timestamp":1742736602000}}
```

**Example — tool result:**
```json
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2026-03-23T14:30:03.000Z","message":{"role":"toolResult","toolCallId":"toolu_123","toolName":"read","content":[{"type":"text","text":"file content here"}],"isError":false,"timestamp":1742736603000}}
```

### `ModelChangeEntry`

Recorded when user switches models during a session.

```typescript
interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}
```

**Example:**
```json
{"type":"model_change","id":"d4e5f6a7","parentId":"c3d4e5f6","timestamp":"2026-03-23T14:31:00.000Z","provider":"openai","modelId":"gpt-5.4"}
```

### `ThinkingLevelChangeEntry`

Recorded when user changes thinking level.

```typescript
interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}
```

**Example:**
```json
{"type":"thinking_level_change","id":"e5f6a7b8","parentId":"d4e5f6a7","timestamp":"2026-03-23T14:31:30.000Z","thinkingLevel":"high"}
```

### `CompactionEntry`

Recorded after context compaction. Contains the LLM-generated summary and a pointer to the first kept entry.

```typescript
interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;             // LLM-generated summary of compacted messages
  firstKeptEntryId: string;    // id of the first entry that was NOT summarized
  tokensBefore: number;        // total tokens before compaction
}
```

**Example:**
```json
{"type":"compaction","id":"f6a7b8c9","parentId":"c3d4e5f6","timestamp":"2026-03-23T14:35:00.000Z","summary":"The user asked to implement a REST API endpoint. We created /api/users.ts with GET and POST handlers, updated the router...","firstKeptEntryId":"b2c3d4e5","tokensBefore":145000}
```

### `BranchSummaryEntry`

Recorded when navigating away from a branch via `/tree`. Contains a summary of the abandoned branch for context.

```typescript
interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  summary: string;             // LLM-generated summary of the branch
  fromId: string;              // entry id where the branch diverged, or "root"
  details?: unknown;           // extension-defined metadata
  fromHook?: boolean;          // true when generated by extension hook
}
```

**Example:**
```json
{"type":"branch_summary","id":"a7b8c9d0","parentId":"a1b2c3d4","timestamp":"2026-03-23T14:40:00.000Z","summary":"In this branch, attempted to add TypeScript strict mode but encountered circular dependency issues...","fromId":"a1b2c3d4"}
```

### `CustomEntry`

Client-side-only state stored by extensions. NOT reconstructed as LLM messages.

```typescript
interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;    // extension-defined type discriminant
  data?: unknown;        // arbitrary extension data
}
```

**Example:**
```json
{"type":"custom","id":"b8c9d0e1","parentId":"c3d4e5f6","timestamp":"2026-03-23T14:30:05.000Z","customType":"plan-mode-state","data":{"steps":["Step 1","Step 2"],"currentStep":0}}
```

### `CustomMessageEntry`

Extension-defined messages that ARE sent to the LLM context.

```typescript
interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}
```

When building session context, `custom_message` entries are converted with `createCustomMessage(customType, content, display, details, timestamp)`.

**Example:**
```json
{"type":"custom_message","id":"c9d0e1f2","parentId":"a1b2c3d4","timestamp":"2026-03-23T14:30:00.500Z","customType":"skill_invocation","content":"# Code Review Skill\n\nWhen reviewing code...","display":true}
```

### `LabelEntry`

User-defined bookmark. Displayed in `/tree` view.

```typescript
interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}
```

**Example:**
```json
{"type":"label","id":"d0e1f2a3","parentId":"b2c3d4e5","timestamp":"2026-03-23T14:30:02.500Z","targetId":"b2c3d4e5","label":"Working implementation"}
```

### `SessionInfoEntry`

Stores display metadata for the session.

```typescript
interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}
```

**Example:**
```json
{"type":"session_info","id":"e1f2a3b4","parentId":null,"timestamp":"2026-03-23T14:30:00.100Z","name":"REST API implementation"}
```

---

## Tree Structure

Entries form a tree via `parentId`:

```
null ← "session_info" (root)
  │
  └─ "a1b2c3d4" (user message: "Hello")
        │
        └─ "b2c3d4e5" (assistant: "Hi!")
              │
              ├─ "c3d4e5f6" (user: "/fork here")
              │     │
              │     └─ "d4e5f6a7" (assistant: "Forked branch response")
              │           │
              │           └─ [abandoned branch entries...]
              │
              └─ "e5f6a7b8" (user: "Continue on main branch")
                    │
                    └─ "f6a7b8c9" (current leaf)
```

**Key concepts:**
- `leafId` = the ID of the most recently active entry
- A "branch" is any path from `leafId` back to the root (via `parentId` chain)
- Multiple active paths can exist simultaneously (branching history)
- `SessionManager.branch(entryId)` changes `leafId` to `entryId`, next append creates a new branch from there
- `SessionManager.resetLeaf()` sets `leafId = null`, next append starts a new root-level chain

---

## Context Reconstruction Algorithm

`buildSessionContext(leafId?)` walks the tree and produces the `Message[]` for the LLM:

```
function buildSessionContext(leafId = this.leafId):
  // 1. Walk tree from leafId to root
  pathEntries = []
  current = entries.find(e => e.id === leafId)
  while current exists:
    pathEntries.push(current)
    current = entries.find(e => e.id === current.parentId)
  pathEntries.reverse()  // now root-first

  // 2. Find compaction entry (if any)
  compactionIdx = pathEntries.findLastIndex(e => e.type === "compaction")

  // 3. Extract metadata
  thinkingLevel = "off"
  model = null
  for each entry in pathEntries:
    if entry.type === "thinking_level_change": thinkingLevel = entry.thinkingLevel
    if entry.type === "model_change": model = { provider: entry.provider, modelId: entry.modelId }
    if entry.type === "message" && entry.message.role === "assistant":
      model = { provider: entry.message.provider, modelId: entry.message.model }

  // 4. Build message list
  messages = []
  if compactionIdx >= 0:
    compactionEntry = pathEntries[compactionIdx]

    // Add synthetic summary message
    messages.push({
      role: "user",
      content: [{ type: "text", text: `[Summary of previous conversation]\n${compactionEntry.summary}` }],
      timestamp: compactionEntry.timestamp
    })

    // Find entries from firstKeptEntryId to the compaction point
    firstKeptIdx = pathEntries.findIndex(e => e.id === compactionEntry.firstKeptEntryId)
    keptEntries = pathEntries.slice(firstKeptIdx, compactionIdx)
    postCompactionEntries = pathEntries.slice(compactionIdx + 1)
    relevantEntries = [...keptEntries, ...postCompactionEntries]
  else:
    relevantEntries = pathEntries

  // 5. Convert entries to messages
  for each entry in relevantEntries:
    switch entry.type:
      "message":
        messages.push(entry.message)

      "custom_message":
        messages.push(createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp))

      "branch_summary":
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `[Previous branch summary]\n${entry.summary}` }],
          // minimal assistant message fields
        })

      // All other types (label, session_info, model_change, etc.) are skipped

  return SessionContext { messages, model, thinkingLevel }
```

Special case: `leafId === null` means "before first entry" and returns empty `messages`, `thinkingLevel: "off"`, and `model: null`.

---

## Persistence Behavior

Sessions are written to disk **lazily** — only after the first assistant response:

```
state:
  flushed: boolean = false
  bufferedEntries: SessionEntry[] = []

appendMessage(message):
  entry = createEntry(message)
  bufferedEntries.push(entry)

  if agent has responded AND !flushed:
    // Write header + all buffered entries to file
    fs.writeFileSync(path, JSON.stringify(header) + "\n")
    for each entry in bufferedEntries:
      fs.appendFileSync(path, JSON.stringify(entry) + "\n")
    bufferedEntries = []
    flushed = true
  else if flushed:
    fs.appendFileSync(path, JSON.stringify(entry) + "\n")
```

This prevents creating session files for conversations that were immediately abandoned.

---

## Version Migration

### v1 → v2 (tree structure)

v1 had no `id`/`parentId` fields — a flat linear array.  
v2 adds tree structure.

Migration applied on `SessionManager.open()`:
```
if version is absent or 1:
  for each entry:
    entry.id = generateId()
    entry.parentId = previousEntry?.id || null
    if entry.type === "compaction":
      entry.firstKeptEntryId = findEntryIdByIndex(entry.firstKeptEntryIndex)
      delete entry.firstKeptEntryIndex
  version = 2
```

### v2 → v3 (role rename)

`"hookMessage"` message role renamed to `"custom"` inside `type: "message"` entries.

Migration:
```
if version === 2:
  for each entry:
    if entry.type === "message" and entry.message.role === "hookMessage":
      entry.message.role = "custom"
  version = 3
```

---

## `SessionInfo`

Lightweight summary object returned by listing APIs. Computed from session file contents.

```typescript
interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
}
```

`SessionManager.list(cwd)` and `SessionManager.listAll()` return `SessionInfo[]` sorted by `modified` descending.

---

## In-Memory Session (`SessionManager.inMemory`)

For testing or `--no-session` mode: all operations work on in-memory arrays without any file I/O.

- `path = undefined`
- `appendMessage()` etc. work normally on in-memory state
- Nothing is written to disk
- `list()` returns `[]`

---

## Fork Sessions

When a user forks a session (`/fork` command or `SessionManager.forkFrom()`):

1. Walk tree from `entryId` (the fork point) to root
2. Collect all entries on that path
3. Write a new session file with:
   - New `SessionHeader` with `parentSession: originalPath`
   - All entries from the fork path (with new IDs)
4. The original session is unchanged
5. Both sessions share history up to the fork point (by copying, not referencing)

```typescript
static async forkFrom(
  sourcePath: string,
  targetCwd: string,
  sessionDir?: string,
): Promise<SessionManager>
```
