# piccolo-web-gateway — Specification

## Overview

The web gateway is a Cloudflare Worker that:
1. Serves the SolidJS SPA as static assets.
2. Accepts a WebSocket connection at `/rpc` and exposes `IWebGateway` via Cap'n Web RPC.

The browser calls `newWebSocketRpcSession<IWebGateway>(url)` once, calls `getUser()` to obtain an `IUser` stub bound to the authenticated userId, then uses `IUser` and `ISession` directly for all operations.

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

1. Calls `ISession.getHistory()`, `ISession.getModel()`, `ISession.getName()`, and `ISession.getCurrentTurn()` in parallel on mount.
2. Calls `session.subscribe(observer)` once — all `AgentEvent`s from all turns arrive through this single subscription. `isStreaming` is driven by `start` / `finish` events.
3. Calls `ISession.getCurrentTurn()` on mount — non-undefined means a turn is already in progress (e.g. page reload mid-turn); set `isStreaming=true` immediately.
4. On user send: calls `ISession.prompt(text)`. Events arrive via the existing session subscription. No per-turn observable needed.

This means reloading the page while a turn is streaming reconnects and displays the correct live state without any lost content.
