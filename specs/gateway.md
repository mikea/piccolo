# Gateway — Specification

## Purpose

A **gateway** is piccolo's concept for a user-facing interface. It is the boundary between a human user (or an external messaging system) and the piccolo agent core. The agent core knows nothing about how a user connects; it exposes a typed JSRPC surface. Gateways implement that surface on behalf of a specific interaction channel — web browser, Telegram bot, Slack, CLI, etc.

There is no TUI in piccolo. All user interaction goes through gateways.

---

## Gateway Specifications

Two gateways are specified. Each has its own document:

| Gateway | ID | Document |
|---|---|---|
| Web UI | `"web"` | [web_gateway.md](web_gateway.md) |
| Telegram | `"telegram"` | [telegram_gateway.md](telegram_gateway.md) |

Additional gateways (Slack, CLI, REST API, etc.) can be added without modifying the core. Each gateway is an independent Cloudflare Worker.

---

## Gateway Contract

A gateway is a Cloudflare Worker that connects two JSRPC surfaces:

1. **Inbound** — accepts input from the user's channel and translates it into calls on `IPiccoloCore` / `ISession`.
2. **Outbound** — receives `AgentEvent` streams from the core and translates them into the channel's output format.

All types referenced below are defined in [api.md](api.md).

### Calling the Core

Gateways call `IPiccoloCore` to obtain `ISession` stubs, then call methods on the session directly:

```typescript
// Obtain the core via service binding
const core: IPiccoloCore = env.CORE;

// Create or retrieve a session
const session: ISession = await core.newSession({ name: "My session" });
// or
const session: ISession = await core.getSession(storedSessionId);

// All per-session operations are on the ISession stub
const turn = await session.prompt("Hello", attachments);
await session.setModel("anthropic/claude-sonnet-4-5");
const currentTurn = await session.getCurrentTurn();
await currentTurn?.abort();
```

See [api.md §1–2](api.md) for `IPiccoloCore` and `ISession`.

### Gateway Callback

Each gateway implements `IGatewayCallback` (see [api.md §5](api.md)) and passes a stub to the core so the core can request interactive input mid-turn (select, confirm, free-text input, notifications).

---

## Tool Output

Tools are currently non-interactive. Gateways render `ToolResult.content` directly and do not call any tool UI interfaces.

---

## Summary

| Aspect | Web UI | Telegram |
|---|---|---|
| Transport | Cap'n Web over WebSocket (`capnweb`) | Telegram Bot API (webhook) |
| Browser→server | `IUser` / `ISession` RPC method calls | N/A |
| Server→browser events | `ReadableStream<AgentEvent>` from `session.prompt()` | Throttled `editMessageText` |
| Streaming | Stream consumed directly by browser | Throttled `editMessageText` |
| Session reference | `ISession` stub via `IUser.getSession(id)` | `TelegramSessionDO` (`ITelegramSession` extends `ISession`) |
| Tool output mode | `ToolResult.content` text/image rendering | `ToolResult.content` text rendering |
| Callback UI | `IGatewayCallback` stubs (modal dialogs) | Not implemented in Phase 1 |
| Auth | CF Zero Trust (Access JWT email as userId) | Bot token + allowlist var |
