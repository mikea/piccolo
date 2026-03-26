/**
 * SessionSidebar.tsx — Left panel: session list, new chat button.
 */

import type { ISession } from "@piccolo/core";
import { type Component, createResource, createSignal, For, Show } from "solid-js";

interface Props {
  sessions: ISession[];
  loading: boolean;
  activeSessionId: string | null;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteActiveSession: () => void;
  refetchSessions: () => void;
}

export const SessionSidebar: Component<Props> = (props) => (
  <aside style="background:#1a1a1a;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;height:100vh;overflow:hidden;">
    <div style="padding:12px;border-bottom:1px solid #2a2a2a;">
      <button
        type="button"
        onClick={() => {
          console.debug("[ui] new chat button clicked");
          props.onNewSession();
        }}
        style="width:100%;padding:8px 12px;background:#3d7eff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;"
      >
        + New Chat
      </button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:8px;">
      <Show when={props.loading}>
        <p style="color:#666;font-size:13px;padding:8px;">Loading...</p>
      </Show>
      <For each={props.sessions}>
        {(session) => (
          <SessionItem
            session={session}
            activeSessionId={props.activeSessionId}
            onSelect={props.onSelectSession}
            onDeleteActive={props.onDeleteActiveSession}
            refetchSessions={props.refetchSessions}
          />
        )}
      </For>
    </div>
  </aside>
);

interface ItemProps {
  session: ISession;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDeleteActive: () => void;
  refetchSessions: () => void;
}

const SessionItem: Component<ItemProps> = (props) => {
  const session = props.session;

  const [editing, setEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal("");

  const [info] = createResource(async () => {
    const [id, name] = await Promise.all([session.sessionId(), session.getName()]);
    return { id, name };
  });

  const displayName = () => info()?.name ?? "New chat";
  const isActive = () => info()?.id === props.activeSessionId;
  const bg = () => (isActive() ? "#2a3a5a" : "transparent");

  const handleDelete = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Delete this session?")) {
      const wasActive = isActive();
      try {
        await session.delete();
        props.refetchSessions();
        if (wasActive) props.onDeleteActive();
      } catch (err) {
        console.error("[rpc] delete error:", err);
      }
    }
  };

  const handleRenameBlur = async () => {
    setEditing(false);
    const val = editValue().trim();
    if (val && val !== displayName()) {
      try {
        await session.setName(val);
        props.refetchSessions();
      } catch (err) {
        console.error("[rpc] setName error:", err);
      }
    }
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") void handleRenameBlur();
    else if (e.key === "Escape") setEditing(false);
  };

  return (
    <Show when={info()}>
      {(i) => (
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
            <div style="display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:4px;color:#e8e8e8;font-size:13px;">
              <button
                type="button"
                onClick={() => props.onSelect(i().id)}
                onDblClick={() => {
                  setEditValue(displayName());
                  setEditing(true);
                }}
                style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:none;color:#e8e8e8;text-align:left;cursor:pointer;padding:0;"
              >
                {displayName()}
              </button>
              <button
                type="button"
                onClick={(e) => void handleDelete(e)}
                style="flex-shrink:0;background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:3px;"
              >
                ×
              </button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
};
