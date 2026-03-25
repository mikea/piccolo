/**
 * PiccoloCore — the WorkerEntrypoint that gateways connect to.
 *
 * Creates/retrieves sessions, lists sessions, lists models.
 *
 * ISession design:
 *   PiccoloCore returns the SessionImpl RpcTarget from AgentSessionDO directly.
 *   Workers JSRPC serialises RpcTarget objects transparently across Worker
 *   boundaries — no wrapper stub is needed. The gateway receives the same
 *   SessionImpl that tools and extensions use inside the DO.
 *
 * Authentication design:
 *   userId is an explicit parameter on newSession() and listSessions(). The
 *   calling gateway authenticates the user and supplies the userId.
 *
 * Spec refs:
 *   specs/api.md §1  IPiccoloCore
 *   specs/core.md §IPiccoloCore WorkerEntrypoint
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { AgentSessionDO } from "./agent-session-do.ts";
import { listSessions as dbListSessions } from "./session/persistence.ts";
import type { IPiccoloCore, ISession, NewSessionOptions } from "./types.ts";
import { parseModels } from "./types-internal.ts";

/**
 * The public JSRPC WorkerEntrypoint for piccolo-core.
 *
 * Gateways bind to this Worker as a service binding and call these methods.
 * Per-session work is delegated to AgentSessionDO; the SessionImpl RpcTarget
 * is returned directly to the gateway over JSRPC.
 *
 * Spec ref: specs/api.md §1 IPiccoloCore
 */
export class PiccoloCore extends WorkerEntrypoint<Env> implements IPiccoloCore {
  // ─── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Create a new session and return its ISession RpcTarget.
   *
   * Generates a fresh sessionId, initialises AgentSessionDO (persisting the
   * sessionId to DO storage for cold-start recovery), then returns the DO's
   * own SessionImpl directly. The D1 sessions row is written lazily on the
   * first assistant response.
   *
   * @param userId  Authenticated user ID, provided by the calling gateway.
   * @param options Optional session metadata (name, modelId, cwd).
   *
   * Spec ref: specs/api.md §1 IPiccoloCore.newSession
   */
  async newSession(userId: string, options?: NewSessionOptions): Promise<ISession> {
    const sessionId = crypto.randomUUID();
    const stub = this.#getDoStub(sessionId);
    await stub.initSession(sessionId, userId, options);
    return stub.getSession(userId);
  }

  /**
   * Retrieve an existing session by ID and return its ISession RpcTarget.
   *
   * Returns the DO's SessionImpl without verifying the session exists. The DO
   * will error on the first method call if the session is not found.
   *
   * Note: userId is not loaded here (no D1 round-trip). Callers that need it
   * should call session.info() and read info.userId.
   *
   * Spec ref: specs/api.md §1 IPiccoloCore.getSession
   */
  async getSession(sessionId: string): Promise<ISession> {
    return this.#getDoStub(sessionId).getSession("");
  }

  /**
   * List sessions for a given user as live ISession RpcTargets.
   *
   * Queries D1 for the user's session IDs (ordered by updated_at DESC) then
   * returns a Session stub for each — callers call session.info() for metadata.
   * This uses JSRPC to its fullest: gateways receive live session objects, not
   * plain data records.
   *
   * @param userId  Authenticated user ID, provided by the calling gateway.
   *
   * Spec ref: specs/api.md §1 IPiccoloCore.listSessions
   */
  async listSessions(userId: string): Promise<ISession[]> {
    const infos = await dbListSessions(userId, this.env.SESSIONS_DB);
    return Promise.all(infos.map((info) => this.#getDoStub(info.id).getSession(userId)));
  }

  // ─── Global model registry ─────────────────────────────────────────────────

  /**
   * List available models.
   *
   * Parses the MODELS env var (JSON-encoded string[]) — it is the sole
   * authoritative source. No KV lookup, no fallback catalog.
   *
   * Spec ref: specs/api.md §1 IPiccoloCore.listModels
   */
  async listModels(): Promise<string[]> {
    return parseModels(this.env.MODELS);
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  #getDoStub(sessionId: string): DurableObjectStub<AgentSessionDO> {
    return this.env.AGENT_SESSION.get(this.env.AGENT_SESSION.idFromName(sessionId));
  }
}
