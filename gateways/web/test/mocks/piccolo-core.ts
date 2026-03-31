/**
 * Mock IPiccoloCore, IUser, and ISession for web gateway tests.
 *
 * Spec ref: specs/api.md §IPiccoloCore, §IUser, §ISession
 */

import type {
  AgentEvent,
  ContextUsage,
  IDisposable,
  IObservable,
  IObserver,
  IPiccoloCore,
  ISession,
  ITurn,
  IUser,
} from "@piccolo/api";
import { vi } from "vitest";

const DEFAULT_SESSION_ID = "test-session-id";
const DEFAULT_USER_ID = "test-user-id";
const DEFAULT_MODEL = "test/model";

/** Create an IObservable<AgentEvent> that emits the given events then completes. */
const noopSubscription: IDisposable = { [Symbol.dispose]() {} };

export function createEventObservable(events: AgentEvent[]): IObservable<AgentEvent> {
  return {
    async subscribe(observer: IObserver<AgentEvent>): Promise<IDisposable> {
      for (const event of events) {
        await observer.onNext(event);
      }
      await observer.onComplete();
      return noopSubscription;
    },
  };
}

function emptyTurn(): ITurn {
  return {
    getCallback: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  } as unknown as ITurn;
}

export function createMockSession(
  overrides: Partial<ISession> = {},
  options: { sessionId?: string; userId?: string } = {},
): ISession {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const userId = options.userId ?? DEFAULT_USER_ID;

  return {
    sessionId: vi.fn().mockResolvedValue(sessionId),
    userId: vi.fn().mockResolvedValue(userId),
    getUpdatedAt: vi.fn().mockResolvedValue(0),
    getName: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(emptyTurn()),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(noopSubscription),
    getCurrentTurn: vi.fn().mockResolvedValue(undefined),
    getModel: vi.fn().mockResolvedValue(DEFAULT_MODEL),
    setModel: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([DEFAULT_MODEL]),
    getActiveTools: vi.fn().mockResolvedValue([]),
    getEntries: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({ inputTokens: 0 } satisfies ContextUsage),
    compact: vi.fn().mockResolvedValue(undefined),
    getSystemPrompt: vi.fn().mockResolvedValue(""),
    fork: vi.fn().mockResolvedValue("forked-session-id"),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createMockUser(session?: ISession): IUser {
  const mockSession = session ?? createMockSession();
  return {
    newSession: vi.fn().mockResolvedValue(mockSession),
    getSession: vi.fn().mockResolvedValue(mockSession),
    listSessions: vi.fn().mockResolvedValue([mockSession]),
    listModels: vi.fn().mockResolvedValue([DEFAULT_MODEL]),
  } as unknown as IUser;
}

export function createMockCore(user?: IUser): IPiccoloCore {
  const mockUser = user ?? createMockUser();
  return {
    getUser: vi.fn().mockReturnValue(mockUser),
  };
}
