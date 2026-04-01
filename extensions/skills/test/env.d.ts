declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    SKILLS_DB: D1Database;
  }
}
