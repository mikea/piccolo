/**
 * piccolo-core entry point.
 *
 * The full WorkerEntrypoint (IPiccoloCore) is implemented in item 9.
 * This stub satisfies the Wrangler `main` requirement so Miniflare can
 * start the Worker for unit tests (items 3–8) before the entrypoint exists.
 */
export default {} satisfies ExportedHandler<Env>;

// ── Public library API ────────────────────────────────────────────────────────
// Session persistence layer (item 4)
export * from "./session/index.ts";
