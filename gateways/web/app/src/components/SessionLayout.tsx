/**
 * SessionLayout.tsx — Fetches a session by id and renders ChatView.
 */

import { useParams } from "@solidjs/router";
import { type Component, createResource, createSignal, Show } from "solid-js";
import type { ISession, IUser } from "@piccolo/core";
import { ChatView } from "./ChatView.tsx";

interface Props {
  user: IUser;
}

export const SessionLayout: Component<Props> = (props) => {
  const params = useParams<{ id: string }>();
  const user = props.user;

  console.debug("[nav] SessionLayout mounted, params.id=%s", params.id);

  const [ready, setReady] = createSignal(false);
  let resolvedSession: ISession | null = null;

  createResource(
    () => params.id,
    async (id) => {
      console.debug("[rpc] getSession calling... id=%s", id);
      try {
        resolvedSession = await user.getSession(id) as ISession;
        console.debug("[rpc] getSession done id=%s", id);
        setReady(true);
      } catch (err) {
        console.error("[rpc] getSession error id=%s err=%o", id, err);
      }
    },
  );

  return (
    <div style="display:flex;flex-direction:column;height:100%;width:100%;">
      <Show when={ready()}>
        <ChatView session={resolvedSession!} />
      </Show>
    </div>
  );
};
