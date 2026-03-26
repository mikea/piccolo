import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.template.jsonc" },
    }),
  ],
  test: {
    coverage: {
      provider: "istanbul",
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
