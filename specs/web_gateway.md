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

`prompt()` returns an `ITurn`; the browser calls `ITurn.getStream()` to consume the `ReadableStream<AgentEvent>` directly.

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
2. If `getCurrentTurn()` returns a turn (non-undefined), a turn is in progress — calls `ITurn.getStream()` to consume the remaining `ReadableStream<AgentEvent>`. The undefined/non-undefined result replaces any separate `isStreaming` flag.
3. On user send: calls `ISession.prompt(text)`, then calls `ITurn.getStream()` on the returned `ITurn` and reads the `ReadableStream<AgentEvent>` to update the UI incrementally.

This means reloading the page while a turn is streaming reconnects and displays the correct live state without any lost content.
