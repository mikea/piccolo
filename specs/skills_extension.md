# Skills Extension — Specification

The skills extension loads agent skills from a configurable list of URLs and makes them available as `/skill:name` commands. It implements the [Agent Skills standard](https://agentskills.io/specification).

---

## What is a Skill?

A skill is a Markdown document (`SKILL.md`) that provides the agent with specialised instructions, workflows, and reference material for a specific task. Only the skill's name and description are always in the system prompt; the full content is loaded on-demand when the agent invokes the skill, keeping context usage low (progressive disclosure).

---

## Extension Worker

**Name:** `ext-skills`  
**Implements:** `IExtensionWorker` (see [api.md §8](api.md))  
**Bindings required:** KV for cache (`env.SKILLS_CACHE`), optionally R2 for assets

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-skills",
  "kv_namespaces": [
    { "binding": "SKILLS_CACHE", "id": "..." }
  ],
  "vars": {
    // JSON array of skill source URLs (each pointing to a SKILL.md or a skills index)
    "SKILL_SOURCES": "[]"
  }
  // or store SKILL_SOURCES in a KV key for runtime reconfiguration without redeployment
}
```

---

## Skill Sources

Skills are loaded from a **source list** — a JSON array of URLs stored in the extension's `SKILLS_CACHE` KV under the key `config:sources`, or falling back to the `SKILL_SOURCES` env var. Each entry is one of:

| Source type | URL format | Description |
|---|---|---|
| Single skill | `https://.../SKILL.md` | Loads a single skill document |
| Index file | `https://.../skills.json` | JSON array of `{ name, url }` entries pointing to individual `SKILL.md` URLs |
| GitHub repo root | `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/` | Fetches a `skills.json` index from that root |

### Source list management

The source list is updated at runtime via a JSRPC endpoint on the extension itself — no redeployment needed:

```typescript
// Gateways or admin tools call this directly via dispatch namespace
await env.EXTENSIONS.get("ext-skills").addSource("https://example.com/skills/skills.json");
await env.EXTENSIONS.get("ext-skills").removeSource("https://example.com/skills/skills.json");
await env.EXTENSIONS.get("ext-skills").listSources(); // → string[]
await env.EXTENSIONS.get("ext-skills").reloadSkills(); // force re-fetch all sources
```

---

## Skill Document Format

