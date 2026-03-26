/**
 * rpc-util.ts — Temporary workaround for returning DurableObjectStub as RpcTarget.
 *
 * DurableObjectStub cannot be serialized as an RPC return value directly.
 * Trick suggested by the capnweb author: wrap the stub in a Proxy whose
 * prototype is RpcTarget.prototype — the RPC system then treats it as a
 * capability.
 *
 * TODO: Remove once capnweb supports DurableObjectStub natively.
 */

import { RpcTarget } from "cloudflare:workers";

export function stubAsRpc<T>(stub: DurableObjectStub): T {
  return new Proxy(stub, {
    getPrototypeOf() { return RpcTarget.prototype; },
  }) as unknown as T;
}
