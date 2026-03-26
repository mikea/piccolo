/**
 * AppLayout.tsx — Two-panel layout with sidebar for an active session.
 *
 * Renders directly — no child routes, no props.children.
 * SessionLayout is rendered inline.
 */

import type { ISession, IUser } from "@piccolo/api";
import { useNavigate, useParams } from "@solidjs/router";
import { type Component, createResource, onMount } from "solid-js";
import { SessionLayout } from "./SessionLayout.tsx";
import { SessionSidebar } from "./SessionSidebar.tsx";

interface Props {
  user: IUser;
}

export const AppLayout: Component<Props> = (props) => {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();

  onMount(() => console.debug(`[nav] AppLayout mounted, params.id=${params.id}`));

  const [sessions, { refetch: refetchSessions }] = createResource(async () => {
    console.debug("[rpc] listSessions calling...");
    const result = (await props.user.listSessions()) as ISession[];
    console.debug(`[rpc] listSessions -> ${result.length} sessions`);
    return result;
  });

  const handleNewSession = async () => {
    console.debug("[rpc] newSession calling...");
    try {
      const session = (await props.user.newSession()) as ISession;
      const id = await session.sessionId();
      console.debug(`[nav] newSession -> navigating to /sessions/${id}`);
      refetchSessions();
      navigate(`/sessions/${id}`);
    } catch (err) {
      console.error("[rpc] newSession error:", err);
    }
  };

  const handleSelectSession = (id: string) => {
    console.debug(`[nav] selectSession -> navigating to /sessions/${id}`);
    navigate(`/sessions/${id}`);
  };

  return (
    <div style="display:grid;grid-template-columns:260px 1fr;height:100vh;overflow:hidden;">
      <SessionSidebar
        sessions={sessions() ?? []}
        loading={sessions.loading}
        activeSessionId={params.id}
        onNewSession={() => void handleNewSession()}
        onSelectSession={handleSelectSession}
        onDeleteActiveSession={() => navigate("/sessions")}
        refetchSessions={refetchSessions}
      />
      <main style="display:flex;flex-direction:column;height:100vh;overflow:hidden;">
        <SessionLayout user={props.user} />
      </main>
    </div>
  );
};
