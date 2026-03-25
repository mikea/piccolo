/**
 * main.tsx — SPA entry point.
 *
 * Mounts the root SolidJS component into #root.
 * Initializes global data (sessions, models) on startup.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { loadModels, loadSessions } from "./store.ts";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

// Kick off initial data load before rendering
void loadSessions();
void loadModels();

render(() => <App />, root);
