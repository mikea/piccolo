# `@mariozechner/pi-web-ui` — Specification

**Package:** `packages/web-ui/`  
**npm name:** `@mariozechner/pi-web-ui`  
**Version:** lockstep with monorepo  
**Runtime:** Browser (ESM)  
**Framework:** Lit (Web Components, light DOM — no Shadow DOM)  
**Exports:** `"."` → `dist/index.js`; `"./app.css"` → compiled Tailwind CSS

---

## Purpose

Web Components library for browser AI chat interfaces. Provides a complete streaming chat UI, an artifact viewer (HTML/Markdown/PDF/SVG/Excel/DOCX), a sandboxed JavaScript execution environment with `postMessage` runtime API, IndexedDB-backed storage, and CORS proxy utilities.

---

## Directory Structure

```
src/
├── index.ts                         # All public exports
├── app.css                          # Tailwind CSS entry point
├── ChatPanel.ts                     # Top-level: agent + artifacts side-by-side
├── components/
│   ├── AgentInterface.ts            # Main chat UI
│   ├── Messages.ts                  # Message type definitions + convertToLlm
│   ├── MessageList.ts               # Stable (non-streaming) message list
│   ├── StreamingMessageContainer.ts # RAF-batched streaming message
│   ├── MessageEditor.ts             # Text input with attachments + controls
│   ├── ThinkingBlock.ts             # Collapsible thinking content
│   ├── ConsoleBlock.ts              # Code/console output
│   ├── ExpandableSection.ts         # Collapsible section wrapper
│   ├── Input.ts                     # Styled text input
│   ├── AttachmentTile.ts            # File attachment pill
│   ├── CustomProviderCard.ts        # Custom LLM provider card
│   ├── ProviderKeyInput.ts          # API key input
│   ├── SandboxedIframe.ts           # Sandboxed iframe execution context
│   ├── message-renderer-registry.ts # Role→renderer registry
│   └── sandbox/
│       ├── SandboxRuntimeProvider.ts      # Interface for sandbox APIs
│       ├── RuntimeMessageBridge.ts        # Generates sendRuntimeMessage() code
│       ├── RuntimeMessageRouter.ts        # postMessage dispatcher
│       ├── ArtifactsRuntimeProvider.ts    # Sandbox API: artifact CRUD
│       ├── AttachmentsRuntimeProvider.ts  # Sandbox API: attachment access
│       ├── ConsoleRuntimeProvider.ts      # Captures console.log from sandbox
│       └── FileDownloadRuntimeProvider.ts # Captures returnFile() from sandbox
├── dialogs/
│   ├── ModelSelector.ts
│   ├── SettingsDialog.ts
│   ├── ApiKeyPromptDialog.ts
│   ├── AttachmentOverlay.ts
│   ├── CustomProviderDialog.ts
│   ├── ProvidersModelsTab.ts
│   ├── PersistentStorageDialog.ts
│   └── SessionListDialog.ts
├── prompts/
│   └── prompts.ts                   # Tool system-prompt string constants
├── storage/
│   ├── types.ts                     # StorageBackend, SessionData, etc.
│   ├── store.ts                     # abstract Store base class
│   ├── app-storage.ts               # AppStorage singleton
│   ├── backends/
│   │   └── indexeddb-storage-backend.ts
│   └── stores/
│       ├── sessions-store.ts
│       ├── settings-store.ts
│       ├── provider-keys-store.ts
│       └── custom-providers-store.ts
├── tools/
│   ├── index.ts                     # renderTool(), registerToolRenderer()
│   ├── types.ts                     # ToolRenderer, ToolRenderResult
│   ├── renderer-registry.ts
│   ├── javascript-repl.ts
│   ├── extract-document.ts
│   └── artifacts/
│       ├── artifacts.ts             # ArtifactsPanel + AgentTool
│       ├── ArtifactsToolRenderer.ts
│       ├── ArtifactElement.ts       # Abstract base
│       ├── ArtifactPill.ts
│       ├── HtmlArtifact.ts
│       ├── SvgArtifact.ts
│       ├── MarkdownArtifact.ts
│       ├── ImageArtifact.ts
│       ├── TextArtifact.ts
│       ├── PdfArtifact.ts
│       ├── ExcelArtifact.ts
│       ├── DocxArtifact.ts
│       ├── GenericArtifact.ts
│       └── Console.ts
└── utils/
    ├── attachment-utils.ts
    ├── auth-token.ts
    ├── format.ts
    ├── i18n.ts
    ├── model-discovery.ts
    ├── proxy-utils.ts
    └── test-sessions.ts
```

