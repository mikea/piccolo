# Web UI Gateway — Specification

Browser-based chat interface for piccolo. Serves a single-page application and exposes all session operations to the browser via **Cap'n Web** (`capnweb`) over a persistent WebSocket connection. There is no REST API — the browser uses typed RPC stubs throughout.

Gateway ID: `"web"`

See [gateway.md](gateway.md) for the general gateway contract.

---

## Transport: Cap'n Web over WebSocket

The browser connects to the gateway with a single persistent WebSocket:

```typescript
// Browser-side (SPA)
import { newWebSocketRpcSession } from "capnweb";
import type { IWebGatewayApi } from "./api";

using api = newWebSocketRpcSession<IWebGatewayApi>("wss://piccolo.example.com/rpc");
```

The gateway serves the Cap'n Web endpoint at `GET /rpc` (WebSocket upgrade) and `POST /rpc` (HTTP batch for one-shot requests). The server uses `newWorkersRpcResponse(request, new WebGatewayImpl(env, userId))` from `capnweb`.

All session operations, streaming, interactive callbacks, and model management flow through this single typed RPC connection. No REST endpoints. No SSE. No manual JSON serialisation.

---

## Deployment

- Cloudflare Worker with a service binding to `piccolo-core` (`env.CORE: IPiccoloCore`)
- Static assets (HTML, JS, CSS) served from R2 or bundled inline; delivered via plain `GET /`
- Custom tool UI component modules served at `GET /components/{componentId}.js`
- Auth: Cloudflare Access JWT validated before the Cap'n Web session is established

---

## `IWebGatewayApi` — Browser-facing RPC Interface

The root interface the browser receives when it connects. Defined here; implemented by the gateway Worker.

```typescript
import { RpcTarget } from "capnweb";
import type {
  SessionRecord, SessionInfo, ModelInfo, NewSessionOptions,
  AgentEvent, Attachment
} from "piccolo-core";

// Root interface returned to the browser on connection.
// The browser calls newWebSocketRpcSession<IWebGatewayApi>(url) to get a stub.
interface IWebGatewayApi extends RpcTarget {

  // ─── Session management ───────────────────────────────────────────────────

  // Create a new session and return a stub for it.
  newSession(options?: NewSessionOptions): IWebGatewaySession;

  // Retrieve an existing session by ID.
  getSession(sessionId: string): IWebGatewaySession;

  // List all sessions belonging to the authenticated user.
  listSessions(): Promise<SessionInfo[]>;

  // ─── Model registry ───────────────────────────────────────────────────────

  listModels(): Promise<ModelInfo[]>;
}
```

### `IWebGatewaySession` — Per-Session RPC Stub

Wraps `ISession` with a browser-safe surface and adds the streaming prompt call. The browser holds a stub of this type for each open session.

```typescript
// Per-session interface. Returned by IWebGatewayApi.newSession() / getSession().
// Wraps ISession (api.md §2) with browser-facing additions.
interface IWebGatewaySession extends RpcTarget {

  // ─── Identity and metadata ────────────────────────────────────────────────

  id(): Promise<string>;
  info(): Promise<SessionRecord>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;

  // ─── Conversation ─────────────────────────────────────────────────────────

  // Start a new agent turn.
  //
  // `listener` is an RpcTarget stub the browser passes to the server.
  // The server calls listener.onEvent(event) for each AgentEvent as it arrives.
  // This replaces SSE: events flow server→browser over the existing WebSocket.
  //
  // `callback` is the browser's IGatewayCallback stub for mid-turn interactive
  // prompts (select, confirm, input). The server calls it when needed.
  //
  // Returns a handle the browser can use to check completion or abort early.
  prompt(
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallback,
    attachments?: Attachment[],
  ): ITurnHandle;

  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;

  // ─── Model management ─────────────────────────────────────────────────────

  getModel(): Promise<ModelInfo>;
  setModel(modelId: string): Promise<void>;

  // ─── Context ──────────────────────────────────────────────────────────────

  getContextUsage(): Promise<ContextUsage>;
  compact(options?: CompactOptions): Promise<void>;

  // ─── Session tree ─────────────────────────────────────────────────────────

  branch(entryId: string): Promise<void>;

  // Fork returns a stub for the new session.
  fork(fromEntryId?: string): IWebGatewaySession;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  delete(): Promise<void>;

  // ─── Attachments ──────────────────────────────────────────────────────────

  // Upload a file attachment. Returns an opaque attachmentId.
  uploadAttachment(attachment: Attachment): Promise<string>;
}
```

---

## `IAgentEventListener` — Browser Callback for Streaming

The browser implements this interface and passes a stub to `IWebGatewaySession.prompt()`. The server calls `onEvent()` for each `AgentEvent` as it arrives from the agent loop — replacing SSE with a typed, bidirectional callback.

