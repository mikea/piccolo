# Skills Extension — Specification

The skills extension imports `SKILL.md` files from R2, stores them in D1, discloses a compact skills catalog in the system prompt, and provides tools to import, list, and activate skills.

This extension follows:
- Agent Skills format specification: <https://agentskills.io/specification>
- Agent Skills integration guidance: <https://agentskills.io/client-implementation/adding-skills-support>

---

## Extension Worker

**Name:** `ext-skills`
**Implements:** `IExtensionWorker` (see [api.md §8](api.md))
**Bindings required:**
- D1: `env.SKILLS_DB`
- R2: `env.BUCKET`

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-skills",
  "d1_databases": [
    { "binding": "SKILLS_DB", "database_name": "piccolo-skills", "database_id": "<SKILLS_DB_ID>" }
  ],
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "piccolo-assets" }
  ]
}
```

---

## D1 Schema

Database: `piccolo-skills`.
Migration: `extensions/skills/migrations/0001_initial.sql`.

```sql
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  session_id    TEXT,
  file_name     TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  license       TEXT,
  compatibility TEXT,
  metadata_json TEXT,
  allowed_tools TEXT,
  content       TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (
    (user_id IS NULL AND session_id IS NULL) OR
    (user_id IS NOT NULL AND session_id IS NULL) OR
    (user_id IS NULL AND session_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX skills_scope_file_unique
  ON skills(user_id, session_id, file_name);
```

### Scope model

Rows are scoped by nullable `user_id` and `session_id`:

| Scope | `user_id` | `session_id` |
|---|---|---|
| global | `NULL` | `NULL` |
| user | current user ID | `NULL` |
| session | `NULL` | current session ID |

Visible rows for a session are the union of global + current user + current session rows.

`active` defaults to `1` (active).

---

## Skill format and lenient validation

Imported documents must be valid `SKILL.md` files with YAML frontmatter and only standard Agent Skills fields:

Required:
- `name`
- `description`

Optional:
- `license`
- `compatibility`
- `metadata`
- `allowed-tools`

Lenient rules:
- Unknown/non-standard frontmatter fields are ignored and never persisted.
- Malformed lines are skipped when possible.
- Missing required fields are coerced to safe fallback values for storage.

On successful import:
- The original full file is stored in `content`.
- Parsed frontmatter values are stored in dedicated columns (`name`, `description`, `license`, `compatibility`, `metadata_json`, `allowed_tools`).

---

## Tool: `import_skills`

Recursively imports `SKILL.md` files from an R2 path into D1.

Input:

```typescript
{
  path: string;
  scope: "global" | "user" | "session";
  max_files?: number;
  max_file_bytes?: number;
}
```

### Scope resolution

`scope` determines persisted IDs:
- `global` → `user_id = NULL`, `session_id = NULL`
- `user` → `user_id = ctx.userId()`, `session_id = NULL`
- `session` → `user_id = NULL`, `session_id = ctx.sessionId()`

### Import algorithm

1. List R2 objects recursively using `path` prefix (paginated).
2. Keep only keys ending with `SKILL.md`.
3. Read full file text.
4. Compute SHA-256 over full file text.
5. If existing row for `(user_id, session_id, file_name)` has same `sha256`, skip.
6. Parse and validate frontmatter (lenient mode).
7. Insert/update row by `(user_id, session_id, file_name)`.

Returns counts (`scanned`, `inserted`, `updated`, `skipped`, `errors`) and diagnostics.

---

## Tool: `list_skills`

Lists currently visible skills for the active session context.

Input:

```typescript
{
  query?: string;
  limit?: number;
  offset?: number;
  include_inactive?: boolean;
}
```

Output includes at least:
- `name`
- `description`
- `scope` (`global` | `user` | `session`)
- `active`
- `file_name`

---

## Tool: `activate_skill`

Loads full stored `SKILL.md` content for a visible active skill name.

Input:

```typescript
{
  name: string;
  arguments?: string;
}
```

Resolution precedence when multiple visible rows share the same name:
1. session-scoped
2. user-scoped
3. global-scoped

Returns full `content` text (original `SKILL.md` file). If `arguments` is provided, it is appended as a trailing user-arguments note.

`activate_skill` schema keeps `name` as plain string (no enum list) to avoid schema/token bloat when thousands of skills exist.

---

## System prompt contribution

`getSystemPromptAdditions()` contributes a compact skills catalog (progressive disclosure tier 1) for visible active skills.

The catalog format is XML:

```xml
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

### Prompt algorithm

```typescript
function buildSkillsPromptCatalog(visibleSkills: Skill[]): string {
  const skills = [...visibleSkills].sort((a, b) =>
    a.name.localeCompare(b.name) || a.file_name.localeCompare(b.file_name),
  );
  if (skills.length === 0) return "";

  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Call activate_skill with a skill name when the task matches its description.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(`r2://skills/${skill.file_name}`)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}
```

`escapeXml` must escape: `&`, `<`, `>`, `"`, `'`.

---

## File layout

```
extensions/skills/
├── migrations/
│   └── 0001_initial.sql
└── src/
    ├── index.ts
    ├── extension.ts
    ├── db.ts
    └── parser.ts
```

---

## Deployment

```bash
# Create D1 database
wrangler d1 create piccolo-skills

# Apply migrations
wrangler d1 migrations apply piccolo-skills

# Deploy extension
wrangler deploy --name ext-skills
```

Bind extension service in core as `EXTENSION_SKILLS` and re-deploy core if the binding is added or changed.

---

## TODO

- Replace tool-first UX with custom command UX (`/skill`, `/skills`) once command support and autocomplete integration is implemented.
