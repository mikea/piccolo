# Fetch Tool — Specification

Gives the LLM the ability to make HTTP GET requests to the public internet using the standard `fetch()` Web API. Suitable for reading web pages, calling external APIs, downloading files (including large files via ranged GETs), and inspecting URL headers.

See [tools.md](tools.md) for the general tool authoring contract (`ITool` / `ToolDescriptor`).

---

## Worker

**Name:** `ext-fetch-tool`  
**Implements:** `ITool` (see [api.md](api.md))  
**Bindings required:** none — uses the runtime `fetch()` Web API directly.

### `wrangler.template.jsonc`

```jsonc
{
  "name": "ext-fetch-tool"
}
```

No additional bindings are required. Cloudflare Workers have unrestricted outbound `fetch()` access to the public internet by default.

---

## `ToolDescriptor`

```typescript
import { z } from "zod";
import type { ToolDescriptor } from "piccolo-core";

const descriptor: ToolDescriptor = {
  name: "fetch",
  label: "Fetch URL",
  description: `Make an HTTP request to a public HTTPS URL and return the response.

Actions:
- get  : HTTP GET — retrieve a resource. Supports optional byte-range parameters
         for fetching large files in chunks.
- head : HTTP HEAD — retrieve response headers only, no body. Use to check
         Content-Length and Accept-Ranges before issuing ranged GETs on large resources.

Parameters:
  url        : The full HTTPS URL to request (must begin with https://).
  action     : One of "get", "head" (default: "get").
  byteStart? : First byte of the range to fetch, inclusive (0-based). "get" only.
               If provided, sends a Range: bytes=byteStart-byteEnd request header.
  byteEnd?   : Last byte of the range to fetch, inclusive (0-based). "get" only.
               If byteStart is set and byteEnd is omitted, fetches from byteStart to end of file.
  maxBytes?  : Maximum response body size to return in bytes (default: 1 048 576 = 1 MiB).
               Applies after range slicing. Surplus is truncated with a notice appended.

Response body is returned as UTF-8 text. Binary responses are base64-encoded and noted as such.
The response status code and all response headers are included in the result text.

Errors:
  Throws if the URL scheme is not https.
  Throws if byteStart/byteEnd are provided but the server does not respond with 206 Partial Content
  (indicating the server does not support Range requests for this resource).
  Non-2xx status codes for non-ranged requests do NOT throw — the status is included in the result.`,

  promptSnippet: "Fetch the content of a public HTTPS URL (GET/HEAD, supports ranged GET for large files)",

  promptGuidelines: [
    "Use fetch head to get Content-Length and Accept-Ranges headers before downloading large files.",
    "If the head response includes Accept-Ranges: bytes, use byteStart/byteEnd on a get to fetch only the portion you need.",
    "Only https:// URLs are supported.",
    "Non-2xx responses to non-ranged GETs are returned as results, not errors — check the status before acting on the body.",
    "If you request a range and the server responds 200 instead of 206, the tool will throw — the server does not support range requests for that resource.",
    "Do not use fetch to access localhost, internal IP ranges, or Cloudflare metadata endpoints.",
    "Use maxBytes to cap the size of any single response chunk returned to the LLM.",
  ],

  inputSchema: z.object({
    action: z
      .enum(["get", "head"])
      .default("get")
      .describe('"get" retrieves the resource body; "head" retrieves headers only (no body).'),
    url: z
      .string()
      .url()
      .describe("Full HTTPS URL to request. Must begin with https://."),
    byteStart: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'First byte of the range to fetch, inclusive (0-based). "get" only. ' +
        "Sends a Range: bytes=byteStart-byteEnd header. Requires server support for Range requests (206 response).",
      ),
    byteEnd: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Last byte of the range to fetch, inclusive (0-based). "get" only. ' +
        "If byteStart is set and byteEnd is omitted, fetches from byteStart to end of file.",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1_048_576)
      .describe("Maximum response body size in bytes to include in the result. Default: 1 MiB. Larger responses are truncated."),
  }),
};
```

---

## Input Schema

| Field       | Type             | Required | Default     | Description                                                                          |
|-------------|------------------|----------|-------------|--------------------------------------------------------------------------------------|
| `action`    | `"get"\|"head"`  | no       | `"get"`     | HTTP method                                                                          |
| `url`       | `string` (URL)   | yes      | —           | Fully qualified HTTPS URL                                                            |
| `byteStart` | `number`         | no       | —           | First byte of range, inclusive (0-based). `get` only. Requires 206 from server.     |
| `byteEnd`   | `number`         | no       | —           | Last byte of range, inclusive (0-based). `get` only. Omit for open-ended range.     |
| `maxBytes`  | `number`         | no       | `1_048_576` | Max bytes of response body to include in result; surplus truncated with notice.      |

---

## `execute` — Implementation

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ITool, ISession, ToolResult } from "piccolo-core";

