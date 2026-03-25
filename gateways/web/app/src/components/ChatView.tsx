/**
 * ChatView.tsx — Main chat panel for an active session.
 *
 * Loaded when the route is /sessions/:id.
 * Activates the session in the store on mount and on param change.
 * Renders Header + MessageList + ChatInput stacked vertically.
 */

import { useParams } from "@solidjs/router";
import { type Component, createEffect } from "solid-js";
import { selectSession } from "../store.ts";
import { ChatInput } from "./ChatInput.tsx";
import { Header } from "./Header.tsx";
import { MessageList } from "./MessageList.tsx";

export const ChatView: Component = () => {
  const params = useParams<{ id: string }>();

  // Activate session whenever the :id param changes
  createEffect(() => {
    const id = params.id;
    if (id) {
      void selectSession(id);
    }
  });

  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      <Header />
      <MessageList />
      <ChatInput />
    </div>
  );
};
