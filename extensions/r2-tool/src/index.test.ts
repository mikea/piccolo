import { afterEach, describe, expect, it, vi } from "vitest";
import { R2Tool, R2ToolExtension } from "./extension.ts";

// ── Mock helpers ──────────────────────────────────────────────────────────────

/** Build a minimal mock R2ObjectBody (returned by bucket.get). */
function mockR2ObjectBody(opts: {
  key?: string;
  size?: number;
  etag?: string;
  uploaded?: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  body?: string | Uint8Array;
}): R2ObjectBody {
  const {
    key = "test/file.txt",
    size = 0,
    etag = "abc123",
    uploaded = new Date("2024-01-01T00:00:00.000Z"),
    httpMetadata = {},
    customMetadata = {},
    body = "",
  } = opts;

  const bodyBytes = body instanceof Uint8Array ? body : new TextEncoder().encode(body);
  const arrayBuffer = bodyBytes.buffer as ArrayBuffer;

  return {
    key,
    version: "v1",
    size,
    etag,
    httpEtag: `"${etag}"`,
    uploaded,
    httpMetadata,
    customMetadata,
    checksums: {},
    storageClass: "Standard",
    range: undefined as unknown as R2Range,
    body: new ReadableStream(),
    bodyUsed: false,
    arrayBuffer: vi.fn().mockResolvedValue(arrayBuffer),
    text: vi
      .fn()
      .mockResolvedValue(typeof body === "string" ? body : new TextDecoder().decode(body)),
    json: vi.fn(),
    blob: vi.fn(),
    writeHttpMetadata: vi.fn(),
  } as unknown as R2ObjectBody;
}

/** Build a minimal mock R2Object (returned by bucket.head or bucket.put). */
function mockR2Object(opts: {
  key?: string;
  size?: number;
  etag?: string;
  uploaded?: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}): R2Object {
  const {
    key = "test/file.txt",
    size = 100,
    etag = "abc123",
    uploaded = new Date("2024-01-01T00:00:00.000Z"),
    httpMetadata = {},
    customMetadata = {},
  } = opts;

  return {
    key,
    version: "v1",
    size,
    etag,
    httpEtag: `"${etag}"`,
    uploaded,
    httpMetadata,
    customMetadata,
    checksums: {},
    storageClass: "Standard",
    range: undefined as unknown as R2Range,
    writeHttpMetadata: vi.fn(),
  } as unknown as R2Object;
}

/** Build a mock R2Bucket with all methods as vi.fn(). */
function makeMockBucket(overrides: Partial<R2Bucket> = {}): R2Bucket {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(mockR2Object({})),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({
      objects: [],
      truncated: false,
      delimitedPrefixes: [],
    }),
    head: vi.fn().mockResolvedValue(null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
    ...overrides,
  } as unknown as R2Bucket;
}

function makeTool(bucket = makeMockBucket()) {
  return new R2Tool(bucket);
}

// Minimal ISession stub — execute() only needs it passed, not used.
const ctx = {} as Parameters<R2Tool["execute"]>[2];

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Extension worker interface ─────────────────────────────────────────────────

describe("extension worker interface", () => {
  it("getTools returns an R2Tool whose descriptor name is 'r2'", async () => {
    const bucket = makeMockBucket();
    const ext = Object.create(R2ToolExtension.prototype) as R2ToolExtension;
    (ext as unknown as { env: { BUCKET: R2Bucket } }).env = { BUCKET: bucket };

    const tools = await ext.getTools({} as Parameters<R2ToolExtension["getTools"]>[0]);
    expect(tools).toHaveLength(1);
    const desc = await tools[0]!.getDescriptor();
    expect(desc.name).toBe("r2");
  });

  it("fetch() returns 200 OK", () => {
    const ext = Object.create(R2ToolExtension.prototype) as R2ToolExtension;
    (ext as unknown as { env: { BUCKET: R2Bucket } }).env = { BUCKET: makeMockBucket() };
    const response = ext.fetch();
    expect(response.status).toBe(200);
  });
});