```typescript
// Implemented by the browser. The server calls onEvent() for each AgentEvent.
interface IAgentEventListener extends RpcTarget {
  onEvent(event: AgentEvent): Promise<void>;
}
```

### Browser-side usage

```typescript
import { RpcTarget } from "capnweb";

class EventListener extends RpcTarget implements IAgentEventListener {
  constructor(private readonly onEvent: (event: AgentEvent) => void) { super(); }
  async onEvent(event: AgentEvent) {
    // Dispatch to SolidJS store: append text, show tool call, update usage, etc.
    this.onEvent(event);
  }
}

// In the SPA:
const listener = new EventListener(handleAgentEvent);
const callback = new GatewayCallbackImpl(); // implements IGatewayCallback
const turn = session.prompt("Hello", listener, callback);

// Optionally: abort the turn
await turn.abort();
```

---

## `ITurnHandle` — Active Turn Reference

Returned by `IWebGatewaySession.prompt()`. Lets the browser abort an in-progress turn or wait for its completion.

```typescript
interface ITurnHandle extends RpcTarget {
  // Abort the current turn immediately.
  abort(): Promise<void>;

  // Resolves when the turn ends (agent_end or error event).
  // Rejects if aborted or a fatal error occurs.
  done(): Promise<void>;
}
```

---

## `IGatewayCallback` — Interactive Prompts (Reused from api.md)

`IGatewayCallback` is defined in [api.md §5](api.md). The browser implements it and passes a stub to `prompt()`. The server calls it mid-turn when the agent needs interactive input.

```typescript
// Implemented by the browser. The server calls these mid-turn.
// Full definition in api.md §5.
interface IGatewayCallback extends RpcTarget {
  requestSelect(title: string, options: string[], multiple?: boolean): Promise<string[] | null>;
  requestConfirm(title: string, message: string): Promise<boolean>;
  requestInput(title: string, placeholder?: string): Promise<string | null>;
  notify(message: string, level: "info" | "success" | "warning" | "error"): Promise<void>;
}
```

### Browser-side implementation

```typescript
// app/src/callback.ts
// M1: stub that returns null/false — no interactive prompts yet (M2 adds modals).
class GatewayCallbackImpl extends RpcTarget implements IGatewayCallback {
  async requestSelect(_title: string, _options: string[], _multiple?: boolean) {
    return null;
  }
  async requestConfirm(_title: string, _message: string) {
    return false;
  }
  async requestInput(_title: string, _placeholder?: string) {
    return null;
  }
  async notify(_message: string, _level: string) {}
}
```

---

## `IWebUI` — Tool UI Interface (Reused from api.md)

`IWebUI` and `WebComponentDescriptor` are defined in [api.md §3](api.md). Tools return an `IWebUI` stub from `getGatewayUI("web")`. The gateway calls `getComponent()` server-side before sending a tool call/result notification to the browser. If a descriptor is returned, the browser fetches and mounts the component; otherwise it falls back to `ITextUI` text rendering.

### Component loading

Custom tool UI components are served as ES modules at `GET /components/{componentId}.js`. The browser fetches and dynamically imports these modules; they are not bundled into the SPA. Components are standard SolidJS components that receive `props` from `WebComponentDescriptor.props`.

```typescript
// Fallback chain (resolved server-side, result sent to browser via AgentEvent)
// AgentEvent gains a new optional field for tool rendering:
// { type: "tool_start", ..., component?: WebComponentDescriptor }
// { type: "tool_end",   ..., component?: WebComponentDescriptor }
```

The `AgentEvent` `tool_start` and `tool_end` variants carry an optional `component?: WebComponentDescriptor` field populated by the gateway after calling `tool.getGatewayUI("web")`. If present, the browser mounts the component. If absent, the browser renders default text.

---

## Gateway Worker Implementation

