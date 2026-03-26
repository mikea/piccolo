/**
 * StreamBroadcaster<T> — a TransformStream<T, T> that fans out every chunk
 * to zero or more subscriber streams created via connect().
 *
 * The primary readable (bc.readable, inherited from TransformStream) must be
 * consumed by the caller — it drives backpressure on the source.
 * Each connect() call returns an independent ReadableStream<T> that receives
 * all chunks from that point forward.
 *
 * connect() after close → immediately closed stream.
 * connect() after abort → immediately errored stream.
 *
 * A broken subscriber (enqueue/close/error throws) is silently removed and
 * never affects other subscribers or the primary drain.
 */
export class StreamBroadcaster<T> extends TransformStream<T, T> {
  public readonly subscribers = new Set<ReadableStreamDefaultController<T>>();
  public closed = false;
  public abortReason: unknown = undefined;
  public aborted = false;

  constructor() {
    super({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        console.debug("[brodcaster] chunk", chunk, this.subscribers.size);
        for (const sub of this.subscribers) {
          try {
            sub.enqueue(chunk);
          } catch (e) {
            console.debug("[brodcaster] error", e);
            this.subscribers.delete(sub);
          }
        }
      },
      flush: () => {
        this.closed = true;
        console.debug("[brodcaster] flush(=close)", this.subscribers.size);
        for (const sub of this.subscribers) {
          try {
            sub.close();
          } catch (e) {
            console.debug("[brodcaster] error", e);
            this.subscribers.delete(sub);
          }
        }
        this.subscribers.clear();
      },
    });
  }

  /**
   * Abort all subscribers with the given reason and mark the broadcaster done.
   * Call this when the source stream errors (e.g. from a pipeTo abort handler).
   */
  abort(reason: unknown): void {
    if (this.closed || this.aborted) return;
    console.debug("[brodcaster] abort ", reason);
    this.aborted = true;
    this.abortReason = reason;
    for (const sub of this.subscribers) {
      try {
        sub.error(reason);
      } catch {
        this.subscribers.delete(sub);
      }
    }
    this.subscribers.clear();
  }

  /**
   * Return a new ReadableStream<T> subscribed from this point forward.
   *
   * The returned stream is the readable side of a TransformStream — Workers RPC
   * can only transfer TransformStream.readable over the wire, not a raw
   * ReadableStream constructed with `new ReadableStream({start})`.
   *
   * If already closed/aborted, the TransformStream is immediately closed/errored.
   * Cancelling the returned stream removes the subscriber from the set.
   */
  connect(): ReadableStream<T> {
    const { readable, writable } = new TransformStream<T, T>();
    const writer = writable.getWriter();

    if (this.aborted) {
      writer.abort(this.abortReason).catch(() => {});
      return readable;
    }
    if (this.closed) {
      writer.close().catch(() => {});
      return readable;
    }

    // Register the writer as a subscriber. The broadcaster calls writer methods
    // directly — no intermediate ReadableStream controller needed.
    const sub: ReadableStreamDefaultController<T> = {
      enqueue: (chunk: T) => {
        writer.write(chunk).catch(() => {});
      },
      close: () => {
        writer.close().catch(() => {});
      },
      error: (reason: unknown) => {
        writer.abort(reason).catch(() => {});
      },
      desiredSize: null,
    } as unknown as ReadableStreamDefaultController<T>;

    this.subscribers.add(sub);

    void readable.pipeTo(new WritableStream(), { signal: AbortSignal.abort() }).catch(() => {});
    // Use a separate TransformStream just to intercept cancel.
    const { readable: out, writable: passthrough } = new TransformStream<T, T>();
    readable.pipeTo(passthrough).catch(() => {
      this.subscribers.delete(sub);
    });
    return out;
  }
}
