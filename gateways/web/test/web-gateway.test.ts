/**
 * Integration tests for piccolo-web-gateway (step 10).
 *
 * Tests are structured around the gateway classes directly rather than through
 * the full HTTP fetch handler, since the Cap'n Web RPC layer (newWorkersRpcResponse)
 * requires a real WebSocket connection to test end-to-end. The HTTP routing and
 * auth tests do exercise the fetch handler directly.
 *
 * Test groups:
 *   1. HTTP routing (fetch handler)
 *   2. Auth (authenticateUser)
 *   3. WebGatewayImpl — session management and model listing
 *   4. WebGatewaySessionImpl — session methods
 *   5. prompt() → TurnHandleImpl → listener events
 *   6. TurnHandleImpl.abort()
 *   7. Event enrichment (enrichEvent)
 *   8. WebGatewaySessionImpl.fork()
 *   9. WebUiSessionDO — fan-out and buffer
 *   10. assets serving
 *
 * Spec refs:
 *   specs/api.md §6  IWebGatewayApi, IWebGatewaySession, ITurnHandle
 *   specs/web_gateway.md
 */

import { env, runInDurableObject } from "cloudflare:test";
import type { AgentEvent } from "@piccolo/core";
import { describe, expect, it, vi } from "vitest";
import { serveComponent, serveSpaShell } from "../src/assets.ts";
import { authenticateUser } from "../src/auth.ts";
import { enrichEvent } from "../src/event-enrichment.ts";
import type { WebAgentEvent } from "../src/types.ts";
import { WebGatewayImpl, WebGatewaySessionImpl } from "../src/web-gateway.ts";
import type { WebUiSessionDO } from "../src/web-ui-session-do.ts";
import { createEventStream, createMockCore, createMockSession } from "./mocks/piccolo-core.ts";
import { createMockCallback, createMockListener, devAuthHeaders } from "./mocks/rpc-stubs.ts";

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Create a minimal Env for tests. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CORE: {} as Env["CORE"],
    WEB_UI_SESSION: {} as Env["WEB_UI_SESSION"],
    ASSETS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
      head: vi.fn().mockResolvedValue(null),
    } as unknown as Env["ASSETS"],
    AUTH_SECRET: "test-auth-secret",
    ...overrides,
  };
}

// ─── 1. HTTP routing ─────────────────────────────────────────────────────────

describe("fetch handler routing", () => {
  it("GET / returns 404 when R2 has no index.html", async () => {
    const env = makeEnv();
    const res = await serveSpaShell(env);
    expect(res.status).toBe(404);
  });

  it("GET / returns HTML when index.html exists in R2", async () => {
    const mockBody = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<html>"));
        c.close();
      },
    });
    const env = makeEnv({
      ASSETS: {
        get: vi.fn().mockResolvedValue({ body: mockBody }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        head: vi.fn(),
      } as unknown as Env["ASSETS"],
    });
    const res = await serveSpaShell(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /components/foo.js returns 404 when component not in R2", async () => {
    const env = makeEnv();
    const res = await serveComponent("/components/foo.js", env);
    expect(res.status).toBe(404);
  });

  it("GET /components/foo.js returns JS when component exists in R2", async () => {
    const jsBody = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("export default {}"));
        c.close();
      },
    });
    const env = makeEnv({
      ASSETS: {
        get: vi.fn().mockResolvedValue({ body: jsBody }),
        put: vi.fn(),
        delete: vi.fn(),
        list: vi.fn(),
        head: vi.fn(),
      } as unknown as Env["ASSETS"],
    });
    const res = await serveComponent("/components/foo.js", env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  it("GET /components/../secret.js is rejected (invalid key)", async () => {
    const env = makeEnv();
    const res = await serveComponent("/components/../secret.js", env);
    expect(res.status).toBe(404);
  });
});

// ─── 2. Auth ──────────────────────────────────────────────────────────────────

