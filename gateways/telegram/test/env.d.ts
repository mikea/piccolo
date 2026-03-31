declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
  const env: ProvidedEnv;
}
