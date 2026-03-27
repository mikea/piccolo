/**
 * EmptySessionLayout.tsx — Shown when no session is selected.
 */

import type { ISession, IUser } from "@piccolo/api";
import { useNavigate } from "@solidjs/router";
import { type Component, createResource } from "solid-js";
import { SessionSidebar } from "./SessionSidebar.tsx";

interface Props {
  user: IUser;
}

export const EmptySessionLayout: Component<Props> = (props) => {
  const navigate = useNavigate();
  const user = props.user;

  const [sessions, { refetch: refetchSessions }] = createResource(async () => {
    console.debug("[rpc] listSessions calling...");
    const result = (await user.listSessions()) as ISession[];
    console.debug(`[rpc] listSessions -> ${result.length} sessions`);
    return result;
  });

  const handleNew = async () => {
    console.debug("[rpc] newSession calling...");
    try {
      const session = (await user.newSession()) as ISession;
      const id = await session.sessionId();
      console.debug(`[nav] newSession -> navigating to /sessions/${id}`);
      await refetchSessions();
      navigate(`/sessions/${id}`);
    } catch (err) {
      console.error("[rpc] newSession error:", err);
    }
  };

  return (
    <div style="display:grid;grid-template-columns:260px 1fr;height:100vh;overflow:hidden;">
      <SessionSidebar
        sessions={sessions() ?? []}
        loading={sessions.loading}
        activeSessionId={null}
        onNewSession={() => void handleNew()}
        onSelectSession={(id) => navigate(`/sessions/${id}`)}
        onDeleteActiveSession={() => {}}
        refetchSessions={refetchSessions}
      />
      <main style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:#666;">
        <button
          type="button"
          onClick={() => {
            console.debug("[ui] start new chat button clicked");
            void handleNew();
          }}
          style="padding:10px 24px;background:#3d7eff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px;"
        >
          Start a new chat
        </button>
      </main>
    </div>
  );
};
