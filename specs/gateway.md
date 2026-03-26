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
const stream = await session.prompt("Hello", attachments);
await session.setModel("anthropic/claude-sonnet-4-5");
await session.abort();
```

See [api.md §1–2](api.md) for `IPiccoloCore` and `ISession`.

### Gateway Callback

Each gateway implements `IGatewayCallback` (see [api.md §5](api.md)) and passes a stub to the core so the core can request interactive input mid-turn (select, confirm, free-text input, notifications).

---

## Tool Gateway UI

Tools can provide custom rendering for specific gateways. A gateway calls `tool.getGatewayUI(gatewayId)` before rendering a tool call or result. The returned stub implements the gateway's UI interface. If `getGatewayUI` is absent or returns `undefined`, the gateway uses its default rendering.

See [api.md §3](api.md) for the full `ITextUI`, `IWebUI`, and `ITelegramUI` interface definitions.

### Gateway IDs

| Gateway | `gatewayId` string |
|---|---|
| Web UI | `"web"` |
| Telegram | `"telegram"` |

### Shared interface: `ITextUI`

The minimal interface any gateway can consume. Tools that do not need gateway-specific rendering implement `ITextUI` and return it for any `gatewayId`. Defined in [api.md — Shared Types](api.md).

```typescript
// What a gateway does when a tool result arrives:
const ui = await tool.getGatewayUI?.(gatewayId);
if (ui) {
  await ui.showResult(formatToolResult(result));
} else {
  // default rendering
}
```

### Gateway-specific interfaces

- **`IWebUI`** — extends `ITextUI` with `getComponent(phase)` for mounting custom React components in the browser UI. Defined in [api.md §3](api.md), detailed in [web_gateway.md](web_gateway.md).
- **`ITelegramUI`** — extends `ITextUI` with `formatCall()`, `formatResult()`, and `getInlineKeyboard()` for Telegram-native rendering. Defined in [api.md §3](api.md), detailed in [telegram_gateway.md](telegram_gateway.md).

### Resolution order

When a gateway renders a tool call or result:

1. Call `tool.getGatewayUI(gatewayId)` → stub.
2. Cast stub to the gateway-specific interface (e.g. `IWebUI`). If the required methods are present, use them.
3. Fall back to `ITextUI` methods (`showStatus`, `showResult`, `showError`) if gateway-specific methods return `undefined`.
4. Fall back to built-in default rendering if `getGatewayUI` returned `undefined` or threw.

---

## Summary

| Aspect | Web UI | Telegram |
|---|---|---|
| Transport | Cap'n Web over WebSocket (`capnweb`) | Telegram Bot API (webhook) |
| Browser→server | `IUser` / `ISession` RPC method calls | N/A |
| Server→browser events | `ReadableStream<AgentEvent>` from `session.prompt()` | Throttled `editMessageText` |
| Streaming | Stream consumed directly by browser | Throttled `editMessageText` |
| Session reference | `ISession` stub via `IUser.getSession(id)` | Chat ID → sessionId (KV) |
| Custom tool UI interface | `IWebUI` | `ITelegramUI` |
| Shared fallback UI | `ITextUI` | `ITextUI` |
| Callback UI | `IGatewayCallback` stubs (modal dialogs) | Inline keyboards |
| Auth | CF Zero Trust (Access JWT email as userId) | Bot token + KV allowlist |
