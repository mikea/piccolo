/**
 * logging-stream.ts — LoggingTransformStream<T>
 *
 * A TransformStream that logs every chunk, plus open/close/error events,
 * to console.debug. Install it in a pipeline with .pipeThrough() to observe
 * what flows through a stream without altering the data.
 *
 * Usage:
 *   readable.pipeThrough(new LoggingTransformStream("[session] prompt"))
 */

export class LoggingTransformStream<T> extends TransformStream<T, T> {
  constructor(label: string) {
    super({
      start() {
        console.debug("[stream] %s: opened", label);
      },
      transform(chunk, controller) {
        const preview =
          chunk !== null && typeof chunk === "object" && "type" in chunk
            ? (chunk as { type: unknown }).type
            : String(chunk).slice(0, 60);
        console.debug("[stream] %s: chunk type=%s", label, preview);
        controller.enqueue(chunk);
      },
      flush() {
        console.debug("[stream] %s: closed", label);
      },
    });
  }
}
