# `@mariozechner/pi-coding-agent` — Specification

**Package:** `packages/coding-agent/`  
**npm name:** `@mariozechner/pi-coding-agent`  
**Binary:** `pi` (or `pi-test.sh` from source)  
**Version:** lockstep with monorepo  
**Runtime:** Node.js ≥ 20 or Bun, ESM only

---

## Purpose

Interactive coding agent CLI. Wraps `@mariozechner/pi-agent-core` with session persistence, context compaction, retry logic, extension loading, built-in file system tools, three run modes (interactive TUI, print, RPC), and a public SDK for programmatic use.

---

## Directory Structure

```
src/
├── cli.ts                    # Entry: sets process.title="pi", configures HTTP proxy, calls main()
├── main.ts                   # CLI orchestration: parse args, create AgentSession, dispatch to mode
├── config.ts                 # Path helpers: getAgentDir(), VERSION, APP_NAME, CONFIG_DIR_NAME
├── index.ts                  # Public SDK exports
├── migrations.ts             # One-time startup migrations
├── bun/
│   ├── cli.ts                # Bun binary entry point
│   └── register-bedrock.ts   # Registers Bedrock provider for Bun
├── cli/
│   ├── args.ts               # Args interface, parseArgs(), printHelp()
│   ├── config-selector.ts    # TUI for pi config (package resources)
│   ├── file-processor.ts     # Processes @file args: reads text/images
│   ├── initial-message.ts    # Builds initial prompt from CLI args + stdin
│   ├── list-models.ts        # --list-models implementation
│   └── session-picker.ts     # --resume TUI session picker
├── core/
│   ├── agent-session.ts      # AgentSession class (central coordinator)
│   ├── auth-storage.ts       # AuthStorage: persists API keys + OAuth tokens
│   ├── bash-executor.ts      # BashExecutor: streaming bash execution
│   ├── defaults.ts           # DEFAULT_THINKING_LEVEL = "medium"
│   ├── diagnostics.ts        # ResourceDiagnostic, ResourceCollision types
│   ├── event-bus.ts          # EventBus: pub/sub between extensions
│   ├── exec.ts               # execCommand(): child-process wrapper
│   ├── export-html/          # Session export to HTML
│   ├── extensions/
│   │   ├── types.ts          # ExtensionAPI, ToolDefinition, all event types
│   │   ├── index.ts          # Re-exports
│   │   ├── loader.ts         # loadExtensions(), discoverAndLoadExtensions()
│   │   ├── runner.ts         # ExtensionRunner: dispatches events to extensions
│   │   └── wrapper.ts        # wrapRegisteredTool(): ToolDefinition → AgentTool
│   ├── footer-data-provider.ts  # FooterDataProvider: git branch + extension status
│   ├── keybindings.ts        # AppKeybindings: default keybinding map
│   ├── messages.ts           # Message type constructors
│   ├── model-registry.ts     # ModelRegistry: built-in + custom models
│   ├── model-resolver.ts     # Model selection from CLI args / settings
│   ├── output-guard.ts       # takeOverStdout/restoreStdout
│   ├── package-manager.ts    # DefaultPackageManager: npm/git packages
│   ├── prompt-templates.ts   # PromptTemplate loading
│   ├── resolve-config-value.ts  # Resolves env var references in config
│   ├── resource-loader.ts    # Discovers/loads extensions, skills, prompts, themes
│   ├── sdk.ts                # createAgentSession(): public SDK factory
│   ├── session-manager.ts    # SessionManager: JSONL tree-structured persistence
│   ├── settings-manager.ts   # SettingsManager: global + project settings
│   ├── skills.ts             # Skill loading from directories
│   ├── slash-commands.ts     # BUILTIN_SLASH_COMMANDS + SlashCommandInfo types
│   ├── source-info.ts        # SourceInfo: origin tracking
│   ├── system-prompt.ts      # buildSystemPrompt(): assembles full system prompt
│   ├── timings.ts            # Startup performance timing
│   ├── compaction/
│   │   ├── compaction.ts     # compact(): LLM-based summary generation
│   │   ├── branch-summarization.ts  # generateBranchSummary()
│   │   └── utils.ts          # serializeConversation(), file operation tracking
│   └── tools/
│       ├── index.ts          # allTools, codingTools, readOnlyTools, createAll*()
│       ├── bash.ts           # bash tool
│       ├── edit.ts           # edit tool
│       ├── edit-diff.ts      # fuzzyFindText(), computeEditDiff()
│       ├── file-mutation-queue.ts  # withFileMutationQueue()
│       ├── find.ts           # find tool
│       ├── grep.ts           # grep tool
│       ├── ls.ts             # ls tool
│       ├── path-utils.ts     # resolveToCwd(), resolveReadPath()
│       ├── read.ts           # read tool
│       ├── render-utils.ts   # Shared display helpers
│       ├── tool-definition-wrapper.ts
│       ├── truncate.ts       # truncateHead/Tail/Line
│       └── write.ts          # write tool
├── modes/
│   ├── index.ts
│   ├── print-mode.ts         # runPrintMode()
│   ├── interactive/
│   │   ├── interactive-mode.ts  # InteractiveMode class: full TUI
│   │   ├── theme/
│   │   │   ├── theme.ts      # Theme, initTheme(), setTheme()
│   │   │   ├── dark.json     # Default dark theme
│   │   │   ├── light.json    # Default light theme
│   │   │   └── theme-schema.json
│   │   └── components/       # 35 TUI component files
│   └── rpc/
│       ├── rpc-mode.ts       # runRpcMode()
│       ├── rpc-types.ts      # RpcCommand, RpcResponse, RpcSessionState
│       ├── rpc-client.ts     # RPC client helper
│       └── jsonl.ts          # JSONL framing utilities
└── utils/
    ├── changelog.ts          # CHANGELOG.md parsing
    ├── child-process.ts      # waitForChildProcess()
    ├── clipboard.ts          # copyToClipboard()
    ├── clipboard-image.ts    # readClipboardImage()
    ├── frontmatter.ts        # parseFrontmatter(), stripFrontmatter()
    ├── git.ts                # parseGitUrl()
    ├── image-convert.ts      # Image format conversion
    ├── image-resize.ts       # resizeImage(): 2000×2000 max
    ├── mime.ts               # detectSupportedImageMimeTypeFromFile()
    ├── photon.ts             # Photon WASM image processing
    ├── shell.ts              # getShellConfig(), getShellEnv(), killProcessTree()
    ├── sleep.ts              # sleep(ms, signal): abortable delay
    └── tools-manager.ts      # ensureTool(): fd/rg binary management
```

