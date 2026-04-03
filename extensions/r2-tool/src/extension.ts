import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  IAbortSignal,
  IExtension,
  ISession,
  ITool,
  ToolDescriptor,
  ToolResult,
} from "@piccolo/api";
import * as z from "zod";

// ── Hard ceiling on maxBytes regardless of what the LLM requests ──────────────
const MAX_BYTES_HARD_CAP = 10 * 1_048_576; // 10 MiB

// ── Detail interfaces ─────────────────────────────────────────────────────────

interface R2ReadDetails {
  /** Object key. */
  key: string;
  /** Full object size in bytes (from obj.size). */
  size: number;
  /** Content-Type of the object, if set. */
  contentType: string | undefined;
  /** ISO 8601 upload timestamp. */
  lastModified: string;
  /** True if byteOffset, byteLength, or suffix was specified. */
  ranged: boolean;
  /** True if maxBytes was applied and body was cut short. */
  truncated: boolean;
  /** Bytes actually returned in content[0].text (after range + truncation). */
  returnedBytes: number;
}

interface R2WriteDetails {
  key: string;
  size: number;
  etag: string;
}

interface R2DeleteDetails {
  deletedKeys: string[];
}

interface R2ListDetails {
  objects: Array<{
    key: string;
    size: number;
    lastModified: string;
    etag: string;
  }>;
  /** Virtual directory prefixes (only present when delimiter is set). */
  prefixes: string[];
  truncated: boolean;
  cursor: string | undefined;
}

interface R2StatDetails {
  key: string;
  size: number;
  etag: string;
  contentType: string | undefined;
  lastModified: string;
  customMetadata: Record<string, string>;
}

interface R2CopyDetails {
  sourceKey: string;
  destKey: string;
}

// ── Zod schemas (single source of truth for validation + LLM inputSchema) ─────

const readSchema = z.object({
  action: z.literal("read"),
  key: z.string().describe("Object key to read."),
  encoding: z
    .enum(["text", "base64"])
    .default("text")
    .describe(
      '"text" returns UTF-8 text (binary content auto-detected and base64-encoded). "base64" always base64-encodes.',
    ),
  byteOffset: z
    .int()
    .min(0)
    .optional()
    .describe("Start byte, 0-based. Passed to R2 range.offset. Mutually exclusive with suffix."),
  byteLength: z
    .int()
    .min(1)
    .optional()
    .describe("Number of bytes to return from byteOffset. Passed to R2 range.length."),
  suffix: z
    .int()
    .min(1)
    .optional()
    .describe("Last N bytes of the object. Mutually exclusive with byteOffset/byteLength."),
  maxBytes: z
    .int()
    .min(1)
    .default(1_048_576)
    .describe(
      "Maximum bytes to return. Default 1 MiB. Hard cap 10 MiB. Surplus is truncated with a notice appended.",
    ),
});

const writeSchema = z.object({
  action: z.literal("write"),
  key: z.string().describe("Object key to write."),
  content: z.string().describe("Content to write. If binary=true, must be base64-encoded."),
  binary: z
    .boolean()
    .default(false)
    .describe("If true, content is decoded from base64 before writing."),
  contentType: z.string().optional().describe("HTTP Content-Type to store with the object."),
  metadata: z
    .record(z.string(), z.string())
    .optional()
    .describe("Custom metadata key-value pairs to store with the object."),
});

const deleteSchema = z.object({
  action: z.literal("delete"),
  keys: z.array(z.string()).min(1).max(1000).describe("Keys to delete (1–1000)."),
});

const listSchema = z.object({
  action: z.literal("list"),
  prefix: z.string().default("").describe("Only return keys starting with this prefix."),
  delimiter: z
    .string()
    .optional()
    .describe(
      "Character used to group keys into virtual directories. Use '/' for path-like listings.",
    ),
  limit: z
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe("Maximum number of objects to return (1–1000)."),
  cursor: z
    .string()
    .optional()
    .describe("Continuation cursor from a previous truncated list result."),
});

