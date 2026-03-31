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
 ├── getDescriptor() → ToolDescriptor      ← pure data, no logic
 │     ├── name
 │     ├── label
 │     ├── description
 │     ├── promptSnippet?
 │     ├── promptGuidelines?
 │     └── inputSchema (JSON Schema)
 └── execute(toolCallId, params, ctx, signal) → ToolResult
```

**`ToolDescriptor`** is static and logic-free. It describes the tool to the LLM (via the system prompt) and to the piccolo core (for registration and schema generation). It carries no behaviour.

**`execute`** is where all logic lives. The core calls it with params validated by the AI SDK against `descriptor.inputSchema`.

### Minimal example

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ITool, ISession, ToolDescriptor, ToolResult } from "@piccolo/api";

export default class GreetTool extends WorkerEntrypoint implements ITool {

  async getDescriptor(): Promise<ToolDescriptor> {
    return {
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
  }

  async execute(
    toolCallId: string,
    params: { name: string },
    ctx: ISession,
    signal?: { isAborted(): Promise<boolean> },
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

## Tool Output in Gateways

Tools are currently non-interactive. Return clear `content` text/image parts from `execute()`. Gateways render those parts directly.

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

Tools are deployed as extension Workers and bound to `piccolo-core` via `EXTENSION_*` service bindings:

```bash
# 1. Deploy the tool Worker
wrangler deploy --name ext-my-tool

# 2. Add a core service binding (packages/core/wrangler.jsonc)
# { "binding": "EXTENSION_MY_TOOL", "service": "ext-my-tool" }

# 3. Re-deploy core so binding changes apply
wrangler deploy --config packages/core/wrangler.jsonc
```

Updating tool code needs no core redeploy as long as service and binding names stay unchanged. Changing enabled tool bindings requires a core redeploy. See [extension-system.md](extension-system.md) for the full lifecycle.

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
- [ ] `specs/overview.md` document index is updated.
