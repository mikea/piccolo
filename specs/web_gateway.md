# piccolo-web-gateway — Specification

## Overview

The web gateway is a Cloudflare Worker that:
1. Serves the SolidJS SPA as static assets.
2. Accepts a WebSocket connection at `/rpc` and exposes `IWebGateway` via Cap'n Web RPC.

The browser constructs the `WebSocket` directly, attaches `error` and `close` listeners that set a SolidJS signal, then passes the socket to `newWebSocketRpcSession<IWebGateway>(ws)`. It also attaches `gateway.onRpcBroken(...)` so transport/session failures reported by Cap'n Web surface through the same UI path. `getUser()` returns an `IUser` stub bound to the authenticated userId; `IUser` and `ISession` are used for all subsequent operations.

WebSocket-level errors, unexpected disconnections, and Cap'n Web `onRpcBroken()` failures surface as a fixed error banner at the top of the page (rendered by `App.tsx` via the `wsError` signal). A clean close (`event.wasClean === true`) is not treated as an error.

---

## `IWebGateway`

```typescript
import type { IUser } from "@piccolo/core";
import type { RpcTarget } from "capnweb";

interface IWebGateway extends RpcTarget {
  getUser(): IUser;
}
```

## `IUser` / `ISession`

Defined in `@piccolo/core` — see `specs/api.md §IUser` and `specs/api.md §ISession`.

`ISession extends IObservable<AgentEvent>` — the browser calls `session.subscribe(observer)` once on mount and receives all `AgentEvent`s for the session lifetime. `prompt()` returns an `ITurn` carrying only the optional callback.

---

## Implementation

```typescript
// web-gateway.ts
class WebGatewayImpl extends RpcTarget implements IWebGateway {
  constructor(private readonly core: IPiccoloCore, private readonly userId: string) { super(); }
  getUser(): IUser { return this.core.getUser(this.userId); }
}

// index.ts
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/rpc")
      return newWorkersRpcResponse(request, new WebGatewayImpl(env.CORE, env.USER_ID));
    return new Response("Not Found", { status: 404 });
  },
};
```

---

## Wrangler vars

| Var | Description |
|---|---|
| CF Access JWT | `email` (or `sub`) claim decoded from `Cf-Access-Jwt-Assertion` header on every request |

---

## Browser SPA

SolidJS + Vite. `IUser` stub passed as a prop through the component tree. No global store. Components call `IUser`/`ISession` methods directly via JSRPC.

Cap'n Web stubs are callable `Proxy(function)` values. When storing an `IUser`/`ISession` stub in a Solid signal, setters must wrap the stub in a thunk (for example, `setSession(() => stub)`) so Solid stores the value instead of invoking it as a functional updater.

Static assets are served from `gateways/web/app/static` (configured as Vite `publicDir`), and `index.html` links `/favicon.ico` as the site icon.

### Routes and empty-session view

- `/` redirects to `/sessions`.
- `/sessions/:id` renders the two-panel chat layout (session sidebar + chat view).
- `/sessions` renders the same sidebar with the conversation list and a main-pane CTA button (`Start a new chat`). The empty view does not show a "No session selected" message.

### Stateless UI principle

The UI holds **no conversation state**. All state lives server-side in `AgentSessionDO`. The SPA:

1. Calls `ISession.getEntries()`, `ISession.getModel()`, `ISession.getName()`, and `ISession.getCurrentTurn()` in parallel on mount.
2. Calls `session.subscribe(observer)` once — all `AgentEvent`s from all turns arrive through this single subscription. `isStreaming` is driven by `start` / `finish` events.
3. Calls `ISession.getCurrentTurn()` on mount — non-undefined means a turn is already in progress (e.g. page reload mid-turn); set `isStreaming=true` immediately.
4. On user send: calls `ISession.prompt(text)`. Events arrive via the existing session subscription. No per-turn observable needed.

This means reloading the page while a turn is streaming reconnects and displays the correct live state without any lost content.

### Reasoning display

`reasoning-delta` events are accumulated into an ephemeral `reasoning: string` field on the streaming assistant UI entry. This field is **not** persisted — it exists only for the duration of the streaming turn.

The `ReasoningBlock` component renders the reasoning text:

- **While `isStreaming === true`**: expanded by default, labelled "Thinking…", shows the accumulated text in grey italic.
- **When `isStreaming` transitions to `false`**: automatically collapses to a toggle labelled "Reasoning". The user can click to expand/collapse.
- If `reasoning` is empty the block is not rendered at all.

The `reasoning` field is preserved when `text-delta` events arrive (it is not cleared). The `ReasoningBlock`'s collapsed state is driven solely by the `isStreaming` prop transition.

Store mutations for both `reasoning-delta` and `text-delta` use SolidJS granular path-based `setEntries(idx, updater)` calls — not whole-array replacements — so reactive updates fire correctly.
