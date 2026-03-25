/**
 * MessageList.tsx — Scrollable list of chat messages.
 *
 * Uses SolidJS For for fine-grained updates — only the message being
 * streamed into causes a DOM update, not the whole list.
 * Auto-scrolls to the bottom on new messages.
 */

import { type Component, createEffect, For, onMount } from "solid-js";
import { store } from "../store.ts";
import { MessageItem } from "./MessageItem.tsx";

export const MessageList: Component = () => {
  let listRef: HTMLDivElement | undefined;

  // Auto-scroll to bottom whenever messages or their content changes
  createEffect(() => {
    // Access messages to track changes (including content updates during streaming)
    const _msgs = store.messages.map((m) => m.content).join("");
    void _msgs;
    if (listRef) {
      listRef.scrollTop = listRef.scrollHeight;
    }
  });

  onMount(() => {
    if (listRef) listRef.scrollTop = listRef.scrollHeight;
  });

  return (
    <div
      ref={listRef}
      style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"
    >
      <For each={store.messages}>{(message) => <MessageItem message={message} />}</For>
    </div>
  );
};