---

## CLI Argument Parsing (`src/cli/args.ts`)

### `Args` Interface

```typescript
interface Args {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  thinking?: ThinkingLevel;
  continue?: boolean;          // -c / --continue
  resume?: boolean;            // -r / --resume
  help?: boolean;
  version?: boolean;
  mode?: "text" | "json" | "rpc";
  noSession?: boolean;
  session?: string;            // path or UUID prefix
  fork?: string;               // path or UUID prefix
  sessionDir?: string;
  models?: string[];           // comma-separated patterns for model cycling
  tools?: ToolName[];
  noTools?: boolean;
  extensions?: string[];       // -e / --extension (repeatable)
  noExtensions?: boolean;
  print?: boolean;             // -p / --print
  export?: string;             // --export <session.jsonl>
  noSkills?: boolean;
  skills?: string[];
  promptTemplates?: string[];
  noPromptTemplates?: boolean;
  themes?: string[];
  noThemes?: boolean;
  listModels?: string | true;
  offline?: boolean;
  verbose?: boolean;
  messages: string[];          // positional args
  fileArgs: string[];          // @file prefixed args (@ stripped)
  unknownFlags: Map<string, boolean | string>;  // extension-registered flags
}
```

### Two-Pass Parsing

```
1. First pass (no extensionFlags):
   - Discover --extension paths, mode, and whether to take over stdout
   - Load extension modules

2. Extensions register their flags via pi.registerFlag()

3. Second pass (with extensionFlags):
   - Parse extension-registered --flagname flags
   - Values stored in extensionRuntime.flagValues
```

### Package Commands

Before normal parsing, `main()` checks if `process.argv[2]` is:
- `install`, `remove`, `uninstall`, `update`, `list`

If so, routes to `DefaultPackageManager` directly.

---

## Configuration System

### `getAgentDir(): string`

```
Priority: PI_CODING_AGENT_DIR env var → join(homedir(), ".pi", "agent")
```

### `Settings` Interface

```typescript
interface Settings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  transport?: "sse" | "websocket" | "auto";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  theme?: string;
  compaction?: {
    threshold?: number;      // fraction of context window (default 0.8)
    keepRecentTokens?: number;  // default 20000
    reserveTokens?: number;     // default 16384
  };
  branchSummary?: {
    enabled?: boolean;
    reserveTokens?: number;
  };
  retry?: {
    maxRetries?: number;     // default 3
    baseDelayMs?: number;    // default 2000
    maxDelayMs?: number;     // default 60000
  };
  hideThinkingBlock?: boolean;
  shellPath?: string;
  quietStartup?: boolean;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  collapseChangelog?: boolean;
  packages?: PackageSource[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
  enableSkillCommands?: boolean;
  terminal?: { showImages?: boolean; clearOnShrink?: boolean };
  images?: { autoResize?: boolean; blockImages?: boolean };
  enabledModels?: string[];
  doubleEscapeAction?: "fork" | "tree" | "none";
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
  thinkingBudgets?: ThinkingBudgets;
  editorPaddingX?: number;
  autocompleteMaxVisible?: number;
  showHardwareCursor?: boolean;
  markdown?: { codeBlockIndent?: string };
}
```

