/**
 * main.tsx — SPA entry point.
 *
 * The only file that knows about RpcStub and capnweb. Creates the WebSocket
 * connection and gets the IUser stub, then passes it as a plain IUser prop.
 *
 * A SolidJS signal tracks WebSocket-level errors and disconnections so the
 * App can render a visible error banner when the connection is lost.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import type { IUser } from "@piccolo/api";
import { newWebSocketRpcSession } from "capnweb";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { IWebGateway } from "../../src/types.ts";
import { App } from "./App.tsx";

console.debug("[app] main.tsx loading");

const proto = location.protocol === "https:" ? "wss" : "ws";
const url = `${proto}://${location.host}/rpc`;
console.debug("[app] connecting to", url);

const [wsError, setWsError] = createSignal<string | null>(null);

const showConnectionError = (message: string) => {
  setWsError(message);
};

const ws = new WebSocket(url);
ws.addEventListener("error", () => {
  console.error("[ws] connection error");
  showConnectionError("Connection error. Please reload the page.");
});
ws.addEventListener("close", (event) => {
  if (event.wasClean) return;
  console.error("[ws] connection closed unexpectedly", event.code, event.reason);
  showConnectionError(`Connection lost (code ${event.code}). Please reload the page.`);
});

const gateway = newWebSocketRpcSession<IWebGateway>(ws);
gateway.onRpcBroken((error) => {
  console.error("[rpc] session broken", error);
  showConnectionError("Connection error. Please reload the page.");
});

const user: IUser = gateway.getUser();

console.debug("[app] user ready");

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

render(() => <App user={user} wsError={wsError} />, root);
