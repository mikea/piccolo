/**
 * ChatView.tsx — Main chat panel for an active session.
 *
 * Receives the ISession RPC stub as a prop from SessionLayout.
 * All conversation state is server-owned. On mount we call getHistory() and
 * getCurrentTurn() in parallel. A non-undefined getCurrentTurn() result means
 * a turn is in progress (replaces any separate getStatus()/isStreaming check).
 *
 * No local "messages" store. The server is the single source of truth.
 *
 * IMPORTANT: ISession is an RpcStub Proxy. Capture it as a plain variable
 * at component init — never pass it into SolidJS reactive primitives.
 */

import type {
  AgentEvent,
  ContextUsage,
  HistoryEntry,
  IDisposable,
  IObserver,
  ISession,
} from "@piccolo/api";
import { RpcTarget } from "capnweb";
import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { ChatInput } from "./ChatInput.tsx";
import { Header } from "./Header.tsx";
import { MessageList } from "./MessageList.tsx";

/**
 * Local extension of the assistant HistoryEntry that carries ephemeral
 * reasoning text while streaming. `reasoning` is cleared on the first
 * text-delta so it disappears when the real response starts.
 */
export type UIEntry =
  | HistoryEntry
  | (Extract<HistoryEntry, { type: "assistant" }> & { reasoning: string });

interface Props {
  session: ISession;
}

