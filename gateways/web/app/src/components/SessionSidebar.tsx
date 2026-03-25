/**
 * SessionSidebar.tsx — Left panel: session list, new chat button.
 */

import { A, useMatch, useNavigate } from "@solidjs/router";
import { type Component, createResource, createSignal, For, Show } from "solid-js";
import type { ISession } from "@piccolo/core";

interface Props {
  sessions: ISession[];
  loading: boolean;
  onNewSession: () => void;
  refetchSessions: () => void;
}

export const SessionSidebar: Component<Props> = (props) => (
  <aside style="background:#1a1a1a;border-right:1px solid #2a2a2a;display:flex;flex-direction:column;height:100vh;overflow:hidden;">
    <div style="padding:12px;border-bottom:1px solid #2a2a2a;">
      <button
        type="button"
        onClick={props.onNewSession}
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
        {(session) => <SessionItem session={session} refetchSessions={props.refetchSessions} />}
      </For>
    </div>
  </aside>
);

interface ItemProps {
  session: ISession;
  refetchSessions: () => void;
}

const SessionItem: Component<ItemProps> = (props) => {
  const navigate = useNavigate();
  const [editing, setEditing] = createSignal(false);
  const [editValue, setEditValue] = createSignal("");

  const [info] = createResource(async () => {
    const [id, name] = await Promise.all([props.session.sessionId(), props.session.getName()]);
    return { id, name };
  });

  const displayName = () => info()?.name ?? "New chat";
  const matchActive = useMatch(() => `/sessions/${info()?.id ?? "__none__"}`);
  const isActive = () => !!matchActive();
  const bg = () => (isActive() ? "#2a3a5a" : "transparent");

  const handleDelete = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Delete this session?")) {
      try {
        await props.session.delete();
        props.refetchSessions();
        if (isActive()) navigate("/sessions");
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
        await props.session.setName(val);
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
            <A
              href={`/sessions/${i().id}`}
              style="display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:4px;text-decoration:none;color:#e8e8e8;font-size:13px;cursor:pointer;"
              onDblClick={() => { setEditValue(displayName()); setEditing(true); }}
            >
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                {displayName()}
              </span>
              <button
                type="button"
                onClick={(e) => void handleDelete(e)}
                style="flex-shrink:0;background:none;border:none;color:#666;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:3px;"
              >×</button>
            </A>
          </Show>
        </div>
      )}
    </Show>
  );
};
