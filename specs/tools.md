# Tools — Specification

Tools are the primary mechanism through which the LLM takes action. This document specifies the tool authoring contract (`ITool` / `ToolDescriptor`), the execution lifecycle, and the checklist for adding new tools. Individual tool specs live in their own files.

---

## Provided Tools

Piccolo has no built-in tools — the core ships with zero tools. The following tools are provided as ready-to-deploy extension Workers:

| Tool | Spec | Purpose |
|---|---|---|
| R2 | [r2_tool.md](r2_tool.md) | Read/write files in a Cloudflare R2 bucket |
| D1 | [d1_tool.md](d1_tool.md) | Query and modify a Cloudflare D1 (SQLite) database |
| Fetch | [fetch_tool.md](fetch_tool.md) | Make HTTP requests to the public internet via `fetch()` |

---

## Tool Contract: `ITool` and `ToolDescriptor`

Every piccolo tool is a Cloudflare Worker that extends `WorkerEntrypoint` and implements the `ITool` interface. All types are defined in [api.md — Shared Types](api.md).

```
ITool
 ├── descriptor: ToolDescriptor      ← pure data, no logic
 │     ├── name
 │     ├── label
 │     ├── description
 │     ├── promptSnippet?
 │     ├── promptGuidelines?
 │     └── inputSchema (JSON Schema)
 ├── execute(toolCallId, params, ctx, signal) → ToolResult
 └── getGatewayUI?(gatewayId) → ITextUI | undefined   ← optional
```

**`ToolDescriptor`** is static and logic-free. It describes the tool to the LLM (via the system prompt) and to the piccolo core (for registration and schema generation). It carries no behaviour.

**`execute`** is where all logic lives. The core calls it with params validated by the AI SDK against `descriptor.inputSchema`.

**`getGatewayUI`** is optional. When present, gateways call it before rendering a tool call or result to get a custom UI stub. See [Gateway UI Integration](#gateway-ui-integration) below.

### Minimal example

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ITool, ToolDescriptor, ToolResult, IExtensionContext } from "piccolo-core";

export default class GreetTool extends WorkerEntrypoint implements ITool {

  readonly descriptor: ToolDescriptor = {
    name: "greet",
    label: "Greet",
    description: "Greet a person by name. Returns a greeting string.",
    promptSnippet: "Greet a user by name",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "The name to greet" },
      },
      required: ["name"],
    },
  };

  async execute(
    toolCallId: string,
    params: { name: string },
    ctx: IExtensionContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { name: params.name },
    };
  }
}
```

---

## `ToolResult`

Defined in [api.md — Shared Types](api.md):

```typescript
interface ToolResult {
  // Sent to the LLM as the tool result.
  content: Array<
    | { type: "text";  text: string }
    | { type: "image"; data: string; mimeType: string }
  >;

  // Stored in the session entry for gateway UI rendering. NOT sent to the LLM.
  // Define a tight per-tool type for this field.
  details?: unknown;

  // Prefer throwing from execute() — the core sets isError: true automatically.
  isError?: boolean;
}
```

---

## Gateway UI Integration

Tools can provide custom rendering for specific gateways by implementing `getGatewayUI(gatewayId)`. The gateway calls this method before rendering a tool call or result. The returned stub implements the gateway's UI interface. Returning `undefined` causes the gateway to use its default rendering.

Gateway IDs and their UI interfaces:

| `gatewayId` | Interface | Spec |
|---|---|---|
| `"web"` | `IWebUI extends ITextUI` | [web_gateway.md](web_gateway.md) |
| `"telegram"` | `ITelegramUI extends ITextUI` | [telegram_gateway.md](telegram_gateway.md) |
| any | `ITextUI` | [api.md §3](api.md) |

### `ITextUI` — shared minimal interface

For tools that want consistent text rendering across all gateways:

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ITool, ITextUI, GatewayId } from "piccolo-core";

class MyToolUI extends RpcTarget implements ITextUI {
  async showStatus(text: string) { /* stored for gateway to poll */ }
  async showResult(text: string) { /* stored for gateway to display */ }
  async showError(text: string)  { /* stored for gateway to display as error */ }
}

export default class MyTool extends WorkerEntrypoint implements ITool {
  // ...descriptor and execute...

  async getGatewayUI(gatewayId: GatewayId): Promise<ITextUI | undefined> {
    return new MyToolUI();   // same text UI for all gateways
  }
}
```

### `IWebUI` — custom React component

For tools that want a rich browser experience (file trees, tables, charts, etc.):

```typescript
import type { IWebUI, WebComponentDescriptor } from "piccolo-core";

class R2ToolWebUI extends RpcTarget implements IWebUI {
  constructor(private result: R2ListDetails) { super(); }

  async showStatus(text: string) { /* no-op for web, component handles it */ }
  async showResult(text: string) { /* fallback if component fails to load */ }
  async showError(text: string)  { /* show error in component slot */ }

  async getComponent(phase: "call" | "result"): Promise<WebComponentDescriptor | undefined> {
    if (phase === "result") {
      return {
        componentId: "r2-file-tree",
        props: { objects: this.result.objects, prefixes: this.result.prefixes },
      };
    }
    return undefined;  // default text rendering for the call phase
  }
}
```

