# Prompt Templates Extension — Specification

The prompt templates extension loads Markdown snippet templates from a configurable list of URLs and makes them available as `/template:{name}` commands. Templates expand into full prompts with argument substitution before being sent to the agent.

---

## What is a Prompt Template?

A prompt template is a Markdown file containing a reusable prompt pattern. The user types `/template:{name}` (with optional arguments) in any gateway, the extension expands the template — substituting argument placeholders — and the resulting text becomes the user message sent to the agent.

Templates support positional arguments (`$1`, `$2`, `$@`) identically to the pi prompt-templates standard.

---

## Extension Worker

**Name:** `ext-templates`  
**Implements:** `IExtensionWorker` (see [api.md §8](api.md))  
**Bindings required:** KV for cache (`env.TEMPLATES_CACHE`)

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-templates",
  "kv_namespaces": [
    { "binding": "TEMPLATES_CACHE", "id": "..." }
  ],
  "vars": {
    // JSON array of template source URLs stored here or in KV for runtime reconfiguration
    "TEMPLATE_SOURCES": "[]"
  }
}
```

---

## Template Sources

Templates are loaded from a **source list** — a JSON array of URLs stored in `TEMPLATES_CACHE:config:sources` (KV), falling back to the `TEMPLATE_SOURCES` env var. Each entry is one of:

| Source type | URL format | Description |
|---|---|---|
| Single template | `https://.../review.md` | Loads a single template file |
| Index file | `https://.../templates.json` | JSON array of `{ name, url }` pointing to individual `.md` files |
| GitHub repo root | `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/` | Fetches a `templates.json` index from that root |

### Source list management (JSRPC)

```typescript
await env.EXTENSIONS.get("ext-templates").addSource("https://example.com/templates.json");
await env.EXTENSIONS.get("ext-templates").removeSource("https://example.com/templates.json");
await env.EXTENSIONS.get("ext-templates").listSources();    // → string[]
await env.EXTENSIONS.get("ext-templates").reloadTemplates(); // force re-fetch
```

---

## Template Document Format

Each template is a `.md` file. The filename (without `.md`) is the template name.

```markdown
---
description: Review staged git changes for bugs, security issues, and style
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Error handling gaps
- Code style consistency
```

### Frontmatter

| Field | Required | Description |
|---|---|---|
| `description` | No | One-line description shown in gateway autocomplete and `/help`. If absent, the first non-empty line of content is used. |

Unknown frontmatter fields are ignored.

### Template Name

The template name is the URL path filename without the `.md` extension:

- `review.md` → `review` → command `/template:review`
- `component-scaffold.md` → `component-scaffold` → command `/template:component-scaffold`

Name rules:
- Lowercase letters, digits, hyphens
- No leading/trailing hyphens
- No consecutive hyphens
- Templates with name collisions: first occurrence wins, warn on subsequent

---

## Argument Substitution

Templates support the same argument syntax as the pi prompt-templates standard:

| Placeholder | Meaning |
|---|---|
| `$1`, `$2`, ... | Positional arguments (1-indexed) |
| `$@` or `$ARGUMENTS` | All arguments joined with a space |
| `${@:N}` | Arguments from position N onward (1-indexed) |
| `${@:N:L}` | `L` arguments starting at position N |

### Example template: `component.md`

```markdown
---
description: Scaffold a new React component with specified features
---
Create a React component named $1.

Features to implement:
$@

Requirements:
- TypeScript with strict types
- Export as named export
- Include a basic story for Storybook
```

Invocation: `/template:component Button "onClick handler" "disabled state" "loading spinner"`

Expands to:

```
Create a React component named Button.

Features to implement:
onClick handler disabled state loading spinner

Requirements:
- TypeScript with strict types
- Export as named export
- Include a basic story for Storybook
```

### Argument parsing rules

Arguments following the template name are split by whitespace, unless quoted:

```
/template:component Button "click handler" "disabled support"
$1 = "Button"
$2 = "click handler"
$3 = "disabled support"
$@ = "Button click handler disabled support"
```

Quoted arguments use standard shell-style quoting: single or double quotes, backslash escaping.

### Unresolved placeholders

If a template references `$2` but only one argument is supplied, `$2` is replaced with an empty string. No error is raised.

---

## Extension Behaviour

### Session start (`onSessionStart`)