**Deep merge:** project `.pi/settings.json` merges on top of global `~/.pi/agent/settings.json`. Arrays and primitives: project wins. Nested objects: keys merged recursively.

---

## `AgentSession` Class (`src/core/agent-session.ts`)

The central coordination object. Wraps `Agent` from `pi-agent-core` and adds session persistence, compaction, retry, extensions, model management, and tool management.

### Constructor

```typescript
interface AgentSessionConfig {
  agent: Agent;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;
  scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
  resourceLoader: ResourceLoader;
  customTools?: ToolDefinition[];
  modelRegistry: ModelRegistry;
  initialActiveToolNames?: string[];
  baseToolsOverride?: Record<string, AgentTool>;
  extensionRunnerRef?: { current?: ExtensionRunner };
}
```

### Public API

```typescript
class AgentSession {
  // Prompting
  async prompt(text: string, options?: PromptOptions): Promise<void>;
  async steer(text: string, images?: ImageContent[]): Promise<void>;
  async followUp(text: string, images?: ImageContent[]): Promise<void>;
  async sendCustomMessage<T>(message: CustomAgentMessage<T>, options?: SendMessageOptions): Promise<void>;
  async sendUserMessage(content: UserMessageContent, options?: SendMessageOptions): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };

  // Model management
  async setModel(model: Model<Api>): Promise<void>;
  async cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // Compaction
  async compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Session lifecycle
  async newSession(options?: NewSessionOptions): Promise<boolean>;
  async switchSession(sessionPath: string): Promise<boolean>;
  async fork(entryId: string): Promise<{ selectedText: string; cancelled: boolean }>;
  async navigateTree(targetId: string, options?: NavigateTreeOptions): Promise<NavigateTreeResult>;
  async reload(): Promise<void>;
  async abort(): Promise<void>;
  dispose(): void;

  // Bash execution
  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: BashOptions,
  ): Promise<BashResult>;
  abortBash(): void;

  // Extension binding
  async bindExtensions(bindings: ExtensionBindings): Promise<void>;

  // State access (read-only properties)
  get model(): Model<Api> | undefined;
  get thinkingLevel(): ThinkingLevel;
  get isStreaming(): boolean;
  get systemPrompt(): string;
  get state(): AgentState;
  get messages(): AgentMessage[];
  get sessionFile(): string | undefined;
  get sessionId(): string | undefined;
  get sessionName(): string | undefined;
  get scopedModels(): ScopedModel[];
  get isCompacting(): boolean;
  get isRetrying(): boolean;
  get pendingMessageCount(): number;

  getActiveToolNames(): string[];
  getAllTools(): ToolInfo[];
  getContextUsage(): ContextUsage | undefined;
  getSessionStats(): SessionStats;

  // Subscription
  subscribe(listener: AgentSessionEventListener): () => void;
}
```

### `prompt()` Processing Pipeline

```
1. Check if text starts with "/" → attempt extension command execution
   (extension commands handled separately from agent prompt)

2. Emit "input" event to extension runner
   → handlers can return { action: "handled" } (abort prompt)
   → or { action: "transform", text: newText } (modify prompt)
   → or { action: "continue" } / undefined (pass through)

3. Expand /skill:name commands:
   - Find skill by name in loaded skills
   - Prepend SKILL.md content to prompt text
   - Track as skill invocation custom message

4. Expand prompt templates (/templatename):
   - Find template by name
   - Replace template variables in text

5. If agent.state.isStreaming:
   - Queue as steering (steer mode) or follow-up (followUp mode)
   - Return immediately

6. Validate model is set and has API key

7. Check if context needs compaction before submission

8. Build user message:
   UserMessage { role: "user", content: [...textContent, ...imageContents], timestamp: now }

9. Inject any pending nextTurn custom messages before the user message

10. Emit "before_agent_start" to extension runner:
    → handlers can inject context messages, modify system prompt

11. Call agent.prompt(messages)

12. Wait for any auto-retry to complete
```

### Event Processing (`_handleAgentEvent`)

Events from `Agent` are processed via a serial queue (`_agentEventQueue`) to prevent reentrant processing:

```
1. Track steering/follow-up dequeuing:
   on message_start for user messages: decrement pendingMessageCount

2. Emit to extension runner (_emitExtensionEvent)

3. Notify all session subscribers

4. On message_end:
   - Persist message to SessionManager

5. On agent_end:
   - Check for retryable errors → auto-retry with exponential backoff
   - Check for compaction trigger
```

### Auto-Retry Algorithm

