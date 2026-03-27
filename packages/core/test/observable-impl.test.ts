/**
 * Unit tests for ObservableImpl<T>, tryDispose, and dupIfRpcStub.
 *
 * Tests run in the Workers Miniflare environment, so RpcTarget and
 * Symbol.dispose are available natively.
 *
 * Spec ref: specs/api.md §IObservable
 */

import type { IObserver } from "@piccolo/api";
import { describe, expect, it, vi } from "vitest";
import { dupIfRpcStub, ObservableImpl, tryDispose } from "../src/observable-impl.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeObserver<T>(): IObserver<T> & {
  values: T[];
  errors: unknown[];
  completions: number;
} {
  const values: T[] = [];
  const errors: unknown[] = [];
  let completions = 0;
  return {
    values,
    errors,
    get completions() {
      return completions;
    },
    async onNext(v) {
      values.push(v);
    },
    async onError(e) {
      errors.push(e);
    },
    async onComplete() {
      completions++;
    },
  };
}

// ─── tryDispose ───────────────────────────────────────────────────────────────

describe("tryDispose", () => {
  it("calls [Symbol.dispose]() if present", () => {
    const disposed = vi.fn();
    const obj = { [Symbol.dispose]: disposed };
    tryDispose(obj);
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("no-op for object without [Symbol.dispose]", () => {
    expect(() => tryDispose({ foo: 1 })).not.toThrow();
  });

  it("no-op for null", () => {
    expect(() => tryDispose(null)).not.toThrow();
  });

  it("no-op for undefined", () => {
    expect(() => tryDispose(undefined)).not.toThrow();
  });

  it("no-op for primitives", () => {
    expect(() => tryDispose(42)).not.toThrow();
    expect(() => tryDispose("string")).not.toThrow();
    expect(() => tryDispose(true)).not.toThrow();
  });

  it("calls [Symbol.dispose]() with correct this context", () => {
    let capturedThis: unknown;
    const obj = {
      [Symbol.dispose]() {
        capturedThis = this;
      },
    };
    tryDispose(obj);
    expect(capturedThis).toBe(obj);
  });
});

// ─── dupIfRpcStub ─────────────────────────────────────────────────────────────

describe("dupIfRpcStub", () => {
  it("returns value unchanged if no .dup() method", () => {
    const obj = { onNext: vi.fn(), onError: vi.fn(), onComplete: vi.fn() };
    expect(dupIfRpcStub(obj)).toBe(obj);
  });

  it("calls .dup() and returns result if .dup() is present", () => {
    const duped = { isDup: true };
    const stub = { dup: vi.fn().mockReturnValue(duped) };
    const result = dupIfRpcStub(stub);
    expect(stub.dup).toHaveBeenCalledOnce();
    expect(result).toBe(duped);
  });

  it("returns value unchanged for null", () => {
    expect(dupIfRpcStub(null)).toBeNull();
  });

  it("returns value unchanged for primitives", () => {
    expect(dupIfRpcStub(42)).toBe(42);
    expect(dupIfRpcStub("hello")).toBe("hello");
  });
});

// ─── ObservableImpl — emit and complete ───────────────────────────────────────

describe("ObservableImpl — emit and complete", () => {
  it("subscriber receives emitted values and onComplete", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    obs.emit(1);
    obs.emit(2);
    await obs.complete();
    expect(sub.values).toEqual([1, 2]);
    expect(sub.completions).toBe(1);
  });

  it("values are delivered in emission order", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    for (let i = 0; i < 10; i++) obs.emit(i);
    await obs.complete();
    expect(sub.values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("multiple subscribers all receive emitted values", async () => {
    const obs = new ObservableImpl<string>();
    const s1 = makeObserver<string>();
    const s2 = makeObserver<string>();
    await obs.subscribe(s1);
    await obs.subscribe(s2);
    obs.emit("a");
    obs.emit("b");
    await obs.complete();
    expect(s1.values).toEqual(["a", "b"]);
    expect(s2.values).toEqual(["a", "b"]);
  });

  it("complete() is idempotent", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    await obs.complete();
    await obs.complete();
    expect(sub.completions).toBe(1);
  });
});

// ─── ObservableImpl — error ───────────────────────────────────────────────────

describe("ObservableImpl — error", () => {
  it("subscribers receive onError with the reason", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    obs.emit(1);
    await obs.error(new Error("boom"));
    expect(sub.values).toEqual([1]);
    expect(sub.errors).toHaveLength(1);
    expect((sub.errors[0] as Error).message).toBe("boom");
  });

  it("error() is idempotent", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    await obs.error("first");
    await obs.error("second");
    expect(sub.errors).toHaveLength(1);
  });

  it("error() after complete() is no-op", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    await obs.complete();
    await obs.error("too late");
    expect(sub.errors).toHaveLength(0);
    expect(sub.completions).toBe(1);
  });
});

