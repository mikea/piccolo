/**
 * MessageList.tsx — Scrollable list of chat history entries.
 *
 * Accepts HistoryEntry[] directly from the server (via ISession.getHistory()).
 * No client-side Message type — the server is the source of truth.
 */

import type { HistoryEntry } from "@piccolo/api";
import { type Component, createEffect, For, onMount } from "solid-js";
import { MessageItem } from "./MessageItem.tsx";

interface Props {
  entries: HistoryEntry[];
}

export const MessageList: Component<Props> = (props) => {
  console.debug("[ui] MessageList mounted");
  let listRef: HTMLDivElement | undefined;

  createEffect(() => {
    const len = props.entries.length;
    console.debug("[ui] MessageList entries count=%d", len);
    if (listRef) listRef.scrollTop = listRef.scrollHeight;
  });

  onMount(() => {
    console.debug("[ui] MessageList onMount");
    if (listRef) listRef.scrollTop = listRef.scrollHeight;
  });

  return (
    <div
      ref={listRef}
      style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;"
    >
      <For each={props.entries}>{(entry) => <MessageItem entry={entry} />}</For>
    </div>
  );
};