describe("authenticateUser", () => {
  it("returns null when no JWT and no dev-auth", async () => {
    const req = new Request("https://example.com/rpc");
    // Omit AUTH_SECRET entirely (no dev-auth bypass)
    const env = makeEnv();
    delete (env as Partial<Env>).AUTH_SECRET;
    expect(await authenticateUser(req, env)).toBeNull();
  });

  it("returns userId from dev-auth headers when AUTH_SECRET matches", async () => {
    const req = new Request("https://example.com/rpc", {
      headers: devAuthHeaders("user-123"),
    });
    const env = makeEnv({ AUTH_SECRET: "test-auth-secret" });
    expect(await authenticateUser(req, env)).toBe("user-123");
  });

  it("returns null when dev-auth secret does not match", async () => {
    const req = new Request("https://example.com/rpc", {
      headers: {
        "x-dev-auth": "wrong-secret",
        "x-dev-user-id": "user-123",
      },
    });
    const env = makeEnv({ AUTH_SECRET: "test-auth-secret" });
    expect(await authenticateUser(req, env)).toBeNull();
  });

  it("returns null when AUTH_SECRET is set but x-dev-auth header is missing", async () => {
    const req = new Request("https://example.com/rpc", {
      headers: { "x-dev-user-id": "user-123" },
    });
    const env = makeEnv({ AUTH_SECRET: "test-auth-secret" });
    expect(await authenticateUser(req, env)).toBeNull();
  });
});

// ─── 3. WebGatewayImpl ────────────────────────────────────────────────────────

describe("WebGatewayImpl", () => {
  it("newSession() returns an IWebGatewaySession synchronously", () => {
    const core = createMockCore();
    const gateway = new WebGatewayImpl(core, "user-1", makeEnv());
    const session = gateway.newSession();
    expect(session).toBeDefined();
    // Session methods are available immediately (pipelining)
    expect(typeof session.id).toBe("function");
  });

  it("getSession() returns an IWebGatewaySession synchronously", () => {
    const core = createMockCore();
    const gateway = new WebGatewayImpl(core, "user-1", makeEnv());
    const session = gateway.getSession("existing-session-id");
    expect(session).toBeDefined();
    expect(typeof session.prompt).toBe("function");
  });

  it("listSessions() returns SessionInfo[] mapped from SessionRecord[]", async () => {
    const mockSession = createMockSession({}, { sessionId: "test-session-id", userId: "user-1" });
    const core = createMockCore(mockSession);
    const gateway = new WebGatewayImpl(core, "user-1", makeEnv());
    const sessions = await gateway.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("test-session-id");
    expect(sessions[0]?.messageCount).toBe(0);
  });

  it("listModels() delegates to core.listModels()", async () => {
    const core = createMockCore();
    const gateway = new WebGatewayImpl(core, "user-1", makeEnv());
    const models = await gateway.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("test/model");
  });
});

// ─── 4. WebGatewaySessionImpl — session methods ───────────────────────────────

describe("WebGatewaySessionImpl", () => {
  it("id() returns the session's ID", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    expect(await gwSession.id()).toBe("test-session-id");
  });

  it("info() returns the session record for the correct user", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const record = await gwSession.info();
    expect(record.id).toBe("test-session-id");
    expect(record.userId).toBe("test-user-id");
  });

  it("info() throws Forbidden when userId does not match", async () => {
    const session = createMockSession({}, { userId: "owner-user" });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "different-user",
      makeEnv(),
    );
    await expect(gwSession.info()).rejects.toThrow("Forbidden");
  });

  it("getName() delegates to session.getName()", async () => {
    const session = createMockSession({ getName: vi.fn().mockResolvedValue("My Chat") });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    expect(await gwSession.getName()).toBe("My Chat");
  });

  it("setName() delegates to session.setName()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.setName("New Name");
    expect(session.setName).toHaveBeenCalledWith("New Name");
  });

  it("getModel() delegates to session.getModel()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const model = await gwSession.getModel();
    expect(model.id).toBe("test/model");
  });

  it("setModel() delegates to session.setModel()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.setModel("anthropic/claude-opus-4");
    expect(session.setModel).toHaveBeenCalledWith("anthropic/claude-opus-4");
  });

  it("steer() delegates to session.steer()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.steer("correction");
    expect(session.steer).toHaveBeenCalledWith("correction");
  });

  it("abort() delegates to session.abort()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.abort();
    expect(session.abort).toHaveBeenCalled();
  });

  it("getContextUsage() delegates to session.getContextUsage()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const usage = await gwSession.getContextUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.contextWindowTokens).toBe(200_000);
  });

  it("compact() delegates to session.compact()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.compact({ keepRecentTokens: 10_000 });
    expect(session.compact).toHaveBeenCalledWith({ keepRecentTokens: 10_000 });
  });

  it("branch() delegates to session.branch()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.branch("entry-id-123");
    expect(session.branch).toHaveBeenCalledWith("entry-id-123");
  });

  it("delete() delegates to session.delete()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    await gwSession.delete();
    expect(session.delete).toHaveBeenCalled();
  });
});