---

## Core Components

### `ChatPanel` (`<pi-chat-panel>`)

Top-level layout component. Renders `AgentInterface` and `ArtifactsPanel` side-by-side (or stacked on mobile).

```typescript
class ChatPanel extends LitElement {
  @property() agent?: Agent;
  @property() config?: ChatPanelConfig;

  setAgent(agent: Agent, config?: ChatPanelConfig): void;
}

interface ChatPanelConfig {
  enableAttachments?: boolean;
  enableModelSelector?: boolean;
  enableThinkingSelector?: boolean;
  sandboxUrlProvider?: () => string;
}
```

### `AgentInterface` (`<agent-interface>`)

Main chat UI. Manages streaming display, tool call visualization, model selection, and input.

```typescript
class AgentInterface extends LitElement {
  @property() session?: AgentSession;
  @property() enableAttachments?: boolean;
  @property() enableModelSelector?: boolean;
  @property() enableThinkingSelector?: boolean;

  // Callbacks
  onApiKeyRequired?: (provider: string) => Promise<boolean>;
  onBeforeSend?: (text: string, attachments: Attachment[]) => Promise<boolean>;
  onBeforeToolCall?: (toolCall: ToolCall) => Promise<boolean>;
  onCostClick?: () => void;
  onModelSelect?: (model: Model<Api>) => void;

  // Programmatic control
  sendMessage(input: MessageEditorInput, attachments?: Attachment[]): Promise<void>;
  setInput(text: string): void;
  setAutoScroll(enabled: boolean): void;
}
```

**Streaming architecture:**

```
AgentSession.subscribe(event => {
  if event.type === "message_update":
    streamingContainer.setMessage(event.message, false)
    // RAF-batched: schedules requestAnimationFrame, deep-clones, requestUpdate()

  if event.type === "message_end":
    streamingContainer.setMessage(null, true)  // immediate clear
    requestUpdate()  // AgentInterface re-renders with message in stable MessageList
})
```

The `StreamingMessageContainer` renders with `requestAnimationFrame` batching to prevent excessive re-renders during fast token streaming.

### `MessageList` (`<message-list>`)

Renders the stable (completed) message list. Only re-renders when `messages` property reference changes.

```typescript
class MessageList extends LitElement {
  @property() messages: AgentMessage[] = [];
  @property() tools: AgentTool[] = [];
  @property() pendingToolCalls: Set<string> = new Set();
  @property() isStreaming: boolean = false;
  @property() onCostClick?: () => void;
}
```

### `StreamingMessageContainer` (`<streaming-message-container>`)

Displays the currently-streaming message with RAF batching.

```typescript
class StreamingMessageContainer extends LitElement {
  @property() tools: AgentTool[] = [];
  @property() pendingToolCalls: Set<string> = new Set();

  // toolResultsById: Map<toolCallId, ToolResultMessage>
  setMessage(message: AssistantMessage | null, immediate: boolean): void;
  get isStreaming(): boolean;
}
```

**`setMessage(message, immediate)` algorithm:**
- If `immediate = true`: set synchronously, call `requestUpdate()`
- If `immediate = false`: if no pending RAF, schedule `requestAnimationFrame(() => { deepClone(message); requestUpdate() })`

Renders an animated pulse cursor when `isStreaming` but no message yet (latency indicator).

### `AssistantMessage` (`<assistant-message>`)

