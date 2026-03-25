/**
 * Mock IPiccoloCore and ISession for web gateway tests.
 *
 * Uses vi.fn() for all async methods so tests can assert call counts and
 * override return values with mockResolvedValue/mockImplementation.
 *
 * Spec ref: specs/api.md §1 IPiccoloCore, §2 ISession
 */

import type {
  AgentEvent,
  ContextUsage,
  IPiccoloCore,
  ISession,
  SessionRecord,
} from "@piccolo/core";
import { vi } from "vitest";
import type { WebAgentEvent } from "../../src/types.ts";

const DEFAULT_SESSION_ID = "test-session-id";
const DEFAULT_USER_ID = "test-user-id";
const DEFAULT_MODEL = "test/model";

/** Create an empty ReadableStream that closes immediately. */
function emptyStream(): ReadableStream<AgentEvent> {
  return new ReadableStream<AgentEvent>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Create a mock ISession with vi.fn() methods.
 *
 * @param overrides Partial ISession to override specific methods.
 * @param options   Optional sessionId and userId.
 */
export function createMockSession(
  overrides: Partial<ISession> = {},
  options: { sessionId?: string; userId?: string } = {},
): ISession {
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
  const userId = options.userId ?? DEFAULT_USER_ID;

  const defaultRecord: SessionRecord = {
    id: sessionId,
    userId,
    createdAt: 0,
    updatedAt: 0,
  };

  const session: ISession = {
    userId,
    id: vi.fn().mockResolvedValue(sessionId),
    info: vi.fn().mockResolvedValue(defaultRecord),
    getName: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(emptyStream()),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    getCurrentTurn: vi.fn().mockResolvedValue(undefined),
    getModel: vi.fn().mockResolvedValue(DEFAULT_MODEL),
    setModel: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([DEFAULT_MODEL]),
    getActiveTools: vi.fn().mockResolvedValue([]),
    setActiveTools: vi.fn().mockResolvedValue(undefined),
    appendCustomMessage: vi.fn().mockResolvedValue(undefined),
    appendCustomEntry: vi.fn().mockResolvedValue(undefined),
    getEntries: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue({
      inputTokens: 0,
      contextWindowTokens: 200_000,
      usedFraction: 0,
    } satisfies ContextUsage),
    compact: vi.fn().mockResolvedValue(undefined),
    getSystemPrompt: vi.fn().mockResolvedValue(""),
    branch: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn().mockImplementation(async () => createMockSession()),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return session;
}

/**
 * Create a mock IPiccoloCore with vi.fn() methods.
 *
 * @param session Optional ISession to return from newSession/getSession.
 */
export function createMockCore(session?: ISession): IPiccoloCore {
  const mockSession = session ?? createMockSession();

  return {
    newSession: vi.fn().mockResolvedValue(mockSession),
    getSession: vi.fn().mockResolvedValue(mockSession),
    listSessions: vi.fn().mockResolvedValue([mockSession]),
    listModels: vi.fn().mockResolvedValue([DEFAULT_MODEL]),
  };
}

/**
 * Create a ReadableStream that emits the given events then closes.
 */
export function createEventStream(events: AgentEvent[]): ReadableStream<AgentEvent> {
  return new ReadableStream<AgentEvent>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(event);
      }
      controller.close();
    },
  });
}

/** Drain a ReadableStream<WebAgentEvent> into an array. */
export async function drainStream(stream: ReadableStream<WebAgentEvent>): Promise<WebAgentEvent[]> {
  const events: WebAgentEvent[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}
