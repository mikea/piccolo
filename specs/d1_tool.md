# D1 Tool — Specification

Gives the LLM full SQL access to a Cloudflare D1 (SQLite) database: schema inspection, DDL changes, DML operations (insert, update, delete), SELECT queries, and arbitrary batched SQL.

See [tools.md](tools.md) for the general tool authoring contract (`ITool` / `ToolDescriptor`).

---

## Worker

**Name:** `ext-d1-tool`  
**Implements:** `ITool` (see [api.md](api.md))  
**Binding required:** D1 database bound as `DB`

### `wrangler.jsonc`

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
import { z } from "zod";
import type { ToolDescriptor } from "piccolo-core";

// Shared param type used across multiple actions
const sqlParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

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

  inputSchema: z.discriminatedUnion("action", [

    // ── schema ────────────────────────────────────────────────────────────────
    z.object({
      action: z.literal("schema"),
      table: z.string().optional()
        .describe("Show schema for this table only. Omit to list all tables with their schemas."),
    }),

    // ── select ────────────────────────────────────────────────────────────────
    z.object({
      action: z.literal("select"),
      sql: z.string()
        .describe("A SELECT statement with ? placeholders for parameters"),
      params: z.array(sqlParam).default([])
        .describe("Positional values bound to ? placeholders"),
      limit: z.number().int().min(1).max(5000).default(100)
        .describe("Maximum rows to return. Appended as LIMIT if not already present in sql."),
    }),

    // ── insert ────────────────────────────────────────────────────────────────
    z.object({
      action: z.literal("insert"),
      table: z.string().describe("Table name"),
      rows: z.array(z.record(sqlParam)).min(1)
        .describe("Array of row objects to insert. Keys are column names."),
      onConflict: z.enum(["error", "ignore", "replace"]).default("error")
        .describe("Conflict resolution: error=raise, ignore=skip duplicate row, replace=upsert"),
    }),

    // ── update ────────────────────────────────────────────────────────────────
    z.object({
      action: z.literal("update"),
      table: z.string().describe("Table name"),
      set: z.record(sqlParam)
        .describe("Columns and their new values"),
      where: z.string()
        .describe("WHERE clause without the WHERE keyword, e.g. \"id = ?\""),
      params: z.array(sqlParam).default([])
        .describe("Positional parameters for the WHERE clause"),
    }),

    // ── delete ────────────────────────────────────────────────────────────────
    z.object({
      action: z.literal("delete"),
      table: z.string().describe("Table name"),
      where: z.string()
        .describe("WHERE clause without the WHERE keyword, e.g. \"status = ?\""),
      params: z.array(sqlParam).default([])
        .describe("Positional parameters for the WHERE clause"),
      dryRun: z.boolean().default(false)
        .describe("If true, return the matching row count without deleting"),
    }),

    // ── schema_change ─────────────────────────────────────────────────────────
    z.object({
      action: z.literal("schema_change"),
      sql: z.string()
        .describe("A DDL statement: CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX, etc."),
      confirm: z.boolean()
        .describe("Must be explicitly set to true. Prevents accidental destructive schema changes."),
    }),

    // ── sql ───────────────────────────────────────────────────────────────────
    z.object({
      action: z.literal("sql"),
      statements: z.array(z.object({
        sql: z.string()
          .describe("Any SQL statement: SELECT, INSERT, UPDATE, DELETE, DDL, PRAGMA, etc."),
        params: z.array(sqlParam).default([])
          .describe("Positional parameters"),
      })).min(1).max(100)
        .describe("One or more SQL statements. Executed as a D1 batch (atomic for write statements)."),
    }),

  ]),
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
