/**
 * SessionLayout.tsx — Fetches a session by id and renders ChatView.
 *
 * The inner <Show> is keyed via null-clearing so that ChatView is fully
 * unmounted and remounted whenever the active session changes. This
 * ensures ChatView's captured `session` reference is always fresh and
 * its onMount/onCleanup lifecycle runs correctly per session.
 *
 * Calls onSessionResolved once the session stub is resolved so the parent
 * can inject it into the sidebar list when the server list doesn't include
 * it yet (lazy session creation).
 */

import type { ISession, IUser } from "@piccolo/api";
import { useParams } from "@solidjs/router";
import { type Component, createResource, createSignal, Show } from "solid-js";
import { ChatView } from "./ChatView.tsx";

interface Props {
  user: IUser;
  onSessionResolved?: (id: string, session: ISession) => void;
}

export const SessionLayout: Component<Props> = (props) => {
  const params = useParams<{ id: string }>();
  const user = props.user;

  console.debug(`[nav] SessionLayout mounted, params.id=${params.id}`);

  // resolvedSession tracks both the session stub and the id it belongs to.
  // Storing the id alongside lets the Show key on it to force ChatView remounts.
  const [resolvedSession, setResolvedSession] = createSignal<{
    id: string;
    session: ISession;
  } | null>(null);

  createResource(
    () => params.id,
    async (id) => {
      // Clear the previous session immediately so the old ChatView unmounts
      // before the new one mounts.
      setResolvedSession(null);
      console.debug(`[rpc] getSession calling... id=${id}`);
      try {
        const nextSession = (await user.getSession(id)) as ISession;
        // Cap'n Web stubs are callable proxies; wrap in a setter thunk so
        // Solid stores the value instead of treating it as an updater function.
        setResolvedSession(() => ({ id, session: nextSession }));
        console.debug(`[rpc] getSession done id=${id}`);
        // Notify parent so it can inject this session into the sidebar if the
        // server list doesn't include it yet (lazy creation).
        props.onSessionResolved?.(id, nextSession);
      } catch (err) {
        console.error(`[rpc] getSession error id=${id}`, err);
      }
    },
  );

  return (
    <div style="display:flex;flex-direction:column;height:100%;width:100%;">
      <Show when={resolvedSession()}>
        {(resolved) => <ChatView session={resolved().session} />}
      </Show>
    </div>
  );
};
