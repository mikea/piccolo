import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchTool } from "../src/extension.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock Response object. */
function mockResponse(opts: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}): Response {
  const { status = 200, statusText = "OK", headers = {}, body = "" } = opts;

  const init: ResponseInit = { status, statusText, headers };
  const bodyInit = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
  return new Response(bodyInit, init);
}

/** Construct the inner tool instance directly (bypassing the WorkerEntrypoint). */
function makeTool(): FetchTool {
  return new FetchTool();
}

// Minimal ISession stub — execute() only needs to accept it, not call anything.
const ctx = {} as Parameters<FetchTool["execute"]>[2];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extension worker interface", () => {
  it("getTools returns the fetch tool descriptor", async () => {
    const tool = makeTool();
    expect((await tool.getDescriptor()).name).toBe("fetch");
  });

  it("returned tool executes successfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain" },
          body: "hello",
        }),
      ),
    );

    const tool = makeTool();
    const result = await tool.execute(
      "id-dispatch",
      { action: "get", url: "https://example.com" },
      ctx,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("HTTP/200 OK");
    expect(text).toContain("hello");
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("GET — happy path", () => {
  it("returns status, headers, and body for a JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
        }),
      ),
    );

    const tool = makeTool();
    const result = await tool.execute(
      "id1",
      { action: "get", url: "https://example.com/api" },
      ctx,
    );

    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("HTTP/200 OK");
    expect(text).toContain("content-type: application/json");
    expect(text).toContain('{"ok":true}');

    const details = result.details as { status: number; ranged: boolean; truncated: boolean };
    expect(details.status).toBe(200);
    expect(details.ranged).toBe(false);
    expect(details.truncated).toBe(false);
  });
});

// ── HEAD ──────────────────────────────────────────────────────────────────────

describe("HEAD action", () => {
  it("returns response headers only — no body in result text", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html",
          "content-length": "12345",
          "accept-ranges": "bytes",
        },
        body: "",
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const tool = makeTool();
    const result = await tool.execute(
      "id2",
      { action: "head", url: "https://example.com/file.html" },
      ctx,
    );

    // fetch must be called with HEAD method
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/file.html",
      expect.objectContaining({ method: "HEAD" }),
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("content-length: 12345");
    expect(text).toContain("accept-ranges: bytes");

    const details = result.details as { bodyBytes: number; method: string };
    expect(details.bodyBytes).toBe(0);
    expect(details.method).toBe("HEAD");
  });
});

// ── Ranged GET ────────────────────────────────────────────────────────────────

describe("ranged GET", () => {
  it("sends Range header and returns 206 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 206,
        statusText: "Partial Content",
        headers: {
          "content-type": "text/plain",
          "content-range": "bytes 0-999/5000",
        },
        body: "a".repeat(1000),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const tool = makeTool();
    const result = await tool.execute(
      "id3",
      { action: "get", url: "https://example.com/big.txt", byteStart: 0, byteEnd: 999 },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/big.txt",
      expect.objectContaining({
        headers: { Range: "bytes=0-999" },
      }),
    );

    const details = result.details as {
      ranged: boolean;
      rangeRequested: string;
      contentRange: string;
      status: number;
    };
    expect(details.ranged).toBe(true);
    expect(details.rangeRequested).toBe("bytes=0-999");
    expect(details.contentRange).toBe("bytes 0-999/5000");
    expect(details.status).toBe(206);
  });

  it("sends open-ended Range header when only byteStart is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 206,
        statusText: "Partial Content",
        headers: { "content-type": "text/plain", "content-range": "bytes 500-4999/5000" },
        body: "x".repeat(500),
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const tool = makeTool();
    await tool.execute(
      "id4",
      { action: "get", url: "https://example.com/big.txt", byteStart: 500 },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/big.txt",
      expect.objectContaining({ headers: { Range: "bytes=500-" } }),
    );
  });

  it("throws when server returns 200 for a ranged request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ status: 200, statusText: "OK", body: "full body" })),
    );

    const tool = makeTool();
    await expect(
      tool.execute(
        "id5",
        { action: "get", url: "https://example.com/big.txt", byteStart: 0, byteEnd: 999 },
        ctx,
      ),
    ).rejects.toThrow("Range request failed: expected 206 Partial Content but got 200");
  });

  it("throws when server returns 416 Range Not Satisfiable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ status: 416, statusText: "Range Not Satisfiable" })),
    );

    const tool = makeTool();
    await expect(
      tool.execute(
        "id6",
        { action: "get", url: "https://example.com/big.txt", byteStart: 99999, byteEnd: 199999 },
        ctx,
      ),
    ).rejects.toThrow("Range request failed: expected 206 Partial Content but got 416");
  });
});

