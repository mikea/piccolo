/**
 * web-gateway.ts — WebGatewayImpl and WebGatewaySessionImpl for piccolo-web-gateway.
 *
 * WebGatewayImpl — root Cap'n Web RpcTarget returned to the browser on connection.
 * WebGatewaySessionImpl — per-session RpcTarget wrapping ISession with browser extras.
 *
 * Design:
 *   - newSession() and getSession() return synchronously (no await) so the browser
 *     can pipeline dependent calls without a round trip (Cap'n Web promise pipelining).
 *   - WebGatewaySessionImpl wraps a Promise<ISession> which is resolved lazily when
 *     any method is first called.
 *   - prompt() returns TurnHandleImpl synchronously; the async work happens inside it.
 *   - User isolation is enforced in info(): userId of the session must match the
 *     authenticated caller.
 *
 * Spec refs:
 *   specs/api.md §6  IWebGatewayApi, IWebGatewaySession
 *   specs/web_gateway.md §Gateway Worker Implementation
 */

import type {
  Attachment,
  CompactOptions,
  ContextUsage,
  IGatewayCallback,
  IPiccoloCore,
  ISession,
  NewSessionOptions,
  SessionInfo,
  SessionRecord,
} from "@piccolo/core";
import { RpcTarget } from "capnweb";
import type { ToolWithGatewayUI } from "./event-enrichment.ts";
import { TurnHandleImpl } from "./turn-handle.ts";
import type {
  IAgentEventListener,
  IGatewayCallback as IGatewayCallbackRpc,
  ITurnHandle,
  IWebGatewayApi,
  IWebGatewaySession,
} from "./types.ts";

// ─── WebGatewayImpl ────────────────────────────────────────────────────────────

/**
 * Root browser-facing RpcTarget.
 *
 * Returned to the browser when it calls newWebSocketRpcSession<IWebGatewayApi>(url).
 * Bound to one authenticated userId for the lifetime of the WebSocket connection.
 *
 * Spec ref: specs/api.md §6 IWebGatewayApi
 */
export class WebGatewayImpl extends RpcTarget implements IWebGatewayApi {
  readonly #core: IPiccoloCore;
  readonly #userId: string;
  readonly #env: Env;

  constructor(core: IPiccoloCore, userId: string, env: Env) {
    super();
    this.#core = core;
    this.#userId = userId;
    this.#env = env;
  }

