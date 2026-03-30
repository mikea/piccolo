# Extension System — Specification

Complete reference for writing, deploying, and integrating extensions in piccolo.

---

## Overview

Extensions are independent Cloudflare Workers deployed as normal services. Each extension implements `IExtensionWorker` — a typed `WorkerEntrypoint` surface defined in [api.md §8](api.md) — and is invoked by the core via JSRPC through a service binding.

There is no in-process extension loading, no TypeScript evaluation at runtime, and no filesystem scanning. The core discovers extensions by enumerating bindings named `EXTENSION_<something>` in its own environment.

All types (`IExtensionWorker`, `ISession`, `ToolDescriptor`, event and result types) are defined in [api.md](api.md).

---

## Extension Discovery

At session start, the core enumerates all env bindings whose names start with `EXTENSION_`, sorts them lexicographically by binding name, and treats each binding value as an extension worker stub.

Example:

```jsonc
"services": [
  { "binding": "EXTENSION_10_GUARD", "service": "ext-permissions" },
  { "binding": "EXTENSION_20_SKILLS", "service": "ext-skills" }
]
```

The sorted order controls extension merge precedence for "first wins" hooks.

---

## Installing / Updating / Removing

No user installation of code is required. Operators deploy each extension as a normal Worker service, then wire it into `piccolo-core`:

```bash
# Install/update extension worker
wrangler deploy --config extensions/my-extension/wrangler.jsonc

# Add binding in packages/core/wrangler.jsonc
# { "binding": "EXTENSION_MY_EXTENSION", "service": "ext-my-extension" }

# Remove by deleting the EXTENSION_* binding from core config

# Apply binding changes
wrangler deploy --config packages/core/wrangler.jsonc
```

Updating extension code does not require a core redeploy if binding and service names are unchanged.
Changing the extension set (add/remove/rename `EXTENSION_*` bindings) requires redeploying `piccolo-core`.

---

## Extension API Summary

Extensions implement any subset of `IExtensionWorker`. The core checks method existence before dispatching by probing `await stub.method` on first use, caches that decision per extension+method for the session lifetime, and silently skips unimplemented methods thereafter.

**Registration methods** (called at session start):

| Method | Purpose |
|---|---|
| `getTools()` | Declare tools the LLM can call |
| `getCommands()` | Declare `/commands` shown in gateway autocomplete |
| `getSystemPromptAdditions()` | Contribute snippets to the assembled system prompt |

**Event handlers**:

| Method | Fired when | Can return |
|---|---|---|
| `onSessionStart` | Session loaded or created | — |
| `onSessionShutdown` | Session DO evicted | — |
| `onBeforeAgentStart` | User submits prompt | `BeforeAgentStartResult` (inject messages, override system prompt) |
| `onAgentStart/End` | Agent loop starts/ends | — |
| `onTurnStart/End` | Each LLM turn | — |
| `onToolStart/End` | Tool execution lifecycle | — |
| `onContext` | Before each LLM call | `ContextResult` (replace/filter message list) |
| `onToolCall` | Before tool executes | `ToolCallResult` (block with reason) |
| `onToolResult` | After tool executes | `ToolResultOverride` (replace content/details/isError) |
| `onInput` | User types any input | `InputResult` (handle, transform, or continue) |
| `onBeforeCompact` | Before compaction | `BeforeCompactResult` (cancel or provide summary) |
| `onCompact` | After compaction | — |

---

## Use Cases and Examples

The following use cases mirror pi extension patterns, adapted for piccolo's cloud-native, JSRPC-based model. Each extension is a deployed Cloudflare Worker — no user code installation needed.

---

### 1. Permission Gates

Block or confirm dangerous tool calls before they execute.

**Mechanism:** `onToolCall` returns `{ block: true, reason }`. For interactive confirmation, the extension calls `ctx.sendUserMessage()` with a confirmation request and returns `{ block: true, reason: "Awaiting confirmation" }`, then a follow-up extension-triggered turn handles the decision.

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";

export default class PermissionGateExtension extends WorkerEntrypoint {

  async onToolCall(event, ctx) {
    // Block any d1 schema_change without explicit confirmation
    if (event.toolName === "d1" && (event.input as any).action === "schema_change") {
      const sql = (event.input as any).sql as string;
      // Store pending action in extension KV for the confirmation turn
      await this.env.PENDING_KV.put(
        `confirm:${ctx.sessionId}`,
        JSON.stringify({ sql, toolCallId: event.toolCallId }),
        { expirationTtl: 120 }
      );
      await ctx.sendUserMessage(
        `⚠️ Schema change requested:\n\`\`\`sql\n${sql}\n\`\`\`\nReply "confirm" to execute or "cancel" to abort.`
      );
      return { block: true, reason: "Awaiting user confirmation" };
    }
  }

