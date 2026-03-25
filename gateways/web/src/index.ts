/**
 * index.ts — piccolo-web-gateway Worker entry point.
 *
 * Handles three route types:
 *   GET /             → SPA shell from R2
 *   GET /components/* → custom tool UI component JS modules from R2
 *   GET/POST /rpc     → Cap'n Web RPC endpoint (WebSocket upgrade or HTTP batch)
 *   everything else   → 404
 *
 * Auth is performed at the /rpc endpoint via CF Access JWT validation.
 * Once authenticated, userId is bound into WebGatewayImpl for the connection lifetime.
 *
 * Spec refs:
 *   specs/web_gateway.md §Worker fetch handler
 *   specs/web_gateway.md §Auth
 */

import type { IPiccoloCore } from "@piccolo/core";
import { newWorkersRpcResponse } from "capnweb";
import { serveComponent, serveSpaShell } from "./assets.ts";
import { authenticateUser } from "./auth.ts";
import { WebGatewayImpl } from "./web-gateway.ts";
import { WebUiSessionDO } from "./web-ui-session-do.ts";

// ── Named exports for Wrangler DO registration ────────────────────────────────
export { WebUiSessionDO };

// ── Default export: Worker fetch handler ─────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── SPA shell ─────────────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveSpaShell(env);
    }

    // ── Custom tool UI component modules ──────────────────────────────────────
    if (url.pathname.startsWith("/components/")) {
      return serveComponent(url.pathname, env);
    }

    // ── Cap'n Web RPC endpoint ────────────────────────────────────────────────
    if (url.pathname === "/rpc") {
      const userId = await authenticateUser(request, env);
      if (!userId) {
        return new Response("Unauthorized", { status: 401 });
      }

      const core = env.CORE as unknown as IPiccoloCore;
      return newWorkersRpcResponse(request, new WebGatewayImpl(core, userId, env));
    }

    // ── Fallback ──────────────────────────────────────────────────────────────
    return new Response("Not Found", { status: 404 });
  },
};
