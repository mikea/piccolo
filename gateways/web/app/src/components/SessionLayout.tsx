/**
 * SessionLayout.tsx — Two-panel layout: sidebar + chat area.
 *
 * Renders the SessionSidebar on the left and the router outlet
 * (EmptyState or ChatView) on the right.
 */

import { type RouteSectionProps, useNavigate } from "@solidjs/router";
import type { Component } from "solid-js";
import { newSession, store } from "../store.ts";
import { SessionSidebar } from "./SessionSidebar.tsx";

const styles = {
  layout: [
    "display:grid",
    "grid-template-columns:260px 1fr",
    "height:100vh",
    "overflow:hidden",
  ].join(";"),
} as const;

export const SessionLayout: Component<RouteSectionProps> = (props) => {
  const navigate = useNavigate();

  const handleNewSession = async () => {
    await newSession();
    if (store.activeSessionId) {
      navigate(`/sessions/${store.activeSessionId}`);
    }
  };

  return (
    <div style={styles.layout}>
      <SessionSidebar onNewSession={() => void handleNewSession()} />
      <main style="display:flex;flex-direction:column;overflow:hidden;">{props.children}</main>
    </div>
  );
};
