# Telegram Gateway — Specification

Exposes piccolo as a Telegram bot. Each Telegram chat maps to a piccolo session. Supports custom tool message formatting via `ITelegramUI`.

Gateway ID: `"telegram"`

See [gateway.md](gateway.md) for the general gateway contract.

---

## Deployment

- Cloudflare Worker registered as a Telegram bot webhook handler
- Service binding to `piccolo-core` (`env.CORE: IPiccoloCore`)
- Chat→session mapping in Workers KV (`env.KV`)
- Per-chat serialisation state in `ITelegramChatDO` (one DO per Telegram chat)
- Secrets: `TELEGRAM_BOT_TOKEN`

---

## `ITelegramUI` — Tool UI Interface

Defined in [api.md §3](api.md). Tools return an `ITelegramUI` stub from `getGatewayUI("telegram")` to provide custom Telegram message formatting.

```typescript
interface ITelegramUI extends ITextUI {
  // Return custom MarkdownV2 text for the in-progress tool call message.
  // Called when tool_start arrives. Return undefined for default "⚙️ Running: {toolName}".
  formatCall(toolName: string, input: unknown): Promise<string | undefined>;

  // Return custom MarkdownV2 text for the completed tool result message.
  // Called when tool_end arrives. Return undefined to fall back to ITextUI.showResult().
  formatResult(toolName: string, output: unknown, isError: boolean): Promise<string | undefined>;

  // Return an inline keyboard to attach to the result message.
  // Useful for tools that produce actionable output (e.g. approve/reject, pagination).
  // Return undefined for no inline keyboard.
  getInlineKeyboard(
    toolName: string,
    output: unknown,
  ): Promise<TelegramInlineKeyboard | undefined>;
}

interface TelegramInlineKeyboard {
  rows: Array<Array<{
    text: string;          // Button label
    callbackData: string;  // Opaque string returned in callback_query
  }>>;
}
```

### Fallback chain

```
ITelegramUI.formatResult(toolName, output, isError)
  → string          → send as MarkdownV2 message
  → undefined       → ITextUI.showResult(text) → send as plain text
  → getGatewayUI absent → default "✅ {toolName} completed" / "❌ {toolName} failed"
```

---

## `ITelegramChatDO`

Defined in [api.md §7](api.md). One Durable Object per Telegram chat. Responsibilities:

- Serialises concurrent Telegram updates for the same chat (Telegram may deliver multiple updates in parallel)
- Tracks the active turn; queues incoming messages as follow-ups if a turn is in progress
- Holds the `message_id` of the typing indicator for subsequent edits

---

## Webhook Handler

```
POST /webhook/{bot-token-hash}
```

The `bot-token-hash` is a HMAC of the bot token, validated server-side against `env.TELEGRAM_BOT_TOKEN` to prevent spoofed webhooks.

Handled `Update` types:

| Update type | Action |
|---|---|
| `message` (text) | Resolve session, call `session.prompt(text)`, consume via `ITurn.getStream()` |
| `message` (photo/document) | Download, store to R2 as attachment, `session.prompt(caption, [attachment])`, consume via `ITurn.getStream()` |
| `message` (/command) | Handle as gateway command (see below) |
| `callback_query` | Route to active `ITelegramChatDO` for inline keyboard handling |
| `edited_message` | Ignored |
| `channel_post` | Ignored |

All update handling is routed through `ITelegramChatDO.handleUpdate()` to ensure serialisation per chat.

---

## Chat → Session Mapping

```
On first message from chatId:
  session = await core.newSession({ name: "Telegram chat {chatId}" })
  await kv.put(`tg:chat:${chatId}`, JSON.stringify({ sessionId: await session.id(), createdAt: Date.now() }))

On subsequent messages:
  { sessionId } = JSON.parse(await kv.get(`tg:chat:${chatId}`))
  session = await core.getSession(sessionId)
  const turn = await session.prompt(text, attachments?)
  const stream = await turn.getStream()
```

KV key: `tg:chat:{chatId}` → `{ sessionId: string; createdAt: number }`

---

## Streaming → Telegram Messages

Telegram does not support true streaming. The gateway adapts `AgentEvent` to Telegram messages:

| Event | Action |
|---|---|
| `agent_start` | Send `sendMessage("…")` as typing indicator; record `message_id` |
| `text_delta` | Accumulate text; call `editMessageText` at most once per 2 s (rate limit) |
| `reasoning_delta` | Accumulate separately; omit from output by default (opt-in setting shows as blockquote) |
| `tool_start` | Call `ITelegramUI.formatCall()` or default `"⚙️ Running: {toolName}"`; send or edit |
| `tool_end` | Call `ITelegramUI.formatResult()` or default summary; attach `getInlineKeyboard()` result |
| `agent_end` | Final `editMessageText` with complete assistant text; delete typing indicator |
| `error` | Edit indicator to `"❌ {message.error}"` |

**Message splitting:** If the final accumulated text exceeds 4096 characters, split into multiple sequential `sendMessage` calls.

**Formatting:** All assistant text is sent with `parse_mode: "MarkdownV2"`. Piccolo escapes all special characters (`_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`) before sending. Code blocks use triple-backtick syntax.

---

## Gateway Callback UI

When the core invokes `IGatewayCallback`:

| Method | Telegram implementation |
|---|---|
| `requestSelect(title, options, multiple?)` | Send message with inline keyboard (one button per option); suspend until `callback_query` arrives; answer and delete keyboard; return selected value(s) |
| `requestConfirm(title, message)` | Send message with "Yes" / "No" inline keyboard; suspend; return boolean |
| `requestInput(title, placeholder?)` | Send prompt message; suspend; next plain-text message from user is the response |

While suspended waiting for user response, further incoming messages from the same chat are queued in `ITelegramChatDO` and processed after the response is received.

---

## Inline Keyboard Callback Routing

Inline keyboard `callbackData` follows the format `piccolo:{toolName}:{opaque}`. On `callback_query`:

1. Validate the `callbackData` prefix.
2. Answer the `callback_query` immediately (Telegram requires this within 10 s).
3. Route to the active `ITelegramChatDO` for handling.
4. The DO resolves the pending `getInlineKeyboard` promise with the selected `callbackData`.

---

## Gateway-Level Slash Commands

Telegram `/commands` are handled by the gateway and not forwarded to the agent core:

| Command | Action |
|---|---|
| `/new` | `core.newSession()`, update KV mapping, confirm to user |
| `/model <id>` | `session.setModel(id)`, confirm to user |
| `/models` | `core.listModels()`, reply with list |
| `/abort` | `session.abort()`, confirm to user |
| `/status` | `session.getModel()` + `session.getContextUsage()`, reply with model + token usage |
| `/compact` | `session.compact()`, confirm to user |
| `/help` | Reply with list of available commands and descriptions |

---

## Auth

- Bot token stored in `TELEGRAM_BOT_TOKEN` Workers Secret.
- User-level allowlist in KV: `tg:allowed:{userId}` → `"true"`. Checked on every update.
- Users not on the allowlist receive a static "Access denied" reply; the update is otherwise ignored.
- Allowlist management is out of scope for piccolo core (handled by ops tooling or a future admin extension).