/** Hard ceiling on maxBytes regardless of what the LLM requests. */
const MAX_BYTES_HARD_CAP = 10 * 1_048_576; // 10 MiB

function validateScheme(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(`Unsupported scheme: ${url.protocol}. Only https:// is allowed.`);
  }
}

function validateNotSsrf(url: URL): void {
  const h = url.hostname;
  if (
    h === "localhost" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    throw new Error(`SSRF: private address not allowed: ${h}`);
  }
}

export default class FetchTool extends WorkerEntrypoint implements ITool {
  readonly descriptor = descriptor; // from above

  async execute(
    toolCallId: string,
    params: {
      action: "get" | "head";
      url: string;
      byteStart?: number;
      byteEnd?: number;
      maxBytes?: number;
    },
    ctx: ISession,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const url = new URL(params.url);
    validateScheme(url);
    validateNotSsrf(url);

    const isHead = params.action === "head";
    const isRanged = !isHead && (params.byteStart !== undefined || params.byteEnd !== undefined);
    const effectiveMax = Math.min(params.maxBytes ?? 1_048_576, MAX_BYTES_HARD_CAP);

    const reqHeaders: Record<string, string> = {};
    let rangeRequested: string | null = null;
    if (isRanged) {
      const start = params.byteStart ?? 0;
      const end = params.byteEnd !== undefined ? String(params.byteEnd) : "";
      rangeRequested = `bytes=${start}-${end}`;
      reqHeaders["Range"] = rangeRequested;
    }

    const response = await fetch(params.url, {
      method: isHead ? "HEAD" : "GET",
      headers: reqHeaders,
      signal,
    });

    // Ranged requests must receive 206; anything else means the server does not support ranges.
    if (isRanged && response.status !== 206) {
      throw new Error(
        `Range request failed: expected 206 Partial Content but got ${response.status} ${response.statusText}. ` +
        `The server may not support Range requests for this resource.`,
      );
    }

    // Build response header summary
    const headerLines: string[] = [];
    response.headers.forEach((value, key) => {
      headerLines.push(`${key}: ${value}`);
    });
    const contentRange = response.headers.get("content-range");

    // Read body (HEAD returns no body)
    let bodyText = "";
    let truncated = false;
    let bodyBytes = 0;
    if (!isHead) {
      const contentType = response.headers.get("content-type") ?? "";
      const isBinary =
        !contentType.includes("text") &&
        !contentType.includes("json") &&
        !contentType.includes("xml") &&
        !contentType.includes("javascript");

      const buffer = await response.arrayBuffer();
      const slice = buffer.byteLength > effectiveMax
        ? (truncated = true, buffer.slice(0, effectiveMax))
        : buffer;

      bodyText = isBinary
        ? `[base64] ${btoa(String.fromCharCode(...new Uint8Array(slice)))}`
        : new TextDecoder().decode(slice);

      bodyBytes = new TextEncoder().encode(bodyText).byteLength;
    }

    const parts: string[] = [
      `HTTP/${response.status} ${response.statusText}`,
      headerLines.join("\n"),
      "",
      bodyText,
    ];
    if (truncated) {
      parts.push(`\n[Response truncated at ${effectiveMax} bytes]`);
    }

    const text = parts.join("\n");

    return {
      content: [{ type: "text", text }],
      details: {
        url: params.url,
        method: isHead ? "HEAD" : "GET",
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        bodyBytes,
        truncated,
        ranged: isRanged,
        rangeRequested,
        contentRange,
      } satisfies FetchDetails,
    };
  }
}
```

---

## `ToolResult` and `details`

```typescript
interface FetchDetails {
  /** The URL that was requested. */
  url: string;
  /** HTTP method used: "GET" or "HEAD". */
  method: string;
  /** HTTP response status code. */
  status: number;
  /** HTTP response status text (e.g. "OK", "Partial Content"). */
  statusText: string;
  /** Value of the response Content-Type header, or null if absent. */
  contentType: string | null;
  /** Number of bytes of body text included in the result (after truncation). */
  bodyBytes: number;
  /** True if the response body was truncated due to maxBytes. */
  truncated: boolean;
  /** True if a Range header was sent in the request. */
  ranged: boolean;
  /** The Range header value sent, e.g. "bytes=0-1023". Null if not a ranged request. */
  rangeRequested: string | null;
  /** Value of the Content-Range response header, e.g. "bytes 0-1023/5242880". Null if absent. */
  contentRange: string | null;
}
```

---

## Security Constraints

The following constraints are enforced in `execute()` at runtime:

1. **Scheme allowlist** — only `https://` URLs are permitted. `http://`, `file://`, `data://`, and all other schemes throw immediately.
2. **SSRF guard** — requests to private IP ranges (`10.x`, `172.16–31.x`, `192.168.x`, `127.x`, `::1`, `169.254.x`, `localhost`) are rejected with an error before the request is made.
3. **`maxBytes` hard cap** — enforced server-side regardless of what the LLM passes; hard cap at 10 MiB.
4. **No custom request headers from LLM** — the only header the tool sends is `Range` when `byteStart`/`byteEnd` are provided. The LLM cannot inject arbitrary headers.

