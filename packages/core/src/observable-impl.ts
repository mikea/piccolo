/**
 * ObservableImpl<T> — a generic RpcTarget implementing IObservable<T>.
 *
 * Spec ref: specs/api.md §IObservable
 */

import { RpcTarget } from "cloudflare:workers";
import type { IDisposable, IObservable, IObserver, ISubscription } from "@piccolo/api";

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Call [Symbol.dispose]() on a value if the method exists.
 * Safe to call on any value — no-op if Symbol.dispose is not present.
 */
export function tryDispose(value: unknown): void {
  const d = (value as Record<symbol, unknown>)?.[Symbol.dispose];
  if (typeof d === "function") {
    (d as () => void).call(value);
  }
}

/**
 * Dup a value if it is a capnweb/Workers RpcStub, otherwise return it as-is.
 *
 * capnweb auto-releases capabilities passed as RPC call arguments once the
 * call returns. When a remote IObserver is passed to subscribe(), we must
 * retain our own reference so the server can call back onNext/onError/onComplete
 * across multiple turns for the session lifetime.
 *
 * RpcStubs expose a .dup() method that increments the refcount and returns a
 * new stub pointing at the same target. The caller's original stub is
 * auto-released; the dup we hold keeps the remote capability alive until we
 * explicitly dispose it (via tryDispose) on unsubscribe.
 *
 * Duck-typed: any object with a .dup() method is treated as a stub. Plain
 * local objects (e.g. in tests) have no .dup() and are returned unchanged.
 */
export function dupIfRpcStub<T>(value: T): T {
  const asStub = value as unknown as { dup?: () => unknown };
  return typeof asStub?.dup === "function" ? (asStub.dup() as T) : value;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface Subscriber<T> {
  readonly observer: IObserver<T>;
  readonly unsubscribe: () => void;
}

// ─── ObservableImpl ───────────────────────────────────────────────────────────

export class ObservableImpl<T> extends RpcTarget implements IObservable<T> {
  readonly #subscribers = new Set<Subscriber<T>>();
  #done = false;
  #hasError = false;
  #doneError: unknown = undefined;

  #queue: Promise<void> = Promise.resolve();

  // ─── Source-side API ────────────────────────────────────────────────────────

  emit(value: T): void {
    this.#queue = this.#queue.then(() => this.#dispatch((sub) => sub.observer.onNext(value)));
  }

  async complete(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#queue;
    await this.#dispatch((sub) => sub.observer.onComplete());
    this.#resolveAll();
  }

  async error(reason: unknown): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#hasError = true;
    this.#doneError = reason;
    await this.#queue;
    await this.#dispatch((sub) => sub.observer.onError(reason));
    this.#resolveAll();
  }

  // ─── IObservable<T> ─────────────────────────────────────────────────────────

  async subscribe(observer: IObserver<T>): Promise<ISubscription> {
    if (this.#done) {
      const p = this.#hasError ? observer.onError(this.#doneError) : observer.onComplete();
      await p.catch(() => {});
      const noop: IDisposable = { [Symbol.dispose]() {} };
      return noop;
    }

    // Dup if observer is an RpcStub so subscribe() can return immediately while
    // we retain our own reference for the subscription lifetime.
    const held = dupIfRpcStub(observer);

    let sub: Subscriber<T>;
    let disposed = false;
    const subscription: ISubscription = {
      [Symbol.dispose]: () => {
        if (disposed) return;
        disposed = true;
        this.#subscribers.delete(sub);
        // Dispose the dup when unsubscribing; no-op for plain local observers.
        if (held !== observer) tryDispose(held);
      },
    };
    sub = { observer: held, unsubscribe: subscription[Symbol.dispose].bind(subscription) };
    this.#subscribers.add(sub);
    return subscription;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async #dispatch(fn: (sub: Subscriber<T>) => Promise<void>): Promise<void> {
    const calls: Promise<void>[] = [];
    for (const sub of this.#subscribers) {
      calls.push(
        fn(sub).catch((e) => {
          console.warn("[observer] subscriber error, removing", sub.observer, e);
          sub.unsubscribe();
        }),
      );
    }
    await Promise.all(calls);
  }

  #resolveAll(): void {
    for (const sub of this.#subscribers) sub.unsubscribe();
    this.#subscribers.clear();
  }
}
