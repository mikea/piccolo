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
| `USER_ID` | Authenticated user ID stamped on all sessions |

---

## Browser SPA

SolidJS + Vite. `IUser` stub passed as a prop through the component tree. No global store. Components call `IUser`/`ISession` methods directly via JSRPC.