```typescript
class AssistantMessageComponent extends LitElement {
  @property() message!: AssistantMessage;
  @property() tools: AgentTool[] = [];
  @property() pendingToolCalls: Set<string> = new Set();
  @property() hideToolCalls: boolean = false;
  @property() toolResultsById: Map<string, ToolResultMessage> = new Map();
  @property() isStreaming: boolean = false;
  @property() hidePendingToolCalls: boolean = false;
  @property() onCostClick?: () => void;
}
```

Renders `message.content` items: `TextContent` → markdown/text display; `ThinkingContent` → `<thinking-block>`; `ToolCall` → `<tool-message>`.

### `ToolMessage` (`<tool-message>`)

```typescript
class ToolMessageComponent extends LitElement {
  @property() toolCall!: ToolCall;
  @property() tool?: AgentTool;
  @property() result?: ToolResultMessage;
  @property() pending: boolean = false;
  @property() aborted: boolean = false;
  @property() isStreaming: boolean = false;
}
```

Calls `renderTool(toolCall.name, toolCall.arguments, result)` → uses registered `ToolRenderer` or `DefaultRenderer`.

### `MessageEditor` (`<message-editor>`)

```typescript
class MessageEditor extends LitElement {
  @property() isStreaming: boolean = false;
  @property() currentModel?: Model<Api>;
  @property() thinkingLevel?: ThinkingLevel;
  @property() showAttachmentButton: boolean = false;
  @property() showModelSelector: boolean = false;
  @property() showThinkingSelector: boolean = false;

  onSend?: (text: string, attachments: Attachment[]) => void;
  onAbort?: () => void;
  onModelSelect?: (model: Model<Api>) => void;
  onThinkingChange?: (level: ThinkingLevel) => void;

  get value(): string;
  get attachments(): Attachment[];
}
```

### `ThinkingBlock` (`<thinking-block>`)

```typescript
class ThinkingBlock extends LitElement {
  @property() content!: ThinkingContent;
  @property() isStreaming: boolean = false;
}
```

Collapsible. Shows truncated preview when collapsed. Full content when expanded.

---

## Message Types

### Extended Message Types

```typescript
interface UserMessageWithAttachments extends UserMessage {
  attachments?: Attachment[];
}

interface ArtifactMessage {
  role: "artifact";
  action: "create" | "update" | "delete";
  filename: string;
  content?: string;
  mimeType?: string;
  timestamp: number;
}

// Type guards
function isUserMessageWithAttachments(msg: AgentMessage): msg is UserMessageWithAttachments;
function isArtifactMessage(msg: AgentMessage): msg is ArtifactMessage;
```

### `convertAttachments(attachments: Attachment[]): (TextContent | ImageContent)[]`

```
For each attachment:
  if mimeType starts with "image/": → ImageContent { type: "image", data: base64, mimeType }
  else: → TextContent { type: "text", text: `[File: ${name}]\n${content}` }
```

### `defaultConvertToLlm(messages: AgentMessage[]): Message[]`

```
Filter out ArtifactMessage (role: "artifact") — these are client-side only
Convert UserMessageWithAttachments:
  content = convertAttachments(attachments) + original text content
Return standard Message[] for LLM
```

### Message Renderer Registry

```typescript
interface MessageRenderer {
  render(message: AgentMessage): TemplateResult;
}

function registerMessageRenderer(role: string, renderer: MessageRenderer): void;
function getMessageRenderer(role: string): MessageRenderer | undefined;
```

Allows registering custom renderers for custom message roles (e.g., extension-added roles).

---

## Artifacts System

### `Artifact` Interface

```typescript
interface Artifact {
  filename: string;
  content: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
}
```

### `ArtifactsParams` (tool call schema)

```typescript
// TypeBox schema passed to the LLM as tool definition
const ArtifactsSchema = Type.Object({
  command: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("rewrite"),
    Type.Literal("get"),
    Type.Literal("delete"),
    Type.Literal("logs"),
  ]),
  filename: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
});

type ArtifactsParams = Static<typeof ArtifactsSchema>;
```

