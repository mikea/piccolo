# Piccolo — Key Differences from Pi

This document captures the principal design divergences that must be reflected when deriving piccolo's specification from the pi spec. It is a living reference for spec authors, not an implementation guide.

---

## 1. Minimal Core (Radical Extension-First Architecture)

**Pi:** The core ships with 6 built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`), a TUI framework, session persistence, context compaction, and multiple run modes. Extensions are additive.

**Piccolo:** The core contains only what *cannot* be moved to an extension. Every capability that can be implemented as an extension *must* be. The core's job is to:

- Define the extension API contract
- Load and dispatch to extensions
- Manage the agent loop (LLM turns, tool dispatch, event bus)
- Integrate with Cloudflare infrastructure primitives (see §3)

Consequences:
- No built-in tools in the core — file I/O, shell execution, search are all extensions
- No built-in session storage in the core — persistence is an extension concern backed by Cloudflare infrastructure
- No built-in UI in the core — TUI, web UI, and any other interface are extensions
- No built-in compaction logic in the core — compaction strategy is an extension (or a default extension that ships separately)
- Model/provider registry is an extension — no hardcoded model catalog in the core

The core exposes a minimal, stable API surface. Feature growth happens in the extension layer.

---

## 2. Runs in the Cloud

**Pi:** Designed as a local CLI binary. Configuration lives in `~/.pi/`, sessions are written to local disk, and the agent process runs on the developer's machine.

**Piccolo:** Designed to run as a cloud service on Cloudflare's platform. Key implications:

- **No local filesystem assumptions.** There is no `~/.piccolo/` directory, no local file reads/writes in the core. All state goes through cloud-native storage APIs.
- **No process-local state that must survive restarts.** Session continuity is achieved via durable storage, not in-memory buffers.
- **Stateless request handling where possible.** Each invocation should be able to reconstruct context from durable storage without relying on in-process memory across requests.
- **No binary compilation targets.** There is no `bun build --compile` step for platform-specific executables. Deployment is via Cloudflare Workers or Durable Objects.
- **No shell execution in the core.** The `bash`/exec primitives that pi bundles are not part of piccolo's core; cloud execution environments (if needed) are extension concerns.
- **Auth and secrets** come from Cloudflare Workers secrets / environment bindings, not from a local `auth.json` file.
- **Configuration** is stored in KV, R2, or D1 rather than local JSON files.

---

## 3. Full Use of Cloudflare Cloud Infrastructure

**Pi:** Uses npm workspaces, Node.js/Bun runtimes, local disk I/O (JSONL files), and standard HTTP clients. Infrastructure is generic.

**Piccolo:** Infrastructure primitives are first-class citizens, not bolted on. Specifically:

| Concern | Pi approach | Piccolo approach |
|---|---|---|
| Session / conversation storage | Local JSONL files on disk | Cloudflare Durable Objects or D1 |
| Key-value config & settings | Local JSON files in `~/.pi/` | Cloudflare Workers KV |
| Large asset / file storage | Local filesystem | Cloudflare R2 |
| Auth tokens & API keys | `auth.json` file + per-provider env vars | CF AI Gateway secrets (managed in AI Gateway, not in Workers env) |
| LLM provider integration | Custom per-provider streaming code (`piccolo-ai`) | CF AI Gateway unified `/compat` endpoint via `ai` + `ai-gateway-provider` packages |
| Compute / agent process | Local process or Docker container | Cloudflare Workers / Durable Objects |
| Scheduled / periodic tasks | Watched JSON files (pi-mom) | Cloudflare Cron Triggers |
| Real-time streaming to clients | SSE / WebSocket from local server | Cloudflare Workers streaming responses + Durable Objects for connection state |
| Extension distribution | Local `.ts`/`.js` files on disk | Independent Worker services bound to core (`EXTENSION_*`) (see §3.2) |
| Inter-component communication | In-process function calls | Workers RPC / JSRPC (see §3.1) |

The spec for piccolo must describe each subsystem in terms of these CF primitives, not in terms of local file paths or process APIs.

### 3.1 Workers RPC (JSRPC) as the Universal Communication Layer

All communication between piccolo's internal components — and between the core and extensions — uses **Cloudflare Workers RPC** (also called JSRPC). This is a JavaScript-native RPC system built into the Workers runtime that requires no custom protocol design.

**How it works:**

- A component exposes public methods by extending `WorkerEntrypoint` (for Workers) or `DurableObject` (for stateful components), or by returning objects that extend `RpcTarget`.
- Callers invoke those methods as ordinary async function calls via a service binding: `await env.SOME_SERVICE.myMethod(arg)`.
- The runtime handles serialization, transport, and deserialization transparently. All structured-cloneable types (objects, arrays, strings, numbers) pass freely. `ReadableStream` and `Response` are also supported natively, enabling LLM token streaming over RPC without custom framing.
- Functions and `RpcTarget` class instances can be passed over RPC as stubs — the recipient calls them, and execution happens back in the origin Worker. This enables callback-style APIs (e.g., passing an `onUpdate` streaming callback to a tool executor) without any custom message-passing protocol.
- **Promise pipelining**: chained calls on a stub returned by RPC can be dispatched in a single round-trip, keeping latency low for composed service calls.

**Consequences for the spec:**

- There is no custom JSON-over-HTTP or WebSocket protocol between piccolo components. All internal APIs are defined as typed `WorkerEntrypoint` or `RpcTarget` classes.
- The agent core, session store, extension host, UI gateway, and any tool workers each expose their interfaces as RPC-callable classes.
- Streaming events (LLM token deltas, tool progress updates) are carried as `ReadableStream` values over RPC, not as custom SSE or WebSocket frames at the internal layer.
- The extension API (`ExtensionAPI` equivalent) that pi passes as an in-process object is instead an `RpcTarget` stub — extensions call back to the core over RPC, and the core calls into extensions over RPC.

### 3.2 Extension Installation via Core Service Bindings

**Pi:** Extensions are `.ts`/`.js` files on the local filesystem. Adding an extension requires placing a file in `~/.pi/agent/extensions/` or a project-local `.pi/extensions/` directory and restarting the agent. Users must have write access to the host machine.

**Piccolo:** Extensions are deployed Workers and wired into `piccolo-core` through service bindings named `EXTENSION_<something>`.

**How it works:**

- Each extension is a normal Worker service (e.g. `ext-skills`, `ext-r2-tool`).
- `piccolo-core` declares one service binding per enabled extension (e.g. `EXTENSION_10_GUARD`, `EXTENSION_20_SKILLS`).
- At runtime, `ExtensionRunner` enumerates env keys prefixed `EXTENSION_`, sorts them lexicographically, and calls each binding as an `IExtension` RPC stub.
- Installing/uninstalling an extension in the core means editing `piccolo-core` service bindings and redeploying core.
- Updating extension code does not require a core redeploy as long as binding and service names are unchanged.

**Consequences for the spec:**

- Extensions are Workers, not TypeScript files. They are authored, versioned, and deployed as first-class Cloudflare Workers.
- The extension API contract (the set of RPC methods an extension must/may implement) is the primary extension specification surface.
- The enabled extension set is encoded in `piccolo-core` service bindings, not in a filesystem registry.
- There is no Jiti/in-process TypeScript evaluation. Extensions run in isolated Worker sandboxes, giving each extension its own CPU and memory limits, security boundary, and independent deployability.
- Extensions that need to call back into the core (e.g., to send a message, access session state, or invoke another tool) receive an `RpcTarget` stub from the core at invocation time, and call it over RPC.
- **Tradeoff**: changing which extensions are enabled requires a core redeploy because binding changes are part of core configuration.

---

## Summary Table

| Dimension | Pi | Piccolo |
|---|---|---|
| Built-in tools | 6 (read, bash, edit, write, grep, find) | None — all are extensions |
| UI model | TUI (pi-tui) + web components | Gateway concept — typed JSRPC surface; no TUI |
| Built-in gateways | None | Web UI gateway + Telegram gateway |
| Session storage | Local JSONL on disk | CF Durable Objects / D1 |
| Configuration | `~/.pi/` JSON files | CF Workers KV + Secrets |
| LLM provider layer | Custom per-provider code (`pi-ai` package) | CF AI Gateway unified API (`ai` + `ai-gateway-provider`) |
| LLM API keys | Per-provider env vars / `auth.json` | Managed in CF AI Gateway; `CF_AI_GATEWAY_TOKEN` only |
| Deployment target | Local binary (macOS, Linux, Windows) | CF Workers / Durable Objects |
| Extension loading | Jiti (in-process TS eval from local fs) | `EXTENSION_*` service binding discovery in core |
| Extension installation | File copy to `~/.pi/extensions/` + restart | Deploy Worker + add core service binding (core redeploy required for set changes) |
| Inter-component communication | In-process function calls | Workers RPC (JSRPC) — `WorkerEntrypoint` / `RpcTarget` classes |
| Streaming (LLM deltas, tool updates) | Custom event emitters / SSE frames | `ReadableStream` over Workers RPC |
| Core size principle | Batteries included | Minimal — everything optional is an extension |
