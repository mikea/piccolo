/**
 * rpc.ts — Cap'n Web RPC client singleton.
 *
 * Returns a lazily-initialized RpcStub<IWebGatewayApi> connected to the
 * gateway Worker at wss://{host}/rpc. The same connection is reused for
 * the lifetime of the page.
 *
 * Dev mode: when VITE_DEV_AUTH_SECRET and VITE_DEV_USER_ID are set,
 * they are appended as URL query parameters (?devAuth=...&devUserId=...)
 * that the server's auth.ts reads as the dev-auth escape hatch.
 * CF Access JWT is attached automatically via cookie in production.
 *
 * Spec ref: specs/web_gateway.md §Cap'n Web client setup, §Auth
 */

import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { IWebGatewayApi } from "../../src/types.ts";

// Vite injects import.meta.env at build time. Declare the shape we use.
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_DEV_AUTH_SECRET?: string;
  readonly VITE_DEV_USER_ID?: string;
}
// biome-ignore lint/suspicious/noExplicitAny: Vite env augmentation
declare const __VITE_ENV__: ImportMetaEnv;

let _api: RpcStub<IWebGatewayApi> | null = null;

/**
 * Return the singleton IWebGatewayApi RPC stub.
 * Creates the WebSocket connection on first call.
 */
export function getApi(): RpcStub<IWebGatewayApi> {
  if (!_api) {
    const env = (typeof import.meta !== "undefined" &&
      (import.meta as { env?: ImportMetaEnv }).env) as ImportMetaEnv | undefined;
    const isDev = env?.DEV ?? false;
    const proto = isDev ? "ws" : "wss";
    const params = new URLSearchParams();

    if (isDev && env?.VITE_DEV_AUTH_SECRET) {
      params.set("devAuth", env.VITE_DEV_AUTH_SECRET);
      params.set("devUserId", env.VITE_DEV_USER_ID ?? "dev-user");
    }

    const query = params.toString();
    const url = `${proto}://${location.host}/rpc${query ? `?${query}` : ""}`;

    _api = newWebSocketRpcSession<IWebGatewayApi>(url);
  }
  return _api;
}
