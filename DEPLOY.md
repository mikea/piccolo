# Deploying Piccolo

This guide covers a full first-time deployment of piccolo to Cloudflare. The
only component with a deployable UI today is **piccolo-core** + **piccolo-web-gateway**
(Milestone 11 M1). Telegram gateway and extensions are not yet implemented.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Cloudflare account | **Workers Paid plan** required (Durable Objects + Workers for Platforms) |
| `wrangler` CLI | Installed via `pnpm install`; authenticate with `pnpm wrangler login` |
| Node.js 22+ | Required by Wrangler 4 |
| pnpm | Used for all package management |
| Cloudflare AI Gateway | Create one at dash.cloudflare.com → AI → AI Gateway |

---

## Step 1 — Authenticate Wrangler

```bash
pnpm wrangler login
```

This opens a browser tab. Authorise Wrangler for your Cloudflare account.
Verify it worked:

```bash
pnpm wrangler whoami
```

---

## Step 2 — Create Cloudflare resources (one-time)

Run each command once. Copy the IDs printed — you need them in Step 3.

```bash
# D1 database — session records and conversation history
pnpm wrangler d1 create piccolo-sessions

# KV namespace — extension registry, model catalog, per-session config
pnpm wrangler kv namespace create piccolo-config

# R2 bucket — tool file storage and (future) web component assets
pnpm wrangler r2 bucket create piccolo-assets

# Workers for Platforms dispatch namespace — hosts extension Workers
pnpm wrangler dispatch-namespace create piccolo-extensions
```

> **Workers for Platforms** requires the Workers Paid plan. If you get a
> permission error on the dispatch namespace, verify your plan in the
> Cloudflare dashboard.

### Create an AI Gateway

1. Go to **dash.cloudflare.com → AI → AI Gateway → Create Gateway**
2. Name it `piccolo` (or any slug you prefer — you will set it as a var below)
3. Note your **Account ID** (shown in the sidebar) and the **Gateway name**

### Create an AI Gateway API token

1. Go to **dash.cloudflare.com → My Profile → API Tokens → Create Token**
2. Use the **"AI Gateway - Read and Write"** template, or create a custom token
   with **Account → AI Gateway → Edit** permission
3. Copy the token — it becomes `CF_AI_GATEWAY_TOKEN`

### Add provider API keys to the AI Gateway

In the Cloudflare dashboard, navigate to your AI Gateway → **Settings → API Keys**
and add the keys for the providers you want to use (Anthropic, OpenAI, etc.).
Piccolo passes requests through the gateway using the unified endpoint, so keys
live in the gateway, not in piccolo's config.

---

## Step 3 — Configure `piccolo-core`

```bash
cp packages/core/wrangler.template.jsonc packages/core/wrangler.jsonc
```

Open `packages/core/wrangler.jsonc` and replace all `<PLACEHOLDER>` values:

```jsonc
// packages/core/wrangler.jsonc  (gitignored — never commit this file)
{
  // ...
  "d1_databases": [
    {
      "binding": "SESSIONS_DB",
      "database_name": "piccolo-sessions",
      "database_id": "PASTE_D1_ID_HERE"        // ← from Step 2: d1 create output
    }
  ],
  "kv_namespaces": [
    {
      "binding": "CONFIG",
      "id": "PASTE_KV_ID_HERE"                 // ← from Step 2: kv namespace create output
    }
  ],
  // R2 and dispatch namespace are referenced by name — no IDs needed
  "vars": {
    "CF_ACCOUNT_ID": "PASTE_ACCOUNT_ID_HERE",  // ← from dash sidebar
    "CF_AI_GATEWAY_NAME": "piccolo",            // ← your gateway slug from Step 2
    "AGENT_NAME": "Piccolo",                    // ← displayed in system prompt; change freely
    "MODELS": "anthropic/claude-sonnet-4-5,openai/gpt-4o"  // ← comma-separated model IDs
  }
}
```

**`MODELS`** is a comma-separated list of model IDs that the agent can use. IDs must match the provider routing format understood by your AI Gateway (e.g. `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`). The list is shown in the model picker in the web UI and controls which models users can select.

---

## Step 4 — Deploy `piccolo-core`

### 4a. Apply D1 migrations

```bash
pnpm wrangler d1 migrations apply piccolo-sessions --config packages/core/wrangler.jsonc --remote
```

This creates the `sessions` and `entries` tables. Safe to re-run — migrations
are idempotent.

### 4b. Set the AI Gateway token secret

```bash
pnpm wrangler secret put CF_AI_GATEWAY_TOKEN \
  --config packages/core/wrangler.jsonc
```

Paste your AI Gateway API token when prompted. This is stored encrypted by
Cloudflare and never appears in logs or config files.

### 4c. Deploy the Worker

```bash
pnpm wrangler deploy --config packages/core/wrangler.jsonc
```

Verify the Worker is live:

```bash
pnpm wrangler tail --config packages/core/wrangler.jsonc
```

---

## Step 5 — Configure `piccolo-web-gateway`

```bash
cp gateways/web/wrangler.template.jsonc gateways/web/wrangler.jsonc
```

The web gateway has no placeholder IDs — it references piccolo-core by service
name and R2 by bucket name. The only thing to change (optionally) is the
Cloudflare Access configuration.

**Production auth (Cloudflare Access):**

