# piccolo

An AI agent running on Cloudflare.

Inspired by [pi](https://github.com/badlogic/pi-mono), a capable local AI agent by Mario Zechner.

AI-implemented, human-steered.

---

## Design Principals

### Minimal core

The core does four things:

- run the agent loop with tools support
- persist state
- define the extension API
- dispatch to extensions

No built-in tools. No built-in UI.

### Cloudflare as the architecture

Cloud-native.
Fully embrace Cloudflare Workers platform.

### JSRPC everywhere

All communications use jsrpc/capnweb

### Extensions are Workers

Each extension is a Cloudflare Worker deployed into a dispatch namespace. Adding or updating an extension requires no core redeploy.

---

## Deploy

See [DEPLOY.md](DEPLOY.md).

---

## Specification

- [specs/overview.md](specs/overview.md) — system overview and component roles
- [specs/api.md](specs/api.md) — all public JSRPC interfaces
- [specs/core.md](specs/core.md) — piccolo-core internals
- [specs/agent.md](specs/agent.md) — agent loop and AI Gateway integration
- [specs/web_gateway.md](specs/web_gateway.md) — web UI gateway
- [specs/extension-system.md](specs/extension-system.md) — extension contract
- [specs/infrastructure.md](specs/infrastructure.md) — deployment and bindings
- [specs/implementation_plan.md](specs/implementation_plan.md) — implementation plan
