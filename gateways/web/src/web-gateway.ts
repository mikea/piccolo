/**
 * web-gateway.ts — WebGatewayImpl.
 *
 * The sole gateway RpcTarget. Holds the authenticated userId and the core
 * binding. Returns a userId-bound IUser stub from getUser().
 *
 * Spec ref: specs/web_gateway.md §IWebGateway
 */

import type { IPiccoloCore, IUser } from "@piccolo/api";
import { RpcTarget } from "capnweb";
import type { IWebGateway } from "./types.ts";

export class WebGatewayImpl extends RpcTarget implements IWebGateway {
  readonly #core: IPiccoloCore;
  readonly #userId: string;

  constructor(core: IPiccoloCore, userId: string) {
    super();
    this.#core = core;
    this.#userId = userId;
  }

  getUser(): IUser {
    console.debug("[gateway] getUser userId=%s", this.#userId);
    return this.#core.getUser(this.#userId);
  }
}
