import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Read migrations at config time (Node.js side) so they can be injected into
// the Workers Miniflare environment via `test.provide`. Tests call
// `inject("migrations")` and pass the result to `applyD1Migrations()`.
const migrationsPath = new URL("migrations", import.meta.url).pathname;
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.template.jsonc" },
    }),
  ],
  test: {
    provide: { migrations },
    coverage: {
      provider: "istanbul",
      thresholds: {
        lines: 80,
        // InstructionsExtension (WorkerEntrypoint) methods cannot be constructed
        // directly in tests — env is injected by the CF runtime. The thin wrapper
        // methods (fetch, getTools, getSystemPromptAdditions) delegate entirely to
        // InstructionsTool and buildSystemPromptAdditions, both fully tested.
        functions: 70,
        branches: 70,
      },
    },
  },
});
