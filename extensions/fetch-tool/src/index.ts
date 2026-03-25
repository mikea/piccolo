import { WorkerEntrypoint } from "cloudflare:workers";
import type { ISession, ITool, ToolDescriptor, ToolResult } from "@piccolo/core";
import { z } from "zod";

// ── Hard ceiling on maxBytes regardless of what the LLM requests ──────────────
const MAX_BYTES_HARD_CAP = 10 * 1_048_576; // 10 MiB

// ── Security helpers ──────────────────────────────────────────────────────────

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

// ── FetchDetails ──────────────────────────────────────────────────────────────

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

// ── ToolDescriptor ────────────────────────────────────────────────────────────

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

  promptSnippet:
    "Fetch the content of a public HTTPS URL (GET/HEAD, supports ranged GET for large files)",

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
    url: z.string().url().describe("Full HTTPS URL to request. Must begin with https://."),
    byteStart: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        '"get" only. First byte of the range to fetch, inclusive (0-based). ' +
          "Sends a Range: bytes=byteStart-byteEnd header. Requires 206 from server.",
      ),
    byteEnd: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        '"get" only. Last byte of the range to fetch, inclusive (0-based). ' +
          "If byteStart is set and byteEnd is omitted, fetches from byteStart to end of file.",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1_048_576)
      .describe(
        "Maximum response body size in bytes to include in the result. Default: 1 MiB. Larger responses are truncated.",
      ),
  }),
};

// ── FetchTool ─────────────────────────────────────────────────────────────────

export default class FetchTool extends WorkerEntrypoint implements ITool {
  readonly descriptor: ToolDescriptor = descriptor;

  async execute(
    _toolCallId: string,
    params: {
      action: "get" | "head";
      url: string;
      byteStart?: number;
      byteEnd?: number;
      maxBytes?: number;
    },
    _ctx: ISession,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const url = new URL(params.url);
    validateScheme(url);
    validateNotSsrf(url);

    const isHead = params.action === "head";
    const isRanged = !isHead && (params.byteStart !== undefined || params.byteEnd !== undefined);
    const effectiveMax = Math.min(params.maxBytes ?? 1_048_576, MAX_BYTES_HARD_CAP);

    // Build request headers — only Range is ever added (no LLM-controlled headers)
    const reqHeaders: Record<string, string> = {};
    let rangeRequested: string | null = null;
    if (isRanged) {
      const start = params.byteStart ?? 0;
      const end = params.byteEnd !== undefined ? String(params.byteEnd) : "";
      rangeRequested = `bytes=${start}-${end}`;
      // biome-ignore lint/complexity/useLiteralKeys: tsc noPropertyAccessFromIndexSignature requires bracket notation here
      reqHeaders["Range"] = rangeRequested;
    }

    const response = await fetch(params.url, {
      method: isHead ? "HEAD" : "GET",
      headers: reqHeaders,
      signal: signal ?? null,
    });

    // Ranged requests must receive 206; anything else means the server does not support ranges.
    if (isRanged && response.status !== 206) {
      throw new Error(
        `Range request failed: expected 206 Partial Content but got ${response.status} ${response.statusText}. ` +
          "The server may not support Range requests for this resource.",
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
      let slice: ArrayBuffer;
      if (buffer.byteLength > effectiveMax) {
        truncated = true;
        slice = buffer.slice(0, effectiveMax);
      } else {
        slice = buffer;
      }

      if (isBinary) {
        // Encode binary bodies as base64 so the LLM can read them
        const bytes = new Uint8Array(slice);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i] as number);
        }
        bodyText = `[base64] ${btoa(binary)}`;
      } else {
        bodyText = new TextDecoder().decode(slice);
      }

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

    const details: FetchDetails = {
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
    };

    return {
      content: [{ type: "text", text }],
      details,
    };
  }
}
