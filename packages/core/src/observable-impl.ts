/**
 * ObservableImpl<T> — a generic RpcTarget implementing IObservable<T>.
 *
 * Purpose: fan out values to multiple IObserver<T> subscribers while fully
 * isolating the source from observer errors. If any observer throws or rejects
 * from onNext / onComplete / onError it is silently removed from the subscriber
 * set and never called again. It cannot disrupt other subscribers or the source.
 *
 * Delivery ordering:
 *   emit(value)   — synchronous enqueue; returns void. Dispatches to all current
 *                   subscribers by chaining onto an internal promise queue, so
 *                   deliveries are ordered and never overlap.
 *   complete()    — returns a Promise that resolves only after all pending emit()
 *                   deliveries have finished, then signals onComplete to all subscribers.
 *   error(reason) — same as complete() but signals onError.
 *
 * Late subscribers miss values emitted before subscribe() was called.
 * The caller is responsible for subscribing before any values are emitted.
 *
 * Spec ref: specs/api.md §IObservable
 */

import { RpcTarget } from "cloudflare:workers";
import type { IObservable, IObserver } from "@piccolo/api";

export class ObservableImpl<T> extends RpcTarget implements IObservable<T> {
  readonly #subscribers = new Set<IObserver<T>>();
  #done = false;
  #hasError = false;
  #doneError: unknown = undefined;

  // Internal promise queue — each emit/complete/error chains onto this so
  // deliveries are strictly ordered and never overlap.
  #queue: Promise<void> = Promise.resolve();

  // ─── Source-side API ────────────────────────────────────────────────────────

  /** Enqueue a value for delivery to all current subscribers. Returns void. */
  emit(value: T): void {
    this.#queue = this.#queue.then(() => this.#dispatch((sub) => sub.onNext(value)));
  }

  /**
   * Wait for all pending emit() deliveries, then signal onComplete to all
   * subscribers. Returns a Promise that resolves when all onComplete calls finish.
   */
  async complete(): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    await this.#queue;
    await this.#dispatch((sub) => sub.onComplete());
    this.#subscribers.clear();
  }

  /**
   * Wait for all pending emit() deliveries, then signal onError to all
   * subscribers. Returns a Promise that resolves when all onError calls finish.
   */
  async error(reason: unknown): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    this.#hasError = true;
    this.#doneError = reason;
    await this.#queue;
    await this.#dispatch((sub) => sub.onError(reason));
    this.#subscribers.clear();
  }

  // ─── IObservable<T> ─────────────────────────────────────────────────────────

  async subscribe(observer: IObserver<T>): Promise<void> {
    if (this.#done) {
      try {
        if (this.#hasError) {
          await observer.onError(this.#doneError);
        } else {
          await observer.onComplete();
        }
      } catch {
        // observer error on terminal signal — ignore
      }
      return;
    }
    this.#subscribers.add(observer);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Call fn(subscriber) on every current subscriber concurrently.
   * Any subscriber that throws or rejects is silently removed.
   */
  async #dispatch(fn: (sub: IObserver<T>) => Promise<void>): Promise<void> {
    const calls: Promise<void>[] = [];
    for (const sub of this.#subscribers) {
      calls.push(
        fn(sub).catch((e) => {
          console.warn("[observer] subscriber error, deleting", sub, e);
          this.#subscribers.delete(sub);
        }),
      );
    }
    await Promise.all(calls);
  }
}
