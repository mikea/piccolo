/**
 * index.ts — piccolo-web-gateway Worker entry point.
 *
 * Routes:
 *   GET /     → SPA shell (handled automatically by Wrangler static assets)
 *   GET /rpc  → Cap'n Web RPC: returns WebGatewayImpl with raw core + userId
 *
 * No auth. userId comes from the USER_ID env var.
 *
 * Spec ref: specs/web_gateway.md
 */

import type { IPiccoloCore } from "@piccolo/core";
import { newWorkersRpcResponse } from "capnweb";
import { WebGatewayImpl } from "./web-gateway.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/rpc") {
      const core = env.CORE as unknown as IPiccoloCore;
      return newWorkersRpcResponse(request, new WebGatewayImpl(core, env.USER_ID));
    }

    return new Response("Not Found", { status: 404 });
  },
};