1. Read source list from `TEMPLATES_CACHE:config:sources`.
2. For each source, fetch templates (respecting cache TTL).
3. Parse frontmatter; extract name and description.
4. Build name → `{ url, name, description, content }` registry.
5. Templates without a description fall back to first non-empty content line.

### System prompt contribution

`getSystemPromptAdditions` returns a `context` section listing all available templates:

```
## Prompt Templates

Type /template:{name} to expand a reusable prompt. Available templates:

- **/template:review** — Review staged git changes for bugs, security issues, and style
- **/template:component** — Scaffold a new React component with specified features
- **/template:summarize** — Summarize the current conversation
```

Added at section `"context"` with `priority: 200` (after skills).

### Command registration

`getCommands` returns one `CommandDescriptor` per template:

```typescript
[
  { name: "template:review",    description: "Review staged git changes for bugs, security issues, and style" },
  { name: "template:component", description: "Scaffold a new React component with specified features" },
]
```

### Input handling

`onInput` handles `/template:{name}` commands:

```
if event.commandName starts with "template:":
  templateName = event.commandName.slice("template:".length)
  content = await fetchTemplateContent(templateName)   // from cache or URL
  if not found: return { action: "continue" } (pass through as plain text)
  args = parseArgs(event.commandArgs ?? "")
  expanded = substituteArguments(content, args)
  return { action: "transform", text: expanded }
```

The transformed text (expanded template body) becomes the prompt sent to the agent. Gateway autocomplete and display show the original `/template:name args` input to the user.

---

## Caching

Templates are cached in `TEMPLATES_CACHE` KV:

| Key | Value | TTL |
|---|---|---|
| `template:{name}:content` | Raw template Markdown | 1 hour (default) |
| `template:{name}:meta` | `{ name, description, url, fetchedAt }` | 1 hour |
| `config:sources` | JSON source list | No TTL |

Cache TTL is configurable via `TEMPLATE_CACHE_TTL_SECONDS` env var (default: `3600`). On `reloadTemplates()` call, all `template:*` entries are purged.

---

## JSRPC Extension Endpoints

Additional methods callable from gateways or admin tools:

```typescript
class TemplatesExtension extends WorkerEntrypoint {

  // IExtensionWorker: onSessionStart, getSystemPromptAdditions, getCommands, onInput
  // ...

  // ─── Admin endpoints ──────────────────────────────────────────────────────

  async listSources(): Promise<string[]>
  async addSource(url: string): Promise<void>
  async removeSource(url: string): Promise<void>
  async reloadTemplates(): Promise<void>

  // List all loaded templates (name + description).
  async listTemplates(): Promise<Array<{ name: string; description: string; url: string }>>

  // Fetch and return the raw content of a named template.
  async getTemplateContent(name: string): Promise<string | null>

  // Expand a template with given arguments and return the result without sending to the agent.
  // Useful for gateway previews.
  async expandTemplate(name: string, args: string[]): Promise<string | null>
}
```

---

## Example Usage

### Add a template source

```bash
wrangler dispatch-namespace execute piccolo-extensions \
  --binding ext-templates \
  --method addSource \
  --args '["https://raw.githubusercontent.com/myorg/piccolo-templates/main/templates.json"]'
```

### Template index file format (`templates.json`)

```json
[
  { "name": "review",    "url": "https://raw.githubusercontent.com/myorg/piccolo-templates/main/review.md" },
  { "name": "component", "url": "https://raw.githubusercontent.com/myorg/piccolo-templates/main/component.md" },
  { "name": "bugfix",    "url": "https://raw.githubusercontent.com/myorg/piccolo-templates/main/bugfix.md" }
]
```

### Invoking a template from any gateway

**Web UI:** type `/template:review` in the input box — autocomplete suggests available templates with descriptions.

**Telegram:** send `/template:review` as a message — the gateway routes it through `onInput`, expands it, and sends the full prompt to the agent.

---

## Relationship to Skills

| Aspect | Skills | Prompt Templates |
|---|---|---|
| Content loaded | Full `SKILL.md` on invocation | Template expanded inline at input time |
| System prompt | Always lists names/descriptions | Lists all templates as commands |
| Invocation | `/skill:{name}` | `/template:{name} [args]` |
| Argument support | Single trailing string | Full `$1`, `$@`, `${@:N}` syntax |
| Progressive disclosure | Yes (description always; full content on demand) | No (full content always expanded) |
| Caching | Required (potentially large) | Lightweight (short snippets) |
| Standard | Agent Skills spec | Pi prompt-templates convention |