### `ITelegramUI` — custom Telegram formatting

For tools that produce output better expressed as Telegram-native formatting or actionable inline keyboards:

```typescript
import type { ITelegramUI, TelegramInlineKeyboard } from "piccolo-core";

class D1ToolTelegramUI extends RpcTarget implements ITelegramUI {
  constructor(private rows: Record<string, unknown>[]) { super(); }

  async showStatus(text: string) {}
  async showResult(text: string) {}
  async showError(text: string)  {}

  async formatCall(toolName: string, input: unknown): Promise<string | undefined> {
    return `🗄 *Querying database*\n\`${(input as any).sql}\``;
  }

  async formatResult(toolName: string, output: unknown, isError: boolean): Promise<string | undefined> {
    if (isError) return undefined;  // let showError handle it
    return `✅ *${this.rows.length} rows returned*`;
  }

  async getInlineKeyboard(toolName: string, output: unknown): Promise<TelegramInlineKeyboard | undefined> {
    return undefined;  // no inline keyboard for query results
  }
}
```

---

## Error Signalling

Throw from `execute()` to signal failure. Do not set `isError: true` manually.

```typescript
async execute(toolCallId, params, ctx, signal) {
  const obj = await this.env.BUCKET.get(params.key);
  if (!obj) throw new Error(`Not found: ${params.key}`);  // ← correct
  return { content: [{ type: "text", text: await obj.text() }] };
}
```

The core catches thrown errors, wraps them as `isError: true` results, and sends them to the LLM so it can respond accordingly.

---

## Streaming Progress

For long-running tools, call `ctx.onUpdate()` to emit intermediate `tool_update` events to gateways. Users see live progress.

```typescript
async execute(toolCallId, params, ctx, signal) {
  ctx.onUpdate?.({ content: [{ type: "text", text: "Scanning rows..." }] });
  const rows = await runQuery(params.sql, signal);
  ctx.onUpdate?.({ content: [{ type: "text", text: `Found ${rows.length} rows, formatting...` }] });
  return {
    content: [{ type: "text", text: formatRows(rows) }],
    details: { rowCount: rows.length },
  };
}
```

---

## Tool Bindings

Each tool Worker declares its own Cloudflare bindings (R2, D1, KV, etc.) in its own `wrangler.template.jsonc`. The core does not share its bindings with tools. Tools are fully isolated Workers with independent resource allocation.

---

## Deployment

Tools are deployed as extension Workers into the piccolo dispatch namespace:

```bash
# 1. Deploy the tool Worker
wrangler deploy --name ext-my-tool \
  --dispatch-namespace piccolo-extensions

# 2. Register in KV
wrangler kv key put --binding CONFIG \
  extensions:registry '["ext-my-tool", "ext-existing"]'
```

No core redeploy is needed. See [extension-system.md](extension-system.md) for the full lifecycle.

---

## Writing Effective Descriptors

The LLM reads `description` verbatim before deciding whether and how to call a tool. Write it as if it is the only documentation the LLM will ever see for that tool.

**`description`:**
- Describe every `action` variant (if the tool is action-based).
- Document parameter semantics, defaults, and constraints.
- State what is returned in `content[0].text`.
- Call out gotchas (e.g. "delete is irreversible", "requires confirm: true").

**`promptSnippet`:**
- One line. Verb-first. E.g. "Read, write, and list files in R2 storage."
- Appears in the "Available tools" section of the system prompt.

**`promptGuidelines`:**
- Bullet points added to the system prompt "Guidelines" section.
- One bullet per non-obvious rule (sequencing, safety, preferred patterns).

---

## Checklist for a New Tool

Before shipping a tool spec or implementation, verify:

- [ ] `name` is unique, snake_case, concise.
- [ ] `description` covers all actions, parameters, return values, and error conditions.
- [ ] `promptSnippet` is one verb-first line.
- [ ] `promptGuidelines` has at least one bullet per non-obvious usage rule.
- [ ] A tight `details` type is defined for every action, documenting what gets stored in the session.
- [ ] All error conditions throw an `Error` with a human-readable message.
- [ ] No user-supplied values are interpolated into SQL, object keys, or shell commands without validation.
- [ ] A spec file exists in `specs/` (named `{tool}_tool.md`) before or alongside the implementation.
- [ ] The tool is listed in the table at the top of this file.
- [ ] If the tool produces structured output (tables, file lists, charts): `IWebUI.getComponent()` is implemented.
- [ ] If the tool produces Telegram-relevant output: `ITelegramUI.formatResult()` is implemented.
- [ ] `specs/overview.md` document index is updated.