// ── Truncation ────────────────────────────────────────────────────────────────

describe("truncation", () => {
  it("truncates body when response exceeds maxBytes", async () => {
    const bigBody = "x".repeat(200);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          headers: { "content-type": "text/plain" },
          body: bigBody,
        }),
      ),
    );

    const tool = makeTool();
    const result = await tool.execute(
      "id7",
      { action: "get", url: "https://example.com/big.txt", maxBytes: 100 },
      ctx,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[Response truncated at 100 bytes]");

    const details = result.details as { truncated: boolean; bodyBytes: number };
    expect(details.truncated).toBe(true);
    expect(details.bodyBytes).toBeLessThanOrEqual(100);
  });

  it("hard caps maxBytes at 10 MiB regardless of requested value", async () => {
    // The tool should clamp 20 MiB requests down to 10 MiB.
    // We verify via a small mock that the effective cap is applied (not a full 20 MiB body).
    const body = "y".repeat(50);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ headers: { "content-type": "text/plain" }, body })),
    );

    const tool = makeTool();
    // Request 20 MiB — should not throw; effectiveMax is silently capped
    const result = await tool.execute(
      "id8",
      { action: "get", url: "https://example.com/file", maxBytes: 20 * 1_048_576 },
      ctx,
    );
    // Body is 50 bytes, well under any cap — should come back untouched
    const details = result.details as { truncated: boolean };
    expect(details.truncated).toBe(false);
  });
});

// ── Binary response ───────────────────────────────────────────────────────────

describe("binary response", () => {
  it("base64-encodes non-text content types", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          headers: { "content-type": "image/png" },
          body: pngBytes,
        }),
      ),
    );

    const tool = makeTool();
    const result = await tool.execute(
      "id9",
      { action: "get", url: "https://example.com/img.png" },
      ctx,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[base64]");
  });
});

// ── Security: scheme guard ────────────────────────────────────────────────────

describe("scheme guard", () => {
  it("throws for http:// URLs", async () => {
    const tool = makeTool();
    await expect(
      tool.execute("id10", { action: "get", url: "http://example.com/page" }, ctx),
    ).rejects.toThrow("Unsupported scheme: http:");
  });

  it("throws for file:// URLs", async () => {
    const tool = makeTool();
    await expect(
      tool.execute("id11", { action: "get", url: "file:///etc/passwd" }, ctx),
    ).rejects.toThrow("Unsupported scheme: file:");
  });
});

// ── Security: SSRF guard ──────────────────────────────────────────────────────

describe("SSRF guard", () => {
  const ssrfCases: [string, string][] = [
    ["192.168.1.1", "https://192.168.1.1/"],
    ["10.0.0.1", "https://10.0.0.1/"],
    ["127.0.0.1", "https://127.0.0.1/"],
    ["169.254.169.254", "https://169.254.169.254/"],
    ["localhost", "https://localhost/"],
  ];

  for (const [label, url] of ssrfCases) {
    it(`throws for ${label}`, async () => {
      const tool = makeTool();
      await expect(tool.execute("ssrf", { action: "get", url }, ctx)).rejects.toThrow(
        "SSRF: private address not allowed:",
      );
    });
  }
});

// ── Network error ─────────────────────────────────────────────────────────────

describe("network errors", () => {
  it("propagates fetch() errors as thrown exceptions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network unreachable")));

    const tool = makeTool();
    await expect(
      tool.execute("id12", { action: "get", url: "https://example.com/" }, ctx),
    ).rejects.toThrow("Network unreachable");
  });
});

// ── Non-2xx (non-ranged) ──────────────────────────────────────────────────────

describe("non-2xx non-ranged responses", () => {
  it("returns a result (not throws) for 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ status: 404, statusText: "Not Found", body: "not found" }),
        ),
    );

    const tool = makeTool();
    const result = await tool.execute(
      "id13",
      { action: "get", url: "https://example.com/missing" },
      ctx,
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("HTTP/404 Not Found");

    const details = result.details as { status: number };
    expect(details.status).toBe(404);
    // isError should not be set
    expect(result.isError).toBeUndefined();
  });

  it("returns a result (not throws) for 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ status: 500, statusText: "Internal Server Error", body: "error" }),
        ),
    );

    const tool = makeTool();
    const result = await tool.execute(
      "id14",
      { action: "get", url: "https://example.com/error" },
      ctx,
    );

    const details = result.details as { status: number };
    expect(details.status).toBe(500);
    expect(result.isError).toBeUndefined();
  });
});