### `ArtifactsPanel` (`<artifacts-panel>`)

```typescript
class ArtifactsPanel extends LitElement {
  @property() agent?: Agent;
  @property() sandboxUrlProvider?: () => string;
  @property() collapsed: boolean = false;
  @property() overlay: boolean = false;

  onArtifactsChange?: (artifacts: Artifact[]) => void;
  onClose?: () => void;
  onOpen?: () => void;

  // The AgentTool to pass to the agent
  get tool(): AgentTool;

  // Reconstruct artifact state from session messages (on session load)
  reconstructFromMessages(messages: AgentMessage[]): void;

  openArtifact(filename: string): void;

  get artifacts(): Map<string, Artifact>;
}
```

**Artifact state management:**
- `_artifacts: Map<string, Artifact>` — current state
- `artifactElements: Map<string, ArtifactElement>` — DOM elements
- Elements are programmatically appended into a content `div` (bypasses Lit template rendering)
- Shown/hidden via `style.display` — avoids destroying iframe state on re-renders

**`reconstructFromMessages(messages)` algorithm:**
```
1. Filter messages to find:
   a. ArtifactMessage entries (role: "artifact")
   b. Successful ToolResultMessage entries for the "artifacts" tool

2. Replay in chronological order:
   - "create"/"update"/"rewrite": upsert into _artifacts, create/update DOM element
   - "delete": remove from _artifacts, remove DOM element

3. This avoids re-executing HTML artifact code on session restore
```

### Artifact Types

| Type | File extensions | Renderer |
|------|-----------------|---------|
| HTML | `.html`, `.htm` | `HtmlArtifact` → `SandboxedIframe` |
| SVG | `.svg` | `SvgArtifact` → inline `<svg>` |
| Markdown | `.md`, `.markdown` | `MarkdownArtifact` → rendered markdown |
| Image | `.png`, `.jpg`, `.gif`, `.webp`, `.ico` | `ImageArtifact` → `<img>` |
| Text/Code | `.txt`, `.ts`, `.js`, `.py`, etc. | `TextArtifact` → syntax-highlighted code |
| PDF | `.pdf` | `PdfArtifact` → pdfjs-dist viewer |
| Excel | `.xlsx`, `.xls` | `ExcelArtifact` → xlsx library + table |
| DOCX | `.docx` | `DocxArtifact` → docx-preview |
| Other | anything else | `GenericArtifact` → download button |

### `ArtifactElement` (Abstract Base)

```typescript
abstract class ArtifactElement extends LitElement {
  abstract setContent(artifact: Artifact): void;
  abstract getDescription(): string;
}
```

---

## Sandboxed Iframe System

### `SandboxedIframe` (`<sandbox-iframe>`)

```typescript
class SandboxedIframe extends LitElement {
  // Execute code in sandboxed iframe
  execute(
    sandboxId: string,
    code: string,
    runtimeProviders: SandboxRuntimeProvider[],
    consumers?: SandboxRuntimeProvider[],
    signal?: AbortSignal,
  ): Promise<void>;

  // Provider for sandbox URL (optional — defaults to blob URL)
  sandboxUrlProvider?: () => string;
}
```

**Sandbox iframe attributes:** `sandbox="allow-scripts"` — NO `allow-same-origin`. This prevents access to `localStorage`, `document.cookie`, and cross-frame DOM access.

**Execution sequence:**
```
1. Collect getData() from all runtimeProviders → window property injections
2. Collect getRuntime() from all runtimeProviders → function code to inject
3. Generate bridge code via RuntimeMessageBridge.generateBridgeCode()
4. Build full HTML:
   <html>
     <head>
       <script>
         // Injected window properties
         window.artifacts = {...};
         window.attachments = {...};
         // Runtime functions
         window.sendRuntimeMessage = ...bridge code...;
         // Provider runtime functions
         ...
       </script>
     </head>
     <body>
       <script>
         // User's HTML/JS code
         ...userCode...
       </script>
     </body>
   </html>
5. Create blob URL or use sandboxUrlProvider()
6. Set iframe.src
7. Listen for postMessage via RuntimeMessageRouter
8. Route messages to runtimeProviders[].handleMessage()
```