// ─── 5. prompt() → TurnHandleImpl → listener events ──────────────────────────

describe("prompt() and TurnHandleImpl", () => {
  it("prompt() returns an ITurnHandle synchronously", () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const listener = createMockListener();
    const callback = createMockCallback();
    const handle = gwSession.prompt("Hello", listener, callback);
    expect(typeof handle.abort).toBe("function");
    expect(typeof handle.done).toBe("function");
  });

  it("done() resolves after all stream events are delivered", async () => {
    const events: AgentEvent[] = [
      { type: "agent_start" },
      { type: "text_delta", delta: "Hi" },
      {
        type: "agent_end",
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        },
      },
    ];
    const session = createMockSession({
      prompt: vi.fn().mockResolvedValue(createEventStream(events)),
    });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const listener = createMockListener();
    const callback = createMockCallback();
    const handle = gwSession.prompt("Hello", listener, callback);
    await handle.done();
    expect(listener.events).toHaveLength(3);
    expect(listener.events[0]).toEqual({ type: "agent_start" });
    expect(listener.events[1]).toEqual({ type: "text_delta", delta: "Hi" });
  });

  it("prompt() passes the callback to session.prompt()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const listener = createMockListener();
    const callback = createMockCallback();
    const handle = gwSession.prompt("Hello", listener, callback);
    await handle.done();
    expect(session.prompt).toHaveBeenCalledWith("Hello", undefined, callback);
  });

  it("listener.onEvent() is called for each event", async () => {
    const events: AgentEvent[] = [
      { type: "turn_start", stepNumber: 1 },
      { type: "text_delta", delta: "world" },
    ];
    const session = createMockSession({
      prompt: vi.fn().mockResolvedValue(createEventStream(events)),
    });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const listener = createMockListener();
    await gwSession.prompt("Hi", listener, createMockCallback()).done();
    expect(listener.onEvent).toHaveBeenCalledTimes(2);
  });

  it("done() resolves even if session.prompt() throws", async () => {
    const session = createMockSession({
      prompt: vi.fn().mockRejectedValue(new Error("core error")),
    });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const listener = createMockListener();
    await gwSession.prompt("Hi", listener, createMockCallback()).done();
    // Error event should have been sent to listener
    expect(listener.events.some((e) => e.type === "error")).toBe(true);
  });
});

// ─── 6. TurnHandle.abort() ───────────────────────────────────────────────────

describe("TurnHandleImpl.abort()", () => {
  it("abort() calls session.abort()", async () => {
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const handle = gwSession.prompt("Hi", createMockListener(), createMockCallback());
    await handle.abort();
    expect(session.abort).toHaveBeenCalled();
  });
});

// ─── 7. Event enrichment ──────────────────────────────────────────────────────

