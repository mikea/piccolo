# Fetch Tool — Specification

Gives the LLM the ability to make HTTP requests to the public internet using the standard `fetch()` Web API. Suitable for reading web pages, calling external APIs, downloading files, and checking URLs.

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
  description: `Make an HTTP request to a public URL and return the response body.

Actions:
- get    : HTTP GET — retrieve a resource (default)
- post   : HTTP POST — send a body to an endpoint
- put    : HTTP PUT — replace a resource
- patch  : HTTP PATCH — partially update a resource
- delete : HTTP DELETE — remove a resource
- head   : HTTP HEAD — retrieve headers only, no body

Parameters:
  url       : The full URL to request (must include scheme, e.g. https://…)
  action    : One of "get", "post", "put", "patch", "delete", "head" (default: "get")
  headers?  : Key-value map of request headers to include
  body?     : Request body string (for post/put/patch). Use JSON.stringify for JSON payloads.
  bodyType? : MIME type of the body (default: "application/json"). Sent as Content-Type.
  maxBytes? : Maximum response body size to return in bytes (default: 1 048 576 = 1 MiB).
              Responses larger than this are truncated; a truncation notice is appended.

Response body is returned as UTF-8 text. Binary responses are base64-encoded and noted as such.
The response status code and headers are included in the result text.

Errors:
  Throws if the URL is not reachable, the scheme is not https/http, or the request times out.
  Non-2xx status codes do NOT throw — the status is included in the result so the LLM can react.`,

  promptSnippet: "Make HTTP requests to public URLs (GET, POST, PUT, PATCH, DELETE, HEAD)",

  promptGuidelines: [
    "Use fetch get to read a web page or call a REST API endpoint.",
    "Set the appropriate Content-Type via bodyType when posting JSON or form data.",
    "Always use https:// URLs. Plain http:// is allowed but should be avoided.",
    "Non-2xx responses are returned as results, not errors — check the status before acting on the body.",
    "Use fetch head to check existence or Content-Type of a resource without downloading its body.",
    "Avoid requesting very large binary files; use maxBytes to cap the download size.",
    "Do not use fetch to access localhost, internal IP ranges, or Cloudflare metadata endpoints.",
  ],

  inputSchema: z.object({
    action: z
      .enum(["get", "post", "put", "patch", "delete", "head"])
      .default("get")
      .describe('HTTP method to use. Default: "get".'),
    url: z.string().url().describe("Full URL to request, including scheme (https:// or http://)."),
    headers: z
      .record(z.string())
      .optional()
      .describe("Optional key-value map of HTTP request headers."),
    body: z
      .string()
      .optional()
      .describe("Request body string. Required for post/put/patch. Ignored for get/delete/head."),
    bodyType: z
      .string()
      .optional()
      .default("application/json")
      .describe('MIME type sent as Content-Type. Default: "application/json".'),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1_048_576)
      .describe("Maximum response body size in bytes. Default: 1 MiB. Larger responses are truncated."),
  }),
};
```

---

## Input Schema

| Field      | Type                                               | Required | Default              | Description                                                         |
|------------|----------------------------------------------------|----------|----------------------|---------------------------------------------------------------------|
| `action`   | `"get"\|"post"\|"put"\|"patch"\|"delete"\|"head"` | no       | `"get"`              | HTTP method                                                         |
| `url`      | `string` (URL)                                     | yes      | —                    | Fully qualified URL                                                 |
| `headers`  | `Record<string, string>`                           | no       | `{}`                 | Additional request headers                                          |
| `body`     | `string`                                           | no       | —                    | Request body (for post/put/patch)                                   |
| `bodyType` | `string`                                           | no       | `"application/json"` | `Content-Type` of the body                                          |
| `maxBytes` | `number`                                           | no       | `1_048_576`          | Max bytes of response body to read; surplus is truncated            |

---

## `execute` — Implementation

```typescript
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ITool, ISession, ToolResult } from "piccolo-core";

export default class FetchTool extends WorkerEntrypoint implements ITool {
  readonly descriptor = descriptor; // from above

