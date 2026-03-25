/**
 * store.ts — Central reactive application state.
 *
 * Uses SolidJS createStore for fine-grained reactive updates.
 * Active session RPC stubs are stored in createSignal (not the store)
 * because RpcTarget objects should not be tracked by SolidJS reactivity.
 *
 * Actions mutate the store and interact with the Cap'n Web RPC API.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import type { RpcStub } from "capnweb";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type {
  ITurnHandle,
  IWebGatewaySession,
  ModelInfo,
  SessionInfo,
  WebAgentEvent,
} from "../../src/types.ts";
// SessionInfo and ModelInfo are re-exported from gateway types.ts which gets them from @piccolo/core
import { GatewayCallbackImpl } from "./callback.ts";
import { EventListener } from "./listener.ts";
import { getApi } from "./rpc.ts";

// ─── Message types ────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "error" | "tool";

export interface Message {
  id: string;
  role: MessageRole;
  /** Accumulated text content. For assistant messages, built up by text_delta events. */
  content: string;
  /** True while the turn that created this message is still in progress. */
  isStreaming: boolean;
}

// ─── Application state shape ─────────────────────────────────────────────────

export interface AppState {
  /** All sessions for the authenticated user. */
  sessions: SessionInfo[];
  /** ID of the currently active session (matches URL param). */
  activeSessionId: string | null;
  /** Messages in the active session. Cleared on session switch. */
  messages: Message[];
  /** True while an agent turn is in progress. */
  isStreaming: boolean;
  /** Error from the last failed operation (null if none). */
  error: string | null;
  /** All available models from api.listModels(). */
  models: ModelInfo[];
  /** Model currently set for the active session. */
  activeModel: ModelInfo | null;
  /** True while sessions are loading. */
  loadingSessions: boolean;
}

// ─── Store initialization ────────────────────────────────────────────────────

const [store, setStore] = createStore<AppState>({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isStreaming: false,
  error: null,
  models: [],
  activeModel: null,
  loadingSessions: false,
});

export { store };

// Active session stub — outside the reactive store (RpcTarget must not be tracked)
const [activeSession, setActiveSession] = createSignal<RpcStub<IWebGatewaySession> | null>(null);
// Active turn handle — outside the store for same reason
const [activeTurn, setActiveTurn] = createSignal<RpcStub<ITurnHandle> | null>(null);

export { activeSession };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function addMessage(role: MessageRole, content: string, isStreaming = false): string {
  const id = makeId();
  setStore("messages", (msgs) => [...msgs, { id, role, content, isStreaming }]);
  return id;
}

function updateLastAssistantMessage(updater: (content: string) => string): void {
  setStore("messages", (msgs) => {
    const idx = msgs.length - 1;
    if (idx < 0 || msgs[idx]?.role !== "assistant") return msgs;
    return msgs.map((m, i) => (i === idx ? { ...m, content: updater(m.content) } : m));
  });
}

function finishLastAssistantMessage(): void {
  setStore("messages", (msgs) => {
    const idx = msgs.length - 1;
    if (idx < 0 || msgs[idx]?.role !== "assistant") return msgs;
    return msgs.map((m, i) => (i === idx ? { ...m, isStreaming: false } : m));
  });
}

// ─── AgentEvent handler ───────────────────────────────────────────────────────

/**
 * Dispatch an incoming WebAgentEvent to the store.
 * Called by EventListener.onEvent() during an active turn.
 *
 * Spec ref: specs/api.md §AgentEvent
 */