---

## Error Conditions

| Condition | Behaviour |
|---|---|
| Non-`https` scheme | Throws `Error("Unsupported scheme: …")` |
| Private/reserved IP target | Throws `Error("SSRF: private address not allowed: …")` |
| Ranged request but server returns non-206 | Throws `Error("Range request failed: expected 206 …")` |
| Network timeout / unreachable | Throws the underlying `fetch()` error |
| Response body exceeds `maxBytes` | Body truncated; `truncated: true` in `details`; notice appended to `content[0].text` |
| Non-2xx status (non-ranged) | Returned as a normal result (not thrown); LLM sees status in `content[0].text` |

---

## Tests

| Test | Coverage |
|---|---|
| `get` a JSON endpoint → status 200, headers, body in result | Happy path |
| `head` → no body, response headers present | HEAD action |
| `get` with `byteStart=0, byteEnd=999` → `Range` header sent, 206 response, `ranged: true` in details | Ranged GET |
| `get` with `byteStart` only (no `byteEnd`) → `Range: bytes=N-` sent | Open-ended range |
| `get` with range, server returns 200 → throws with 206 expected message | Range not supported |
| `get` with range, server returns 416 → throws | Range out of bounds |
| Response body > `maxBytes` → truncated with notice, `truncated: true` | Truncation |
| `maxBytes` hard cap at 10 MiB | Hard cap enforcement |
| Binary response (`image/png`) → `[base64]` prefix in body | Binary detection |
| `http://` URL → throws scheme error | Scheme guard |
| `file://` URL → throws scheme error | Scheme guard |
| Private IP (`192.168.1.1`) → throws SSRF error | SSRF guard |
| Private IP (`10.0.0.1`) → throws SSRF error | SSRF guard |
| Private IP (`127.0.0.1`) → throws SSRF error | SSRF loopback guard |
| Metadata IP (`169.254.169.254`) → throws SSRF error | CF metadata guard |
| Network error (mock `fetch` throws) → throws | Network error propagation |
| Non-2xx (404) non-ranged → result, not error | Non-2xx handling |

---

## Deployment

```bash
# 1. Deploy the tool Worker into the dispatch namespace
pnpm wrangler deploy --config extensions/fetch-tool/wrangler.template.jsonc \
  --dispatch-namespace piccolo-extensions

# 2. Register in KV
pnpm wrangler kv key put --binding CONFIG \
  --config packages/core/wrangler.jsonc \
  extensions:registry '["ext-fetch-tool"]'
```

No additional bindings are required. No `piccolo-core` redeploy needed — the extension registry is polled at session start. See [tools.md](tools.md) for the general deployment checklist.
