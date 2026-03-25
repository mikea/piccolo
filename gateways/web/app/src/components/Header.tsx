/**
 * Header.tsx — Chat panel header.
 *
 * Shows the current session name and model picker.
 */

import { type Component, Show } from "solid-js";
import { store } from "../store.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export const Header: Component = () => {
  const sessionName = () => {
    const id = store.activeSessionId;
    if (!id) return "Chat";
    const session = store.sessions.find((s) => s.id === id);
    return session?.name ?? session?.firstMessage ?? "New chat";
  };

  return (
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2a2a2a;background:#111;flex-shrink:0;">
      <span style="font-size:14px;font-weight:500;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        {sessionName()}
      </span>
      <Show when={store.models.length > 0}>
        <ModelPicker />
      </Show>
    </div>
  );
};
