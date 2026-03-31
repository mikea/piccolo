# Telegram Gateway — Specification

Exposes piccolo as a Telegram bot via webhook.

Gateway ID: `"telegram"`

See [gateway.md](gateway.md) for the general gateway contract.

---

## Current Scope (Phase 1)

This document describes the currently implemented baseline gateway.

Implemented:

- text messages only
- one `TelegramSessionDO` per Telegram chat (`telegram-chat:{chatId}`)
- one persistent piccolo session per telegram user id (created/resolved by the DO)
- send assistant text to Telegram after `ITurn.complete()`
- typing indicator while a turn is running
- static allowlist from Wrangler config (`ALLOWED_TELEGRAM_USER_IDS`)

Not implemented yet (future phases):

- Telegram commands (`/new`, `/model`, etc.)
- attachments/media ingestion
- inline keyboards / `callback_query`
- gateway callback UI (`IGatewayCallback`)
- tool interactivity/UI customisation

Telegram-specific session contract is local to the gateway package (not `@piccolo/api`):

- `gateways/telegram/src/api.ts` (`ITelegramSession extends ISession`)

---

## Deployment

- Cloudflare Worker registered as a Telegram bot webhook handler
- Service binding to `piccolo-core` (`env.CORE: IPiccoloCore`)
- Durable Object binding (`env.TELEGRAM_SESSION`) to `TelegramSessionDO`
- Secret: `TELEGRAM_BOT_TOKEN`
- Var: `ALLOWED_TELEGRAM_USER_IDS` (JSON array of numeric Telegram user IDs)
- Var: `TELEGRAM_BOT_FIRST_NAME` (used for preloaded bot identity in runtime)
- Var: `TELEGRAM_BOT_USERNAME` (used for preloaded bot identity in runtime)

---

## Webhook Handler

```
POST /webhook/{token-hash}
```

`token-hash` is derived from `TELEGRAM_BOT_TOKEN` as:

- `sha256(token)` (hex)
- first 32 hex chars used in the webhook path

Requests to any other path return `404`.

Handled `Update` types:

| Update type | Action |
|---|---|
| `message` (text) | Allowlist check, resolve `TelegramSessionDO` for chat, call `initialize(...)` then `processIncomingText(text)` |
| all others | Ignored |

Users not present in `ALLOWED_TELEGRAM_USER_IDS` are ignored (no reply).

---

## Telegram Session DO Lifecycle

One `TelegramSessionDO` is maintained per Telegram chat (`idFromName("telegram-chat:{chatId}")`).

`TelegramSessionDO` implements `ITelegramSession extends ISession` from `gateways/telegram/src/api.ts`:

```
interface ITelegramSession extends ISession {
  sendMessage(text: string): Promise<void>;
  changeStatus(status: "typing" | "idle"): Promise<void>;
}
```

Gateway-only methods (not part of `ITelegramSession`) drive immutable setup and ingress:

- `initialize({ telegramUserId, telegramChatId, piccoloUserId })`
- `processIncomingText(text)`

`initialize(...)` is called before the first prompt and must be idempotent with the same parameters; re-binding with different values is rejected.

During `initialize(...)`, the DO resolves and stores the core `ISession` for subsequent calls.

The DO is responsible for:

- creating/restoring the underlying core `ISession` for the telegram user
- serialising per-chat inbound messages
- awaiting `ITurn.complete()` and translating the returned `TurnResult` into Telegram messages

---

## Turn Completion → Telegram Messages

`TelegramSessionDO` starts a turn with `session.prompt(text)`, then awaits `turn.complete()`.

- success result (`{ messages }`): send assistant text extracted from returned messages
- error result (`{ type: "error", message }`): send a single error line

While waiting for completion, `TelegramSessionDO` sends `sendChatAction("typing")` every 4 s.

Message length:

- assistant text is split to Telegram 4096-char chunks and sent with `sendMessage`

All output is sent as plain text (no Markdown parse mode).
