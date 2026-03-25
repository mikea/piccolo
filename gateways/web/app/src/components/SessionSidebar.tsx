/**
 * SessionSidebar.tsx — Left panel: session list, new chat button.
 *
 * Features:
 * - Lists all sessions from the store, sorted by updatedAt (newest first)
 * - Active session highlighted
 * - Click to navigate to /sessions/:id
 * - Double-click session name to rename (inline edit)
 * - Delete button per session
 * - "New Chat" button at the top
 */

import { A, useNavigate } from "@solidjs/router";
import { type Component, createSignal, For, Show } from "solid-js";
import { deleteSession, renameSession, store } from "../store.ts";

interface Props {
  onNewSession: () => void;
}

export const SessionSidebar: Component<Props> = (props) => {
  return (
    <aside style="background:#1a1a1a;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;height:100vh;overflow:hidden;">
      {/* Header */}
      <div style="padding:12px;border-bottom:1px solid #2a2a2a;">
        <button
          type="button"
          onClick={props.onNewSession}
          style="width:100%;padding:8px 12px;background:#3d7eff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;"
        >
          + New Chat
        </button>
      </div>

      {/* Session list */}
      <div style="flex:1;overflow-y:auto;padding:8px;">
        <Show when={store.loadingSessions}>
          <p style="color:#666;font-size:13px;padding:8px;">Loading...</p>
        </Show>
        <For each={[...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)}>
          {(session) => (
            <SessionItem
              id={session.id}
              name={session.name ?? session.firstMessage ?? "New chat"}
              isActive={store.activeSessionId === session.id}
            />
          )}
        </For>
      </div>

      {/* Error */}
      <Show when={store.error}>
        <div style="padding:8px;background:#3a1a1a;color:#ff6b6b;font-size:12px;">
          {store.error}
        </div>
      </Show>
    </aside>
  );
};

interface ItemProps {
  id: string;
  name: string;
  isActive: boolean;
}

const SessionItem: Component<ItemProps> = (props) => {
  const navigate = useNavigate();
  const [editing, setEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal(props.name);

  const handleDelete = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Delete this session?")) {
      await deleteSession(props.id);
      if (props.isActive) navigate("/sessions");
    }
  };

  const handleDoubleClick = () => {
    setEditValue(props.name);
    setEditing(true);
  };

  const handleRenameBlur = async () => {
    setEditing(false);
    const val = editValue().trim();
    if (val && val !== props.name) {
      await renameSession(props.id, val);
    }
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      void handleRenameBlur();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  };

  const bg = () => (props.isActive ? "#2a3a5a" : "transparent");
  const hover = () => (props.isActive ? "#2a3a5a" : "#222");

  return (
    <div style={`background:${bg()};border-radius:6px;margin-bottom:2px;padding:2px;`}>
      <Show
        when={!editing()}
        fallback={
          <input
            type="text"
            value={editValue()}
            onInput={(e) => setEditValue(e.currentTarget.value)}
            onBlur={() => void handleRenameBlur()}
            onKeyDown={handleRenameKeyDown}
            style="width:100%;padding:6px 8px;background:#2a2a2a;color:#e8e8e8;border:1px solid #3d7eff;border-radius:4px;font-size:13px;"
            ref={(el) => setTimeout(() => el.focus(), 0)}
          />
        }
      >
        <A
          href={`/sessions/${props.id}`}
          style={`display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:4px;text-decoration:none;color:#e8e8e8;font-size:13px;cursor:pointer;&:hover{background:${hover()};}`}
          onDblClick={handleDoubleClick}
        >
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            {props.name}
          </span>
          <button
            type="button"
            onClick={(e) => void handleDelete(e)}
            style="flex-shrink:0;background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:3px;"
            title="Delete session"
          >
            ×
          </button>
        </A>
      </Show>
    </div>
  );
};