### `SandboxRuntimeProvider` Interface

```typescript
interface SandboxRuntimeProvider {
  // Data injected as window.* properties in sandbox
  getData(sandboxId: string): Record<string, unknown> | Promise<Record<string, unknown>>;

  // JavaScript function string injected into sandbox (defines sendXxx() functions)
  getRuntime(sandboxId: string): string | Promise<string>;

  // Handles postMessage from sandbox
  handleMessage(
    sandboxId: string,
    message: SandboxMessage,
    respond: (response: unknown) => void,
  ): boolean | Promise<boolean>;  // returns true if handled

  getDescription(): string;  // human-readable description for LLM
}
```

### `RuntimeMessageBridge`

Generates `window.sendRuntimeMessage()` source code for two contexts:

**Sandbox context (iframe):**
```javascript
window.sendRuntimeMessage = function(msg) {
  return new Promise((resolve, reject) => {
    const messageId = Math.random().toString(36);
    window.addEventListener('message', function handler(e) {
      if (e.data && e.data.messageId === messageId) {
        window.removeEventListener('message', handler);
        if (e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.result);
      }
    });
    window.parent.postMessage({ ...msg, messageId }, '*');
  });
};
```

**Browser extension (user-script) context:**
```javascript
window.sendRuntimeMessage = function(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({...msg}, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
};
```

```typescript
interface RuntimeMessageBridgeOptions {
  context: "iframe" | "extension";
}

class RuntimeMessageBridge {
  static generateBridgeCode(options: RuntimeMessageBridgeOptions): string;
}
```

### `RuntimeMessageRouter`

```typescript
// Singleton
const RUNTIME_MESSAGE_ROUTER: RuntimeMessageRouter;

class RuntimeMessageRouter {
  register(sandboxId: string, providers: SandboxRuntimeProvider[]): void;
  unregister(sandboxId: string): void;
}
```

Listens to `window.addEventListener("message", ...)`. For each message, finds registered providers for `sandboxId` and calls `handleMessage()` in order until one returns `true`.

### Built-in Runtime Providers

#### `ArtifactsRuntimeProvider`

```typescript
class ArtifactsRuntimeProvider implements SandboxRuntimeProvider {
  constructor(
    panel: ArtifactsPanel,
    agent?: Agent,
    readWrite?: boolean,  // default: false (read-only)
  );
}
```

Sandbox API (accessed via `window.sendRuntimeMessage`):

| Message type | Method | Description |
|---|---|---|
| `"artifact-operation"` + `action: "list"` | `listArtifacts()` | Returns `[{filename, mimeType}]` |
| `"artifact-operation"` + `action: "get"` | `getArtifact(filename)` | Returns artifact content |
| `"artifact-operation"` + `action: "create"` | `createOrUpdateArtifact(filename, content, mimeType)` | Create/update artifact |
| `"artifact-operation"` + `action: "delete"` | `deleteArtifact(filename)` | Delete artifact |

#### `AttachmentsRuntimeProvider`

```typescript
class AttachmentsRuntimeProvider implements SandboxRuntimeProvider {
  constructor(attachments: Attachment[]);
}
```

Sandbox API:

| Method | Description |
|---|---|
| `listAttachments()` | Returns `[{name, mimeType, size}]` |
| `readTextAttachment(name)` | Returns text content |
| `readBinaryAttachment(name)` | Returns base64 encoded content |

#### `ConsoleRuntimeProvider`

Intercepts `console.log`, `console.warn`, `console.error` calls from sandbox via `postMessage`. Collects output for display in `Console` component.

#### `FileDownloadRuntimeProvider`

Captures `window.returnFile(filename, content, mimeType)` calls from sandbox. Triggers browser download.

---

## Tool Renderer System

### `ToolRenderer` Interface

