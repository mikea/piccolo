/**
 * piccolo-core.ts — PiccoloCore WorkerEntrypoint and UserImpl RpcTarget.
 *
 * PiccoloCore exposes a single method: getUser(userId) → IUser.
 * IUser owns all session and model operations for that user — no userId
 * parameter is needed anywhere downstream.
 *
 * Spec refs:
 *   specs/api.md §IPiccoloCore
 *   specs/api.md §IUser
 *   specs/core.md §IPiccoloCore WorkerEntrypoint
 */

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { AgentSessionDO } from "./agent-session-do.ts";
import { getSession as dbGetSession } from "./db/schema.ts";
import { listSessions as dbListSessions } from "./session/persistence.ts";
import type { IPiccoloCore, ISession, IUser, NewSessionOptions } from "./types.ts";
import { parseModels } from "./types-internal.ts";

// ─── UserImpl ─────────────────────────────────────────────────────────────────

class UserImpl extends RpcTarget implements IUser {
  readonly #userId: string;
  readonly #env: Env;

  constructor(userId: string, env: Env) {
    super();
    this.#userId = userId;
    this.#env = env;
  }

  async newSession(options?: NewSessionOptions): Promise<ISession> {
    const sessionId = crypto.randomUUID();
    console.debug("[core] newSession userId=%s options=%o", this.#userId, options);
    const stub = this.#getDoStub(sessionId);
    // Initialize the DO; ignore the returned ISession since the stub itself is the ISession.
    await stub._init(sessionId, this.#userId, options);
    console.debug("[core] newSession done sessionId=%s", sessionId);
    return stub as unknown as ISession;
  }

  async getSession(sessionId: string): Promise<ISession> {
    console.debug("[core] getSession sessionId=%s userId=%s", sessionId, this.#userId);
    const row = await dbGetSession(this.#env.SESSIONS_DB, sessionId);
    if (!row || row.user_id !== this.#userId) throw new Error("Forbidden");
    return this.#getDoStub(sessionId) as unknown as ISession;
  }

  async listSessions(): Promise<ISession[]> {
    console.debug("[core] listSessions userId=%s", this.#userId);
    const infos = await dbListSessions(this.#userId, this.#env.SESSIONS_DB);
    console.debug("[core] listSessions found %d sessions", infos.length);
    return infos.map((info) => this.#getDoStub(info.id) as unknown as ISession);
  }

  async listModels(): Promise<string[]> {
    const models = parseModels(this.#env.MODELS);
    console.debug("[core] listModels →", models);
    return models;
  }

  #getDoStub(sessionId: string): DurableObjectStub<AgentSessionDO> {
    return this.#env.AGENT_SESSION.get(this.#env.AGENT_SESSION.idFromName(sessionId));
  }
}

// ─── PiccoloCore ──────────────────────────────────────────────────────────────

export class PiccoloCore extends WorkerEntrypoint<Env> implements IPiccoloCore {
  /**
   * Return a userId-bound IUser RpcTarget.
   * The gateway calls this once per connection, then uses IUser for everything.
   *
   * Spec ref: specs/api.md §IPiccoloCore.getUser
   */
  getUser(userId: string): IUser {
    console.debug("[core] getUser userId=%s", userId);
    return new UserImpl(userId, this.env);
  }
}