describe("enrichEvent()", () => {
  it("passes non-tool events through unchanged", async () => {
    const event: WebAgentEvent = { type: "text_delta", delta: "hello" };
    const result = await enrichEvent(event, new Map());
    expect(result).toEqual(event);
  });

  it("passes tool_start through unchanged when tool not in cache", async () => {
    const event: WebAgentEvent = {
      type: "tool_start",
      toolCallId: "tc1",
      toolName: "read_file",
      input: { path: "/foo" },
    };
    const result = await enrichEvent(event, new Map());
    expect(result).toEqual(event);
    expect((result as { component?: unknown }).component).toBeUndefined();
  });

  it("passes tool_start through when tool has no getGatewayUI", async () => {
    const toolCache = new Map([["read_file", {}]]);
    const event: WebAgentEvent = {
      type: "tool_start",
      toolCallId: "tc1",
      toolName: "read_file",
      input: {},
    };
    const result = await enrichEvent(event, toolCache);
    expect((result as { component?: unknown }).component).toBeUndefined();
  });

  it("attaches component to tool_start when tool returns WebComponentDescriptor", async () => {
    const descriptor = { componentId: "r2-file-tree", props: { bucket: "my-bucket" } };
    const mockTool = {
      getGatewayUI: vi.fn().mockResolvedValue({
        getComponent: vi.fn().mockResolvedValue(descriptor),
      }),
    };
    const toolCache = new Map([["r2_read", mockTool]]);
    const event: WebAgentEvent = {
      type: "tool_start",
      toolCallId: "tc1",
      toolName: "r2_read",
      input: {},
    };
    const result = await enrichEvent(event, toolCache);
    expect((result as { component?: unknown }).component).toEqual(descriptor);
  });

  it("attaches component to tool_end as result phase", async () => {
    const descriptor = { componentId: "r2-result", props: { files: [] } };
    const mockTool = {
      getGatewayUI: vi.fn().mockResolvedValue({
        getComponent: vi.fn().mockResolvedValue(descriptor),
      }),
    };
    const toolCache = new Map([["r2_read", mockTool]]);
    const event: WebAgentEvent = {
      type: "tool_end",
      toolCallId: "tc1",
      toolName: "r2_read",
      output: { files: [] },
      isError: false,
    };
    const result = await enrichEvent(event, toolCache);
    expect((result as { component?: unknown }).component).toEqual(descriptor);
    // Verify phase was "result"
    const getComponent = mockTool.getGatewayUI.mock.results[0]?.value as Promise<{
      getComponent: ReturnType<typeof vi.fn>;
    }>;
    const resolvedUi = await getComponent;
    expect(resolvedUi.getComponent).toHaveBeenCalledWith("result");
  });

  it("swallows enrichment errors and returns original event", async () => {
    const mockTool = {
      getGatewayUI: vi.fn().mockRejectedValue(new Error("UI error")),
    };
    const toolCache = new Map([["broken_tool", mockTool]]);
    const event: WebAgentEvent = {
      type: "tool_start",
      toolCallId: "tc1",
      toolName: "broken_tool",
      input: {},
    };
    const result = await enrichEvent(event, toolCache);
    expect(result).toEqual(event);
  });
});

// ─── 8. fork() ────────────────────────────────────────────────────────────────

describe("WebGatewaySessionImpl.fork()", () => {
  it("fork() returns a new IWebGatewaySession synchronously", () => {
    const forkedSession = createMockSession({}, { sessionId: "forked-session-id" });
    const session = createMockSession({ fork: vi.fn().mockResolvedValue(forkedSession) });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const forked = gwSession.fork();
    expect(typeof forked.id).toBe("function");
    expect(typeof forked.prompt).toBe("function");
  });

  it("fork() resolves to the forked session's ID", async () => {
    const forkedSession = createMockSession(
      {},
      { sessionId: "forked-session-id", userId: "test-user-id" },
    );
    const session = createMockSession({ fork: vi.fn().mockResolvedValue(forkedSession) });
    const gwSession = new WebGatewaySessionImpl(
      Promise.resolve(session),
      "test-user-id",
      makeEnv(),
    );
    const forked = gwSession.fork("entry-abc");
    expect(await forked.id()).toBe("forked-session-id");
    expect(session.fork).toHaveBeenCalledWith("entry-abc");
  });
});

// ─── 9. WebUiSessionDO ────────────────────────────────────────────────────────
// WebUiSessionDO is a native WebSocket transport — it uses Workers hibernation
// API to accept connections. Tests use runInDurableObject and WebSocketPair.

