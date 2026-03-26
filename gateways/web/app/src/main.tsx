/**
 * main.tsx — SPA entry point.
 *
 * The only file that knows about RpcStub and capnweb. Creates the WebSocket
 * connection and gets the IUser stub, then passes it as a plain IUser prop.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import type { IUser } from "@piccolo/api";
import { newWebSocketRpcSession } from "capnweb";
import { render } from "solid-js/web";
import type { IWebGateway } from "../../src/types.ts";
import { App } from "./App.tsx";

console.debug("[app] main.tsx loading");

const proto = location.protocol === "https:" ? "wss" : "ws";
const url = `${proto}://${location.host}/rpc`;
console.debug("[app] connecting to", url);

// ── Logging WebSocket proxy ───────────────────────────────────────────────────
// Wraps the real WebSocket and logs every RPC frame, close, and error so we
// can diagnose "ReadableStream received over RPC disconnected prematurely".
const rawWs = new WebSocket(url);
const loggingWs = new Proxy(rawWs, {
  get(target, prop) {
    if (prop === "addEventListener") {
      return (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === "message") {
          const wrapped = (event: Event) => {
            const me = event as MessageEvent;
            try {
              const parsed = JSON.parse(me.data as string) as unknown;
              const tag = Array.isArray(parsed) ? (parsed[0] as string) : "?";
              console.debug("[capnweb] ←", tag, JSON.stringify(parsed).slice(0, 200));
            } catch {
              console.debug("[capnweb] ← (unparseable)", String(me.data).slice(0, 200));
            }
            if (typeof listener === "function") listener(event);
            else listener.handleEvent(event);
          };
          target.addEventListener(type, wrapped, options);
        } else if (type === "close") {
          const wrapped = (event: Event) => {
            const ce = event as CloseEvent;
            console.debug(
              "[capnweb] ws:close code=%d reason=%s wasClean=%s",
              ce.code,
              ce.reason,
              ce.wasClean,
            );
            if (typeof listener === "function") listener(event);
            else listener.handleEvent(event);
          };
          target.addEventListener(type, wrapped, options);
        } else if (type === "error") {
          const wrapped = (event: Event) => {
            console.debug("[capnweb] ws:error", event);
            if (typeof listener === "function") listener(event);
            else listener.handleEvent(event);
          };
          target.addEventListener(type, wrapped, options);
        } else {
          target.addEventListener(type, listener as EventListener, options);
        }
      };
    }
    const val = Reflect.get(target, prop, target);
    return typeof val === "function" ? (val as Function).bind(target) : val;
  },
});

const gateway = newWebSocketRpcSession<IWebGateway>(loggingWs as unknown as WebSocket);
const user: IUser = gateway.getUser();

console.debug("[app] user ready");

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

render(() => <App user={user} />, root);
