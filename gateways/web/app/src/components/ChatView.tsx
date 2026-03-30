import type {
  AgentEvent,
  AnyEntry,
  ContextUsage,
  IDisposable,
  IObserver,
  ISession,
  ToolCallPart,
  ToolResultPart,
} from "@piccolo/api";
import { RpcTarget } from "capnweb";
import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { ChatInput } from "./ChatInput.tsx";
import { Header } from "./Header.tsx";
import { MessageList } from "./MessageList.tsx";

type StreamingAssistantEntry = {
  type: "streaming_assistant";
  id: string;
  content: string;
  reasoning: string;
  isStreaming: boolean;
};

type ToolLiveEntry = {
  type: "tool";
  id: string;
  toolName: string;
  input: ToolCallPart["input"] | undefined;
  output: ToolResultPart["output"] | undefined;
  isError: boolean;
  isStreaming: boolean;
};

type ErrorLiveEntry = { type: "error"; id: string; message: string };
type LocalUserEntry = { type: "local_user"; id: string; content: string };

const TRUNCATED_RECONNECT_PREFIX = "<Truncated, Will Update When Finished>";

export type UIEntry =
  | AnyEntry
  | StreamingAssistantEntry
  | ToolLiveEntry
  | ErrorLiveEntry
  | LocalUserEntry;

interface Props {
  session: ISession;
}

export const ChatView: Component<Props> = (props) => {
  const session = props.session;
  const [entries, setEntries] = createStore<UIEntry[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [contextUsage, setContextUsage] = createSignal<ContextUsage | undefined>(undefined);

  let aborted = false;
  let subscription: IDisposable | undefined;
  let joinedActiveTurn = false;

  function createStreamingAssistantEntry(truncated = false): StreamingAssistantEntry {
    return {
      type: "streaming_assistant",
      id: "streaming",
      content: truncated ? `${TRUNCATED_RECONNECT_PREFIX}\n` : "",
      reasoning: "",
      isStreaming: true,
    };
  }

  async function refreshEntriesFromServer(): Promise<void> {
    if (aborted) return;
    try {
      const history = await session.getEntries();
      if (!aborted) {
        setEntries(history);
      }
    } catch (err) {
      console.error("[rpc] refresh entries error:", err);
    }
  }

  onCleanup(() => {
    aborted = true;
    subscription?.[Symbol.dispose]();
    subscription = undefined;
    setEntries([]);
    setIsStreaming(false);
  });

  async function subscribeToSession(): Promise<void> {
    class SessionObserver extends RpcTarget implements IObserver<AgentEvent> {
      async onNext(event: AgentEvent): Promise<void> {
        console.debug(event);
        if (aborted) return;
        if (event.type === "start") setIsStreaming(true);
        if (event.type === "finish") setIsStreaming(false);
        if (event.type === "usage") setContextUsage({ inputTokens: event.inputTokens });
        applyEvent(event);
      }
      async onError(): Promise<void> {
        finishStreamingEntry();
        setIsStreaming(false);
      }
      async onComplete(): Promise<void> {
        setIsStreaming(false);
      }
    }

    subscription = await session.subscribe(new SessionObserver());
  }

  function applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case "start":
        setEntries((es) => {
          const idx = lastStreamingAssistantIdx(es);
          if (idx !== -1) return es;
          return [...es, createStreamingAssistantEntry()];
        });
        break;
      case "reasoning-delta": {
        setEntries((es) => {
          const idx = lastStreamingAssistantIdx(es);
          if (idx === -1) {
            const next = [...es, createStreamingAssistantEntry()];
            const inserted = next[next.length - 1];
            if (inserted?.type === "streaming_assistant") {
              next[next.length - 1] = { ...inserted, reasoning: event.delta };
            }
            return next;
          }
          return es.map((e, i) =>
            i === idx && e.type === "streaming_assistant"
              ? { ...e, reasoning: e.reasoning + event.delta }
              : e,
          );
        });
        break;
      }
      case "text-delta": {
        setEntries((es) => {
          const idx = lastStreamingAssistantIdx(es);
          if (idx === -1) {
            const next = [...es, createStreamingAssistantEntry()];
            const inserted = next[next.length - 1];
            if (inserted?.type === "streaming_assistant") {
              next[next.length - 1] = { ...inserted, content: event.delta };
            }
            return next;
          }
          return es.map((e, i) =>
            i === idx && e.type === "streaming_assistant"
              ? { ...e, content: e.content + event.delta }
              : e,
          );
        });
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
          },
        ]);
        break;
      case "tool-result":
        setEntries((es) => {
          const idx = es.findIndex((e) => e.type === "tool" && e.id === event.toolCallId);
          if (idx === -1) {
            return [
              ...es,
              {
                type: "tool",
                id: event.toolCallId,
                toolName: event.toolName,
                input: undefined,
                output: event.output as ToolResultPart["output"],
                isError: event.isError,
                isStreaming: false,
              },
            ];
          }
          return es.map((e, i) =>
            i === idx
              ? {
                  ...e,
                  output: event.output as ToolResultPart["output"],
                  isError: event.isError,
                  isStreaming: false,
                }
              : e,
          );
        });
        break;
      case "finish":
        finishStreamingEntry();
        if (joinedActiveTurn) {
          joinedActiveTurn = false;
          void refreshEntriesFromServer();
        }
        break;
      case "error":
        finishStreamingEntry();
        setEntries((es) => [
          ...es,
          { type: "error", id: Math.random().toString(36).slice(2), message: event.message },
        ]);
        break;
    }
  }

  function lastStreamingAssistantIdx(es: readonly UIEntry[]): number {
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (e?.type === "streaming_assistant" && e.isStreaming) return i;
    }
    return -1;
  }

  function finishStreamingEntry(): void {
    setEntries((es) =>
      es.map((e) => {
        if (e.type === "streaming_assistant" && e.isStreaming) return { ...e, isStreaming: false };
        if (e.type === "tool" && e.isStreaming) return { ...e, isStreaming: false };
        return e;
      }),
    );
  }

  onMount(() => {
    void (async () => {
      try {
        await subscribeToSession();
        const [history, turn, usage] = await Promise.all([
          session.getEntries(),
          session.getCurrentTurn(),
          session.getContextUsage(),
        ]);
        joinedActiveTurn = turn !== undefined;
        const initialEntries: UIEntry[] =
          turn !== undefined ? [...history, createStreamingAssistantEntry(true)] : history;
        setEntries(initialEntries);
        setContextUsage(usage);
        setIsStreaming(turn !== undefined);
      } catch (err) {
        console.error("[rpc] init error:", err);
      }
    })();
  });

  async function handleSend(text: string): Promise<void> {
    if (isStreaming()) return;
    try {
      const localUserId = Math.random().toString(36).slice(2);
      setEntries((es) => [...es, { type: "local_user", id: localUserId, content: text }]);
      await session.prompt(text);
    } catch {
      finishStreamingEntry();
      if (!aborted) setIsStreaming(false);
    }
  }

  async function handleAbort(): Promise<void> {
    try {
      const turn = await session.getCurrentTurn();
      await turn?.abort();
    } catch {
      // turn may have ended
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