const statSchema = z.object({
  action: z.literal("stat"),
  key: z.string().describe("Object key to inspect."),
});

const copySchema = z.object({
  action: z.literal("copy"),
  sourceKey: z.string().describe("Key of the source object."),
  destKey: z.string().describe("Key for the destination object."),
});

const moveSchema = z.object({
  action: z.literal("move"),
  sourceKey: z.string().describe("Key of the source object."),
  destKey: z.string().describe("Key for the destination object. Source is deleted after copy."),
});

const r2ParamsSchema = z.discriminatedUnion("action", [
  readSchema,
  writeSchema,
  deleteSchema,
  listSchema,
  statSchema,
  copySchema,
  moveSchema,
]);

type R2Params = z.output<typeof r2ParamsSchema>;

const r2ParamsRpcSchema = z.toJSONSchema(r2ParamsSchema, { target: "draft-07" });

// ── ToolDescriptor ────────────────────────────────────────────────────────────

const descriptor: ToolDescriptor = {
  name: "r2",
  label: "R2 Storage",
  description: `Read and write files in the R2 object storage bucket.

Actions:
- read   : Read the content of an object by key. Supports byte-range reads (byteOffset/byteLength
           or suffix) and maxBytes truncation — similar to the fetch tool's range parameters.
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
    "Use byteOffset/byteLength or suffix on read to fetch only a portion of a large object without downloading the full body.",
    "Use maxBytes on read to cap the size returned to the LLM; the body will be truncated with a notice appended.",
  ],

  inputSchema: r2ParamsRpcSchema,
};

// ── Binary detection helper ───────────────────────────────────────────────────

function isBinaryContentType(contentType: string): boolean {
  return (
    !contentType.includes("text") &&
    !contentType.includes("json") &&
    !contentType.includes("xml") &&
    !contentType.includes("javascript")
  );
}

// ── base64 encode helper (Workers-safe) ───────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

// ── R2Tool ────────────────────────────────────────────────────────────────────

/**
 * RpcTarget implementing ITool. Returned by R2ToolExtension.getTools() as a
 * JSRPC capability so piccolo-core can call getDescriptor() and execute() on it.
 *
 * The bucket binding is passed via constructor because RpcTarget subclasses do
 * not have access to the Workers `env` object — only WorkerEntrypoint does.
 */
export class R2Tool extends RpcTarget implements ITool {
  constructor(private readonly bucket: R2Bucket) {
    super();
  }

  getDescriptor(): Promise<ToolDescriptor> {
    return Promise.resolve(descriptor);
  }

  async execute(
    _toolCallId: string,
    params: unknown,
    _ctx: ISession,
    _iSignal?: IAbortSignal,
  ): Promise<ToolResult> {
    const parsed: R2Params = r2ParamsSchema.parse(params);

    switch (parsed.action) {
      case "read":
        return this.#read(parsed);
      case "write":
        return this.#write(parsed);
      case "delete":
        return this.#delete(parsed);
      case "list":
        return this.#list(parsed);
      case "stat":
        return this.#stat(parsed);
      case "copy":
        return this.#copy(parsed);
      case "move":
        return this.#move(parsed);
    }
  }

  // ── read ───────────────────────────────────────────────────────────────────

  async #read(params: z.output<typeof readSchema>): Promise<ToolResult> {
    const { key, encoding, byteOffset, byteLength, suffix, maxBytes } = params;
    const effectiveMax = Math.min(maxBytes, MAX_BYTES_HARD_CAP);
    const isRanged = suffix !== undefined || byteOffset !== undefined || byteLength !== undefined;

    // Build R2GetOptions.range using exactOptionalPropertyTypes-safe construction.
    // R2Range type requires either { suffix: number } or { offset?: number; length?: number }
    // where absent properties must not be present at all (not set to undefined).
    let getOptions: R2GetOptions | undefined;
    if (suffix !== undefined) {
      getOptions = { range: { suffix } };
    } else if (byteOffset !== undefined && byteLength !== undefined) {
      getOptions = { range: { offset: byteOffset, length: byteLength } };
    } else if (byteOffset !== undefined) {
      getOptions = { range: { offset: byteOffset } };
    } else if (byteLength !== undefined) {
      getOptions = { range: { length: byteLength } };
    }

    const obj = await this.bucket.get(key, getOptions);
    if (obj === null) {
      throw new Error(`Not found: ${key}`);
    }
    // bucket.get() without onlyIf always returns R2ObjectBody (has arrayBuffer()).
    // Guard defensively: if R2Object is returned (e.g. future conditional path),
    // arrayBuffer would not be available.
    if (!("arrayBuffer" in obj)) {
      throw new Error(`Object ${key} returned without body`);
    }

    const buffer = await obj.arrayBuffer();
    const contentType = obj.httpMetadata?.contentType ?? "";

    // Apply maxBytes truncation
    let truncated = false;
    let slice: ArrayBuffer;
    if (buffer.byteLength > effectiveMax) {
      truncated = true;
      slice = buffer.slice(0, effectiveMax);
    } else {
      slice = buffer;
    }

    // Determine if content should be base64
    const forcedBase64 = encoding === "base64";
    const autoBinary = !forcedBase64 && isBinaryContentType(contentType);
    const encodeAsBase64 = forcedBase64 || autoBinary;

    let bodyText: string;
    if (encodeAsBase64) {
      bodyText = `[base64] ${bufferToBase64(slice)}`;
    } else {
      bodyText = new TextDecoder().decode(slice);
    }

    const parts: string[] = [bodyText];
    if (truncated) {
      parts.push(`\n[Response truncated at ${effectiveMax} bytes]`);
    }

    const text = parts.join("");
    const returnedBytes = new TextEncoder().encode(bodyText).byteLength;

    const details: R2ReadDetails = {
      key: obj.key,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType,
      lastModified: obj.uploaded.toISOString(),
      ranged: isRanged,
      truncated,
      returnedBytes,
    };

    return {
      content: [{ type: "text", text }],
      details,
    };
  }

  // ── write ──────────────────────────────────────────────────────────────────

  async #write(params: z.output<typeof writeSchema>): Promise<ToolResult> {
    const { key, content, binary, contentType, metadata } = params;

    let body: string | Uint8Array;
    if (binary) {
      // Decode base64 content to binary
      const binaryStr = atob(content);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      body = bytes;
    } else {
      body = content;
    }

    // Build R2PutOptions without setting optional fields to undefined
    // (exactOptionalPropertyTypes: true requires absent keys, not undefined values).
    const putOptions: R2PutOptions = {
      ...(contentType !== undefined ? { httpMetadata: { contentType } } : {}),
      ...(metadata !== undefined ? { customMetadata: metadata } : {}),
    };
    // put() without onlyIf always returns R2Object (never null).
    const result = await this.bucket.put(key, body, putOptions);

    const details: R2WriteDetails = {
      key,
      size: result.size,
      etag: result.etag,
    };

    return {
      content: [{ type: "text", text: `Written: ${key} (${result.size} bytes)` }],
      details,
    };
  }

  // ── delete ─────────────────────────────────────────────────────────────────

  async #delete(params: z.output<typeof deleteSchema>): Promise<ToolResult> {
    const { keys } = params;
    await this.bucket.delete(keys);

    const details: R2DeleteDetails = { deletedKeys: keys };

    return {
      content: [{ type: "text", text: `Deleted ${keys.length} object(s)` }],
      details,
    };
  }

  // ── list ───────────────────────────────────────────────────────────────────

  async #list(params: z.output<typeof listSchema>): Promise<ToolResult> {
    const { prefix, delimiter, limit, cursor } = params;

    // Build R2ListOptions without setting optional fields to undefined
    const listOptions: R2ListOptions = {
      limit,
      ...(prefix !== "" ? { prefix } : {}),
      ...(delimiter !== undefined ? { delimiter } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
    const listed = await this.bucket.list(listOptions);

    const objects = listed.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      lastModified: obj.uploaded.toISOString(),
      etag: obj.etag,
    }));

    const prefixes = listed.delimitedPrefixes ?? [];

    const details: R2ListDetails = {
      objects,
      prefixes,
      truncated: listed.truncated,
      cursor: listed.truncated ? listed.cursor : undefined,
    };

    const location = prefix ? ` under '${prefix}'` : "";
    const summary = `Listed ${objects.length} object(s)${location}${prefixes.length > 0 ? ` and ${prefixes.length} prefix(es)` : ""}${listed.truncated ? " (truncated)" : ""}`;

    return {
      content: [{ type: "text", text: summary }],
      details,
    };
  }

  // ── stat ───────────────────────────────────────────────────────────────────

  async #stat(params: z.output<typeof statSchema>): Promise<ToolResult> {
    const { key } = params;
    const obj = await this.bucket.head(key);
    if (obj === null) {
      throw new Error(`Not found: ${key}`);
    }

    const details: R2StatDetails = {
      key: obj.key,
      size: obj.size,
      etag: obj.etag,
      contentType: obj.httpMetadata?.contentType,
      lastModified: obj.uploaded.toISOString(),
      customMetadata: obj.customMetadata ?? {},
    };

    return {
      content: [
        {
          type: "text",
          text: `${key}: ${obj.size} bytes, etag=${obj.etag}, lastModified=${obj.uploaded.toISOString()}`,
        },
      ],
      details,
    };
  }

  // ── copy ───────────────────────────────────────────────────────────────────

  async #copy(params: z.output<typeof copySchema>): Promise<ToolResult> {
    const { sourceKey, destKey } = params;

    const obj = await this.bucket.get(sourceKey);
    if (obj === null) {
      throw new Error(`Not found: ${sourceKey}`);
    }

    const copyPutOptions: R2PutOptions = {
      ...(obj.httpMetadata !== undefined ? { httpMetadata: obj.httpMetadata } : {}),
      ...(obj.customMetadata !== undefined ? { customMetadata: obj.customMetadata } : {}),
    };
    await this.bucket.put(destKey, obj.body, copyPutOptions);

    const details: R2CopyDetails = { sourceKey, destKey };

    return {
      content: [{ type: "text", text: `Copied: ${sourceKey} → ${destKey}` }],
      details,
    };
  }

  // ── move ───────────────────────────────────────────────────────────────────

  async #move(params: z.output<typeof moveSchema>): Promise<ToolResult> {
    const { sourceKey, destKey } = params;

    const obj = await this.bucket.get(sourceKey);
    if (obj === null) {
      throw new Error(`Not found: ${sourceKey}`);
    }

    // Put first — only delete source if put succeeds.
    // If put throws, the source is left intact (no half-moved state).
    const movePutOptions: R2PutOptions = {
      ...(obj.httpMetadata !== undefined ? { httpMetadata: obj.httpMetadata } : {}),
      ...(obj.customMetadata !== undefined ? { customMetadata: obj.customMetadata } : {}),
    };
    await this.bucket.put(destKey, obj.body, movePutOptions);

    await this.bucket.delete(sourceKey);

    const details: R2CopyDetails = { sourceKey, destKey };

    return {
      content: [{ type: "text", text: `Moved: ${sourceKey} → ${destKey}` }],
      details,
    };
  }
}

// ── R2ToolExtension ───────────────────────────────────────────────────────────

/**
 * WorkerEntrypoint for the r2-tool extension.
 * Exported as the default export of index.ts.
 */
export class R2ToolExtension extends WorkerEntrypoint<{ BUCKET: R2Bucket }> implements IExtension {
  override fetch(): Response {
    return new Response("OK", { status: 200 });
  }

  async getTools(_session: ISession): Promise<ITool[]> {
    console.debug("[r2] getTools");
    return [new R2Tool(this.env.BUCKET)];
  }
}
