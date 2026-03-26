/**
 * App.tsx — Root component with SolidJS Router setup.
 */

import { Navigate, Route, Router } from "@solidjs/router";
import type { Component } from "solid-js";
import type { IUser } from "@piccolo/core";
import { AppLayout } from "./components/AppLayout.tsx";
import { EmptySessionLayout } from "./components/EmptySessionLayout.tsx";

interface Props {
  user: IUser;
}

export const App: Component<Props> = (props) => {
  const AppLayoutWithUser: Component = () => <AppLayout user={props.user} />;
  const EmptyWithUser: Component = () => <EmptySessionLayout user={props.user} />;

  return (
    <Router>
      <Route path="/" component={() => <Navigate href="/sessions" />} />
      <Route path="/sessions" component={EmptyWithUser} />
      <Route path="/sessions/:id" component={AppLayoutWithUser} />
    </Router>
  );
};
