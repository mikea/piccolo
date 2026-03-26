# R2 Tool — Specification

Gives the LLM read/write access to a Cloudflare R2 bucket. Exposes file-system-like operations: read, write, delete, list, copy, move, and metadata inspection.

See [tools.md](tools.md) for the general tool authoring contract (`ITool` / `ToolDescriptor`).

---

## Worker

**Name:** `ext-r2-tool`  
**Implements:** `ITool` (see [api.md](api.md))  
**Binding required:** R2 bucket bound as `BUCKET`

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-r2-tool",
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "piccolo-workspace" }
  ]
}
```

---

## `ToolDescriptor`

```typescript
import type { ToolDescriptor } from "piccolo-core";

const descriptor: ToolDescriptor = {
  name: "r2",
  label: "R2 Storage",
  description: `Read and write files in the R2 object storage bucket.

Actions:
- read   : Read the content of an object by key
- write  : Write content to an object (creates or overwrites)
- delete : Delete one or more objects by key (up to 1000 at once)
- list   : List objects, optionally filtered by prefix and/or delimiter
- stat   : Get metadata for an object without downloading its body
- copy   : Copy an object to a new key (both keys exist afterward)
- move   : Move an object to a new key (source is deleted after copy succeeds)

Keys are arbitrary strings. Use '/' as a separator convention for path-like organisation,
e.g. 'projects/myapp/README.md'. Keys are case-sensitive.`,

  promptSnippet: "Read, write, list, and manage files in R2 object storage",

  promptGuidelines: [
    "Use r2 read/write for storing and retrieving files, code, documents, or binary content.",
    "Use r2 list with a prefix and delimiter='/' to browse a virtual directory structure.",
    "Prefer r2 move over a manual copy+delete sequence to rename files atomically.",
    "Binary content must be base64-encoded and written with binary: true.",
    "r2 stat retrieves metadata without downloading the object body — use it to check existence or size.",
  ],

  inputSchema: {
    oneOf: [
      { type: "object", additionalProperties: false, properties: { action: { const: "read" }, key: { type: "string" }, encoding: { type: "string", enum: ["text", "base64"], default: "text" } }, required: ["action", "key"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "write" }, key: { type: "string" }, content: { type: "string" }, binary: { type: "boolean", default: false }, contentType: { type: "string" }, metadata: { type: "object", additionalProperties: { type: "string" } } }, required: ["action", "key", "content"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "delete" }, keys: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string" } } }, required: ["action", "keys"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "list" }, prefix: { type: "string", default: "" }, delimiter: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 }, cursor: { type: "string" } }, required: ["action"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "stat" }, key: { type: "string" } }, required: ["action", "key"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "copy" }, sourceKey: { type: "string" }, destKey: { type: "string" } }, required: ["action", "sourceKey", "destKey"] },
      { type: "object", additionalProperties: false, properties: { action: { const: "move" }, sourceKey: { type: "string" }, destKey: { type: "string" } }, required: ["action", "sourceKey", "destKey"] },
    ],
  },
};
```

---

## `ToolResult` `details` Types

```typescript
// action: "read"
interface R2ReadDetails {
  key: string;
  size: number;
  contentType?: string;
  lastModified: string;      // ISO 8601
}

// action: "write"
interface R2WriteDetails {
  key: string;
  size: number;
  etag: string;
}

// action: "delete"
interface R2DeleteDetails {
  deletedKeys: string[];     // the keys that were requested for deletion
}

// action: "list"
interface R2ListDetails {
  objects: Array<{
    key: string;
    size: number;
    lastModified: string;    // ISO 8601
    etag: string;
  }>;
  prefixes: string[];        // virtual directory prefixes (only when delimiter is set)
  truncated: boolean;
  cursor?: string;           // pass to next list call to get the next page
}

// action: "stat"
interface R2StatDetails {
  key: string;
  size: number;
  etag: string;
  contentType?: string;
  lastModified: string;      // ISO 8601
  customMetadata: Record<string, string>;
}

// action: "copy" | "move"
interface R2CopyDetails {
  sourceKey: string;
  destKey: string;
}
```

---

## Behaviour Specification

### `read`

1. Call `env.BUCKET.get(key)`.
2. If the object does not exist, throw `Error(`Not found: ${key}`)`.
3. If `encoding === "text"`: set `content[0].text = await obj.text()`.
4. If `encoding === "base64"`: read `await obj.arrayBuffer()`, encode to base64, set `content[0].text`.
5. Set `details: R2ReadDetails` from `obj.key`, `obj.size`, `obj.httpMetadata.contentType`, `obj.uploaded.toISOString()`.

### `write`

1. If `binary === true`: decode `content` from base64 to `ArrayBuffer`.
2. Call `env.BUCKET.put(key, body, { httpMetadata: { contentType }, customMetadata: metadata })`.
3. Set `content[0].text` to a confirmation message, e.g. `"Written: {key} ({size} bytes)"`.
4. Set `details: R2WriteDetails` from the returned `R2Object`.

### `delete`

1. Call `env.BUCKET.delete(keys)` (accepts an array of up to 1000 keys).
2. Set `content[0].text` to `"Deleted {n} object(s)"`.
3. Set `details: R2DeleteDetails` with the requested keys.

### `list`

1. Call `env.BUCKET.list({ prefix, delimiter, limit, cursor })`.
2. Set `content[0].text` to a summary, e.g. `"Listed 42 objects under 'src/'" `.
3. Set `details: R2ListDetails`:
   - Map `listed.objects` → `objects` array.
   - Map `listed.delimitedPrefixes` → `prefixes`.
   - Copy `listed.truncated` and `listed.cursor`.

### `stat`

1. Call `env.BUCKET.head(key)`.
2. If `null`, throw `Error(`Not found: ${key}`)`.
3. Do not call `get()` — do not download the body.
4. Set `details: R2StatDetails`.

### `copy`

1. Call `env.BUCKET.get(sourceKey)`. Throw if not found.
2. Call `env.BUCKET.put(destKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata })`.
3. Set `details: R2CopyDetails`.

### `move`

1. Call `env.BUCKET.get(sourceKey)`. Throw if not found.
2. Call `env.BUCKET.put(destKey, obj.body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata })`.
3. Only after the `put` succeeds: call `env.BUCKET.delete(sourceKey)`.
4. If the `put` fails, throw without deleting the source — do not leave the bucket in a half-moved state.
5. Set `details: R2CopyDetails`.
