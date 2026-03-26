# D1 Tool — Specification

Gives the LLM full SQL access to a Cloudflare D1 (SQLite) database: schema inspection, DDL changes, DML operations (insert, update, delete), SELECT queries, and arbitrary batched SQL.

See [tools.md](tools.md) for the general tool authoring contract (`ITool` / `ToolDescriptor`).

---

## Worker

**Name:** `ext-d1-tool`  
**Implements:** `ITool` (see [api.md](api.md))  
**Binding required:** D1 database bound as `DB`

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-d1-tool",
  "d1_databases": [
    { "binding": "DB", "database_name": "piccolo-workspace", "database_id": "..." }
  ]
}
```

---

## `ToolDescriptor`

```typescript
import type { ToolDescriptor } from "piccolo-core";

const descriptor: ToolDescriptor = {
  name: "d1",
  label: "D1 Database",
  description: `Read and modify a Cloudflare D1 (SQLite) database.

Actions:
- schema        : Inspect tables, columns, indexes, and constraints
- select        : Run a SELECT query and return rows as JSON
- insert        : Insert one or more rows into a table
- update        : Update rows matching a WHERE clause
- delete        : Delete rows matching a WHERE clause (supports dry-run)
- schema_change : Execute DDL statements (CREATE/ALTER/DROP TABLE, CREATE INDEX, etc.)
- sql           : Execute one or more arbitrary SQL statements as a D1 batch

All parameterised statements use ? placeholders with a separate params array.
Multiple statements in the sql action are executed as an atomic D1 batch.`,

  promptSnippet: "Query and modify the D1 SQLite database",

  promptGuidelines: [
    "Always run d1 schema before writing queries against unfamiliar tables.",
    "Use ? placeholders and the params array — never interpolate values directly into SQL strings.",
    "Prefer the targeted actions (select, insert, update, delete) over raw sql for simple operations.",
    "Use the sql action with multiple statements when multiple queries must succeed or fail together.",
    "schema_change requires confirm: true — always explain the change to the user before setting it.",
    "d1 delete supports dryRun: true — use it to preview the row count before committing a destructive delete.",
  ],

  inputSchema: {
    oneOf: [
      { type: "object", additionalProperties: false, properties: { action: { const: "schema" }, table: { type: "string" } }, required: ["action"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "select" }, sql: { type: "string" }, params: { type: "array", default: [], items: { type: ["string", "number", "boolean", "null"] } }, limit: { type: "integer", minimum: 1, maximum: 5000, default: 100 } }, required: ["action", "sql"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "insert" }, table: { type: "string" }, rows: { type: "array", minItems: 1, items: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } } }, onConflict: { type: "string", enum: ["error", "ignore", "replace"], default: "error" } }, required: ["action", "table", "rows"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "update" }, table: { type: "string" }, set: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } }, where: { type: "string" }, params: { type: "array", default: [], items: { type: ["string", "number", "boolean", "null"] } } }, required: ["action", "table", "set", "where"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "delete" }, table: { type: "string" }, where: { type: "string" }, params: { type: "array", default: [], items: { type: ["string", "number", "boolean", "null"] } }, dryRun: { type: "boolean", default: false } }, required: ["action", "table", "where"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "schema_change" }, sql: { type: "string" }, confirm: { type: "boolean" } }, required: ["action", "sql", "confirm"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "sql" }, statements: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, properties: { sql: { type: "string" }, params: { type: "array", default: [], items: { type: ["string", "number", "boolean", "null"] } } }, required: ["sql"] } } }, required: ["action", "statements"] },
    ],
  },
};
```

---

## `ToolResult` `details` Types

```typescript
// action: "schema"
interface D1SchemaDetails {
  tables: Array<{
    name: string;
    sql: string;          // original CREATE TABLE statement from sqlite_master
    columns: Array<{
      name: string;
      type: string;
      notNull: boolean;
      defaultValue: string | null;
      primaryKey: boolean;
    }>;
    indexes: Array<{
      name: string;
      sql: string;
    }>;
  }>;
}

// action: "select"
interface D1SelectDetails {
  rows: Record<string, unknown>[];
  rowCount: number;
  columnNames: string[];
  truncated: boolean;   // true if returned rows === limit (more may exist)
}

