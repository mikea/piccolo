/**
 * MessageList.tsx — Scrollable list of chat messages.
 *
 * Pure presentational component. Messages are passed as a prop from ChatView.
 */

import { type Component, createEffect, For, onMount } from "solid-js";
import type { Message } from "./types.ts";
import { MessageItem } from "./MessageItem.tsx";

interface Props {
  messages: Message[];
}

export const MessageList: Component<Props> = (props) => {
  let listRef: HTMLDivElement | undefined;

  createEffect(() => {
    const _msgs = props.messages.map((m) => m.content).join("");
    void _msgs;
    if (listRef) listRef.scrollTop = listRef.scrollHeight;
  });

  onMount(() => {
    if (listRef) listRef.scrollTop = listRef.scrollHeight;
  });

  return (
    <div
      ref={listRef}
      style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"
    >
      <For each={props.messages}>{(message) => <MessageItem message={message} />}</For>
    </div>
  );
};