  async onInput(event, ctx) {
    const pending = await this.env.PENDING_KV.get(`confirm:${ctx.sessionId}`);
    if (!pending) return { action: "continue" as const };

    const text = event.text.trim().toLowerCase();
    if (text === "confirm" || text === "cancel") {
      await this.env.PENDING_KV.delete(`confirm:${ctx.sessionId}`);
      if (text === "cancel") {
        await ctx.sendFollowUp("Schema change cancelled.");
        return { action: "handled" as const };
      }
      // Re-issue the blocked tool call via follow-up
      const { sql } = JSON.parse(pending);
      await ctx.sendFollowUp(
        `Schema change confirmed. Please execute: \`\`\`sql\n${sql}\n\`\`\``
      );
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  }
}
```

---

### 2. Path / Content Protection

Prevent the agent from reading or writing sensitive paths (secrets, credentials, node_modules).

```typescript
const BLOCKED_PATTERNS = [
  /\.env(\.|$)/i,
  /node_modules\//,
  /\.ssh\//,
  /credentials\.json/i,
];

export default class PathProtectionExtension extends WorkerEntrypoint {

  async onToolCall(event, ctx) {
    const path = (event.input as any)?.key ?? (event.input as any)?.path ?? "";
    if (BLOCKED_PATTERNS.some(p => p.test(path))) {
      return {
        block: true,
        reason: `Access to '${path}' is blocked by the path protection policy.`
      };
    }
  }
}
```

---

### 3. Usage Tracking / Audit Log

Record token usage and costs per session to your own D1 database.

```typescript
export default class UsageTrackerExtension extends WorkerEntrypoint {

  async onAgentEnd(event, ctx) {
    const { totalUsage } = event;
    await this.env.DB.prepare(
      `INSERT INTO usage_log (session_id, user_id, input_tokens, output_tokens, ts)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      ctx.sessionId, ctx.userId,
      totalUsage.promptTokens, totalUsage.completionTokens,
      new Date().toISOString()
    ).run();
  }
}
```

---

### 4. Custom Compaction

Replace the default LLM-based summarisation with a custom strategy (e.g., structured JSON summary, per-domain summarisation model).

```typescript
export default class CustomCompactionExtension extends WorkerEntrypoint {

  async onBeforeCompact(event, ctx) {
    // Use a cheaper / faster model for summarisation
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Summarise this conversation concisely." },
          { role: "user", content: serializeMessages(event.messages) },
        ],
      }),
    });
    const { choices } = await response.json() as any;
    return { summary: choices[0].message.content };
  }
}
```

---

### 5. Context Injection (Before-Agent-Start)

Inject dynamic context into every turn — e.g. current date/time, user preferences, project metadata fetched from an API.

```typescript
export default class ContextInjectorExtension extends WorkerEntrypoint {

  async onBeforeAgentStart(event, ctx) {
    const prefs = await this.env.USER_KV.get(`prefs:${ctx.userId}`, "json") as any;
    return {
      contextMessages: [
        {
          role: "user" as const,
          content: `[System context] Current UTC time: ${new Date().toISOString()}. User timezone: ${prefs?.timezone ?? "UTC"}. Preferred language: ${prefs?.language ?? "English"}.`,
        }
      ]
    };
  }
}
```

---

### 6. Input Transform / Rewrite

Rewrite shorthand inputs before they reach the agent. E.g., expand `?quick ...` to "Respond briefly: ...".

```typescript
export default class InputTransformExtension extends WorkerEntrypoint {

  async onInput(event, ctx) {
    if (event.text.startsWith("?quick ")) {
      return {
        action: "transform" as const,
        text: `Respond briefly and concisely: ${event.text.slice(7)}`,
      };
    }
    if (event.text.startsWith("?strict ")) {
      return {
        action: "transform" as const,
        text: `${event.text.slice(8)}\n\nIMPORTANT: Be strictly accurate. No speculation.`,
      };
    }
    return { action: "continue" as const };
  }
}
```

---

### 7. Stateful Tools (Persistent Todo List)

Tools that maintain per-session state across turns by reading and writing custom entries.

```typescript
export default class TodoExtension extends WorkerEntrypoint {

  static todoDescriptor = {
    name: "todo",
    label: "Todo List",
    description: "Manage a persistent todo list for this session. Actions: list, add, complete, delete.",
    promptSnippet: "Manage a persistent per-session todo list",
    inputSchema: {
      oneOf: [
        { type: "object", additionalProperties: false, properties: { action: { const: "list" } }, required: ["action"] },
        { type: "object", additionalProperties: false, properties: { action: { const: "add" }, item: { type: "string" } }, required: ["action", "item"] },
        { type: "object", additionalProperties: false, properties: { action: { const: "complete" }, item: { type: "string" } }, required: ["action", "item"] },
        { type: "object", additionalProperties: false, properties: { action: { const: "delete" }, item: { type: "string" } }, required: ["action", "item"] },
      ],
    },
  };

  async getTools() { return [TodoExtension.todoDescriptor]; }

  async execute(toolCallId, params, ctx) {
    // Rebuild state from custom entries (survives compaction since entries are in the session tree)
    const entries = await ctx.getEntries("todo");
    let items: Array<{ text: string; done: boolean }> = [];
    for (const e of entries) {
      items = (e.data as any).items;
    }

    if (params.action === "list") {
      const text = items.length === 0
        ? "Todo list is empty."
        : items.map((i, n) => `${n + 1}. [${i.done ? "x" : " "}] ${i.text}`).join("\n");
      return { content: [{ type: "text" as const, text }], details: { items } };
    }

    if (params.action === "add") {
      items = [...items, { text: params.item, done: false }];
    } else if (params.action === "complete") {
      items = items.map(i => i.text === params.item ? { ...i, done: true } : i);
    } else if (params.action === "delete") {
      items = items.filter(i => i.text !== params.item);
    }

    // Persist new state
    await ctx.appendCustomEntry("todo", { items });
    return { content: [{ type: "text" as const, text: `Todo list updated.` }], details: { items } };
  }
}
```

---

### 8. External Integration / Webhook Trigger

Post a Slack notification or trigger a CI pipeline when the agent finishes a turn.

```typescript
export default class SlackNotifierExtension extends WorkerEntrypoint {

  async onAgentEnd(event, ctx) {
    const lastAssistant = [...event.messages].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return;

    const text = (lastAssistant.content as any[])
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("")
      .slice(0, 200);

    await fetch(this.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `*Piccolo session update* (${ctx.sessionId.slice(0, 8)})\n${text}…`,
      }),
    });
  }
}
```

---

### 9. System Prompt Contribution

Inject a standing system prompt section — e.g., company coding standards, user persona, tool-specific guidelines.

```typescript
export default class CodingStandardsExtension extends WorkerEntrypoint {

  async getSystemPromptAdditions(ctx) {
    const standards = await this.env.STANDARDS_KV.get("coding-standards");
    if (!standards) return;
    return [
      {
        section: "guidelines" as const,
        content: `## Coding Standards\n\n${standards}`,
        priority: 50,
      }
    ];
  }
}
```

---

### 10. Slash Command (Gateway Autocomplete + Input Handler)

Register a custom slash command that appears in gateway autocomplete and is handled in `onInput`.

```typescript
export default class HelpExtension extends WorkerEntrypoint {

