/**
 * Unit tests for StreamBroadcaster.
 *
 * Tests run in the Workers Miniflare environment, so ReadableStream /
 * WritableStream / TransformStream are WHATWG Workers streams.
 */

import { describe, expect, it } from "vitest";
import { StreamBroadcaster } from "../src/stream-broadcaster.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a ReadableStream from an array of chunks, closed immediately. */
function sourceStream<T>(chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
}

/** Build a ReadableStream that enqueues chunks then errors. */
function erroringStream<T>(chunks: T[], reason: unknown): ReadableStream<T> {
  return new ReadableStream<T>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.error(reason);
    },
  });
}

/** Drain a ReadableStream into an array. */
async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const results: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) results.push(value);
  }
  return results;
}

/** Drain a stream, capturing any error thrown. */
async function drainWithError<T>(
  stream: ReadableStream<T>,
): Promise<{ items: T[]; error: unknown }> {
  const items: T[] = [];
  let error: unknown;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) items.push(value);
    }
  } catch (e) {
    error = e;
  }
  return { items, error };
}

/**
 * Pipe a source into the broadcaster and concurrently drain bc.readable
 * (the primary drain that drives backpressure). Resolves when both sides
 * complete. On source error, calls bc.abort() then rejects.
 */
async function pipe<T>(bc: StreamBroadcaster<T>, source: ReadableStream<T>): Promise<void> {
  try {
    await Promise.all([source.pipeTo(bc.writable), drain(bc.readable)]);
  } catch (err) {
    bc.abort(err);
    throw err;
  }
}

// ─── Basic emit and close ─────────────────────────────────────────────────────

describe("StreamBroadcaster — basic flow", () => {
  it("primary readable receives all chunks and closes", async () => {
    const bc = new StreamBroadcaster<number>();
    // Pipe source into writable and drain readable concurrently.
    const [, chunks] = await Promise.all([
      sourceStream([1, 2, 3]).pipeTo(bc.writable),
      drain(bc.readable),
    ]);
    expect(chunks).toEqual([1, 2, 3]);
  });

  it("subscriber connected before pipe receives all chunks", async () => {
    const bc = new StreamBroadcaster<number>();
    const sub = bc.connect();
    void pipe(bc, sourceStream([1, 2, 3]));
    expect(await drain(sub)).toEqual([1, 2, 3]);
  });

  it("connect() after close returns an immediately closed stream", async () => {
    const bc = new StreamBroadcaster<number>();
    await pipe(bc, sourceStream([1]));
    expect(await drain(bc.connect())).toEqual([]);
  });

  it("closed flag is set after source closes", async () => {
    const bc = new StreamBroadcaster<number>();
    expect(bc.closed).toBe(false);
    await pipe(bc, sourceStream([]));
    expect(bc.closed).toBe(true);
  });
});

// ─── Multiple subscribers ─────────────────────────────────────────────────────

describe("StreamBroadcaster — multiple subscribers", () => {
  it("all subscribers receive every chunk", async () => {
    const bc = new StreamBroadcaster<number>();
    const s1 = bc.connect();
    const s2 = bc.connect();
    const s3 = bc.connect();
    void pipe(bc, sourceStream([10, 20]));
    const [r1, r2, r3] = await Promise.all([drain(s1), drain(s2), drain(s3)]);
    expect(r1).toEqual([10, 20]);
    expect(r2).toEqual([10, 20]);
    expect(r3).toEqual([10, 20]);
  });

  it("late subscriber only receives chunks written after connect()", async () => {
    const bc = new StreamBroadcaster<number>();
    const s1 = bc.connect();

    // Drive the writable manually; drain bc.readable concurrently to avoid backpressure.
    const primaryDrain = drain(bc.readable);
    const writer = bc.writable.getWriter();
    await writer.write(1);
    // Connect s2 after chunk 1 is already written.
    const s2 = bc.connect();
    await writer.write(2);
    await writer.write(3);
    await writer.close();

    await primaryDrain;
    expect(await drain(s1)).toEqual([1, 2, 3]);
    expect(await drain(s2)).toEqual([2, 3]);
  });

  it("subscribers count tracks live connections", async () => {
    const bc = new StreamBroadcaster<number>();
    expect(bc.subscribers.size).toBe(0);
    const s1 = bc.connect();
    expect(bc.subscribers.size).toBe(1);
    const s2 = bc.connect();
    expect(bc.subscribers.size).toBe(2);
    await pipe(bc, sourceStream([]));
    expect(bc.subscribers.size).toBe(0);
    // streams should be closed
    expect(await drain(s1)).toEqual([]);
    expect(await drain(s2)).toEqual([]);
  });
});

// ─── Error / abort propagation ────────────────────────────────────────────────

