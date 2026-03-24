# piccolo

A minimalistic AI agent, fully specced and implemented by AI — driven and verified by humans.

Inspired by [pi](https://github.com/badlogic/pi-mono), a capable local AI agent by Mario Zechner. Piccolo takes the same core ideas and rebuilds them from the ground up for the cloud, with a radically smaller core and a fundamentally different infrastructure model.

---

## What piccolo is

Piccolo is an AI agent that runs entirely on **Cloudflare's infrastructure** — no server to provision, no binary to install, no local state. You deploy it once; it is accessible from any device through a web browser or Telegram.

The implementation is intentionally AI-driven: every spec document, architectural decision, and code change is authored by an AI agent and reviewed and verified by a human. The spec is the contract. The code must match it.

---

## Key differences from pi

### 1. Minimal core — everything that can be an extension, must be

Pi ships batteries included: 6 built-in tools, a TUI, session persistence, compaction, and a model catalog all in the core. Piccolo's core does exactly four things: define the extension API, load and dispatch to extensions, run the agent loop, and integrate with Cloudflare infrastructure. Everything else is an extension.

- No built-in tools (file I/O, shell, search are all extensions)
- No built-in UI (all user interaction goes through gateways)
- No hardcoded model catalog
- No compaction logic in the core

### 2. Runs in the cloud, not on your machine

Pi is a local CLI binary — `~/.pi/` config, local JSONL sessions, process-local state. Piccolo is a Cloudflare Workers service:

- No local filesystem. All state lives in Durable Objects, D1, KV, or R2.
- No binary compilation. Deployment is `wrangler deploy`.
- No per-provider API key files. Keys are managed in CF AI Gateway.
- Stateless request handling wherever possible — any Worker instance can resume any session from durable storage.

### 3. Cloudflare infrastructure as the architecture

Every subsystem maps to a Cloudflare primitive — not as an implementation detail, but as the design:

| Concern | Piccolo approach |
|---|---|
| Agent session state | Durable Objects |
| Session history | D1 |
| Config & extension registry | Workers KV |
| File/asset storage | R2 |
| LLM routing & observability | CF AI Gateway (unified API, all providers) |
| Extension distribution | Workers for Platforms dispatch namespace |
| All inter-component calls | Workers RPC (JSRPC) |
| User interfaces | Gateway Workers (Web UI, Telegram) |

### 4. JSRPC everywhere

All communication between piccolo components — core to gateway, core to extension, extension back to core — uses Cloudflare Workers RPC. There is no custom HTTP protocol, no WebSocket framing, no JSON-over-fetch between internal components. Everything is a typed `WorkerEntrypoint` or `RpcTarget` method call.

### 5. Extensions are deployed Workers, not local files

Pi extensions are `.ts` files dropped in a directory. Piccolo extensions are independent Cloudflare Workers deployed into a dispatch namespace. Installing an extension after piccolo is already running requires no core redeploy — just upload the Worker and register its name in KV.

---

## Specification

The full specification lives in [`specs/`](specs/). Start with the overview:

- [specs/overview.md](specs/overview.md) — system overview, component roles, infrastructure summary
- [specs/api.md](specs/api.md) — all public JSRPC APIs (single source of truth for interfaces)
- [specs/agent.md](specs/agent.md) — agent loop, AI Gateway integration, tool execution
- [specs/gateway.md](specs/gateway.md) — Web UI and Telegram gateways
- [specs/extension-system.md](specs/extension-system.md) — extension contract and lifecycle
- [specs/core.md](specs/core.md) — piccolo-core implementation (session storage, compaction, extension dispatch)
- [specs/data-flows.md](specs/data-flows.md) — end-to-end data flows
- [specs/infrastructure.md](specs/infrastructure.md) — deployment, bindings, CI/CD
- [specs/code.md](specs/code.md) — TypeScript standards, testing, mocking
- [specs/implementation_plan.md](specs/implementation_plan.md) — ordered implementation plan
