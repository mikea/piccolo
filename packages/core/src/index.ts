/**
 * piccolo-core entry point.
 *
 * The full WorkerEntrypoint (IPiccoloCore) is implemented in item 9.
 * This stub satisfies the Wrangler `main` requirement so Miniflare can
 * start the Worker for unit tests (items 3–8) before the entrypoint exists.
 *
 * AgentSessionDO must be exported from the top-level entry point so Wrangler
 * can register it as a Durable Object class (required by wrangler.template.jsonc).
 */
export default {} satisfies ExportedHandler<Env>;

// ── Durable Objects ───────────────────────────────────────────────────────────
// AgentSessionDO (item 5) — must be a named export for Wrangler DO registration
export { AgentSessionDO } from "./do/agent-session.ts";

// ── Public library API ────────────────────────────────────────────────────────
// Session persistence layer (item 4)
export * from "./session/index.ts";
