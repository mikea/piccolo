/**
 * ChatView.tsx — Main chat panel for an active session.
 *
 * Fetches the session via user.getSession(id) on route change.
 * Owns all turn state. Passes ISession down as props.
 */

import { useParams } from "@solidjs/router";
import { type Component, createEffect, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { AgentEvent, ISession, IUser } from "@piccolo/core";
import type { Message, MessageRole } from "./types.ts";
import { ChatInput } from "./ChatInput.tsx";
import { Header } from "./Header.tsx";
import { MessageList } from "./MessageList.tsx";

interface Props {
  user: IUser;
}

export const ChatView: Component<Props> = (props) => {
  const params = useParams<{ id: string }>();

  const [session, setSession] = createSignal<ISession | null>(null);
  const [messages, setMessages] = createStore<Message[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);

  createEffect(() => {
    const id = params.id;
    if (!id) return;
    setSession(null);
    setMessages([]);
    setIsStreaming(false);
    console.debug("[rpc] getSession calling...", id);
    props.user.getSession(id)
      .then((s) => { setSession(s); console.debug("[rpc] getSession →", id); })
      .catch((err) => console.error("[rpc] getSession error:", err));
  });

  function addMessage(role: MessageRole, content: string, streaming = false): void {
    const id = Math.random().toString(36).slice(2, 10);
    setMessages((msgs) => [...msgs, { id, role, content, isStreaming: streaming }]);
  }

  function updateLastAssistant(f: (c: string) => string): void {
    setMessages((msgs) => {
      const idx = msgs.length - 1;
      if (idx < 0 || msgs[idx]?.role !== "assistant") return msgs;
      return msgs.map((m, i) => i === idx ? { ...m, content: f(m.content) } : m);
    });
  }

  function finishLastAssistant(): void {
    setMessages((msgs) => {
      const idx = msgs.length - 1;
      if (idx < 0 || msgs[idx]?.role !== "assistant") return msgs;
      return msgs.map((m, i) => i === idx ? { ...m, isStreaming: false } : m);
    });
  }

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start": addMessage("assistant", "", true); break;
      case "text_delta": updateLastAssistant((c) => c + event.delta); break;
      case "agent_end": finishLastAssistant(); setIsStreaming(false); break;
      case "error":
        finishLastAssistant(); setIsStreaming(false);
        addMessage("error", event.message);
        break;
      case "tool_start": addMessage("tool", `Running: ${event.toolName}...`); break;
      case "tool_end": if (event.isError) addMessage("error", `Tool ${event.toolName} failed`); break;
    }
  }

  async function handleSend(text: string): Promise<void> {
    const s = session();
    if (!s || isStreaming()) return;
    console.debug("[rpc] prompt calling...");
    addMessage("user", text);
    setIsStreaming(true);
    try {
      const stream = await s.prompt(text);
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        handleEvent(value);
      }
    } catch (err) {
      console.error("[rpc] prompt error:", err);
      finishLastAssistant();
      setIsStreaming(false);
    }
  }

  async function handleAbort(): Promise<void> {
    const s = session();
    if (!s) return;
    try { await s.abort(); } catch { /* turn may have ended */ }
    finishLastAssistant();
    setIsStreaming(false);
  }

  const s = session();
  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      {s && <Header session={s} />}
      <MessageList messages={messages} />
      <ChatInput
        isStreaming={isStreaming()}
        onSend={(text: string) => void handleSend(text)}
        onAbort={() => void handleAbort()}
      />
    </div>
  );
};