Each skill is a Markdown file conforming to the [Agent Skills specification](https://agentskills.io/specification):

```markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
license: MIT
compatibility: Requires BRAVE_API_KEY environment variable.
---

# Brave Search

## Setup

Set the `BRAVE_API_KEY` environment variable in your session context.

## Usage

Ask the agent to search for anything:

> "Search for the latest Cloudflare Workers documentation"
> "Find information about the Zod v4 release"
```

### Frontmatter Fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | 1–64 chars. Lowercase letters, digits, hyphens. Must match the skill's identifier. |
| `description` | Yes | Max 1024 chars. What the skill does and when the agent should use it. Be specific. |
| `license` | No | License name or URL. |
| `compatibility` | No | Max 500 chars. Environment requirements, API keys needed, etc. |
| `metadata` | No | Arbitrary key-value pairs. |
| `allowed-tools` | No | Space-delimited tool names the skill pre-approves. |
| `disable-model-invocation` | No | When `true`, skill is omitted from the system prompt. Only invokable via `/skill:name`. |

### Name Rules

- 1–64 characters
- Lowercase letters `[a-z]`, digits `[0-9]`, hyphens `-`
- No leading or trailing hyphens
- No consecutive hyphens (`--`)

Valid: `pdf-tools`, `code-review`, `data-analysis`  
Invalid: `PDF-Tools`, `-search`, `brave--search`

---

## Extension Behaviour

### Session start

On `onSessionStart`, the extension:
1. Reads the source list from `SKILLS_CACHE:config:sources`.
2. For each source URL, fetches skills (honouring cache TTL via `SKILLS_CACHE`).
3. Parses frontmatter from each `SKILL.md`.
4. Builds a name → `{ url, name, description, disableModelInvocation }` registry.
5. Validates each skill: missing `description` skips the skill; other violations warn but load.
6. Stores the registry in memory for the session lifetime.

### System prompt contribution

`getSystemPromptAdditions` returns a `skills` section listing all skills where `disable-model-invocation` is not `true`:

```
## Available Skills

The following skills provide specialised capabilities. Use `/skill:{name}` to load full instructions.

- **brave-search** — Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
- **pdf-tools** — Extract text and tables from PDF files, merge and fill PDF forms.
```

This is added to the system prompt at the `"skills"` section with `priority: 100`.

### Command registration

`getCommands` returns one `CommandDescriptor` per skill:

```typescript
[
  { name: "skill:brave-search", description: "Web search and content extraction via Brave Search API." },
  { name: "skill:pdf-tools",    description: "Extract text and tables from PDF files." },
  // ...
]
```

### Input handling

`onInput` handles `/skill:{name}` commands:

```
if event.commandName starts with "skill:":
  skillName = event.commandName.slice("skill:".length)
  fullContent = await fetchSkillContent(skillName)
  if commandArgs present:
    append "\n\nUser: {commandArgs}" to fullContent
  return { action: "transform", text: fullContent }
```

The transformed text (the full `SKILL.md` content + optional user args) becomes the user message sent to the agent. The agent reads the instructions and executes the skill.

---

## Caching

Skill content is cached in `SKILLS_CACHE` KV:

| Key | Value | TTL |
|---|---|---|
| `skill:{name}:content` | Raw `SKILL.md` text | 1 hour (default) |
| `skill:{name}:meta` | `{ name, description, url, fetchedAt }` | 1 hour |
| `config:sources` | JSON source list | No TTL (manual update only) |

Cache TTL is configurable via `SKILL_CACHE_TTL_SECONDS` env var (default: `3600`).

On `reloadSkills()` JSRPC call, all `skill:*` cache entries are purged before re-fetching.

---

## JSRPC Extension Endpoints

The extension exposes additional JSRPC methods beyond `IExtensionWorker`, callable from gateways or admin tools via the dispatch namespace:

```typescript
class SkillsExtension extends WorkerEntrypoint {

  // IExtensionWorker implementation (getTools, onSessionStart, getSystemPromptAdditions, getCommands, onInput)
  // ...

  // ─── Admin endpoints ──────────────────────────────────────────────────────

  // List all configured source URLs.
  async listSources(): Promise<string[]>

  // Add a skill source URL.
  async addSource(url: string): Promise<void>

  // Remove a skill source URL.
  async removeSource(url: string): Promise<void>

  // Force re-fetch all skills from all sources.
  async reloadSkills(): Promise<void>

  // List all currently loaded skills (name + description).
  async listSkills(): Promise<Array<{ name: string; description: string; url: string }>>

  // Fetch the full content of a named skill.
  async getSkillContent(name: string): Promise<string | null>
}
```

---

## Validation

The extension validates each `SKILL.md` against the Agent Skills specification:

| Violation | Behaviour |
|---|---|
| Missing `description` | Skip skill entirely (not loaded) |
| Name > 64 chars or invalid characters | Warn in session start log; load anyway |
| Name collision (same name, different source) | Warn; keep first occurrence |
| `description` > 1024 chars | Warn; load anyway |
| Unknown frontmatter fields | Ignore |

---

## Example: Adding Skills

```bash
# Point the skills extension at the pi-skills repository index
curl -X POST https://piccolo.example.com/api/extensions/ext-skills/addSource \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url": "https://raw.githubusercontent.com/badlogic/pi-skills/main/skills.json"}'

# Or call directly via wrangler
wrangler dispatch-namespace execute piccolo-extensions \
  --binding ext-skills \
  --method addSource \
  --args '["https://raw.githubusercontent.com/badlogic/pi-skills/main/skills.json"]'
```

---

## Compatible Skill Sources

The extension is compatible with any source that follows the [Agent Skills standard](https://agentskills.io/specification):

- [Anthropic Skills](https://github.com/anthropics/skills) — document processing, web development
- [Pi Skills](https://github.com/badlogic/pi-skills) — web search, browser automation, Google APIs, transcription
- Any custom `SKILL.md` document served over HTTPS