function handleAgentEvent(event: WebAgentEvent): void {
  switch (event.type) {
    case "agent_start":
      // Add empty assistant message that text_delta events will fill in
      addMessage("assistant", "", true);
      break;

    case "text_delta":
      // Fine-grained append — SolidJS only re-renders the text node
      updateLastAssistantMessage((c) => c + event.delta);
      break;

    case "agent_end":
      finishLastAssistantMessage();
      setStore("isStreaming", false);
      setActiveTurn(null);
      break;

    case "error":
      finishLastAssistantMessage();
      setStore("isStreaming", false);
      setStore("error", event.message);
      setActiveTurn(null);
      addMessage("error", event.message);
      break;

    case "tool_start":
      // M1: plain text line. M2 will add WebComponentDescriptor support.
      addMessage("tool", `Running: ${event.toolName}...`);
      break;

    case "tool_end":
      // M1: append result text to the tool message. M2 will render properly.
      if (event.isError) {
        addMessage("error", `Tool ${event.toolName} failed`);
      }
      break;

    // turn_start, turn_end, reasoning_delta: silently ignored in M1
    default:
      break;
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Load all sessions for the current user. */
export async function loadSessions(): Promise<void> {
  setStore("loadingSessions", true);
  setStore("error", null);
  try {
    const sessions = await getApi().listSessions();
    setStore("sessions", sessions);
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  } finally {
    setStore("loadingSessions", false);
  }
}

/** Load all available models. */
export async function loadModels(): Promise<void> {
  try {
    const models = await getApi().listModels();
    setStore("models", models);
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Activate an existing session by ID.
 * Fetches the session stub from the gateway, loads its model, clears messages.
 */
export async function selectSession(id: string): Promise<void> {
  setStore("error", null);
  setStore("activeSessionId", id);
  setStore("messages", []);
  setStore("isStreaming", false);
  setActiveTurn(null);

  try {
    const session = getApi().getSession(id);
    setActiveSession(session as RpcStub<IWebGatewaySession>);
    // Load current model for the session header
    const model = await session.getModel();
    setStore("activeModel", model);
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Create a new session and activate it.
 */
export async function newSession(name?: string): Promise<void> {
  setStore("error", null);
  try {
    const session = getApi().newSession(name ? { name } : undefined);
    const id = await session.id();
    setActiveSession(session as RpcStub<IWebGatewaySession>);
    setStore("activeSessionId", id);
    setStore("messages", []);
    setStore("isStreaming", false);
    setActiveTurn(null);
    // Reload session list to include the new session
    await loadSessions();
    // Load model for header
    const model = await session.getModel();
    setStore("activeModel", model);
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Delete a session by ID.
 * If it was the active session, clears the active state.
 */
export async function deleteSession(id: string): Promise<void> {
  setStore("error", null);
  try {
    const session = getApi().getSession(id);
    await session.delete();
    setStore("sessions", (sessions) => sessions.filter((s) => s.id !== id));
    if (store.activeSessionId === id) {
      setStore("activeSessionId", null);
      setStore("messages", []);
      setActiveSession(null);
      setActiveTurn(null);
    }
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Rename the active session.
 */
export async function renameSession(id: string, name: string): Promise<void> {
  setStore("error", null);
  try {
    const session = getApi().getSession(id);
    await session.setName(name);
    setStore("sessions", (sessions) => sessions.map((s) => (s.id === id ? { ...s, name } : s)));
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Set the model for the active session.
 */
export async function setModel(modelId: string): Promise<void> {
  const session = activeSession();
  if (!session) return;
  setStore("error", null);
  try {
    await session.setModel(modelId);
    const model = store.models.find((m) => m.id === modelId) ?? null;
    setStore("activeModel", model);
  } catch (err) {
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Send a user message and start an agent turn.
 * Creates a new EventListener and GatewayCallbackImpl per turn.
 */
export async function sendMessage(text: string): Promise<void> {
  const session = activeSession();
  if (!session || store.isStreaming) return;
  setStore("error", null);

  // Add user message immediately for instant feedback
  addMessage("user", text);
  setStore("isStreaming", true);

  try {
    const listener = new EventListener(handleAgentEvent);
    const callback = new GatewayCallbackImpl();
    const turn = session.prompt(text, listener, callback);
    setActiveTurn(turn as RpcStub<ITurnHandle>);
  } catch (err) {
    setStore("isStreaming", false);
    setStore("error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Abort the current agent turn.
 */
export async function abort(): Promise<void> {
  const turn = activeTurn();
  if (!turn) return;
  try {
    await turn.abort();
  } catch {
    // Ignore abort errors (turn may have already ended)
  }
  setStore("isStreaming", false);
  setActiveTurn(null);
  finishLastAssistantMessage();
}
