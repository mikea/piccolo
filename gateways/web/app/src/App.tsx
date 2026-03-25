/**
 * App.tsx — Root component with SolidJS Router setup.
 *
 * Routes:
 *   /                 → redirect to /sessions
 *   /sessions         → SessionLayout (sidebar + outlet)
 *   /sessions/        → EmptyState (no session selected)
 *   /sessions/:id     → ChatView
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import { Navigate, Route, Router } from "@solidjs/router";
import type { Component } from "solid-js";
import { ChatView } from "./components/ChatView.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { SessionLayout } from "./components/SessionLayout.tsx";

export const App: Component = () => (
  <Router>
    <Route path="/" component={() => <Navigate href="/sessions" />} />
    <Route path="/sessions" component={SessionLayout}>
      <Route path="/" component={EmptyState} />
      <Route path="/:id" component={ChatView} />
    </Route>
  </Router>
);
