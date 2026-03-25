/**
 * Vitest configuration for piccolo-web-gateway.
 *
 * Uses @cloudflare/vitest-pool-workers (cloudflareTest plugin) to run tests
 * inside a real Workers runtime sandbox (Miniflare), which provides:
 *   - Durable Objects (WebUiSessionDO)
 *   - R2 bindings (ASSETS)
 *   - Service bindings (CORE — mocked in tests via test helper)
 *
 * Coverage via Istanbul (v8 requires node:inspector/promises, unsupported in workerd).
 *
 * Spec ref: specs/code.md §Testing
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Use test config that omits the CORE service binding.
      // Tests mock IPiccoloCore directly — they never call through CORE.
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    coverage: {
      // v8 coverage requires node:inspector/promises which workerd doesn't support.
      // Istanbul works inside the Workers sandbox.
      provider: "istanbul",
      // auth.ts contains CF Access JWT verification that requires a real CF Access
      // server — it cannot be tested in the Miniflare sandbox. Exclude it from
      // the coverage report so the JWT-specific code does not drag down thresholds.
      exclude: ["**/test/**", "src/auth.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
