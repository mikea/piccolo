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

Each extension is a Cloudflare Worker deployed as a normal service and wired into core via an `EXTENSION_*` service binding. Updating extension code needs no core redeploy, but changing which extensions are enabled requires redeploying core.

---

## Screenshots

<img width="380" height="193" alt="image" src="https://github.com/user-attachments/assets/aa11ff7f-dc45-4e95-9076-51c21e16d9aa" />


---

## Extensions

The following piccolo extensions are available as part of this repository:

- [Web Gateway](gateways/web/) - browser-based UI
- [Telegram Gateway](gateways/telegram/) - telegram UI
- [Fetch Tool](extensions/fetch-tool/) - agent internet access
- [R2 Tools](extensions/r2-tool/) - set of tools to read/write/manager R2 bucket
- [Instructions](extensions/instructions/) - persistent agent instructions
- [Skills](extensions/skills/) - support for skills according to
    [open Agent Skills specification](https://agentskills.io/specification)

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

## CONTRIBUTING

### Piccolo-core

Piccolo strives to be minimal and extensible. Contributions to piccolo-core should focus on:

- simplifications
- correctness
- extensibility

This is AI code, so A LOT can be improved.

Contributions should not try to add features that can be implemented as extensions.

### Extensions

The purpose of all provided extensions is to be a testbed and be an example.
Please do not try to make them fully featured but focus on simplicity and correctness instead.

If you need some specific feature - copy the code and start your own extension.
Please share it with the community.
