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

import type { AgentEvent, HistoryEntry, ISession } from "@piccolo/api";
import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { ChatInput } from "./ChatInput.tsx";
import { Header } from "./Header.tsx";
import { MessageList } from "./MessageList.tsx";

interface Props {
  session: ISession;
}

export const ChatView: Component<Props> = (props) => {
  console.debug("[nav] ChatView mounted");
  // Capture once — never read props.session in reactive context.
  const session = props.session;

  const [entries, setEntries] = createStore<HistoryEntry[]>([]);
  // isStreaming tracks whether we're actively consuming a stream (client-side only, for UI controls).
  const [isStreaming, setIsStreaming] = createSignal(false);

  let aborted = false;

  onCleanup(() => {
    aborted = true;
    setEntries([]);
    setIsStreaming(false);
  });

  // ─── Stream consumption ────────────────────────────────────────────────────

  /**
   * Consume a ReadableStream<AgentEvent> and update entries reactively.
   * Handles both prompt() streams and getCurrentTurn() reconnect streams.
   *
   * `setStreaming` controls whether we call setIsStreaming(true/false).
   * For getCurrentTurn() reconnects we only flip isStreaming if the stream is
   * actually live (i.e. we receive at least one event before done).
   */
  async function consumeStream(
    stream: ReadableStream<AgentEvent>,
    setStreaming = true,
  ): Promise<void> {
    console.debug("[stream] consumeStream start, setStreaming=%s", setStreaming);
    let streamingSet = false;
    let eventCount = 0;
    try {
      for await (const event of stream) {
        if (aborted) break;
        console.debug("[stream] event: type=%s aborted=%s", event?.type ?? "—", aborted);
        eventCount++;
        if (setStreaming && !streamingSet) {
          setIsStreaming(true);
          streamingSet = true;
          console.debug("[ui] isStreaming → true (from stream)");
        }
        applyEvent(event);
      }
    } catch (err) {
      console.error("[stream] read error:", err);
      finishStreamingEntry();
    } finally {
      console.debug("[stream] consumeStream done, eventCount=%d", eventCount);
      if (!aborted && streamingSet) {
        setIsStreaming(false);
        console.debug("[ui] isStreaming → false (from stream)");
      }
    }
  }

  function applyEvent(event: AgentEvent): void {
    console.debug("[ui] applyEvent type=%s", event.type);
    switch (event.type) {
      case "agent_start":
        // Add a new streaming assistant entry.
        setEntries((es) => [
          ...es,
          { type: "assistant", id: "streaming", content: "", isStreaming: true } as HistoryEntry,
        ]);
        break;
      case "text_delta":
        // Append text to the last streaming assistant entry.
        setEntries((es) => {
          const idx = lastStreamingAssistantIdx(es);
          if (idx === -1) return es;
          return es.map((e, i) => {
            if (i !== idx || e.type !== "assistant") return e;
            return { ...e, content: e.content + event.delta };
          });
        });
        break;
      case "tool_start":
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
      case "tool_end":
        setEntries((es) =>
          es.map((e) => {
            if (e.type !== "tool" || e.id !== event.toolCallId) return e;
            return { ...e, output: event.output, isError: event.isError, isStreaming: false };
          }),
        );
        break;
      case "agent_end":
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

  function lastStreamingAssistantIdx(es: readonly HistoryEntry[]): number {
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
        // Load history and active turn in parallel.
        console.debug("[rpc] getHistory + getCurrentTurn calling...");
        const [history, turn] = await Promise.all([session.getHistory(), session.getCurrentTurn()]);
        console.debug("[rpc] getHistory →", history.length, "entries");
        setEntries(history);

        // getCurrentTurn() returns undefined when idle — non-undefined means streaming.
        if (turn !== undefined) {
          console.debug("[rpc] getCurrentTurn → active turn, reconnecting stream");
          const stream = await turn.getStream();
          void consumeStream(stream);
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
    console.debug("[rpc] prompt calling... text=%s", text.slice(0, 60));
    const userId = Math.random().toString(36).slice(2);
    setEntries((es) => [...es, { type: "user", id: userId, content: text } as HistoryEntry]);
    setIsStreaming(true);
    console.debug("[ui] isStreaming → true");
    try {
      const turn = await session.prompt(text);
      const stream = await turn.getStream();
      console.debug(
        "[rpc] prompt returned turn+stream, type=%s",
        Object.prototype.toString.call(stream),
      );
      // Pass setStreaming=false — isStreaming is already true above.
      await consumeStream(stream, false);
      console.debug("[rpc] consumeStream finished");
    } catch (err) {
      console.error("[rpc] prompt/stream error:", err);
      finishStreamingEntry();
    } finally {
      if (!aborted) {
        setIsStreaming(false);
        console.debug("[ui] isStreaming → false");
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
      <Header session={session} />
      <MessageList entries={entries} />
      <ChatInput
        isStreaming={isStreaming()}
        onSend={(text: string) => void handleSend(text)}
        onAbort={() => void handleAbort()}
      />
    </div>
  );
};