  /**
   * Create a new session and return a session stub.
   *
   * Returns synchronously — the ISession resolution happens inside
   * WebGatewaySessionImpl lazily. This enables promise pipelining:
   *   const session = api.newSession();
   *   const turn = session.prompt("Hello", listener, callback);
   * Both calls complete in one round trip.
   *
   * Spec ref: specs/api.md §6 IWebGatewayApi.newSession
   */
  newSession(options?: NewSessionOptions): IWebGatewaySession {
    const sessionPromise = this.#core.newSession(this.#userId, options);
    return new WebGatewaySessionImpl(sessionPromise, this.#userId, this.#env);
  }

  /**
   * Retrieve an existing session by ID.
   *
   * Spec ref: specs/api.md §6 IWebGatewayApi.getSession
   */
  getSession(sessionId: string): IWebGatewaySession {
    const sessionPromise = this.#core.getSession(sessionId);
    return new WebGatewaySessionImpl(sessionPromise, this.#userId, this.#env);
  }

  /**
   * List all sessions for the authenticated user as SessionInfo[].
   *
   * Retrieves SessionRecord from each ISession stub and maps to SessionInfo.
   * messageCount and firstMessage default to 0 / "" — the browser populates
   * these from the session history when needed.
   *
   * Spec ref: specs/api.md §6 IWebGatewayApi.listSessions
   */
  async listSessions(): Promise<SessionInfo[]> {
    const sessions = await this.#core.listSessions(this.#userId);
    const records = await Promise.all(sessions.map((s) => s.info()));
    return records.map((r) => ({
      id: r.id,
      userId: r.userId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      // messageCount and firstMessage require a D1 query not available from ISession.
      // The browser populates these via session.info() when displaying the list.
      messageCount: 0,
      firstMessage: "",
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
    }));
  }

  /**
   * List available models.
   *
   * Spec ref: specs/api.md §6 IWebGatewayApi.listModels
   */
  async listModels(): Promise<string[]> {
    return this.#core.listModels();
  }
}

// ─── WebGatewaySessionImpl ─────────────────────────────────────────────────────

/**
 * Per-session browser-facing RpcTarget.
 *
 * Wraps a Promise<ISession> (may be an unresolved pipeline promise from pipelining).
 * All methods resolve the session lazily by awaiting the promise.
 *
 * Spec ref: specs/api.md §6 IWebGatewaySession
 */
export class WebGatewaySessionImpl extends RpcTarget implements IWebGatewaySession {
  readonly #sessionPromise: Promise<ISession>;
  readonly #userId: string;
  readonly #env: Env;

  /**
   * Tool cache built once per session turn for event enrichment.
   * Populated lazily from session.getActiveTools() when prompt() is called.
   */
  readonly #toolCache: Map<string, ToolWithGatewayUI> = new Map();

  constructor(sessionPromise: Promise<ISession>, userId: string, env: Env) {
    super();
    this.#sessionPromise = sessionPromise;
    this.#userId = userId;
    this.#env = env;
  }

  async #session(): Promise<ISession> {
    return this.#sessionPromise;
  }

  // ─── Identity and metadata ──────────────────────────────────────────────────

  async id(): Promise<string> {
    return (await this.#session()).id();
  }

  async info(): Promise<SessionRecord> {
    const session = await this.#session();
    const record = await session.info();
    // Enforce user isolation: only the owner can access their session.
    if (record.userId !== this.#userId) {
      throw new Error("Forbidden");
    }
    return record;
  }

  async getName(): Promise<string | undefined> {
    return (await this.#session()).getName();
  }

  async setName(name: string): Promise<void> {
    return (await this.#session()).setName(name);
  }

  // ─── Conversation ────────────────────────────────────────────────────────────

  /**
   * Start a new agent turn.
   *
   * Returns TurnHandleImpl synchronously (for pipelining). The async work —
   * resolving the session, calling prompt(), streaming events to listener —
   * runs inside TurnHandleImpl.
   *
   * Before starting the turn, refreshes the tool cache from session.getActiveTools()
   * so enrichEvent() can look up tool UI descriptors.
   *
   * Spec ref: specs/api.md §6 IWebGatewaySession.prompt
   */
  prompt(
    text: string,
    listener: IAgentEventListener,
    callback: IGatewayCallbackRpc,
    attachments?: Attachment[],
  ): ITurnHandle {
    // Refresh tool cache asynchronously — TurnHandleImpl waits on #session() anyway.
    // We intentionally do not await here; the cache is updated before the stream starts
    // because TurnHandleImpl awaits session.prompt() which is after this.
    this.#refreshToolCache().catch(() => {});

    // session.prompt() expects core's IGatewayCallback — same interface shape.
    const coreCallback = callback as unknown as IGatewayCallback;
    return new TurnHandleImpl(
      this.#sessionPromise,
      text,
      listener,
      coreCallback,
      attachments,
      this.#toolCache,
    );
  }

  /**
   * Refresh the tool cache from session.getActiveTools().
   * Called before each prompt() so the event enricher has up-to-date tool stubs.
   */
  async #refreshToolCache(): Promise<void> {
    try {
      const session = await this.#session();
      const descriptors = await session.getActiveTools();
      // getActiveTools() returns ToolDescriptor[] not ITool[].
      // The tool stubs with getGatewayUI are accessible via the extension workers;
      // for now we store the tool names with no UI stub — full tool-UI dispatch
      // requires the extension worker stubs which are accessed via the core (step 12+).
      // Until step 12 tools are wired, enrichment is a no-op.
      this.#toolCache.clear();
      for (const d of descriptors) {
        // Descriptor has no getGatewayUI; store as stub with no UI method.
        this.#toolCache.set(d.name, {});
      }
    } catch {
      // Cache refresh failure must not prevent the turn from starting.
    }
  }

  async steer(text: string): Promise<void> {
    return (await this.#session()).steer(text);
  }

  async followUp(text: string): Promise<void> {
    return (await this.#session()).followUp(text);
  }

  async abort(): Promise<void> {
    return (await this.#session()).abort();
  }

  // ─── Model management ────────────────────────────────────────────────────────

  async getModel(): Promise<string> {
    return (await this.#session()).getModel();
  }

  async setModel(modelId: string): Promise<void> {
    return (await this.#session()).setModel(modelId);
  }

  // ─── Context ─────────────────────────────────────────────────────────────────

  async getContextUsage(): Promise<ContextUsage> {
    return (await this.#session()).getContextUsage();
  }

  async compact(options?: CompactOptions): Promise<void> {
    return (await this.#session()).compact(options);
  }

  // ─── Session tree ─────────────────────────────────────────────────────────────

  async branch(entryId: string): Promise<void> {
    return (await this.#session()).branch(entryId);
  }

  /**
   * Fork returns a new IWebGatewaySession synchronously (pipelined).
   *
   * The forked ISession promise is constructed by calling session.fork() on the
   * resolved session. Since session.fork() returns Promise<ISession> we wrap it
   * in a new WebGatewaySessionImpl for pipeline compatibility.
   *
   * Spec ref: specs/api.md §6 IWebGatewaySession.fork
   */
  fork(fromEntryId?: string): IWebGatewaySession {
    const forkedPromise = this.#session().then((s) => s.fork(fromEntryId));
    return new WebGatewaySessionImpl(forkedPromise, this.#userId, this.#env);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async delete(): Promise<void> {
    return (await this.#session()).delete();
  }

  // ─── Attachments ─────────────────────────────────────────────────────────────

  /**
   * Upload an attachment to R2 and return an opaque attachmentId.
   *
   * Stores under `sessions/{sessionId}/attachments/{uuid}` in the ASSETS bucket.
   *
   * Spec ref: specs/web_gateway.md §WebGatewaySessionImpl.uploadAttachment
   */
  async uploadAttachment(attachment: Attachment): Promise<string> {
    const session = await this.#session();
    const attachmentId = crypto.randomUUID();
    const sessionId = await session.id();

    const data = base64ToArrayBuffer(attachment.data);
    await this.#env.ASSETS.put(`sessions/${sessionId}/attachments/${attachmentId}`, data, {
      httpMetadata: { contentType: attachment.mimeType },
    });
    return attachmentId;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode a base64 string to ArrayBuffer.
 * Handles both standard base64 and base64url encoding.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const standard = base64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
