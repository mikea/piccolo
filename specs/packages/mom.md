# `@mariozechner/pi-mom` — Specification

**Package:** `packages/mom/`  
**npm name:** `@mariozechner/pi-mom`  
**Binary:** `mom`  
**Version:** lockstep with monorepo  
**Runtime:** Node.js ≥ 20, ESM only

---

## Purpose

A Slack bot that bridges Slack channels and DMs to a pi coding agent. Each Slack channel or DM gets its own persistent agent session. The bot processes messages sequentially per-channel (prevents concurrent agent runs), downloads file attachments, and supports scheduled/immediate/periodic events via watched JSON files.

---

## Directory Structure

```
src/
├── main.ts           # Entry: CLI parsing, SlackBot wiring, EventsWatcher startup
├── agent.ts          # AgentRunner factory wrapping pi-coding-agent
├── slack.ts          # SlackBot: SocketMode client, event routing, backfill, posting
├── context.ts        # log.jsonl ↔ SessionManager sync; WorkspaceSettingsStorage
├── events.ts         # EventsWatcher: watched JSON file event scheduler
├── store.ts          # ChannelStore: attachment downloads, log.jsonl writes
├── download.ts       # --download mode: dump channel history to stdout
├── log.ts            # Chalk-colored console logging helpers
├── sandbox.ts        # Executor abstraction: HostExecutor / DockerExecutor
└── tools/
    ├── index.ts      # createMomTools() factory
    ├── bash.ts       # bash tool
    ├── read.ts       # read tool
    ├── write.ts      # write tool
    ├── edit.ts       # edit tool
    ├── attach.ts     # attach tool: upload files to Slack
    └── truncate.ts   # truncateHead/truncateTail helpers
```

---

## Startup

### `main(args)` Sequence

```
1. Parse CLI args:
   - mom [--sandbox=host|docker:<name>] <working-directory>
   - mom --download <channel-id>

2. If --download: run downloadMode(channelId, workingDir); exit

3. Validate --sandbox argument (parseSandboxArg, validateSandbox):
   - "host" → HostExecutor
   - "docker:<container-name>" → DockerExecutor

4. Create SlackBot (reads MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN from env)

5. Create MomHandler (wraps AgentRunner logic):
   - Creates ChannelStore
   - Wires event handlers

6. Create EventsWatcher(workingDir, slack)

7. slack.start():
   - Connects SocketMode WebSocket
   - Backfills all channels
   - Starts listening for events

8. eventsWatcher.start()
```

---

## Slack Integration (`src/slack.ts`)

### `SlackBot`

```typescript
class SlackBot {
  constructor(appToken: string, botToken: string);

  async start(): Promise<void>;
  async stop(): Promise<void>;

  // User/channel lookups
  getUser(userId: string): SlackUser | undefined;
  getChannel(channelId: string): SlackChannel | undefined;
  getAllUsers(): Map<string, SlackUser>;
  getAllChannels(): Map<string, SlackChannel>;

  // Message posting
  async postMessage(channelId: string, text: string): Promise<string>;  // returns ts
  async updateMessage(channelId: string, ts: string, text: string): Promise<void>;
  async deleteMessage(channelId: string, ts: string): Promise<void>;
  async postInThread(channelId: string, threadTs: string, text: string): Promise<void>;
  async uploadFile(channelId: string, ts: string, filePath: string, filename: string): Promise<void>;

  // Logging
  async logToFile(channelDir: string, message: LoggedMessage): Promise<void>;
  async logBotResponse(channelDir: string, text: string, ts: string): Promise<void>;

  // Event injection (used by EventsWatcher)
  enqueueEvent(event: SlackEvent): void;
}
```

### `SlackEvent`

```typescript
interface SlackEvent {
  type: "mention" | "dm";
  channel: string;     // channelId
  ts: string;          // Slack message timestamp
  user: string;        // userId
  text: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
}
```

### `SlackContext`

```typescript
interface SlackContext {
  message: SlackEvent;
  channelName?: string;
  channels: Map<string, SlackChannel>;
  users: Map<string, SlackUser>;
  respond(text: string): Promise<void>;        // update main message
  replaceMessage(text: string): Promise<void>; // replace without "..." suffix
  respondInThread(text: string): Promise<void>;
  setTyping(working: boolean): Promise<void>;  // adds/removes " ..." suffix
  uploadFile(filePath: string, filename: string): Promise<void>;
  setWorking(working: boolean): void;
  deleteMessage(): Promise<void>;
}
```

