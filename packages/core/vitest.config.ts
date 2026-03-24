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
      // v8 coverage requires node:inspector/promises which workerd doesn't support.
      // Istanbul works inside the Workers sandbox.
      provider: "istanbul",
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
