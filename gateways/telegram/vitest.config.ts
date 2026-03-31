import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    coverage: {
      // v8 coverage requires node:inspector/promises, unsupported in workerd.
      provider: "istanbul",
      exclude: ["**/test/**"],
      thresholds: {
        lines: 40,
        functions: 30,
        branches: 40,
      },
    },
  },
});