// ── Descriptor ─────────────────────────────────────────────────────────────────

describe("getDescriptor", () => {
  it("returns name 'r2'", async () => {
    expect((await makeTool().getDescriptor()).name).toBe("r2");
  });

  it("has all 7 actions documented in description", async () => {
    const { description } = await makeTool().getDescriptor();
    for (const action of ["read", "write", "delete", "list", "stat", "copy", "move"]) {
      expect(description).toContain(action);
    }
  });
});

// ── read — happy path ──────────────────────────────────────────────────────────

describe("read — happy path", () => {
  it("returns object content as text and populates details", async () => {
    const body = "hello world";
    const obj = mockR2ObjectBody({
      key: "docs/readme.txt",
      size: body.length,
      etag: "etag1",
      uploaded: new Date("2024-06-01T12:00:00.000Z"),
      httpMetadata: { contentType: "text/plain" },
      body,
    });
    const tool = makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) }));

    const result = await tool.execute("id1", { action: "read", key: "docs/readme.txt" }, ctx);

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("hello world");

    const details = result.details as {
      key: string;
      size: number;
      contentType: string;
      lastModified: string;
      ranged: boolean;
      truncated: boolean;
      returnedBytes: number;
    };
    expect(details.key).toBe("docs/readme.txt");
    expect(details.size).toBe(body.length);
    expect(details.contentType).toBe("text/plain");
    expect(details.lastModified).toBe("2024-06-01T12:00:00.000Z");
    expect(details.ranged).toBe(false);
    expect(details.truncated).toBe(false);
    expect(details.returnedBytes).toBeGreaterThan(0);
  });

  it("calls bucket.get with no options when no range params supplied", async () => {
    const obj = mockR2ObjectBody({ body: "data" });
    const getMock = vi.fn().mockResolvedValue(obj);
    await makeTool(makeMockBucket({ get: getMock })).execute(
      "id",
      { action: "read", key: "k" },
      ctx,
    );
    expect(getMock).toHaveBeenCalledWith("k", undefined);
  });
});

// ── read — binary detection ────────────────────────────────────────────────────

describe("read — binary detection", () => {
  it("auto-detects binary content type and returns [base64] prefix", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const obj = mockR2ObjectBody({ httpMetadata: { contentType: "image/png" }, body: pngBytes });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id2",
      { action: "read", key: "img.png" },
      ctx,
    );
    expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/^\[base64\] /);
  });

  it("does not base64-encode text/plain content", async () => {
    const obj = mockR2ObjectBody({
      httpMetadata: { contentType: "text/plain" },
      body: "plain text",
    });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id3",
      { action: "read", key: "f.txt" },
      ctx,
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("[base64]");
    expect(text).toContain("plain text");
  });

  it("does not base64-encode application/json content", async () => {
    const obj = mockR2ObjectBody({
      httpMetadata: { contentType: "application/json" },
      body: '{"ok":true}',
    });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id4",
      { action: "read", key: "d.json" },
      ctx,
    );
    expect((result.content[0] as { type: "text"; text: string }).text).toContain('{"ok":true}');
  });
});

// ── read — explicit base64 encoding ───────────────────────────────────────────

describe("read — explicit base64 encoding", () => {
  it("encoding=base64 always base64-encodes even text content", async () => {
    const obj = mockR2ObjectBody({ httpMetadata: { contentType: "text/plain" }, body: "hello" });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id5",
      { action: "read", key: "f.txt", encoding: "base64" },
      ctx,
    );
    expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/^\[base64\] /);
  });
});

// ── read — byte-range reads ────────────────────────────────────────────────────