```typescript
interface ToolRenderResult {
  header: TemplateResult;       // always visible
  content?: TemplateResult;     // shown when expanded
  defaultExpanded?: boolean;
}

interface ToolRenderer {
  renderCall(args: unknown, isStreaming: boolean): ToolRenderResult;
  renderResult(result: ToolResultMessage | undefined, isError: boolean): ToolRenderResult;
}
```

### Registry Functions

```typescript
function registerToolRenderer(name: string, renderer: ToolRenderer): void;
function getToolRenderer(name: string): ToolRenderer | undefined;

// Render a tool call + result; uses registered renderer or DefaultRenderer
function renderTool(
  toolName: string,
  args: unknown,
  result: ToolResultMessage | undefined,
  isStreaming?: boolean,
): ToolRenderResult;

// Force all tools to use DefaultRenderer (JSON display)
function setShowJsonMode(enabled: boolean): void;

// Template helpers for building consistent tool headers
function renderHeader(state: "running" | "done" | "error", icon: string, label: string): TemplateResult;
function renderCollapsibleHeader(
  state: "running" | "done" | "error",
  icon: string,
  label: string,
  contentRef: Ref,
  chevronRef: Ref,
  defaultOpen?: boolean,
): TemplateResult;
```

### Built-in Renderers

- `BashRenderer` — shows command, exit code, truncated output
- `CalculateRenderer` — shows expression + result
- `GetCurrentTimeRenderer` — shows formatted time
- `DefaultRenderer` — JSON display of args + result (fallback)
- `ArtifactsToolRenderer` — shows artifact filename + action

---

## JavaScript REPL Tool

```typescript
// Create tool with optional sandbox integration
function createJavaScriptReplTool(): AgentTool & {
  runtimeProvidersFactory?: (sandboxId: string) => SandboxRuntimeProvider[];
  sandboxUrlProvider?: () => string;
};

// Pre-built instance
const javascriptReplTool: AgentTool;

// Execute code directly (without going through agent)
async function executeJavaScript(
  code: string,
  runtimeProviders: SandboxRuntimeProvider[],
  signal?: AbortSignal,
  sandboxUrlProvider?: () => string,
): Promise<{ output: string; files?: { filename: string; content: string; mimeType: string }[] }>
```

Tool schema:
```typescript
Type.Object({
  code: Type.String(),  // JavaScript code to execute
})
```

Execution: creates a `SandboxedIframe`, runs code, captures `console.log` output via `ConsoleRuntimeProvider`, captures `returnFile()` calls via `FileDownloadRuntimeProvider`.

---

## Storage System

### `StorageBackend` Interface

```typescript
interface StorageBackend {
  get<T>(storeName: string, key: string): Promise<T | undefined>;
  set<T>(storeName: string, key: string, value: T): Promise<void>;
  delete(storeName: string, key: string): Promise<void>;
  keys(storeName: string): Promise<string[]>;
  getAllFromIndex<T>(
    storeName: string,
    indexName: string,
    direction?: "asc" | "desc",
  ): Promise<T[]>;
  transaction<T>(
    storeNames: string[],
    mode: "readonly" | "readwrite",
    fn: (stores: Record<string, TransactionStore>) => Promise<T>,
  ): Promise<T>;
  getQuotaInfo(): Promise<{ usage: number; quota: number }>;
}
```

### `IndexedDBStorageBackend`

```typescript
interface IndexedDBConfig {
  dbName: string;
  version: number;
  stores: {
    name: string;
    keyPath?: string;
    autoIncrement?: boolean;
    indexes?: {
      name: string;
      keyPath: string;
      unique?: boolean;
    }[];
  }[];
}

class IndexedDBStorageBackend implements StorageBackend {
  constructor(config: IndexedDBConfig);
}
```

### `AppStorage`

```typescript
class AppStorage {
  readonly backend: StorageBackend;
  readonly settings: SettingsStore;
  readonly providerKeys: ProviderKeysStore;
  readonly sessions: SessionsStore;
  readonly customProviders: CustomProvidersStore;

  async getQuotaInfo(): Promise<{ usage: number; quota: number }>;
  async requestPersistence(): Promise<boolean>;
}

function getAppStorage(): AppStorage;
function setAppStorage(storage: AppStorage): void;
```

