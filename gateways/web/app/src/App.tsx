/**
 * App.tsx — Root component with SolidJS Router setup.
 */

import type { IUser } from "@piccolo/api";
import { Navigate, Route, Router } from "@solidjs/router";
import type { Accessor, Component } from "solid-js";
import { Show } from "solid-js";
import { AppLayout } from "./components/AppLayout.tsx";
import { EmptySessionLayout } from "./components/EmptySessionLayout.tsx";

interface Props {
  user: IUser;
  wsError: Accessor<string | null>;
}

export const App: Component<Props> = (props) => {
  const AppLayoutWithUser: Component = () => <AppLayout user={props.user} />;
  const EmptyWithUser: Component = () => <EmptySessionLayout user={props.user} />;

  return (
    <>
      <Show when={props.wsError()}>
        {(msg) => (
          <div style="position:fixed;top:0;left:0;right:0;z-index:9999;background:#3a1a1a;color:#ff6b6b;padding:12px 16px;font-size:14px;border-bottom:2px solid #ff4444;display:flex;align-items:center;gap:8px;">
            <span style="font-weight:600;">⚠ WebSocket error:</span>
            <span>{msg()}</span>
          </div>
        )}
      </Show>
      <Router>
        <Route path="/" component={() => <Navigate href="/sessions" />} />
        <Route path="/sessions" component={EmptyWithUser} />
        <Route path="/sessions/:id" component={AppLayoutWithUser} />
      </Router>
    </>
  );
};