describe("read — byte-range reads", () => {
  it("passes byteOffset+byteLength as R2 range option", async () => {
    const obj = mockR2ObjectBody({ body: "0123456789" });
    const getMock = vi.fn().mockResolvedValue(obj);
    await makeTool(makeMockBucket({ get: getMock })).execute(
      "id6",
      { action: "read", key: "f", byteOffset: 2, byteLength: 5 },
      ctx,
    );
    expect(getMock).toHaveBeenCalledWith("f", { range: { offset: 2, length: 5 } });

    const result2 = await makeTool(
      makeMockBucket({ get: vi.fn().mockResolvedValue(mockR2ObjectBody({ body: "data" })) }),
    ).execute("id6b", { action: "read", key: "f", byteOffset: 2, byteLength: 5 }, ctx);
    expect((result2.details as { ranged: boolean }).ranged).toBe(true);
  });

  it("passes byteOffset only as R2 range offset", async () => {
    const getMock = vi.fn().mockResolvedValue(mockR2ObjectBody({ body: "data" }));
    await makeTool(makeMockBucket({ get: getMock })).execute(
      "id7",
      { action: "read", key: "k", byteOffset: 10 },
      ctx,
    );
    expect(getMock).toHaveBeenCalledWith("k", { range: { offset: 10 } });
  });

  it("passes byteLength only as R2 range length", async () => {
    const getMock = vi.fn().mockResolvedValue(mockR2ObjectBody({ body: "data" }));
    await makeTool(makeMockBucket({ get: getMock })).execute(
      "id8",
      { action: "read", key: "k", byteLength: 100 },
      ctx,
    );
    expect(getMock).toHaveBeenCalledWith("k", { range: { length: 100 } });
  });

  it("passes suffix as R2 range suffix", async () => {
    const getMock = vi.fn().mockResolvedValue(mockR2ObjectBody({ body: "data" }));
    await makeTool(makeMockBucket({ get: getMock })).execute(
      "id9",
      { action: "read", key: "k", suffix: 50 },
      ctx,
    );
    expect(getMock).toHaveBeenCalledWith("k", { range: { suffix: 50 } });
  });
});

// ── read — maxBytes truncation ─────────────────────────────────────────────────

describe("read — truncation", () => {
  it("truncates body when response exceeds maxBytes", async () => {
    const obj = mockR2ObjectBody({
      httpMetadata: { contentType: "text/plain" },
      body: "x".repeat(200),
    });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id10",
      { action: "read", key: "big.txt", maxBytes: 50 },
      ctx,
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[Response truncated at 50 bytes]");
    const details = result.details as { truncated: boolean; returnedBytes: number };
    expect(details.truncated).toBe(true);
    expect(details.returnedBytes).toBeLessThanOrEqual(50);
  });

  it("does not truncate when body is within maxBytes", async () => {
    const obj = mockR2ObjectBody({ httpMetadata: { contentType: "text/plain" }, body: "hello" });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id11",
      { action: "read", key: "f.txt", maxBytes: 1000 },
      ctx,
    );
    expect((result.details as { truncated: boolean }).truncated).toBe(false);
  });

  it("hard-caps maxBytes at 10 MiB", async () => {
    const obj = mockR2ObjectBody({
      httpMetadata: { contentType: "text/plain" },
      body: "y".repeat(50),
    });
    const result = await makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(obj) })).execute(
      "id12",
      { action: "read", key: "f.txt", maxBytes: 20 * 1_048_576 },
      ctx,
    );
    expect((result.details as { truncated: boolean }).truncated).toBe(false);
  });
});

// ── read — not found ───────────────────────────────────────────────────────────

describe("read — not found", () => {
  it("throws when bucket.get returns null", async () => {
    await expect(
      makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(null) })).execute(
        "id13",
        { action: "read", key: "missing.txt" },
        ctx,
      ),
    ).rejects.toThrow("Not found: missing.txt");
  });
});

// ── write ──────────────────────────────────────────────────────────────────────

