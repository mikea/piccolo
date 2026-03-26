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

`prompt()` returns `ReadableStream<AgentEvent>` consumed directly by the browser.

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

### Stateless UI principle

The UI holds **no conversation state**. All state lives server-side in `AgentSessionDO`. The SPA:

1. Calls `ISession.getHistory()` on mount to reconstruct the visible conversation.
2. Calls `ISession.subscribe()` immediately after to reconnect to any in-progress streaming turn (e.g. after a page reload mid-turn). The returned `ReadableStream<AgentEvent>` closes immediately if no turn is active.
3. Calls `ISession.getStatus()` to read `isStreaming` / `model` / `name` for UI controls.
4. On user send: calls `ISession.prompt(text)` and reads the returned `ReadableStream<AgentEvent>` to update the UI incrementally.

This means reloading the page while a turn is streaming reconnects and displays the correct live state without any lost content.