```
Triggers: assistantMessage.stopReason === "error" AND errorMessage matches:
  /overloaded|rate.?limit|429|50[0-4]|service.?unavailable|timeout/i

Retry sequence:
  attempt = 1
  while attempt <= settings.retry.maxRetries (default 3):
    delay = min(baseDelay * 2^(attempt-1), maxDelay)
    add jitter (±20%)
    emit "auto_retry_start" event with attempt count + delay
    sleep(delay)
    call agent.continue()
    if success: break
    attempt++
```

Context overflow errors (detected by `isContextOverflow()`) skip auto-retry and go directly to compaction.

### Auto-Compaction

```
Triggered after agent_end in two cases:

1. Overflow:
   if isContextOverflow(assistantMessage, model.contextWindow):
     remove error message from context
     compact()
     retry agent.continue()

2. Threshold:
   tokens = usage.input + usage.cacheRead + usage.output
   if tokens > model.contextWindow * settings.compaction.threshold:
     compact()
     (no retry — next prompt will use compacted context)
```

---

## Built-in Tools (`src/core/tools/`)

All tools use `DEFAULT_MAX_LINES = 2000` and `DEFAULT_MAX_BYTES = 204800` (200KB) for truncation.

### `read` Tool

```typescript
// TypeBox schema
const ReadSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

interface ReadToolDetails {
  truncation?: TruncationResult;
}

interface ReadOperations {
  readFile(absolutePath: string): Promise<Buffer>;
  access(absolutePath: string): Promise<void>;
  detectImageMimeType(absolutePath: string): Promise<string | null>;
}
```

**Algorithm:**
1. Resolve path via `resolveReadPath(path, cwd)`
2. Detect image by MIME type
3. If image: read as base64, apply auto-resize (2000×2000 max), return as `ImageContent`
4. If text: read as buffer, decode UTF-8
5. Apply `offset`/`limit` (line-based slice)
6. Apply `truncateHead()` if still over limits
7. Return as `TextContent` with syntax highlighting metadata

**Active by default:** yes

### `bash` Tool

```typescript
const BashSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),  // seconds; default no limit
});

interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;  // temp file path if output was saved
}

interface BashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: string) => void;
      signal?: AbortSignal;
      timeout?: number;  // ms
      env?: Record<string, string>;
    },
  ): Promise<{ exitCode: number | null }>;
}
```

**Algorithm:**
1. Spawn shell (via `getShellConfig()`) with `detached: true` for process group tracking
2. Interleave stdout+stderr in `onData` callback
3. On completion: combine output, apply `truncateTail()` if over limits
4. If output > limits: save full output to temp file, return path in `details.fullOutputPath`
5. Format result with exit code

**Shell binary resolution:**
```
settings.shellPath → /bin/bash (fallback)
settings.shellCommandPrefix prepended to command (e.g., "shopt -s expand_aliases")
```

**Active by default:** yes

### `edit` Tool

```typescript
const EditSchema = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
});

interface EditToolDetails {
  diff: string;            // unified diff of the change
  firstChangedLine?: number;  // for cursor positioning
}

interface EditOperations {
  readFile(absolutePath: string): Promise<Buffer>;
  writeFile(absolutePath: string, content: string): Promise<void>;
  access(absolutePath: string): Promise<void>;
}
```

**`fuzzyFindText(fileContent, searchText)` algorithm:**
```
1. Normalize both texts: collapse whitespace, trim lines
2. Try exact match first
3. If no exact match: try line-by-line fuzzy comparison
   - For each potential start position in file
   - Compare normalized lines ignoring leading/trailing whitespace differences
   - Return best match (highest overlap score) if above threshold
```

**Algorithm:**
1. Read file content
2. `fuzzyFindText(content, oldText)` → find exact match location
3. Replace matched section with `newText`
4. Compute unified diff via `computeEditDiff()`
5. Write updated content via `withFileMutationQueue(path, () => writeFile(...))`
6. Return diff in details

**Active by default:** yes

### `write` Tool

```typescript
const WriteSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

interface WriteOperations {
  writeFile(absolutePath: string, content: string): Promise<void>;
  mkdir(dir: string, recursive?: boolean): Promise<void>;
}
```

**Algorithm:**
1. Resolve path via `resolveToCwd(path, cwd)`
2. `mkdir(dirname(absolutePath), { recursive: true })`
3. `withFileMutationQueue(absolutePath, () => writeFile(absolutePath, content))`
4. Return success message with file path

**Active by default:** yes

### `grep` Tool

```typescript
const GrepSchema = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),       // e.g., "*.ts"
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),   // treat as literal string
  context: Type.Optional(Type.Number()),    // lines before/after match
  limit: Type.Optional(Type.Number()),      // default: 100
});

interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: boolean;
  linesTruncated?: boolean;
}

interface GrepOperations {
  search(
    pattern: string,
    cwd: string,
    options: { path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
  ): Promise<string[]>;  // returns matching lines as strings
}
```

