/**
 * App.tsx — Root component with SolidJS Router setup.
 *
 * Receives the IUser stub and passes it down to all route components.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import { Navigate, Route, Router } from "@solidjs/router";
import type { Component } from "solid-js";
import type { IUser } from "@piccolo/core";
import { ChatView } from "./components/ChatView.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { SessionLayout } from "./components/SessionLayout.tsx";

interface Props {
  user: IUser;
}

export const App: Component<Props> = (props) => (
  <Router>
    <Route path="/" component={() => <Navigate href="/sessions" />} />
    <Route path="/sessions" component={(p) => <SessionLayout user={props.user} {...p} />}>
      <Route path="/" component={() => <EmptyState user={props.user} />} />
      <Route path="/:id" component={() => <ChatView user={props.user} />} />
    </Route>
  </Router>
);
