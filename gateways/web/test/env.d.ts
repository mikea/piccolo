// Test environment type declarations for @cloudflare/vitest-pool-workers.
// Provides the `ProvidedEnv` type used by `env` from "cloudflare:test".

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