**Backend selection:**
1. If `fd` binary available at `~/.pi/agent/bin/rg` → use `rg`
2. Otherwise → Node readline fallback

`rg` flags: `--no-heading --line-number` + `--ignore-case` + `--fixed-strings` + `-C N` + `--max-count N` + `--glob PATTERN`

**Active by default:** no (must be enabled via `--tools grep` or settings)

### `find` Tool

```typescript
const FindSchema = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),  // default: 1000
});

interface FindToolDetails {
  truncation?: TruncationResult;
  resultLimitReached?: boolean;
}

interface FindOperations {
  exists(absolutePath: string): boolean;
  glob(pattern: string, cwd: string, options: { ignore?: string[]; limit?: number }): string[];
}
```

**Backend selection:**
1. If `fd` binary at `~/.pi/agent/bin/fd` → use `fd`
2. Otherwise → Node `glob` fallback

`fd` flags: `--full-path --color=never --max-results N`

**Active by default:** no

### `ls` Tool

```typescript
const LsSchema = Type.Object({
  path: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),  // default: 500
});

interface LsToolDetails {
  truncation?: TruncationResult;
  entryLimitReached?: boolean;
}

interface LsOperations {
  exists(absolutePath: string): boolean;
  stat(absolutePath: string): { isDirectory(): boolean };
  readdir(absolutePath: string): string[];
}
```

**Active by default:** no

### Tool Factory Patterns

Each tool has three forms:

```typescript
// 1. Pre-built singleton (uses process.cwd())
export const readTool: AgentTool;
export const bashTool: AgentTool;
export const editTool: AgentTool;
export const writeTool: AgentTool;
export const grepTool: AgentTool;
export const findTool: AgentTool;
export const lsTool: AgentTool;

// 2. Factory with custom cwd
export function createReadTool(cwd: string, opts?: ReadToolOptions): AgentTool;
export function createBashTool(cwd: string, opts?: BashToolOptions): AgentTool;
export function createEditTool(cwd: string, opts?: EditToolOptions): AgentTool;
export function createWriteTool(cwd: string, opts?: WriteToolOptions): AgentTool;
export function createGrepTool(cwd: string, opts?: GrepToolOptions): AgentTool;
export function createFindTool(cwd: string, opts?: FindToolOptions): AgentTool;
export function createLsTool(cwd: string, opts?: LsToolOptions): AgentTool;

// 3. ToolDefinition factory (for extensions / SDK)
export function createReadToolDefinition(cwd: string, opts?: ReadToolOptions): ToolDefinition;
// ... etc.

// Composite groups
export const codingTools: AgentTool[];    // [read, bash, edit, write]
export const readOnlyTools: AgentTool[];  // [read, grep, find, ls]
```

### Truncation Types

```typescript
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

function truncateHead(
  content: string,
  options?: { maxLines?: number; maxBytes?: number },
): TruncationResult;

function truncateTail(
  content: string,
  options?: { maxLines?: number; maxBytes?: number },
): TruncationResult;
```

`truncateHead`: keeps first N lines from the start (used for `read`).  
`truncateTail`: keeps last N lines from the end (used for `bash`).

### `withFileMutationQueue`

```typescript
function withFileMutationQueue<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T>
```

Prevents concurrent writes to the same file. Uses a `Map<string, Promise>` of per-path queues. Each `fn` is chained to the queue for its path.

---

## Model Registry (`src/core/model-registry.ts`)

```typescript
class ModelRegistry {
  // Get all models (built-in + custom)
  getAllModels(): Model<Api>[];

  // Get models for a specific provider
  getModelsForProvider(provider: string): Model<Api>[];

  // Find model by ID (fuzzy: partial match, alias resolution)
  findModel(idOrPattern: string): Model<Api> | undefined;

  // Register a custom model
  registerCustomModel(model: Model<Api>): void;

  // Register a custom provider config
  registerCustomProvider(config: CustomProviderConfig): void;

  // Get API key for a model's provider
  async getApiKey(model: Model<Api>, options?: { apiKey?: string }): Promise<string | undefined>;
}
```

Custom models from `~/.pi/agent/models.json` are loaded at startup and registered.

---

## Model Resolver (`src/core/model-resolver.ts`)

### `defaultModelPerProvider` per Provider

```typescript
const defaultModelPerProvider: Record<KnownProvider, string> = {
  anthropic:        "claude-opus-4-6",
   openai:           "gpt-5.4",
   google:           "gemini-2.5-pro",
   "github-copilot": "gpt-4o",
   "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
   groq:             "openai/gpt-oss-120b",
   xai:              "grok-4-fast-non-reasoning",
   "azure-openai-responses": "gpt-5.2",
   "google-gemini-cli": "gemini-2.5-pro",
   "google-antigravity": "gemini-3.1-pro-high",
   "google-vertex": "gemini-3-pro-preview",
   openrouter: "openai/gpt-5.1-codex",
   "vercel-ai-gateway": "anthropic/claude-opus-4-6",
   cerebras: "zai-glm-4.7",
   zai: "glm-5",
   mistral: "devstral-medium-latest",
   minimax: "MiniMax-M2.7",
   "minimax-cn": "MiniMax-M2.7",
   huggingface: "moonshotai/Kimi-K2.5",
   opencode: "claude-opus-4-6",
   "opencode-go": "kimi-k2.5",
   "kimi-coding": "kimi-k2-thinking",
};
```