describe("write", () => {
  it("calls bucket.put with string body and returns confirmation with correct size", async () => {
    const putMock = vi
      .fn()
      .mockResolvedValue(mockR2Object({ key: "out.txt", size: 5, etag: "etag99" }));
    const result = await makeTool(makeMockBucket({ put: putMock })).execute(
      "id14",
      { action: "write", key: "out.txt", content: "hello" },
      ctx,
    );

    expect(putMock).toHaveBeenCalledWith("out.txt", "hello", expect.any(Object));
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Written: out.txt");
    expect(text).toContain("5 bytes");
    const details = result.details as { key: string; etag: string; size: number };
    expect(details.key).toBe("out.txt");
    expect(details.etag).toBe("etag99");
    expect(details.size).toBe(5);
  });

  it("decodes base64 content and calls put with Uint8Array when binary=true", async () => {
    const putMock = vi.fn().mockResolvedValue(mockR2Object({ key: "img.png", size: 4 }));
    await makeTool(makeMockBucket({ put: putMock })).execute(
      "id15",
      { action: "write", key: "img.png", content: btoa("\x89PNG"), binary: true },
      ctx,
    );
    const calledBody = putMock.mock.calls[0]?.[1];
    expect(calledBody).toBeInstanceOf(Uint8Array);
    expect((calledBody as Uint8Array)[0]).toBe(0x89);
  });

  it("passes contentType in httpMetadata when provided", async () => {
    const putMock = vi.fn().mockResolvedValue(mockR2Object({}));
    await makeTool(makeMockBucket({ put: putMock })).execute(
      "id16",
      { action: "write", key: "f.json", content: "{}", contentType: "application/json" },
      ctx,
    );
    const options = putMock.mock.calls[0]?.[2] as R2PutOptions;
    expect((options.httpMetadata as R2HTTPMetadata)?.contentType).toBe("application/json");
  });

  it("does not set httpMetadata when contentType is omitted", async () => {
    const putMock = vi.fn().mockResolvedValue(mockR2Object({}));
    await makeTool(makeMockBucket({ put: putMock })).execute(
      "id17",
      { action: "write", key: "f.txt", content: "text" },
      ctx,
    );
    const options = putMock.mock.calls[0]?.[2] as R2PutOptions;
    expect(options.httpMetadata).toBeUndefined();
  });

  it("passes customMetadata when metadata is provided", async () => {
    const putMock = vi.fn().mockResolvedValue(mockR2Object({}));
    await makeTool(makeMockBucket({ put: putMock })).execute(
      "id18",
      { action: "write", key: "f.txt", content: "x", metadata: { author: "alice" } },
      ctx,
    );
    const options = putMock.mock.calls[0]?.[2] as R2PutOptions;
    expect(options.customMetadata).toEqual({ author: "alice" });
  });
});

// ── delete ─────────────────────────────────────────────────────────────────────

describe("delete", () => {
  it("calls bucket.delete with the keys array and returns count", async () => {
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const result = await makeTool(makeMockBucket({ delete: deleteMock })).execute(
      "id19",
      { action: "delete", keys: ["a/b.txt", "c/d.txt"] },
      ctx,
    );

    expect(deleteMock).toHaveBeenCalledWith(["a/b.txt", "c/d.txt"]);
    expect((result.content[0] as { type: "text"; text: string }).text).toBe("Deleted 2 object(s)");
    expect((result.details as { deletedKeys: string[] }).deletedKeys).toEqual([
      "a/b.txt",
      "c/d.txt",
    ]);
  });
});

// ── list ───────────────────────────────────────────────────────────────────────