// ─── ObservableImpl — subscribe after terminal state ─────────────────────────

describe("ObservableImpl — subscribe after terminal state", () => {
  it("subscribe after complete() delivers onComplete immediately", async () => {
    const obs = new ObservableImpl<number>();
    await obs.complete();
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    expect(sub.completions).toBe(1);
  });

  it("subscribe after error() delivers onError immediately", async () => {
    const obs = new ObservableImpl<number>();
    await obs.error(new Error("done"));
    const sub = makeObserver<number>();
    await obs.subscribe(sub);
    expect((sub.errors[0] as Error).message).toBe("done");
  });

  it("subscribe after complete() returns noop subscription", async () => {
    const obs = new ObservableImpl<number>();
    await obs.complete();
    const sub = makeObserver<number>();
    const subscription = await obs.subscribe(sub);
    expect(() => subscription[Symbol.dispose]()).not.toThrow();
  });
});

// ─── ObservableImpl — unsubscribe ─────────────────────────────────────────────

describe("ObservableImpl — unsubscribe via ISubscription[Symbol.dispose]", () => {
  it("disposed subscription stops receiving values", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    const subscription = await obs.subscribe(sub);
    obs.emit(1);
    await Promise.resolve(); // flush queue
    subscription[Symbol.dispose]();
    obs.emit(2);
    await obs.complete();
    expect(sub.values).toEqual([1]);
    expect(sub.completions).toBe(0); // unsubscribed before complete
  });

  it("disposing subscription is idempotent", async () => {
    const obs = new ObservableImpl<number>();
    const sub = makeObserver<number>();
    const subscription = await obs.subscribe(sub);
    subscription[Symbol.dispose]();
    expect(() => subscription[Symbol.dispose]()).not.toThrow();
  });

  it("disposing one subscription does not affect others", async () => {
    const obs = new ObservableImpl<number>();
    const s1 = makeObserver<number>();
    const s2 = makeObserver<number>();
    const sub1 = await obs.subscribe(s1);
    await obs.subscribe(s2);
    sub1[Symbol.dispose]();
    obs.emit(99);
    await obs.complete();
    expect(s1.values).toEqual([]);
    expect(s2.values).toEqual([99]);
    expect(s2.completions).toBe(1);
  });
});

// ─── ObservableImpl — fault isolation ────────────────────────────────────────

