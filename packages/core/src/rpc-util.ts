/**
 * rpc-util.ts — Helper for calling methods on a DurableObjectStub via JSRPC.
 *
 * DurableObjectStub cannot be returned as an RPC value directly.
 * Wrapping it in a Proxy whose prototype is RpcTarget.prototype makes the
 * JSRPC system treat it as a serialisable capability.  Only works with
 * DurableObjectStub — the Proxy trick is specific to that type.
 */

import { RpcTarget } from "cloudflare:workers";

export function asRpcStub<T extends Rpc.DurableObjectBranded>(stub: DurableObjectStub<T>): T {
  return new Proxy(stub, {
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  }) as unknown as T;
}