```typescript
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import type { IWebGatewayApi, IWebGatewaySession } from "./types";

class WebGatewayImpl extends RpcTarget implements IWebGatewayApi {
  #core: IPiccoloCore;
  #userId: string;

  constructor(core: IPiccoloCore, userId: string) {
    super();
    this.#core = core;
    this.#userId = userId;
  }

  newSession(options?: NewSessionOptions): IWebGatewaySession {
    const session = this.#core.newSession(options);
    return new WebGatewaySessionImpl(session, this.#userId);
  }

  getSession(sessionId: string): IWebGatewaySession {
    const session = this.#core.getSession(sessionId);
    return new WebGatewaySessionImpl(session, this.#userId);
  }

  async listSessions() { return this.#core.listSessions(); }
  async listModels()   { return this.#core.listModels(); }
}

class WebGatewaySessionImpl extends RpcTarget implements IWebGatewaySession {
  #session: ISession;
  #userId: string;

  constructor(session: ISession, userId: string) {
    super();
    this.#session = session;
    this.#userId = userId;
  }

  async id()      { return this.#session.id(); }
  async info()    {
    const info = await this.#session.info();
    // Enforce: user can only access their own sessions
    if (info.userId !== this.#userId) throw new Error("Forbidden");
    return info;
  }
  async getName() { return this.#session.getName(); }
  async setName(name: string) { return this.#session.setName(name); }

  prompt(
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallback,
    attachments?: Attachment[],
  ): ITurnHandle {
    // 1. Call session.prompt() to get the ReadableStream<AgentEvent>
    // 2. For each event, optionally enrich with WebComponentDescriptor
    //    by calling tool.getGatewayUI("web") (cached per tool per session)
    // 3. Call listener.onEvent(enrichedEvent) for each event
    // 4. Pass callback stub to IPiccoloCore (forwarded to IAgentSessionDO)
    // 5. Return an ITurnHandle stub
    return new TurnHandleImpl(this.#session, text, listener, callback, attachments);
  }

  steer(text: string)   { return this.#session.steer(text); }
  followUp(text: string){ return this.#session.followUp(text); }
  abort()               { return this.#session.abort(); }
  getModel()            { return this.#session.getModel(); }
  setModel(id: string)  { return this.#session.setModel(id); }
  getContextUsage()     { return this.#session.getContextUsage(); }
  compact(opts?)        { return this.#session.compact(opts); }
  branch(entryId: string){ return this.#session.branch(entryId); }
  fork(fromEntryId?)    {
    const forked = this.#session.fork(fromEntryId);
    return new WebGatewaySessionImpl(forked, this.#userId);
  }
  delete()              { return this.#session.delete(); }

  async uploadAttachment(attachment: Attachment): Promise<string> {
    const id = crypto.randomUUID();
    const sessionId = await this.#session.id();
    await env.ASSETS.put(
      `sessions/${sessionId}/attachments/${id}`,
      base64ToArrayBuffer(attachment.data),
      { httpMetadata: { contentType: attachment.mimeType } }
    );
    return id;
  }
}
```

### Worker fetch handler

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Serve SPA shell
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveSpaShell(env);
    }

    // Serve custom tool UI component modules
    if (url.pathname.startsWith("/components/")) {
      return serveComponent(url.pathname, env);
    }

    // Cap'n Web RPC endpoint (WebSocket upgrade or HTTP batch)
    if (url.pathname === "/rpc") {
      const userId = authenticateUser(request);     // CF Access JWT or header
      if (!userId) return new Response("Unauthorized", { status: 401 });

      const core = env.CORE as IPiccoloCore;
      return newWorkersRpcResponse(request, new WebGatewayImpl(core, userId));
    }

    return new Response("Not Found", { status: 404 });
  }
};
```

---

## Promise Pipelining

Cap'n Web's promise pipelining eliminates round trips. The browser can chain dependent calls without awaiting intermediate results:

```typescript
// Create a session and immediately start prompting — one round trip.
const session = api.newSession({ name: "New chat" });
const turn = session.prompt("Hello", listener, callback);
await turn.done();

// Fork and start a new turn in the forked session — one round trip.
const forked = session.fork();
const turn2 = forked.prompt("What if we tried differently?", listener, callback);
```

---

## `IWebUiSessionDO`

Defined in [api.md §6](api.md).

With Cap'n Web over WebSocket, each browser tab maintains its own persistent WebSocket connection directly to the gateway Worker. The `IWebUiSessionDO` is no longer needed for SSE fan-out (that was a REST-era pattern). However, the DO is retained for **connection durability**: when the gateway Worker is evicted, open WebSocket connections are re-established via the DO, which holds the connection state and can replay buffered events.

```typescript
class WebUiSessionDO extends DurableObject {
  // Pure WebSocket transport — no capnweb stubs stored here.
  // Uses Workers hibernation API (ctx.acceptWebSocket / ctx.getWebSockets) so
  // connections survive Worker eviction. Events are serialized as JSON.

  // Called by the gateway Worker to accept a WebSocket upgrade from a browser tab.
  // Hibernates the connection so it persists across Worker evictions.
  // Replays recent buffered events to the new connection immediately.
  async addConnection(request: Request): Promise<Response>;

  // Called by the gateway Worker as it consumes AgentEvents from piccolo-core.
  // Broadcasts the serialized event to all hibernated WebSocket connections.
  // Buffers the last 50 events for reconnect replay.
  async pushEvent(event: AgentEvent): Promise<void>;