// action: "insert"
interface D1InsertDetails {
  table: string;
  insertedCount: number;
  lastRowId: number | null;
}

// action: "update"
interface D1UpdateDetails {
  table: string;
  updatedCount: number;
}

// action: "delete"
interface D1DeleteDetails {
  table: string;
  deletedCount: number;   // 0 when dryRun: true
  matchedCount?: number;  // set when dryRun: true
  dryRun: boolean;
}

// action: "schema_change"
interface D1SchemaChangeDetails {
  sql: string;
  success: boolean;
  changes: number;
}

// action: "sql"
interface D1SqlDetails {
  results: Array<{
    sql: string;
    rows?: Record<string, unknown>[];
    rowCount?: number;
    changes?: number;
    lastRowId?: number | null;
    success: boolean;
  }>;
}
```

---

## Behaviour Specification

### `schema`

1. If `table` is provided:
   - Query `sqlite_master` for `sql` where `name = table`.
   - Run `PRAGMA table_info({table})` for columns.
   - Run `PRAGMA index_list({table})` for index names, then `PRAGMA index_info({name})` for each.
2. If `table` is omitted:
   - Query `sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'` for all user tables.
   - Run `PRAGMA table_info` for each.
3. Set `content[0].text` to a readable DDL-style schema summary.
4. Set `details: D1SchemaDetails`.

### `select`

1. If `sql` contains no `LIMIT` clause (case-insensitive), append `LIMIT {limit}`.
2. Call `env.DB.prepare(sql).bind(...params).run<Record<string, unknown>>()`.
3. Set `truncated: true` if `result.results.length === limit`.
4. Set `content[0].text` to a compact markdown table of the rows.
5. Set `details: D1SelectDetails`.

### `insert`

1. For each row, build `INSERT [OR IGNORE | OR REPLACE] INTO {table} ({cols}) VALUES (?, ...)`.
2. If more than one row: collect all prepared statements and call `env.DB.batch([...])` atomically.
3. If one row: call `.run()` directly.
4. Set `details: D1InsertDetails` with `result.meta.last_row_id` and inserted count.

### `update`

1. Build `UPDATE {table} SET col1 = ?, col2 = ?, ... WHERE {where}`.
2. Positional parameters = `[...Object.values(set), ...params]` (set values first, then where params).
3. Call `env.DB.prepare(sql).bind(...allParams).run()`.
4. Set `details: D1UpdateDetails` with `result.meta.changes`.

### `delete`

1. If `dryRun === true`:
   - Run `SELECT COUNT(*) AS n FROM {table} WHERE {where}` bound with `params`.
   - Return `details: D1DeleteDetails` with `dryRun: true`, `matchedCount: n`, `deletedCount: 0`.
2. Otherwise:
   - Run `DELETE FROM {table} WHERE {where}` bound with `params`.
   - Set `details: D1DeleteDetails` with `deletedCount: result.meta.changes`, `dryRun: false`.

### `schema_change`

1. If `confirm !== true`: throw `Error("schema_change requires confirm: true")`.
2. Call `env.DB.exec(sql)` — DDL uses raw exec, no bind parameters.
3. Set `content[0].text` to a summary of what changed.
4. For destructive statements (`DROP TABLE`, `DROP INDEX`, `ALTER TABLE ... RENAME`), include the table/index name explicitly in the summary.
5. Set `details: D1SchemaChangeDetails`.

### `sql`

1. Build prepared statements: `statements.map(s => env.DB.prepare(s.sql).bind(...s.params))`.
2. Execute: `const results = await env.DB.batch(stmts)`.
3. Map each result to `D1SqlDetails.results[i]`:
   - SELECT-like: `rows = result.results`, `rowCount = result.results.length`.
   - DML/DDL: `changes = result.meta.changes`, `lastRowId = result.meta.last_row_id`.
4. Set `content[0].text` to a concise batch summary, e.g.:
   `"3 statements: SELECT (12 rows) · INSERT (1 row) · UPDATE (5 rows changed)"`.
5. Set `details: D1SqlDetails`.