### `SessionsStore`

Uses dual-store pattern: `"sessions"` (full data) + `"sessions-metadata"` (lightweight for listing).

```typescript
interface SessionMetadata {
  id: string;
  title?: string;
  createdAt: number;
  lastModified: number;
  previewText?: string;
  messageCount: number;
  totalTokens?: number;
  totalCost?: number;
}

interface SessionData {
  id: string;
  messages: AgentMessage[];
  model?: { id: string; provider: string };
  thinkingLevel?: ThinkingLevel;
  createdAt: number;
  lastModified: number;
}

class SessionsStore extends Store {
  async save(session: SessionData): Promise<void>;
  async get(id: string): Promise<SessionData | undefined>;
  async getAllMetadata(): Promise<SessionMetadata[]>;
  async delete(id: string): Promise<void>;
  async updateTitle(id: string, title: string): Promise<void>;
}
```

`getAllMetadata()` uses `getAllFromIndex("lastModified", "desc")` for efficient sorted listing.

### `SettingsStore`

```typescript
class SettingsStore extends Store {
  async get<T>(key: string): Promise<T | undefined>;
  async set<T>(key: string, value: T): Promise<void>;
  async delete(key: string): Promise<void>;
  async getAll(): Promise<Record<string, unknown>>;
}
```

Keys: `"theme"`, `"language"`, `"proxy.enabled"`, `"proxy.url"`, etc.

### `ProviderKeysStore`

```typescript
class ProviderKeysStore extends Store {
  async getKey(provider: string): Promise<string | undefined>;
  async setKey(provider: string, key: string): Promise<void>;
  async deleteKey(provider: string): Promise<void>;
  async getAllKeys(): Promise<Record<string, string>>;
}
```

### `CustomProvidersStore`

```typescript
interface CustomProvider {
  id: string;
  name: string;
  type: CustomProviderType;
  baseUrl: string;
  apiKeyEnvVar?: string;
}

type CustomProviderType = "openai-completions" | "openai-responses" | "anthropic-messages";

class CustomProvidersStore extends Store {
  async getAll(): Promise<CustomProvider[]>;
  async save(provider: CustomProvider): Promise<void>;
  async delete(id: string): Promise<void>;
}
```

---

## CORS Proxy Utilities

### `shouldUseProxyForProvider(provider, apiKey)`

Returns `true` if the provider typically blocks browser requests:

| Provider | Needs proxy? | Condition |
|----------|-------------|-----------|
| `zai` | Always | CORS blocked |
| `anthropic` | OAuth only | If `apiKey` starts with `sk-ant-oat` (OAuth token) |
| `openai-codex` | Always | Custom endpoint, no CORS support |

### `applyProxyIfNeeded(model, apiKey, proxyUrl?)`

```typescript
function applyProxyIfNeeded(
  model: Model<Api>,
  apiKey: string | undefined,
  proxyUrl?: string,
): Model<Api>
```

If proxy needed and `proxyUrl` is set: returns model copy with `baseUrl = "${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}"`.

### `createStreamFn(getProxyUrl)`

```typescript
function createStreamFn(
  getProxyUrl: () => string | undefined,
): StreamFn
```

Returns a `StreamFn` compatible with `Agent.streamFn`. Before each call:
1. Check `shouldUseProxyForProvider(model.provider, options.apiKey)`
2. If needs proxy: `applyProxyIfNeeded(model, apiKey, getProxyUrl())`
3. Call `streamSimple(modifiedModel, context, options)`

### `isCorsError(error)`

```typescript
function isCorsError(error: unknown): boolean
```

Returns `true` if error message suggests a CORS or network failure (for retry-with-proxy logic).

---

## Model Discovery (`src/utils/model-discovery.ts`)

Auto-discovery for locally running model servers:

```typescript
type AutoDiscoveryProviderType = "ollama" | "lmstudio" | "vllm" | "llama.cpp";

async function discoverModels(
  providerType: AutoDiscoveryProviderType,
  baseUrl?: string,
): Promise<Model<Api>[]>
```

| Provider | Default URL | Endpoint |
|----------|------------|---------|
| `ollama` | `http://localhost:11434` | `GET /api/tags` |
| `lmstudio` | `http://localhost:1234` | `GET /v1/models` |
| `vllm` | `http://localhost:8000` | `GET /v1/models` |
| `llama.cpp` | `http://localhost:8080` | `GET /v1/models` |

Returns normalized `Model<Api>` objects for each discovered model.

---

## Attachment System

```typescript
interface Attachment {
  name: string;
  mimeType: string;
  data: string;      // base64 for images; text content for documents
  size: number;
}

async function loadAttachment(file: File): Promise<Attachment>
```

**`loadAttachment(file)` algorithm:**
```
1. Read file as ArrayBuffer via FileReader

2. Detect type:
   - image/* → base64 encode, return ImageAttachment
   - application/pdf → extract text via pdfjs-dist
   - .docx → extract text via docx-preview
   - .xlsx / .xls → parse via xlsx library, convert to CSV-like text
   - .pptx → extract text from slide XML
   - application/zip → extract relevant content
   - text/* or unknown → read as UTF-8 text

3. Return Attachment { name, mimeType, data, size }
```

---

## Utility Functions

```typescript
// Format cost in USD
function formatCost(cost: number): string;  // "$0.0012"

// Format token count with K/M suffix
function formatTokenCount(n: number): string;  // "1.2K", "3.4M"

// Format full usage summary
function formatUsage(usage: Usage): string;

// Format per-model cost breakdown
function formatModelCost(model: Model<Api>, usage: Usage): string;

// Internationalization
function i18n(key: string, params?: Record<string, string>): string;
function setLanguage(lang: string): void;
const translations: Record<string, Record<string, string>>;

// OAuth token management
function getAuthToken(): string | undefined;
function clearAuthToken(): void;
```

---

## Prompt Constants (`src/prompts/prompts.ts`)

```typescript
// Injected into LLM system prompt when artifacts runtime is available (read-only)
const ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO: string;

// Injected when artifacts runtime is available (read-write)
const ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW: string;

// Injected when attachments runtime is available
const ATTACHMENTS_RUNTIME_DESCRIPTION: string;

// Full artifacts tool description with runtime provider context
function ARTIFACTS_TOOL_DESCRIPTION(runtimeProviderDescriptions: string[]): string;

// Full JavaScript REPL tool description with runtime context
function JAVASCRIPT_REPL_TOOL_DESCRIPTION(runtimeProviderDescriptions: string[]): string;
```

---

## Re-exports from Dependencies

```typescript
// From @mariozechner/pi-agent-core
export { Agent, AgentMessage, AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";

// From @mariozechner/pi-ai
export { Model } from "@mariozechner/pi-ai";
```

---

## Package.json Structure

```json
{
  "name": "@mariozechner/pi-web-ui",
  "version": "0.62.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./app.css": "./dist/app.css"
  },
  "peerDependencies": {
    "@mariozechner/mini-lit": "^0.2.0",
    "lit": "^3.3.1"
  },
  "dependencies": {
    "@mariozechner/pi-ai": "lockstep",
    "@mariozechner/pi-tui": "lockstep",
    "@mariozechner/pi-agent-core": "lockstep",
    "pdfjs-dist": "^...",
    "docx-preview": "^...",
    "jszip": "^...",
    "xlsx": "^...",
    "lucide": "^...",
    "ollama": "^...",
    "@lmstudio/sdk": "^..."
  }
}
```

**Two exports:** JS module (`.`) and compiled Tailwind CSS (`"./app.css"`). Host apps must include both.

**Build:** `tsc -p tsconfig.build.json && tailwindcss -i ./src/app.css -o ./dist/app.css --minify`