### Startup Sequence (`start()`)

```
1. Fetch all users from Slack API (paginated)
2. Fetch all channels (public + private + DMs)
3. startupTs = Date.now() (used to skip old messages)

4. For each channel that has log.jsonl:
   backfillChannel(channelId):
     latestTs = readLastTimestamp(log.jsonl)
     fetch history from Slack API (oldest=latestTs, limit=1000, max 3 pages)
     for each message not in log.jsonl:
       logToFile(channelDir, message)
       // do NOT process — these are historical

5. Connect SocketMode WebSocket
6. Register event handlers: app_mention, message (DMs)
```

### Event Routing

```
On app_mention or message (DM):
  1. Create SlackEvent from Slack payload
  2. logToFile(channelDir, event) — log BEFORE processing
  3. if event.ts <= startupTs: skip (historical message from before bot started)
  4. if handler.isRunning(channelId): post "I'm busy..." reply; return
  5. handler.handleEvent(event, slack)
```

### Message Accumulation Pattern

All `respond()` calls within a single agent run accumulate to the same Slack message:

```typescript
class SlackMessageContext implements SlackContext {
  private accumulatedText = "";
  private ts: string;  // main message ts
  private threadMessages: string[] = [];
  private queueChain: Promise<void> = Promise.resolve();
  private isWorking = false;

  respond(text: string): Promise<void> {
    this.queueChain = this.queueChain.then(() => {
      this.accumulatedText += text;
      const displayText = this.isWorking
        ? this.accumulatedText + " ..."
        : this.accumulatedText;
      return slack.updateMessage(channelId, this.ts, displayText);
    });
    return this.queueChain;
  }
}
```

`queueChain` ensures strict ordering of all Slack API calls even when agent events fire async.

---

## Agent Runner (`src/agent.ts`)

### `AgentRunner`

```typescript
interface AgentRunner {
  run(
    ctx: SlackContext,
    store: ChannelStore,
    pendingMessages?: PendingMessage[],
  ): Promise<{ stopReason: StopReason; errorMessage?: string }>;
  abort(): void;
}

interface PendingMessage {
  userName: string;
  text: string;
  attachments: { local: string }[];
  timestamp: number;
}
```

### `getOrCreateRunner(sandboxConfig, channelId, channelDir): AgentRunner`

Creates one `AgentRunner` per channel, cached across messages. Cache key is `channelId`.

### `run()` sequence

```
1. Re-read MEMORY.md files:
   - workingDir/MEMORY.md (global)
   - workingDir/channelId/MEMORY.md (channel-specific)

2. Reload skills from workingDir/skills/ and workingDir/channelId/skills/

3. Sync log.jsonl → SessionManager:
   syncLogToSessionManager(sessionManager, channelDir)
   (only messages newer than what's already in context)

4. Rebuild system prompt (buildMomSystemPrompt):
   - Includes MEMORY.md content
   - Lists all Slack users and channels
   - Documents event system (JSON file format)
   - Includes tool descriptions

5. Set upload function for attach tool:
   setUploadFunction((filePath, filename) => ctx.uploadFile(filePath, filename))

6. Subscribe to agent events:
   - tool_execution_start: ctx.respondInThread("→ {tool.label}")
   - tool_execution_end: ctx.respondInThread("args: {json}\nresult: {truncated}")
   - message_start: ctx.setTyping(true)
   - message_end: ctx.respond(assistantMessage.text)
   - auto_compaction_start/end: ctx.respondInThread(status)
   - auto_retry_start: ctx.respondInThread("Retrying... attempt N")

7. Build user messages from pendingMessages:
   UserMessage { role: "user", content: [TextContent, ...ImageContent[]] }
   (images from downloaded attachments)

8. agent.prompt(userMessages)

9. await agent.waitForIdle()

10. Check stopReason:
    - If text === "[SILENT]": delete main message + all thread messages
    - Else: post token usage summary to thread

11. Return { stopReason, errorMessage }
```

---

## Context Sync (`src/context.ts`)

### `syncLogToSessionManager(sessionManager, channelDir, excludeSlackTs?)`

