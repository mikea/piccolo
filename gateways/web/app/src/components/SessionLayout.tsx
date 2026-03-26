/**
 * SessionLayout.tsx — Fetches a session by id and renders ChatView.
 */

import type { ISession, IUser } from "@piccolo/api";
import { useParams } from "@solidjs/router";
import { type Component, createResource, createSignal, Show } from "solid-js";
import { ChatView } from "./ChatView.tsx";

interface Props {
  user: IUser;
}

export const SessionLayout: Component<Props> = (props) => {
  const params = useParams<{ id: string }>();
  const user = props.user;

  console.debug(`[nav] SessionLayout mounted, params.id=${params.id}`);

  const [resolvedSession, setResolvedSession] = createSignal<ISession | null>(null);

  createResource(
    () => params.id,
    async (id) => {
      console.debug(`[rpc] getSession calling... id=${id}`);
      try {
        const nextSession = (await user.getSession(id)) as ISession;
        // Cap'n Web stubs are callable proxies; wrap in a setter thunk so
        // Solid stores the value instead of treating it as an updater function.
        setResolvedSession(() => nextSession);
        console.debug(`[rpc] getSession done id=${id}`);
      } catch (err) {
        console.error(`[rpc] getSession error id=${id}`, err);
      }
    },
  );

  return (
    <div style="display:flex;flex-direction:column;height:100%;width:100%;">
      <Show when={resolvedSession()}>{(session) => <ChatView session={session()} />}</Show>
    </div>
  );
};
