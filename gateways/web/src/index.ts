/**
 * index.ts — piccolo-web-gateway Worker entry point.
 *
 * Routes:
 *   /rpc  → Cap'n Web RPC WebSocket. Extracts userId from the Cloudflare
 *            Access JWT (Cf-Access-Jwt-Assertion header) injected by CF Zero
 *            Trust. CF Access has already verified the JWT before this Worker
 *            sees it — we only need to decode the payload to read the email.
 *   /*    → SPA static assets (served automatically by Wrangler assets binding)
 *
 * Spec ref: specs/web_gateway.md
 */

import type { IPiccoloCore } from "@piccolo/api";
import { newWorkersRpcResponse } from "capnweb";
import { WebGatewayImpl } from "./web-gateway.ts";

/**
 * Decode the Cloudflare Access JWT and return the user's email.
 * CF Access has already verified the signature — we trust the payload.
 * Returns null if the header is absent or malformed.
 */
function userIdFromAccessJwt(request: Request): string | null {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    const email = payload["email"];
    if (typeof email === "string" && email.length > 0) return email;
    // Fall back to sub if email is absent
    const sub = payload["sub"];
    if (typeof sub === "string" && sub.length > 0) return sub;
    return null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/rpc") {
      const userId = userIdFromAccessJwt(request);
      if (!userId) {
        return new Response("Unauthorized", { status: 401 });
      }
      console.debug(`[gateway] /rpc userId=${userId}`);
      const core = env.CORE as unknown as IPiccoloCore;
      return newWorkersRpcResponse(request, new WebGatewayImpl(core, userId));
    }

    return new Response("Not Found", { status: 404 });
  },
};