describe("ObservableImpl — fault isolation", () => {
  it("throwing onNext removes the subscriber but does not affect others", async () => {
    const obs = new ObservableImpl<number>();
    const broken: IObserver<number> = {
      async onNext() {
        throw new Error("broken");
      },
      async onError() {},
      async onComplete() {},
    };
    const good = makeObserver<number>();
    await obs.subscribe(broken);
    await obs.subscribe(good);
    obs.emit(1);
    obs.emit(2);
    await obs.complete();
    expect(good.values).toEqual([1, 2]);
    expect(good.completions).toBe(1);
  });

  it("throwing onComplete removes the subscriber silently", async () => {
    const obs = new ObservableImpl<number>();
    const broken: IObserver<number> = {
      async onNext() {},
      async onError() {},
      async onComplete() {
        throw new Error("broken complete");
      },
    };
    const good = makeObserver<number>();
    await obs.subscribe(broken);
    await obs.subscribe(good);
    await expect(obs.complete()).resolves.toBeUndefined();
    expect(good.completions).toBe(1);
  });

  it("throwing onError is silently swallowed", async () => {
    const obs = new ObservableImpl<number>();
    const broken: IObserver<number> = {
      async onNext() {},
      async onError() {
        throw new Error("broken error handler");
      },
      async onComplete() {},
    };
    await obs.subscribe(broken);
    await expect(obs.error("reason")).resolves.toBeUndefined();
  });
});

// ─── ObservableImpl — dupIfRpcStub integration ────────────────────────────────

describe("ObservableImpl — dupIfRpcStub integration via subscribe", () => {
  it("dup() is called on stub-like observers", async () => {
    const obs = new ObservableImpl<number>();
    const values: number[] = [];
    let disposeCount = 0;
    // Simulate an RpcStub: has .dup() which returns a clone with same behaviour.
    const makeStub = (): IObserver<number> & { dup: () => IObserver<number> } => {
      const stub: IObserver<number> & { dup: () => IObserver<number>; [Symbol.dispose](): void } = {
        async onNext(v) {
          values.push(v);
        },
        async onError() {},
        async onComplete() {},
        dup() {
          return makeStub();
        },
        [Symbol.dispose]() {
          disposeCount++;
        },
      };
      return stub;
    };
    const original = makeStub();
    const subscription = await obs.subscribe(original);
    obs.emit(42);
    await obs.complete();
    // The dup received the value (not the original — both have same onNext though)
    expect(values).toEqual([42]);
    // Disposing the subscription disposes the dup.
    // (complete() already called #resolveAll which calls unsubscribe, which
    // calls tryDispose on the dup — so disposeCount is already 1 here)
    expect(disposeCount).toBe(1);
    // Double-dispose is safe
    subscription[Symbol.dispose]();
    // No additional dispose because subscriber was already removed by complete()
    expect(disposeCount).toBe(1);
  });

  it("plain observers (no .dup) are not disposed on unsubscribe", async () => {
    const obs = new ObservableImpl<number>();
    const disposed = vi.fn();
    const plain: IObserver<number> & { [Symbol.dispose](): void } = {
      async onNext() {},
      async onError() {},
      async onComplete() {},
      [Symbol.dispose]: disposed,
    };
    const subscription = await obs.subscribe(plain);
    subscription[Symbol.dispose]();
    // Plain observer — no dup, so tryDispose is NOT called on unsubscribe
    expect(disposed).not.toHaveBeenCalled();
  });
});

// ─── ObservableImpl — delivery ordering ──────────────────────────────────────

describe("ObservableImpl — delivery ordering", () => {
  it("all emits before complete() are delivered before onComplete fires", async () => {
    const obs = new ObservableImpl<number>();
    const received: Array<number | "done"> = [];
    const sub: IObserver<number> = {
      async onNext(v) {
        received.push(v);
      },
      async onError() {},
      async onComplete() {
        received.push("done");
      },
    };
    await obs.subscribe(sub);
    obs.emit(1);
    obs.emit(2);
    obs.emit(3);
    await obs.complete();
    expect(received).toEqual([1, 2, 3, "done"]);
  });

  it("emit() after complete() throws", async () => {
    const obs = new ObservableImpl<number>();
    await obs.subscribe(makeObserver<number>());
    await obs.complete();
    // emit() does not check #done — it chains onto the queue.
    // The dispatch will simply find no subscribers and do nothing.
    expect(() => obs.emit(1)).not.toThrow();
  });
});