1. Go to **dash.cloudflare.com → Zero Trust → Access → Applications**
2. Create a Self-Hosted application for your gateway's URL
3. Configure the allowed users/groups
4. The CF Access JWT is automatically attached to requests as the
   `CF-Access-Jwt-Assertion` header. The gateway validates it server-side.
   No further configuration is needed in `wrangler.jsonc`.

**No Cloudflare Access (open / dev):**

Set the `AUTH_SECRET` dev escape hatch — this allows any request that
sends a matching `X-Dev-Auth` header to authenticate:

```bash
pnpm wrangler secret put AUTH_SECRET \
  --config gateways/web/wrangler.jsonc
```

> **Security note:** `AUTH_SECRET` is a development convenience only. Do not
> use it as a production auth mechanism — it is a shared secret with no
> per-user identity. For production, use Cloudflare Access.

---

## Step 6 — Build and deploy `piccolo-web-gateway`

The web gateway must be built (SolidJS SPA via Vite) before deploying.
Always use the script below — it runs `vite build` then `wrangler deploy`.
**Never run `wrangler deploy` directly** for the web gateway; it will deploy
stale assets.

```bash
pnpm deploy:web
```

After deployment, Wrangler prints the Worker URL (e.g.
`https://piccolo-web-gateway.your-subdomain.workers.dev`). Open it in a
browser.

---

## Step 7 — Verify end-to-end

1. Open the web gateway URL in a browser
2. You should see the piccolo chat UI (session sidebar + empty state)
3. Click **Start a new chat** or **+ New Chat**
4. Type a message and press Enter
5. The agent should respond (streaming text token by token)

If the agent responds, the full stack is working:

```
Browser → piccolo-web-gateway → piccolo-core (AgentSessionDO)
       → Cloudflare AI Gateway → LLM provider
```

---

## Troubleshooting

### "SPA not deployed" on the root URL

The `dist/` directory was not uploaded. Run `pnpm deploy` from `gateways/web/`
(not just `wrangler deploy`).

### "Unauthorized" on WebSocket connect

- **With Cloudflare Access:** the Access application is not configured, or your
  user is not in the allowed group.
- **Without CF Access:** `AUTH_SECRET` is not set, or the browser SPA was built
  without setting `VITE_DEV_AUTH_SECRET`.

For local dev without CF Access, set `AUTH_SECRET` via `wrangler secret put`
and set `VITE_DEV_AUTH_SECRET` in a `.env.local` file in `gateways/web/app/`:

```bash
# gateways/web/app/.env.local  (gitignored)
VITE_DEV_AUTH_SECRET=your-secret-here
VITE_DEV_USER_ID=your-user-id
```

Then redeploy: `pnpm deploy:web`

### Agent returns errors about AI Gateway

- Verify `CF_AI_GATEWAY_TOKEN` secret is set on `piccolo-core`
- Verify `CF_ACCOUNT_ID` and `CF_AI_GATEWAY_NAME` vars are correct
- Verify the provider API key is set in the Cloudflare AI Gateway dashboard
- Check `pnpm wrangler tail --config packages/core/wrangler.jsonc` for error details

### "Service not found" / JSRPC errors

`piccolo-core` must be deployed before `piccolo-web-gateway`. The gateway
declares a service binding to `piccolo-core` by name — if core is not deployed,
the gateway fails at startup.

---

## Re-deployment

After code changes:

```bash
# Re-deploy core only
pnpm deploy:core

# Re-deploy web gateway (rebuilds SPA first)
pnpm deploy:web

# Re-deploy both
pnpm deploy:core && pnpm deploy:web
```

D1 migrations only need to be re-applied when there are new migration files.

---

## Step 8 — Deploy `ext-fetch-tool`

The fetch tool gives the agent the ability to make HTTPS GET and HEAD requests to the public internet, including ranged GET for large files. It requires no Cloudflare bindings.

### 8a. Deploy the tool Worker into the dispatch namespace

```bash
pnpm wrangler deploy --config extensions/fetch-tool/wrangler.template.jsonc \
  --dispatch-namespace piccolo-extensions
```

### 8b. Register in the extension registry KV

Replace the registry value with the current list of extensions you want active.
If this is your first extension, the value is just the fetch tool:

```bash
pnpm wrangler kv key put --binding CONFIG \
  --config packages/core/wrangler.jsonc \
  extensions:registry '["ext-fetch-tool"]'
```

No `piccolo-core` redeploy is needed. The extension registry is polled at session start.

---

## Summary of resources created

| Resource | Name | Used by |
|---|---|---|
| D1 database | `piccolo-sessions` | piccolo-core (`SESSIONS_DB`) |
| KV namespace | `piccolo-config` | piccolo-core (`CONFIG`) |
| R2 bucket | `piccolo-assets` | piccolo-core + web gateway (`ASSETS`) |
| Dispatch namespace | `piccolo-extensions` | piccolo-core (`EXTENSIONS`) |
| AI Gateway | `piccolo` (or your slug) | piccolo-core via `CF_AI_GATEWAY_NAME` |

## Summary of secrets set

| Secret | Worker | Value |
|---|---|---|
| `CF_AI_GATEWAY_TOKEN` | `piccolo-core` | CF API token with AI Gateway Write permission |
| `AUTH_SECRET` | `piccolo-web-gateway` | Dev-only auth bypass; omit in production with CF Access |