### `resolveCliModel(options)` → `ResolveCliModelResult`

```typescript
interface ResolveCliModelOptions {
  model?: string;
  provider?: string;
  registry: ModelRegistry;
}

interface ResolveCliModelResult {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  error?: string;
}
```

**Resolution algorithm:**
1. If `provider/model` format: look up in registry
2. Try exact `model` ID match across all providers
3. If provider known but model not found: create fallback model object with given ID
4. If model contains `:thinking` suffix: parse out thinking level

### `resolveModelScope(patterns, registry)` → `ScopedModel[]`

For `--models` cycling. Supports glob patterns:
- `anthropic/*` → all Anthropic models
- `*sonnet*` → all models with "sonnet" in name
- `model-id:high` → model with thinking level

Prefers aliases over dated versions (e.g., `claude-sonnet-4-5` over `claude-sonnet-4-5-20250929`).

### `findInitialModel(options)` — Priority Order

```
1. CLI --provider + --model args
2. First scoped model (unless --continue / --resume)
3. Saved default from settings.json (defaultProvider, defaultModel)
4. First available model with valid API key, preferring DEFAULT_MODELS order
5. Any model in registry
```

### `parseModelPattern(pattern, models, opts)`

Handles colons in model IDs (e.g., `openai/gpt-4o:extended` OR `model:thinking`):
1. Try exact match of full pattern
2. If not found and has colons, split on LAST colon
3. If suffix is valid `ThinkingLevel` → use it, recurse on prefix
4. If suffix is not a thinking level → warn or treat as model ID

---

## Session Manager (`src/core/session-manager.ts`)

See [session-format.md](../session-format.md) for the complete JSONL format specification.

### Storage Location

```
~/.pi/agent/sessions/{encoded-cwd}/{TIMESTAMP}_{UUID}.jsonl
```

`{encoded-cwd}` = cwd path with `/` replaced by `--` (e.g., `/home/user/project` → `--home--user--project`)

### Static Factories

```typescript
class SessionManager {
  static create(cwd: string, sessionDir?: string): SessionManager;
  static open(path: string, sessionDir?: string): SessionManager;
  static continueRecent(cwd: string, sessionDir?: string): SessionManager;
  static inMemory(cwd?: string): SessionManager;
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManager;
  static list(cwd: string, sessionDir?: string, onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]>;
  static listAll(onProgress?: (loaded: number, total: number) => void): Promise<SessionInfo[]>;
}
```

### Instance Methods

```typescript
class SessionManager {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getSessionDir(): string;
  getCwd(): string;
  getLeafId(): string | null;
  getEntries(): SessionEntry[];

  // Appending
  appendMessage(message: AgentMessage): string;
  appendModelChange(provider: string, modelId: string): string;
  appendThinkingLevelChange(thinkingLevel: string): string;
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendCustomMessageEntry(customType: string, content: string | (TextContent | ImageContent)[], display: boolean, details?: unknown): string;
  appendLabelChange(targetId: string, label: string | undefined): string;
  appendSessionInfo(name: string): string;

  // Tree navigation
  branch(entryId: string): void;
  resetLeaf(): void;
  branchWithSummary(entryId: string | null, summary: string, details?: unknown, fromHook?: boolean): string;

  // Context reconstruction
  buildSessionContext(): SessionContext;
}
```

---

## Compaction (`src/core/compaction/compaction.ts`)

### `compact(preparation, model, apiKey, options?)`

```typescript
interface CompactionOptions {
  customInstructions?: string;
  signal?: AbortSignal;
}

interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
}

async function compact(
  preparation: CompactionPreparation,
  model: Model<Api>,
  apiKey: string | undefined,
  options?: CompactionOptions,
): Promise<CompactionResult>
```

**Algorithm:**
1. `serializeConversation(preparation.messagesToSummarize)` → formatted text of conversation
2. Call `completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [{ role: "user", content: conversationText + customInstructions }] })`
3. Extract summary from assistant response
4. Return `{ summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore }`

### `SUMMARIZATION_SYSTEM_PROMPT`

A system prompt instructing the LLM to produce a concise but complete summary of the conversation, focusing on:
- What was accomplished
- Key decisions made
- Files modified and their current state
- Pending tasks
- Important context for continuing the work

### `prepareCompaction(pathEntries, settings)` → `CompactionPreparation`