  async getCommands(ctx) {
    return [
      { name: "help", description: "Show available piccolo commands and tips" },
      { name: "status", description: "Show current model, context usage, and session info" },
    ];
  }

  async onInput(event, ctx) {
    if (event.commandName === "status") {
      const [model, usage] = await Promise.all([ctx.getModel(), ctx.getContextUsage()]);
      const text = [
        `Model: ${model.label}`,
        `Context: ${Math.round(usage.usedFraction * 100)}% (${usage.inputTokens} / ${usage.contextWindowTokens} tokens)`,
        `Session: ${await ctx.getName() ?? ctx.sessionId}`,
      ].join("\n");
      await ctx.appendCustomMessage("status-reply", text, true);
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  }
}
```

---

### 11. Model-Switching on Input

Automatically switch the active model based on prompt content (e.g., prefer a reasoning model for hard problems).

```typescript
const REASONING_TRIGGER = /\b(prove|derive|formal(ly)?|step.by.step|reason through)\b/i;

export default class ModelRouterExtension extends WorkerEntrypoint {

  async onInput(event, ctx) {
    if (REASONING_TRIGGER.test(event.text)) {
      await ctx.setModel("anthropic/claude-opus-4-5");
    }
    return { action: "continue" as const };
  }
}
```

---

### 12. JSRPC-Exposed Extension Endpoints

Extensions can expose additional JSRPC methods beyond `IExtensionWorker` — gateways or other extensions can call these directly via service bindings. This is how extensions provide rich capabilities without users installing anything.

```typescript
export default class SearchExtension extends WorkerEntrypoint {

  // Standard IExtensionWorker tools
  async getTools() { return [SearchExtension.searchDescriptor]; }
  async execute(toolCallId, params, ctx) { /* ... */ }

  // Additional JSRPC endpoint — callable from gateways or other extensions
  // e.g.: env.EXTENSION_SEARCH.suggest(prefix)
  async suggest(prefix: string): Promise<string[]> {
    const results = await this.env.SEARCH_INDEX.list({ prefix });
    return results.keys.map(k => k.name).slice(0, 10);
  }
}
```

Gateways call extra methods to power autocomplete, dashboards, or admin UIs without going through the agent core.

---

## Extension Bindings

Each extension declares its own Cloudflare bindings in its own `wrangler.template.jsonc`. The core does not share its bindings. Extensions that need storage (KV, D1, R2) must provision their own.

The `ISession` stub gives extensions a controlled API into the core session — they cannot access core internals directly.

---

## Provided Extensions

| Extension | Spec | Purpose |
|---|---|---|
| Skills | [skills_extension.md](skills_extension.md) | Load skills from URLs; register `/skill:name` commands |
| Prompt Templates | [prompt_templates_extension.md](prompt_templates_extension.md) | Load templates from URLs; register `/template:name` commands |
| Instructions | [instructions_extension.md](instructions_extension.md) | Persistent instructions scoped by everyone/user/session, appended to system prompt |