describe("StreamBroadcaster — abort propagation", () => {
  it("abort() errors all connected subscribers", async () => {
    const bc = new StreamBroadcaster<number>();
    const s1 = bc.connect();
    const s2 = bc.connect();
    bc.abort(new Error("boom"));
    const [r1, r2] = await Promise.all([drainWithError(s1), drainWithError(s2)]);
    expect((r1.error as Error).message).toBe("boom");
    expect((r2.error as Error).message).toBe("boom");
  });

  it("connect() after abort() returns an immediately errored stream", async () => {
    const bc = new StreamBroadcaster<number>();
    bc.abort(new Error("already failed"));
    const { error } = await drainWithError(bc.connect());
    expect((error as Error).message).toBe("already failed");
  });

  it("abort() is idempotent", () => {
    const bc = new StreamBroadcaster<number>();
    bc.abort(new Error("first"));
    expect(() => bc.abort(new Error("second"))).not.toThrow();
    expect(bc.aborted).toBe(true);
  });

  it("abort() after close() does nothing", async () => {
    const bc = new StreamBroadcaster<number>();
    await pipe(bc, sourceStream([]));
    expect(() => bc.abort(new Error("too late"))).not.toThrow();
    expect(bc.closed).toBe(true);
    expect(bc.aborted).toBe(false);
  });

  it("source error propagates to subscribers via pipe helper", async () => {
    const bc = new StreamBroadcaster<number>();
    const sub = bc.connect();
    void pipe(bc, erroringStream([], new Error("source error"))).catch(() => {});
    const { error } = await drainWithError(sub);
    expect((error as Error).message).toBe("source error");
  });
});

// ─── Fault isolation ─────────────────────────────────────────────────────────

describe("StreamBroadcaster — fault isolation", () => {
  it("broken subscriber does not affect others", async () => {
    const bc = new StreamBroadcaster<number>();
    const broken = bc.connect();
    const healthy = bc.connect();

    // Cancel broken so its controller is closed — enqueue() will throw.
    await broken.cancel();

    // Drive writable manually; drain bc.readable concurrently.
    const primaryDrain = drain(bc.readable);
    const writer = bc.writable.getWriter();
    await writer.write(99);
    await writer.close();
    await primaryDrain;

    expect(await drain(healthy)).toEqual([99]);
  });

  it("broken subscriber is removed after first failed write", async () => {
    const bc = new StreamBroadcaster<number>();
    const broken = bc.connect();
    await broken.cancel();

    // cancel() fires the cancel callback synchronously, removing the subscriber.
    expect(bc.subscribers.size).toBe(0);
    const primaryDrain = drain(bc.readable);
    const writer = bc.writable.getWriter();
    await writer.write(1);
    await writer.close();
    await primaryDrain;
    expect(bc.subscribers.size).toBe(0);
  });

  it("abort() swallows errors from broken subscribers", async () => {
    const bc = new StreamBroadcaster<number>();
    const broken = bc.connect();
    await broken.cancel();
    expect(() => bc.abort(new Error("source error"))).not.toThrow();
  });

  it("flush swallows errors from broken subscribers", async () => {
    const bc = new StreamBroadcaster<number>();
    const broken = bc.connect();
    await broken.cancel();
    await expect(pipe(bc, sourceStream([]))).resolves.toBeUndefined();
  });

  it("multiple broken subscribers do not prevent healthy ones", async () => {
    const bc = new StreamBroadcaster<number>();
    const b1 = bc.connect();
    const healthy = bc.connect();
    const b2 = bc.connect();
    await b1.cancel();
    await b2.cancel();

    void pipe(bc, sourceStream([7, 8]));
    expect(await drain(healthy)).toEqual([7, 8]);
  });
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

describe("StreamBroadcaster — subscriber cancellation", () => {
  it("cancelling removes subscriber from set", async () => {
    const bc = new StreamBroadcaster<number>();
    const sub = bc.connect();
    expect(bc.subscribers.size).toBe(1);
    await sub.cancel();
    expect(bc.subscribers.size).toBe(0);
  });

  it("cancelling one does not affect others", async () => {
    const bc = new StreamBroadcaster<number>();
    const s1 = bc.connect();
    const s2 = bc.connect();
    await s1.cancel();

    void pipe(bc, sourceStream([42]));
    expect(await drain(s2)).toEqual([42]);
  });
});

// ─── Generic types ────────────────────────────────────────────────────────────

describe("StreamBroadcaster — generic types", () => {
  it("works with object chunks", async () => {
    const bc = new StreamBroadcaster<{ type: string; value: number }>();
    const sub = bc.connect();
    void pipe(
      bc,
      sourceStream([
        { type: "a", value: 1 },
        { type: "b", value: 2 },
      ]),
    );
    expect(await drain(sub)).toEqual([
      { type: "a", value: 1 },
      { type: "b", value: 2 },
    ]);
  });

  it("works with string chunks", async () => {
    const bc = new StreamBroadcaster<string>();
    const sub = bc.connect();
    void pipe(bc, sourceStream(["hello", "world"]));
    expect(await drain(sub)).toEqual(["hello", "world"]);
  });
});