describe("list", () => {
  it("returns objects and prefixes for a delimiter-based listing", async () => {
    const listResult = {
      objects: [
        mockR2Object({ key: "src/a.ts", size: 100, etag: "e1", uploaded: new Date("2024-01-01") }),
        mockR2Object({ key: "src/b.ts", size: 200, etag: "e2", uploaded: new Date("2024-01-02") }),
      ],
      truncated: false,
      delimitedPrefixes: ["src/utils/"],
    };
    const listMock = vi.fn().mockResolvedValue(listResult);
    const result = await makeTool(makeMockBucket({ list: listMock })).execute(
      "id20",
      { action: "list", prefix: "src/", delimiter: "/" },
      ctx,
    );

    expect(listMock).toHaveBeenCalledWith({ limit: 100, prefix: "src/", delimiter: "/" });
    const details = result.details as {
      objects: Array<{ key: string }>;
      prefixes: string[];
      truncated: boolean;
      cursor: undefined;
    };
    expect(details.objects).toHaveLength(2);
    expect(details.objects[0]?.key).toBe("src/a.ts");
    expect(details.prefixes).toEqual(["src/utils/"]);
    expect(details.truncated).toBe(false);
    expect(details.cursor).toBeUndefined();
  });

  it("includes cursor in details when result is truncated", async () => {
    const listResult = {
      objects: [mockR2Object({ key: "f1.txt", size: 10, etag: "e1", uploaded: new Date() })],
      truncated: true,
      delimitedPrefixes: [],
      cursor: "next-page-token",
    };
    const result = await makeTool(
      makeMockBucket({ list: vi.fn().mockResolvedValue(listResult) }),
    ).execute("id21", { action: "list" }, ctx);
    const details = result.details as { truncated: boolean; cursor: string };
    expect(details.truncated).toBe(true);
    expect(details.cursor).toBe("next-page-token");
  });

  it("passes cursor param to bucket.list", async () => {
    const listMock = vi
      .fn()
      .mockResolvedValue({ objects: [], truncated: false, delimitedPrefixes: [] });
    await makeTool(makeMockBucket({ list: listMock })).execute(
      "id22",
      { action: "list", cursor: "next-page-token" },
      ctx,
    );
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next-page-token" }));
  });

  it("does not pass prefix to bucket.list when prefix is the default empty string", async () => {
    const listMock = vi
      .fn()
      .mockResolvedValue({ objects: [], truncated: false, delimitedPrefixes: [] });
    await makeTool(makeMockBucket({ list: listMock })).execute("id23", { action: "list" }, ctx);
    const calledOptions = listMock.mock.calls[0]?.[0] as R2ListOptions;
    expect(calledOptions.prefix).toBeUndefined();
  });
});

// ── stat ───────────────────────────────────────────────────────────────────────

describe("stat", () => {
  it("returns metadata without downloading body", async () => {
    const obj = mockR2Object({
      key: "data.bin",
      size: 1024,
      etag: "abc",
      uploaded: new Date("2024-03-15T10:00:00.000Z"),
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { version: "2" },
    });
    const headMock = vi.fn().mockResolvedValue(obj);
    const getMock = vi.fn();
    const result = await makeTool(makeMockBucket({ head: headMock, get: getMock })).execute(
      "id24",
      { action: "stat", key: "data.bin" },
      ctx,
    );

    expect(headMock).toHaveBeenCalledWith("data.bin");
    expect(getMock).not.toHaveBeenCalled();

    const details = result.details as {
      key: string;
      size: number;
      etag: string;
      contentType: string;
      lastModified: string;
      customMetadata: Record<string, string>;
    };
    expect(details.key).toBe("data.bin");
    expect(details.size).toBe(1024);
    expect(details.etag).toBe("abc");
    expect(details.contentType).toBe("application/octet-stream");
    expect(details.lastModified).toBe("2024-03-15T10:00:00.000Z");
    expect(details.customMetadata).toEqual({ version: "2" });
  });

  it("throws when bucket.head returns null", async () => {
    await expect(
      makeTool(makeMockBucket({ head: vi.fn().mockResolvedValue(null) })).execute(
        "id25",
        { action: "stat", key: "ghost.txt" },
        ctx,
      ),
    ).rejects.toThrow("Not found: ghost.txt");
  });
});