```typescript
interface CompactionPreparation {
  messagesToSummarize: Message[];
  messagesToKeep: Message[];
  firstKeptEntryId: string;
  tokensBefore: number;
}
```

**Algorithm:**
```
totalTokens = sum of input + output tokens across all messages

keepRecentTokens = settings.compaction.keepRecentTokens (default 20000)
reserveTokens = settings.compaction.reserveTokens (default 16384)

Walk messages from END to START:
  accumulateRecentTokens = 0
  while accumulateRecentTokens < keepRecentTokens:
    move message from summarize to keep (prepend)
    accumulateRecentTokens += estimateTokens(message)

messagesToSummarize = messages[0 .. splitPoint]
messagesToKeep = messages[splitPoint ..]
firstKeptEntryId = first entry in messagesToKeep
```

---

## System Prompt Assembly (`src/core/system-prompt.ts`)

### `buildSystemPrompt(options)` → `string`

```typescript
interface BuildSystemPromptOptions {
  cwd: string;
  tools: AgentTool[];
  skills?: LoadedSkill[];
  agentsMd?: string[];         // AGENTS.md contents from cwd and ancestors
  systemMd?: string;           // SYSTEM.md override (replaces default)
  appendSystemMd?: string;     // APPEND_SYSTEM.md (appended)
  settings: Settings;
  includeDefaultPrompt?: boolean;
}
```

**Assembly order:**
```
1. If systemMd is set: use as base (replaces default coding agent system prompt)
   Else: use DEFAULT_SYSTEM_PROMPT (comprehensive coding assistant instructions)

2. Append "## Available Tools" section:
   For each active tool:
     "- **{name}**: {description}" or tool.promptSnippet if set

3. Append "## Tool Guidelines" section:
   For each tool with promptGuidelines:
     Each guideline as bullet point

4. Append skills content:
   For each skill in alphabetical order:
     "## Skill: {name}\n{content}"

5. Append AGENTS.md contents:
   Walk from project root to cwd, collecting AGENTS.md files
   Append each

6. Append appendSystemMd if set

7. Append system state: current date/time, cwd
```

---

## Run Modes

### Interactive Mode (`src/modes/interactive/interactive-mode.ts`)

Full TUI built on `@mariozechner/pi-tui`. ~4647 lines.

**Key components:**
- `DynamicBorder` — editor border that changes color by thinking level
- `FooterComponent` — shows cwd, session name, tokens, cost, model
- `ToolExecutionComponent` — renders tool call + result rows with expand/collapse
- `AssistantMessageComponent` — renders text, thinking blocks, tool calls
- `TreeSelector` — `/tree` session tree browser
- `SessionSelector` — `/resume` session browser with fuzzy search
- `ModelSelector` — Ctrl+L model picker

**Theme system:**
```typescript
class Theme {
  fg(color: ThemeColor, text: string): string;
  bg(color: ThemeColor, text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  strikethrough(text: string): string;
}

function initTheme(themeName: string, isInteractive: boolean): void;
function setTheme(name: string): void;
function getMarkdownTheme(): MarkdownTheme;
function getEditorTheme(): EditorTheme;
function highlightCode(code: string, lang: string): string;
```

Themes hot-reload: file watcher calls `loadThemeFromPath()` and triggers re-render on changes.

### Print Mode (`src/modes/print-mode.ts`)

Single-shot, non-interactive.

```typescript
async function runPrintMode(
  session: AgentSession,
  prompt: string,
  mode: "text" | "json",
): Promise<void>
```

- `"text"` mode: streams assistant text to stdout, tool calls reported as status lines to stderr
- `"json"` mode: emits JSONL events to stdout (one per line): `AgentEvent` objects with extra fields

### RPC Mode (`src/modes/rpc/rpc-mode.ts`)

