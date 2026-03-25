/**
 * RpcTarget stubs for gateway tests.
 *
 * Creates browser-side mock implementations of IAgentEventListener and
 * IGatewayCallback using plain objects (no actual RpcTarget — tests run
 * in Workers sandbox where capnweb RPC is not available).
 *
 * Spec refs:
 *   specs/api.md §6 IAgentEventListener, IGatewayCallback
 */

import { vi } from "vitest";
import type { IAgentEventListener, IGatewayCallback, WebAgentEvent } from "../../src/types.ts";

/**
 * Create a mock IAgentEventListener that records received events.
 * Casts to the interface type — in tests we don't need real RpcTarget behaviour.
 */
export function createMockListener(): IAgentEventListener & { events: WebAgentEvent[] } {
  const events: WebAgentEvent[] = [];
  return {
    onEvent: vi.fn().mockImplementation(async (event: WebAgentEvent) => {
      events.push(event);
    }),
    events,
  } as unknown as IAgentEventListener & { events: WebAgentEvent[] };
}

/**
 * Create a mock IGatewayCallback that auto-resolves with default values.
 */
export function createMockCallback(overrides: Partial<IGatewayCallback> = {}): IGatewayCallback {
  return {
    requestSelect: vi.fn().mockResolvedValue(null),
    requestConfirm: vi.fn().mockResolvedValue(false),
    requestInput: vi.fn().mockResolvedValue(null),
    notify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IGatewayCallback;
}

/**
 * Create a dev-auth header pair for test requests.
 * Used to bypass CF Access JWT validation in the fetch handler tests.
 */
export function devAuthHeaders(
  userId: string,
  secret = "test-auth-secret",
): Record<string, string> {
  return {
    "x-dev-auth": secret,
    "x-dev-user-id": userId,
  };
}