// ── copy ───────────────────────────────────────────────────────────────────────

describe("copy", () => {
  it("calls get then put and returns both keys in details", async () => {
    const obj = mockR2ObjectBody({ key: "src/a.txt", httpMetadata: { contentType: "text/plain" } });
    const getMock = vi.fn().mockResolvedValue(obj);
    const putMock = vi.fn().mockResolvedValue(mockR2Object({}));
    const result = await makeTool(makeMockBucket({ get: getMock, put: putMock })).execute(
      "id26",
      { action: "copy", sourceKey: "src/a.txt", destKey: "dst/a.txt" },
      ctx,
    );

    expect(getMock).toHaveBeenCalledWith("src/a.txt");
    expect(putMock).toHaveBeenCalledWith("dst/a.txt", obj.body, expect.any(Object));
    const details = result.details as { sourceKey: string; destKey: string };
    expect(details.sourceKey).toBe("src/a.txt");
    expect(details.destKey).toBe("dst/a.txt");
  });

  it("throws when source key does not exist", async () => {
    await expect(
      makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(null) })).execute(
        "id27",
        { action: "copy", sourceKey: "nope.txt", destKey: "dst.txt" },
        ctx,
      ),
    ).rejects.toThrow("Not found: nope.txt");
  });
});

// ── move ───────────────────────────────────────────────────────────────────────

describe("move", () => {
  it("calls get, put, then delete in order", async () => {
    const callOrder: string[] = [];
    const obj = mockR2ObjectBody({ key: "src.txt" });
    const getMock = vi.fn().mockImplementation(() => {
      callOrder.push("get");
      return Promise.resolve(obj);
    });
    const putMock = vi.fn().mockImplementation(() => {
      callOrder.push("put");
      return Promise.resolve(mockR2Object({}));
    });
    const deleteMock = vi.fn().mockImplementation(() => {
      callOrder.push("delete");
      return Promise.resolve();
    });

    await makeTool(makeMockBucket({ get: getMock, put: putMock, delete: deleteMock })).execute(
      "id28",
      { action: "move", sourceKey: "src.txt", destKey: "dst.txt" },
      ctx,
    );

    expect(callOrder).toEqual(["get", "put", "delete"]);
    expect(deleteMock).toHaveBeenCalledWith("src.txt");
  });

  it("does NOT call delete when put fails (atomicity guarantee)", async () => {
    const obj = mockR2ObjectBody({ key: "src.txt" });
    const deleteMock = vi.fn();

    await expect(
      makeTool(
        makeMockBucket({
          get: vi.fn().mockResolvedValue(obj),
          put: vi.fn().mockRejectedValue(new Error("put failed")),
          delete: deleteMock,
        }),
      ).execute("id29", { action: "move", sourceKey: "src.txt", destKey: "dst.txt" }, ctx),
    ).rejects.toThrow("put failed");

    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("throws when source key does not exist", async () => {
    await expect(
      makeTool(makeMockBucket({ get: vi.fn().mockResolvedValue(null) })).execute(
        "id30",
        { action: "move", sourceKey: "ghost.txt", destKey: "dst.txt" },
        ctx,
      ),
    ).rejects.toThrow("Not found: ghost.txt");
  });
});

// ── invalid params ─────────────────────────────────────────────────────────────

describe("invalid params", () => {
  it("throws for unknown action", async () => {
    await expect(
      makeTool().execute("id99", { action: "unknown", key: "k" }, ctx),
    ).rejects.toThrow();
  });

  it("throws for missing required key on read", async () => {
    await expect(makeTool().execute("id100", { action: "read" }, ctx)).rejects.toThrow();
  });

  it("throws for delete with empty keys array", async () => {
    await expect(
      makeTool().execute("id101", { action: "delete", keys: [] }, ctx),
    ).rejects.toThrow();
  });
});