export const ChatView: Component<Props> = (props) => {
  console.debug("[nav] ChatView mounted");
  // Capture once — never read props.session in reactive context.
  const session = props.session;

  const [entries, setEntries] = createStore<UIEntry[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [contextUsage, setContextUsage] = createSignal<ContextUsage | undefined>(undefined);

  let aborted = false;
  let subscription: IDisposable | undefined;

  onCleanup(() => {
    aborted = true;
    subscription?.[Symbol.dispose]();
    subscription = undefined;
    setEntries([]);
    setIsStreaming(false);
  });

  // ─── Session observable subscription ──────────────────────────────────────

  /**
   * Subscribe to the session observable once on mount and run for the session
   * lifetime. All AgentEvents from all turns flow through this single subscription.
   * isStreaming is driven by start (true) / finish (false).
   */
  async function subscribeToSession(): Promise<void> {
    // Must extend RpcTarget so capnweb serializes this as a callable RPC
    // capability (not a plain JSON value). The server calls back onNext/onError/
    // onComplete on this stub over the WebSocket.
    class SessionObserver extends RpcTarget implements IObserver<AgentEvent> {
      async onNext(event: AgentEvent): Promise<void> {
        if (aborted) return;
        console.debug("[session] event: %o", event);
        if (event.type === "start") {
          setIsStreaming(true);
          console.debug("[ui] isStreaming → true (start)");
        } else if (event.type === "finish") {
          setIsStreaming(false);
          console.debug("[ui] isStreaming → false (finish)");
        } else if (event.type === "usage") {
          setContextUsage({ inputTokens: event.inputTokens });
          console.debug("[ui] contextUsage →", event.inputTokens, "tokens");
        }
        applyEvent(event);
      }
      async onError(err: unknown): Promise<void> {
        console.error("[stream] session error:", err);
        finishStreamingEntry();
        setIsStreaming(false);
      }
      async onComplete(): Promise<void> {
        console.debug("[stream] session observable complete");
        setIsStreaming(false);
      }
    }

    console.debug("[stream] subscribing to session");
    subscription = await session.subscribe(new SessionObserver());
  }

  function applyEvent(event: AgentEvent): void {
    console.debug("[ui] applyEvent type=%s", event.type);
    switch (event.type) {
      case "start":
        // Add a new streaming assistant entry.
        setEntries((es) => [
          ...es,
          { type: "assistant", id: "streaming", content: "", isStreaming: true, reasoning: "" },
        ]);
        break;
      case "reasoning-delta": {
        // Accumulate reasoning text while streaming using granular store mutation.
        const ridx = lastStreamingAssistantIdx(entries);
        if (ridx !== -1) {
          setEntries(ridx, (e) => {
            const r = "reasoning" in e ? (e as { reasoning: string }).reasoning : "";
            return { ...e, reasoning: r + event.delta };
          });
        }
        break;
      }
      case "text-delta": {
        // Append text using granular store mutation. Reasoning is preserved —
        // the ReasoningBlock component collapses it when isStreaming flips to false.
        const tidx = lastStreamingAssistantIdx(entries);
        if (tidx !== -1) {
          setEntries(tidx, (e) => {
            if (e.type !== "assistant") return e;
            return { ...e, content: e.content + event.delta };
          });
        }
        break;
      }
      case "tool-call":
        setEntries((es) => [
          ...es,
          {
            type: "tool",
            id: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            output: undefined,
            isError: false,
            isStreaming: true,
          } as HistoryEntry,
        ]);
        break;
      case "tool-result":
        setEntries((es) =>
          es.map((e) => {
            if (e.type !== "tool" || e.id !== event.toolCallId) return e;
            return { ...e, output: event.output, isError: event.isError, isStreaming: false };
          }),
        );
        break;
      case "finish":
        finishStreamingEntry();
        break;
      case "error":
        finishStreamingEntry();
        setEntries((es) => [
          ...es,
          {
            type: "error",
            id: Math.random().toString(36).slice(2),
            message: event.message,
          } as HistoryEntry,
        ]);
        break;
    }
  }

  function lastStreamingAssistantIdx(es: readonly UIEntry[]): number {
    for (let i = es.length - 1; i >= 0; i--) {
      if (es[i]?.type === "assistant" && (es[i] as { isStreaming: boolean }).isStreaming) return i;
    }
    return -1;
  }

  function finishStreamingEntry(): void {
    setEntries((es) =>
      es.map((e) => {
        if (e.type === "assistant" && e.isStreaming) return { ...e, isStreaming: false };
        if (e.type === "tool" && e.isStreaming) return { ...e, isStreaming: false };
        return e;
      }),
    );
  }

  // ─── Initialisation ────────────────────────────────────────────────────────

  onMount(() => {
    void (async () => {
      try {
        // Subscribe to session observable first so no events are missed.
        void subscribeToSession();

        // Load history, active turn, and usage in parallel.
        console.debug("[rpc] getHistory + getCurrentTurn + getContextUsage calling...");
        const [history, turn, usage] = await Promise.all([
          session.getHistory(),
          session.getCurrentTurn(),
          session.getContextUsage(),
        ]);
        console.debug("[rpc] getHistory →", history.length, "entries");
        console.debug("[rpc] getContextUsage →", usage.inputTokens, "tokens");
        setEntries(history);
        setContextUsage(usage);

        // If a turn is already active on mount (e.g. page reload mid-turn), set isStreaming.
        if (turn !== undefined) {
          console.debug("[rpc] getCurrentTurn → active turn in progress");
          setIsStreaming(true);
        } else {
          console.debug("[rpc] getCurrentTurn → no active turn");
        }
      } catch (err) {
        console.error("[rpc] init error:", err);
      }
    })();
  });

  // ─── User actions ──────────────────────────────────────────────────────────

  async function handleSend(text: string): Promise<void> {
    if (isStreaming()) {
      console.debug("[ui] handleSend blocked — already streaming");
      return;
    }
    const userId = Math.random().toString(36).slice(2);
    setEntries((es) => [...es, { type: "user", id: userId, content: text } as HistoryEntry]);
    try {
      console.debug("[rpc] prompt calling... text=%s", text.slice(0, 60));
      await session.prompt(text);
      console.debug("[rpc] prompt returned — events arriving via session subscription");
      // isStreaming will be set to true by start and false by finish
      // flowing through the session subscription.
    } catch (err) {
      console.error("[rpc] prompt error:", err);
      finishStreamingEntry();
      if (!aborted) {
        setIsStreaming(false);
        console.debug("[ui] isStreaming → false (prompt error)");
      }
    }
  }

  async function handleAbort(): Promise<void> {
    try {
      await session.abort();
    } catch {
      /* turn may have ended */
    }
    finishStreamingEntry();
    setIsStreaming(false);
  }

  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <Header session={session} contextUsage={contextUsage()} />
      <MessageList entries={entries} />
      <ChatInput
        isStreaming={isStreaming()}
        onSend={(text: string) => void handleSend(text)}
        onAbort={() => void handleAbort()}
      />
    </div>
  );
};