describe("WebUiSessionDO", () => {
  /** Get a fresh DO stub for each test (unique name = fresh instance). */
  let _counter = 0;
  function getStub() {
    _counter += 1;
    return env.WEB_UI_SESSION.get(env.WEB_UI_SESSION.idFromName(`test-do-${_counter}`));
  }

  it("getRecentEvents() returns empty array initially", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance: WebUiSessionDO) => {
      expect(await instance.getRecentEvents()).toEqual([]);
    });
  });

  it("pushEvent() adds events to the buffer", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance: WebUiSessionDO) => {
      const event: AgentEvent = { type: "agent_start" };
      await instance.pushEvent(event);
      const events = await instance.getRecentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });
  });

  it("pushEvent() caps buffer at 50 events", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance: WebUiSessionDO) => {
      for (let i = 0; i < 60; i++) {
        await instance.pushEvent({ type: "text_delta", delta: `delta-${i}` });
      }
      const events = await instance.getRecentEvents();
      expect(events).toHaveLength(50);
      expect((events[0] as Extract<AgentEvent, { type: "text_delta" }>).delta).toBe("delta-10");
    });
  });

  it("addConnection() returns 101 and accepts the WebSocket", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance: WebUiSessionDO) => {
      // Simulate a WebSocket upgrade request using WebSocketPair
      // biome-ignore lint/suspicious/noExplicitAny: Workers global
      const WspCtor = (globalThis as any).WebSocketPair as new () => Record<number, WebSocket>;
      const pair = new WspCtor();
      const [client, server] = [pair[0], pair[1]] as [WebSocket, WebSocket];
      void server; // used by the DO internally
      const req = new Request("https://example.com/", {
        headers: { Upgrade: "websocket" },
      });
      void client; // listener attached after
      const res = await instance.addConnection(req);
      expect(res.status).toBe(101);
    });
  });

  it("addConnection() returns 101 Switching Protocols", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance: WebUiSessionDO) => {
      const req = new Request("https://example.com/", {
        headers: { Upgrade: "websocket" },
      });
      const res = await instance.addConnection(req);
      expect(res.status).toBe(101);
    });
  });

  it("getRecentEvents() returns a copy (mutations don't affect the buffer)", async () => {
    const stub = getStub();
    await runInDurableObject(stub, async (instance: WebUiSessionDO) => {
      await instance.pushEvent({ type: "agent_start" });
      const events = await instance.getRecentEvents();
      events.pop();
      const events2 = await instance.getRecentEvents();
      expect(events2).toHaveLength(1);
    });
  });
});

// ─── 10. Fetch handler routes ─────────────────────────────────────────────────

import workerHandler from "../src/index.ts";

describe("fetch handler", () => {
  it("GET / returns 404 when ASSETS has no index.html (via full handler)", async () => {
    const req = new Request("https://example.com/");
    const mockEnvObj = makeEnv();
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const res = await workerHandler.fetch(req, mockEnvObj, ctx);
    expect(res.status).toBe(404);
  });

  it("GET /unknown returns 404", async () => {
    const req = new Request("https://example.com/unknown");
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const res = await workerHandler.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it("GET /rpc without auth returns 401", async () => {
    const req = new Request("https://example.com/rpc");
    // No auth headers, no AUTH_SECRET bypass
    const testEnv = makeEnv();
    delete (testEnv as Partial<Env>).AUTH_SECRET;
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const res = await workerHandler.fetch(req, testEnv, ctx);
    expect(res.status).toBe(401);
  });

  it("GET /components/bad..path.js returns 404", async () => {
    const req = new Request("https://example.com/components/bad..path.js");
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const res = await workerHandler.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(404);
  });
});

// ─── 11. uploadAttachment ──────────────────────────────────────────────────────

describe("WebGatewaySessionImpl.uploadAttachment()", () => {
  it("stores attachment to R2 and returns an ID", async () => {
    const putMock = vi.fn().mockResolvedValue(undefined);
    const testEnv = makeEnv({
      ASSETS: {
        get: vi.fn().mockResolvedValue(null),
        put: putMock,
        delete: vi.fn(),
        list: vi.fn(),
        head: vi.fn(),
      } as unknown as Env["ASSETS"],
    });
    const session = createMockSession();
    const gwSession = new WebGatewaySessionImpl(Promise.resolve(session), "test-user-id", testEnv);
    const attachment = {
      name: "file.txt",
      mimeType: "text/plain",
      data: btoa("hello"),
      size: 5,
    };
    const id = await gwSession.uploadAttachment(attachment);
    expect(typeof id).toBe("string");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(putMock).toHaveBeenCalledOnce();
    const [key] = putMock.mock.calls[0] as [string];
    expect(key).toContain("sessions/test-session-id/attachments/");
  });
});
