/**
 * AppLayout.tsx — Two-panel layout with sidebar for an active session.
 *
 * Renders directly — no child routes, no props.children.
 * SessionLayout is rendered inline.
 *
 * Sessions are created lazily on the server, so a newly-created session may
 * not appear in listSessions() immediately. We work around this by keeping a
 * `pendingSession` signal: when a session is resolved by SessionLayout and its
 * id is absent from the fetched list, we inject it at the top of the sidebar.
 */

import type { ISession, IUser } from "@piccolo/api";
import { useNavigate, useParams } from "@solidjs/router";
import { type Component, createMemo, createResource, createSignal, onMount } from "solid-js";
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

  // A session stub resolved client-side that may not yet be in the server list.
  const [pendingSession, setPendingSession] = createSignal<{
    id: string;
    session: ISession;
  } | null>(null);

  // Track session ids returned by the server list so we can deduplicate
  // the pending session without async comparisons inside createMemo.
  const [knownIds, setKnownIds] = createSignal<Set<string>>(new Set());

  // Re-resolve known ids whenever the sessions resource updates.
  createMemo(() => {
    const list = sessions();
    if (!list) return;
    void Promise.all(list.map((s) => s.sessionId())).then((ids) => {
      setKnownIds(new Set(ids));
    });
  });

  // Final sidebar list: prepend pending session only if the server hasn't
  // returned it yet.
  const finalSessions = createMemo(() => {
    const list = sessions() ?? [];
    const pending = pendingSession();
    if (!pending) return list;
    if (knownIds().has(pending.id)) return list;
    console.debug(`[sidebar] prepending pending session id=${pending.id}`);
    return [pending.session, ...list];
  });

  // Called by SessionLayout once it has resolved a session. Injects the stub
  // into the sidebar if absent from the server list.
  const handleSessionResolved = (id: string, session: ISession) => {
    console.debug(`[sidebar] session resolved id=${id}`);
    setPendingSession(() => ({ id, session }));
  };

  const handleNewSession = async () => {
    console.debug("[rpc] newSession calling...");
    try {
      const session = (await props.user.newSession()) as ISession;
      const id = await session.sessionId();
      console.debug(`[nav] newSession -> navigating to /sessions/${id}`);
      // Optimistically inject the new session into the sidebar immediately.
      setPendingSession(() => ({ id, session }));
      navigate(`/sessions/${id}`);
      // Refetch in the background so the server list eventually catches up.
      void refetchSessions();
    } catch (err) {
      console.error("[rpc] newSession error:", err);
    }
  };

  const handleSelectSession = (id: string) => {
    console.debug(`[nav] selectSession -> navigating to /sessions/${id}`);
    navigate(`/sessions/${id}`);
    void refetchSessions();
  };

  return (
    <div style="display:grid;grid-template-columns:260px 1fr;height:100vh;overflow:hidden;">
      <SessionSidebar
        sessions={finalSessions()}
        loading={sessions.loading}
        activeSessionId={params.id}
        onNewSession={() => void handleNewSession()}
        onSelectSession={handleSelectSession}
        onDeleteActiveSession={() => navigate("/sessions")}
        refetchSessions={refetchSessions}
      />
      <main style="display:flex;flex-direction:column;height:100vh;overflow:hidden;">
        <SessionLayout user={props.user} onSessionResolved={handleSessionResolved} />
      </main>
    </div>
  );
};
