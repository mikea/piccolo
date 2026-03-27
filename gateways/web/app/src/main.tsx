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

const gateway = newWebSocketRpcSession<IWebGateway>(url);
const user: IUser = gateway.getUser();

console.debug("[app] user ready");

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

render(() => <App user={user} />, root);
