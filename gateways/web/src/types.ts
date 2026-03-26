/**
 * types.ts — Gateway-local types for piccolo-web-gateway.
 *
 * IWebGateway hands the browser a userId-bound IUser stub.
 * All session and model operations are then on IUser directly.
 *
 * Spec ref: specs/web_gateway.md §IWebGateway
 */

import type { IUser } from "@piccolo/api";
import type { RpcTarget } from "capnweb";

export interface IWebGateway extends RpcTarget {
  /** Return the IUser stub for this connection's authenticated user. */
  getUser(): IUser;
}