Headless JSON stdin/stdout protocol. See [rpc-protocol section below](#rpc-protocol).

```typescript
async function runRpcMode(session: AgentSession): Promise<void>
```

---

## RPC Protocol

**Transport:** strict LF-delimited JSONL over stdin/stdout.  
**Use case:** programmatic control from another process (e.g., a web server, IDE extension).

### Commands (stdin → pi)

```typescript
type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { id?: string; type: "steer"; message: string }
  | { id?: string; type: "follow_up"; message: string }
  | { id?: string; type: "abort" }
  | { id?: string; type: "abort_bash" }
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "export_html"; outputPath?: string };
```

### Events (stdout → client)

All `AgentSessionEvent` objects emitted as JSON lines. Additionally:

```typescript
// Command responses
{ id?: string; type: "response"; command: string; success: true; data?: object }
{ id?: string; type: "response"; command: string; success: false; error: string }

// Extension UI requests
{ type: "extension_ui_request"; id: string; method: "select" | "confirm" | "input" | ...; /* params */ }
```

### Extension UI over RPC

When extension calls `ctx.ui.select()`, `ctx.ui.confirm()`, etc.:

**pi → client:**
```typescript
{
  type: "extension_ui_request",
  id: string,               // unique request ID
  method: "select",
  title: string,
  options: string[],
  multiple?: boolean,
}
```

**client → pi:**
```typescript
{
  type: "extension_ui_response",
  id: string,               // must match request ID
  value?: string,
  confirmed?: boolean,
  cancelled?: true,
}
```

### `RpcSessionState`

```typescript
interface RpcSessionState {
  model?: { id: string; name: string; provider: string };
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  pendingMessageCount: number;
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  contextUsage?: ContextUsage;
}
```

---

## Public SDK (`src/core/sdk.ts`)

```typescript
interface CreateAgentSessionOptions {
  cwd?: string;              // default: process.cwd()
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  tools?: ToolDefinition[];
  extensions?: string[];
  settings?: Partial<Settings>;
  sessionDir?: string;
  noSession?: boolean;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
}

interface CreateAgentSessionResult {
  session: AgentSession;
  dispose: () => void;
}

async function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>
```

**Initialization sequence:**
1. Resolve `cwd` (default `process.cwd()`)
2. Load settings (global + project merge)
3. Create `ModelRegistry`
4. Resolve model (from options or settings default)
5. Create `AuthStorage`
6. Create `SessionManager` (or in-memory if `noSession`)
7. Load extensions
8. Create `Agent` with all options wired
9. Create and return `AgentSession`

---

## Auth Storage (`src/core/auth-storage.ts`)

```typescript
class AuthStorage {
  constructor(authFilePath: string);

  getApiKey(provider: string): string | undefined;
  setApiKey(provider: string, key: string): void;

  getOAuthCredentials(provider: string): OAuthCredentials | undefined;
  setOAuthCredentials(provider: string, creds: OAuthCredentials): void;

  removeCredentials(provider: string): void;

  // Get API key resolving OAuth tokens if needed
  async resolveApiKey(
    provider: string,
    model: Model<Api>,
  ): Promise<string | undefined>
}
```

Storage file: `~/.pi/agent/auth.json` (or `~/.pi/mom/auth.json` for mom).

---

## Built-in Slash Commands

```typescript
const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model (opens selector UI)" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
  { name: "import", description: "Import and resume a session from a JSONL file" },
  { name: "share", description: "Share session as a secret GitHub gist" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "fork", description: "Create a new fork from a previous message" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "login", description: "Login with OAuth provider" },
  { name: "logout", description: "Logout from OAuth provider" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
  { name: "quit", description: "Quit pi" },
  // plus extension/prompt/skill slash commands discovered at runtime
];
```

---

## App Keybindings

```typescript
// Declared in keybindings.ts, registered via KeybindingsManager
const KEYBINDINGS: KeybindingDefinitions = {
  "app.interrupt":           { defaultKeys: "escape" },
  "app.clear":               { defaultKeys: "ctrl+c" },
  "app.exit":                { defaultKeys: "ctrl+d" },
  "app.suspend":             { defaultKeys: "ctrl+z" },
  "app.thinking.cycle":      { defaultKeys: "shift+tab" },
  "app.model.cycleForward":  { defaultKeys: "ctrl+p" },
  "app.model.cycleBackward": { defaultKeys: "shift+ctrl+p" },
  "app.model.select":        { defaultKeys: "ctrl+l" },
  "app.tools.expand":        { defaultKeys: "ctrl+o" },
  "app.thinking.toggle":     { defaultKeys: "ctrl+t" },
  "app.session.toggleNamedFilter": { defaultKeys: "ctrl+n" },
  "app.editor.external":     { defaultKeys: "ctrl+g" },
  "app.message.followUp":    { defaultKeys: "alt+enter" },
  "app.message.dequeue":     { defaultKeys: "alt+up" },
  "app.clipboard.pasteImage":{ defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v" },
  "app.session.new":         { defaultKeys: [] },
  "app.session.tree":        { defaultKeys: [] },
  "app.session.fork":        { defaultKeys: [] },
  "app.session.resume":      { defaultKeys: [] },
  "app.tree.foldOrUp":       { defaultKeys: ["ctrl+left", "alt+left"] },
  "app.tree.unfoldOrDown":   { defaultKeys: ["ctrl+right", "alt+right"] },
  "app.session.togglePath":  { defaultKeys: "ctrl+p" },
  "app.session.toggleSort":  { defaultKeys: "ctrl+s" },
  "app.session.rename":      { defaultKeys: "ctrl+r" },
  "app.session.delete":      { defaultKeys: "ctrl+d" },
  "app.session.deleteNoninvasive": { defaultKeys: "ctrl+backspace" },
};
```

User overrides from `~/.pi/agent/keybindings.json` are applied on top.
