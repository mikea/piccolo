/**
 * vite.config.ts — Vite build config for piccolo web UI SPA.
 *
 * Uses vite-plugin-solid for SolidJS JSX transform.
 * Output goes to ../dist (gateways/web/dist/) which Wrangler serves
 * via native static asset hosting with html_handling: single-page-application.
 *
 * root is set to the app/ directory so Vite finds index.html correctly
 * regardless of which directory the build command is invoked from.
 *
 * Spec ref: specs/web_gateway.md §Browser SPA
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [solid()],
  root: __dirname,
  publicDir: resolve(__dirname, "static"),
  build: {
    outDir: resolve(__dirname, "../dist"),
    emptyOutDir: true,
  },
});