  // Return recent buffered events for reconnecting clients.
  // Default: last 50 events.
  async getRecentEvents(): Promise<AgentEvent[]>;
}
```

---

## Browser SPA

Framework: **SolidJS + @solidjs/router** (consistent with `IWebUI` custom component model — dynamic components served at `/components/{id}.js` are SolidJS components).

Build tool: **Vite** with `vite-plugin-solid`.

SPA lives in `gateways/web/app/`. Vite output goes to `gateways/web/dist/`, which Wrangler serves via native static asset hosting (`"assets": { "directory": "./dist", "html_handling": "single-page-application" }`).

### Cap'n Web client setup

```typescript
// app/src/rpc.ts
import { newWebSocketRpcSession } from "capnweb";
import type { IWebGatewayApi } from "../../src/types.ts";

let _api: ReturnType<typeof newWebSocketRpcSession<IWebGatewayApi>> | null = null;

export function getApi() {
  if (!_api) {
    const isDev = import.meta.env.DEV;
    // Dev auth: capnweb does not support custom WS headers, so pass as query params.
    // Production: CF Access JWT is sent automatically via cookie.
    const params = new URLSearchParams();
    if (isDev && import.meta.env.VITE_DEV_AUTH_SECRET) {
      params.set("devAuth", import.meta.env.VITE_DEV_AUTH_SECRET);
      params.set("devUserId", import.meta.env.VITE_DEV_USER_ID ?? "dev-user");
    }
    const query = params.toString();
    _api = newWebSocketRpcSession<IWebGatewayApi>(
      `${isDev ? "ws" : "wss"}://${location.host}/rpc${query ? `?${query}` : ""}`,
    );
  }
  return _api;
}
```

### Required SPA features

**Message display:**
- User messages, assistant messages (streaming text + collapsible reasoning blocks), tool calls (pending + collapsed), error messages
- `text_delta` events appended token-by-token — no full re-render (SolidJS fine-grained reactivity: only the text node updates)
- `tool_start` → show name + input; if `component` field present, mount SolidJS component from `/components/{id}.js`
- `tool_end` → collapse to summary; if `component` field present, replace with result component

**Input:**
- Multi-line, submit on Enter (configurable) or button
- Attachment picker (images, documents)
- Abort button visible while streaming (`ITurnHandle.abort()`)

**Session management:**
- Create, list, resume, delete, rename sessions
- Model picker (`api.listModels()` → `session.setModel()`)
- Context usage bar (`session.getContextUsage()`)
- Fork and branch navigation

**Slash commands** (handled client-side, translated into RPC calls):

| Command | RPC call |
|---|---|
| `/new` | `api.newSession()` |
| `/model <id>` | `session.setModel(id)` |
| `/models` | `api.listModels()` (display) |
| `/abort` | `turn.abort()` |
| `/fork` | `session.fork()` |
| `/compact` | `session.compact()` |

**Gateway callback UI** — `IGatewayCallback` is implemented by the browser. The server calls it mid-turn:
1. `requestSelect` → modal with option list
2. `requestConfirm` → modal with Yes/No
3. `requestInput` → modal with text field
4. `notify` → toast notification

---

## Auth

Cloudflare Access is the preferred authentication mechanism. The CF Access JWT is automatically attached as a cookie to the WebSocket upgrade request. The gateway validates it in the `fetch` handler before calling `newWorkersRpcResponse`. Once authenticated, the `userId` is bound into the `WebGatewayImpl` instance for the lifetime of the connection — no per-call auth overhead.

Session isolation is enforced in `WebGatewaySessionImpl.info()`: the `userId` of the session record must match the authenticated caller.

---

## wrangler.template.jsonc

```jsonc
{
  "name": "piccolo-web-gateway",
  "services": [
    { "binding": "CORE", "service": "piccolo-core" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "WEB_UI_SESSION", "class_name": "WebUiSessionDO" }
    ]
  },
  "r2_buckets": [
    { "binding": "ASSETS", "bucket_name": "piccolo-assets" }
  ]
  // Secrets: AUTH_SECRET (fallback when CF Access not available)
}
```

---

## Summary of Changes from REST

| Aspect | Previous (REST + SSE) | Now (Cap'n Web) |
|---|---|---|
| Browser→server | HTTP fetch per operation | Typed method call on RPC stub |
| Server→browser events | SSE (`text/event-stream`) | `IAgentEventListener.onEvent()` callback stub |
| Interactive prompts | SSE event + follow-up POST | `IGatewayCallback` stub (already in api.md) |
| Session reference | URL path parameter `/:id` | `IWebGatewaySession` stub (promise pipelining) |
| Auth per request | `Authorization` header on every fetch | Once at WebSocket upgrade; bound to session |
| Fan-out to multiple tabs | `IWebUiSessionDO` push + SSE | Each tab has its own WebSocket + listener stub |
| Fork result | `SessionRecord` JSON | `IWebGatewaySession` stub (immediately usable) |