```
1. Read log.jsonl → array of LoggedMessage
2. Build set of existing message identifiers from sessionManager
   (using timestamp as key, after stripping ":ts" prefix)

3. For each LoggedMessage not in session:
   - If isBot: skip (bot messages come from agent events, not log)
   - Else: create UserMessage and appendMessage to sessionManager

Return count of messages injected
```

### `createMomSettingsManager(workspaceDir): SettingsManager`

Creates a `SettingsManager` reading from `workspaceDir/settings.json`.

---

## Event System (`src/events.ts`)

### Event File Formats

Files in `{workingDir}/events/` directory (watched with `fs.watch`):

**Immediate event** (`{channelId}_immediate_{uuid}.json`):
```json
{
  "type": "immediate",
  "channelId": "C123456",
  "text": "Daily standup reminder: please post your updates"
}
```

**One-shot event** (`{channelId}_oneshot_{uuid}.json`):
```json
{
  "type": "one-shot",
  "channelId": "C123456",
  "text": "Deployment scheduled",
  "at": "2026-03-23T14:00:00Z"
}
```

**Periodic event** (`{channelId}_periodic_{uuid}.json`):
```json
{
  "type": "periodic",
  "channelId": "C123456",
  "text": "Daily report request",
  "schedule": "0 9 * * *",
  "timezone": "America/New_York"
}
```

### `EventsWatcher`

```typescript
class EventsWatcher {
  constructor(workspaceDir: string, slack: SlackBot);
  start(): void;
  stop(): void;
}
```

**Processing rules:**

| Event type | Trigger | Conditions |
|---|---|---|
| `immediate` | On file creation detected by `fs.watch` | File must be newer than process start time; stale files deleted silently |
| `one-shot` | `setTimeout` to `at` timestamp | Past events deleted without execution |
| `periodic` | Cron schedule via `croner` | Fires on each cron tick |

**Queue limit:** max 5 events per channel (drops oldest if exceeded).

**Injection:** `slack.enqueueEvent(slackEvent)` — treated identically to a real Slack message.

---

## Sandbox Execution (`src/sandbox.ts`)

### `Executor` Interface

```typescript
interface ExecOptions {
  timeout?: number;  // ms
  signal?: AbortSignal;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface Executor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  getWorkspacePath(hostPath: string): string;
}
```

### `HostExecutor`

Spawns `sh -c command` with `detached: true` for process group killing.

```typescript
class HostExecutor implements Executor {
  constructor(workingDir: string);
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  getWorkspacePath(hostPath: string): string { return hostPath; }
}
```

Caps stdout + stderr at 10MB each.  
On timeout/abort: `process.kill(-pid, "SIGTERM")` (kills entire process group).

### `DockerExecutor`

```typescript
class DockerExecutor implements Executor {
  constructor(workingDir: string, containerName: string);
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  getWorkspacePath(hostPath: string): string {
    // converts /actual/host/path → /workspace
    return hostPath.replace(workingDir, "/workspace");
  }
}
```

Runs: `docker exec {containerName} sh -c '{command}'`

### `parseSandboxArg(value: string): SandboxConfig`

```typescript
type SandboxConfig = { type: "host" } | { type: "docker"; container: string };

// "host" → { type: "host" }
// "docker:my-container" → { type: "docker", container: "my-container" }
```

### `validateSandbox(config): Promise<void>`

For Docker: runs `docker inspect {container}` to verify container exists and is running.

---

## Mom Tools (`src/tools/`)

### `createMomTools(executor: Executor): AgentTool[]`

Returns: `[bash, read, write, edit, attach]`

### `bash` tool

Same schema as coding-agent's bash tool. Uses `executor.exec()` instead of spawning directly. Returns truncated output (last 2000 lines / 50KB via `truncateTail`).

### `read` tool

```typescript
// Schema
Type.Object({ path: Type.String() })
```

Reads file from filesystem. If image: returns base64 as `ImageContent`. If text: returns content as `TextContent`. Uses `truncateHead` (first 2000 lines / 50KB).

### `write` tool

```typescript
Type.Object({ path: Type.String(), content: Type.String() })
```

Writes file, creates parent directories. Path translated via `executor.getWorkspacePath()`.

### `edit` tool

```typescript
Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() })
```

