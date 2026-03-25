/**
 * SessionLayout.tsx — Two-panel layout: sidebar + chat area.
 */

import { type RouteSectionProps, useNavigate } from "@solidjs/router";
import { type Component, createResource } from "solid-js";
import type { ISession, IUser } from "@piccolo/core";
import { SessionSidebar } from "./SessionSidebar.tsx";

interface Props extends RouteSectionProps {
  user: IUser;
}

export const SessionLayout: Component<Props> = (props) => {
  const navigate = useNavigate();

  const [sessions, { refetch: refetchSessions }] = createResource(async () => {
    console.debug("[rpc] listSessions calling...");
    const result = await props.user.listSessions();
    console.debug("[rpc] listSessions →", result.length, "sessions");
    return result as ISession[];
  });

  const handleNewSession = async () => {
    console.debug("[rpc] newSession calling...");
    try {
      const session = await props.user.newSession();
      const id = await session.sessionId();
      console.debug("[rpc] newSession → id:", id);
      refetchSessions();
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
        onNewSession={() => void handleNewSession()}
        refetchSessions={refetchSessions}
      />
      <main style="display:flex;flex-direction:column;overflow:hidden;">{props.children}</main>
    </div>
  );
};