  async execute(
    toolCallId: string,
    params: {
      action: "get" | "post" | "put" | "patch" | "delete" | "head";
      url: string;
      headers?: Record<string, string>;
      body?: string;
      bodyType?: string;
      maxBytes?: number;
    },
    ctx: ISession,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const method = params.action.toUpperCase();
    const maxBytes = params.maxBytes ?? 1_048_576;

    // Build request init
    const init: RequestInit = {
      method,
      headers: {
        "User-Agent": "piccolo-fetch-tool/1.0",
        ...(params.body !== undefined ? { "Content-Type": params.bodyType ?? "application/json" } : {}),
        ...params.headers,
      },
      signal,
    };
    if (params.body !== undefined && method !== "GET" && method !== "HEAD" && method !== "DELETE") {
      init.body = params.body;
    }

    const response = await fetch(params.url, init);

    // Build result header summary
    const headerLines: string[] = [];
    response.headers.forEach((value, key) => {
      headerLines.push(`${key}: ${value}`);
    });
    const headerBlock = headerLines.join("\n");

    // Read body (HEAD returns no body)
    let bodyText = "";
    let truncated = false;
    if (method !== "HEAD") {
      const contentType = response.headers.get("content-type") ?? "";
      const isBinary = !contentType.includes("text") && !contentType.includes("json") && !contentType.includes("xml") && !contentType.includes("javascript");

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        truncated = true;
        const slice = buffer.slice(0, maxBytes);
        bodyText = isBinary
          ? `[base64] ${btoa(String.fromCharCode(...new Uint8Array(slice)))}`
          : new TextDecoder().decode(slice);
      } else {
        bodyText = isBinary
          ? `[base64] ${btoa(String.fromCharCode(...new Uint8Array(buffer)))}`
          : new TextDecoder().decode(buffer);
      }
    }

    const parts: string[] = [
      `HTTP/${response.status} ${response.statusText}`,
      headerBlock,
      "",
      bodyText,
    ];
    if (truncated) {
      parts.push(`\n[Response truncated at ${maxBytes} bytes]`);
    }

    const text = parts.join("\n");

    return {
      content: [{ type: "text", text }],
      details: {
        url: params.url,
        method,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        bodyBytes: method !== "HEAD" ? Math.min((new TextEncoder().encode(bodyText)).byteLength, maxBytes) : 0,
        truncated,
      } satisfies FetchDetails,
    };
  }
}
```

---

## `ToolResult` and `details`

```typescript
interface FetchDetails {
  /** The URL that was requested (after any redirect resolution by the runtime). */
  url: string;
  /** Uppercase HTTP method used. */
  method: string;
  /** HTTP response status code. */
  status: number;
  /** HTTP response status text (e.g. "OK", "Not Found"). */
  statusText: string;
  /** Value of the response `Content-Type` header, or null if absent. */
  contentType: string | null;
  /** Number of bytes of the body included in the result (after truncation). */
  bodyBytes: number;
  /** True if the response body was truncated due to `maxBytes`. */
  truncated: boolean;
}
```

---

## Security Constraints

The following constraints are enforced in `execute()` at runtime:

1. **Scheme allowlist** — only `https://` and `http://` URLs are permitted. `file://`, `data://`, and other schemes throw immediately.
2. **SSRF guard** — requests to private IP ranges (`10.x`, `172.16–31.x`, `192.168.x`, `127.x`, `::1`, `169.254.x`) and the Cloudflare metadata endpoint (`169.254.169.254`) are rejected with an error before the request is made. URL resolution is performed before the check.
3. **`maxBytes` cap** — enforced server-side regardless of what the LLM passes; the implementation hard-caps at 10 MiB even if the caller requests more.
4. **`User-Agent`** — always set to `piccolo-fetch-tool/1.0`; cannot be overridden by the `headers` param.

---

## Error Conditions

| Condition | Behaviour |
|---|---|
| Non-`http`/`https` scheme | Throws `Error("Unsupported scheme: …")` |
| Private/reserved IP target | Throws `Error("SSRF: private address not allowed: …")` |
| Network timeout / unreachable | Throws the underlying `fetch()` error |
| Response body exceeds `maxBytes` | Body truncated; `truncated: true` in `details`; notice appended to `content[0].text` |
| Non-2xx status code | Returned as a normal result (not thrown); LLM sees status in `content[0].text` |

---

## Tests

| Test | Coverage |
|---|---|
| `get` a JSON endpoint → status 200, headers, body parsed | Happy path |
| `post` with JSON body → correct `Content-Type` forwarded | POST |
| `head` → no body in result | HEAD |
| `delete` → status 204, empty body | DELETE |
| Response body > `maxBytes` → truncated with notice | Truncation |
| Binary response → base64-encoded prefix in body | Binary |
| `https://` URL with redirect → follows redirect | Redirects |
| Private IP target → throws SSRF error | SSRF guard |
| `file://` URL → throws scheme error | Scheme guard |
| Network error (mock `fetch` throws) → throws | Network error |
| Non-2xx (404, 500) → result, not error | Non-2xx |

---

## Deployment

```bash
# 1. Deploy the tool Worker
wrangler deploy --name ext-fetch-tool \
  --dispatch-namespace piccolo-extensions

# 2. Register in KV
wrangler kv key put --binding CONFIG \
  extensions:registry '["ext-fetch-tool", "ext-r2-tool", "ext-d1-tool"]'
```

No additional bindings are required. See [tools.md](tools.md) for the general deployment checklist.