Exact-string replacement (not fuzzy — unlike coding-agent's edit). Returns unified diff. File must contain exactly one occurrence of `oldText`.

### `attach` tool

```typescript
Type.Object({ path: Type.String(), filename: Type.Optional(Type.String()) })
```

Uploads a file to Slack. Uses the `uploadFn` set via `setUploadFunction()`.

```typescript
let uploadFn: ((filePath: string, filename: string) => Promise<void>) | undefined;
function setUploadFunction(fn: typeof uploadFn): void;
```

---

## Channel Store (`src/store.ts`)

```typescript
interface LoggedMessage {
  date: string;        // ISO timestamp
  ts: string;          // Slack message timestamp
  user: string;        // userId
  userName?: string;
  displayName?: string;
  text: string;
  attachments: Attachment[];
  isBot: boolean;
}

interface Attachment {
  original: string;    // Slack URL
  local: string;       // local file path after download
}

class ChannelStore {
  constructor(workingDir: string, slack: SlackBot);

  getChannelDir(channelId: string): string;
  generateLocalFilename(url: string): string;

  // Download Slack file attachments
  async processAttachments(
    channelId: string,
    files: SlackFile[],
  ): Promise<Attachment[]>;

  // Write message to log.jsonl
  async logMessage(channelId: string, message: LoggedMessage): Promise<void>;

  // Write bot response to log.jsonl
  async logBotResponse(channelId: string, text: string, ts: string): Promise<void>;

  // Get most recent message timestamp in log.jsonl
  async getLastTimestamp(channelId: string): Promise<string | undefined>;
}
```

---

## Filesystem Layout

```
{workingDir}/
├── MEMORY.md                    # Global memory (injected to all system prompts)
├── settings.json                # WorkspaceSettingsStorage
├── events/                      # Event JSON files (watched by EventsWatcher)
├── skills/                      # Global skills directory
└── {channelId}/
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # All messages (user + bot), no tool details
    ├── context.jsonl            # Full LLM context (messages + tool results)
    ├── last_prompt.jsonl        # Debug: last system prompt + messages sent to LLM
    ├── attachments/             # Downloaded Slack file attachments
    ├── scratch/                 # Agent working directory
    └── skills/                  # Channel-specific skills
```

---

## Truncation Utilities (`src/tools/truncate.ts`)

```typescript
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 51200;  // 50KB

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes";
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
}

// Keep first N lines/bytes
function truncateHead(
  content: string,
  options?: { maxLines?: number; maxBytes?: number },
): TruncationResult;

// Keep last N lines/bytes
function truncateTail(
  content: string,
  options?: { maxLines?: number; maxBytes?: number },
): TruncationResult;

function formatSize(bytes: number): string;  // "1.2 KB", "3.4 MB"
```

---

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `MOM_SLACK_APP_TOKEN` | Yes | Slack Socket Mode app token (`xapp-...`) |
| `MOM_SLACK_BOT_TOKEN` | Yes | Slack bot token (`xoxb-...`) for Web API |

API keys for AI providers stored in `~/.pi/mom/auth.json` via `AuthStorage`.

---

## `[SILENT]` Protocol

If the final assistant message text is exactly `"[SILENT]"`:
1. Delete the main Slack message
2. Delete all thread replies (individually)
3. No content posted to Slack

Used for periodic events when the agent determines there's nothing to report.

---

## Key Algorithms

### Backfill Deduplication

```
On startup for each channel with existing log.jsonl:
  latestTs = getLastTimestamp(channelDir)
  fetch Slack history: { channel, oldest: latestTs, limit: 1000 }
  maxPages = 3; page = 0
  while has_more && page < maxPages:
    for each message in response:
      if message.ts not in log.jsonl:
        logToFile(channelDir, message)
    page++
```

### Tool Output Forwarding to Thread

```
On tool_execution_start:
  ctx.respondInThread("→ {tool.label}")

On tool_execution_end:
  truncatedArgs = JSON.stringify(args, null, 2)  (truncated at 500 chars)
  truncatedResult = truncate(result.content, 1000 chars)
  ctx.respondInThread(`Args:\n\`\`\`${truncatedArgs}\`\`\`\nResult:\n${truncatedResult}`)
```

### Token Usage Summary

After each successful agent run:
```
usage = state.messages[-1].usage
summary = `Tokens: ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cached
Cost: $${usage.cost.total.toFixed(4)}`
ctx.respondInThread(summary)
```
