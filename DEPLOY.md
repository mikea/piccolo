# Deploying Piccolo

This guide covers a full first-time deployment of piccolo to Cloudflare.

Currently deployed user-facing components:

- **piccolo-core**
- **piccolo-web-gateway**
- **piccolo-telegram-gateway** (Phase 1: text-only webhook gateway)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Cloudflare account | Workers enabled (Paid plan recommended for production scale) |
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

# R2 bucket — tool file storage and (future) web component assets
pnpm wrangler r2 bucket create piccolo-assets
```

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
  // R2 bucket is referenced by name — no ID needed
  // Add extension service bindings here (every EXTENSION_* binding is auto-discovered)
  "services": [
    { "binding": "EXTENSION_FETCH_TOOL", "service": "ext-fetch-tool" },
    { "binding": "EXTENSION_R2_TOOL", "service": "ext-r2-tool" },
    { "binding": "EXTENSION_INSTRUCTIONS", "service": "ext-instructions" }
  ],
  "vars": {
    "CF_ACCOUNT_ID": "PASTE_ACCOUNT_ID_HERE",  // ← from dash sidebar
    "CF_AI_GATEWAY_NAME": "piccolo",            // ← your gateway slug from Step 2
    "AGENT_NAME": "Piccolo",                    // ← displayed in system prompt; change freely
    "MODELS": "anthropic/claude-sonnet-4-5,openai/gpt-4o"  // ← comma-separated model IDs
  }
}
```

**`MODELS`** is a comma-separated list of model IDs that the agent can use. IDs must match the provider routing format understood by your AI Gateway (e.g. `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`). The list is shown in the model picker in the web UI and controls which models users can select.

### Extension binding naming recommendations

`piccolo-core` discovers extensions by scanning bindings prefixed with `EXTENSION_` and sorting by binding name. To keep ordering explicit and stable:

- Use a numeric priority prefix: `EXTENSION_10_GUARD`, `EXTENSION_20_SKILLS`, `EXTENSION_30_TEMPLATES`.
- Leave gaps (`10`, `20`, `30`) so you can insert future extensions without renaming everything.
- Keep names uppercase snake case after the prefix.
- Bindings without the `EXTENSION_` prefix are ignored by extension discovery.

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

The gateway requires no additional vars. Auth is handled by **Cloudflare Zero
Trust (Access)**:

1. Go to **dash.cloudflare.com → Zero Trust → Access → Applications**
2. Create a Self-Hosted application for your gateway's deployed URL
3. Configure allowed users / identity provider

CF Access will inject a `Cf-Access-Jwt-Assertion` header on every request.
The Worker decodes the JWT payload and uses the `email` claim as the userId.
Requests without a valid JWT receive a `401 Unauthorized`.

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

### WebSocket connection fails

Check that `piccolo-core` is deployed and the `CORE` service binding in
`gateways/web/wrangler.jsonc` references the correct service name.

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

### 8a. Deploy the extension Worker

```bash
pnpm wrangler deploy --config extensions/fetch-tool/wrangler.template.jsonc \
  --name ext-fetch-tool
```

### 8b. Bind it in `piccolo-core`

Add a service binding to `packages/core/wrangler.jsonc`:

```jsonc
"services": [
  { "binding": "EXTENSION_FETCH_TOOL", "service": "ext-fetch-tool" }
]
```

### 8c. Redeploy `piccolo-core`

```bash
pnpm deploy:core
```

---

## Step 9 — Deploy `ext-r2-tool`

The R2 tool gives the agent read/write access to a dedicated R2 bucket. It supports all seven operations: `read`, `write`, `delete`, `list`, `stat`, `copy`, and `move`. The `read` action supports byte-range reads and `maxBytes` truncation, similar to the fetch tool.

The r2-tool uses a **separate** bucket from the core's `ASSETS` bucket. This keeps agent-writable workspace files isolated from infrastructure assets.

### 9a. Create the workspace R2 bucket

Choose a bucket name (e.g. `piccolo-workspace`) and create it:

```bash
pnpm wrangler r2 bucket create piccolo-workspace
```

### 9b. Configure `ext-r2-tool`

```bash
cp extensions/r2-tool/wrangler.template.jsonc extensions/r2-tool/wrangler.jsonc
```

Open `extensions/r2-tool/wrangler.jsonc` and replace the placeholder with your bucket name:

```jsonc
"r2_buckets": [
  {
    "binding": "BUCKET",
    "bucket_name": "piccolo-workspace"    // ← replace <BUCKET_NAME> with the name from Step 9a
  }
]
```

### 9c. Deploy the extension Worker

```bash
pnpm wrangler deploy --config extensions/r2-tool/wrangler.jsonc
```

### 9d. Add binding in core config and redeploy core

Add this binding in `packages/core/wrangler.jsonc`:

```jsonc
{ "binding": "EXTENSION_R2_TOOL", "service": "ext-r2-tool" }
```

Then redeploy core:

```bash
pnpm deploy:core
```

---

## Step 10 — Deploy `ext-instructions`

The instructions extension lets the LLM manage persistent instructions that are
automatically appended to the system prompt, scoped to everyone / user / session.
It requires its own D1 database.

### 10a. Create the D1 database

```bash
pnpm wrangler d1 create piccolo-instructions
```

Copy the `database_id` from the output.

### 10b. Configure `ext-instructions`

```bash
cp extensions/instructions/wrangler.template.jsonc extensions/instructions/wrangler.jsonc
```

Open `extensions/instructions/wrangler.jsonc` and paste the database ID:

```jsonc
"d1_databases": [
  {
    "binding": "INSTRUCTIONS_DB",
    "database_name": "piccolo-instructions",
    "database_id": "PASTE_D1_ID_HERE"    // ← from Step 10a
  }
]
```

### 10c. Apply D1 migrations

```bash
pnpm wrangler d1 migrations apply piccolo-instructions \
  --config extensions/instructions/wrangler.jsonc --remote
```

This creates the `instructions` table. Safe to re-run.

### 10d. Deploy the extension Worker

```bash
pnpm wrangler deploy --config extensions/instructions/wrangler.jsonc
```

### 10e. Add binding in core config and redeploy core

Add this binding in `packages/core/wrangler.jsonc`:

```jsonc
{ "binding": "EXTENSION_INSTRUCTIONS", "service": "ext-instructions" }
```

Then redeploy core:

```bash
pnpm deploy:core
```

---

## Summary of resources created

| Resource | Name | Used by |
|---|---|---|
| D1 database | `piccolo-sessions` | piccolo-core (`SESSIONS_DB`) |
| D1 database | `piccolo-instructions` | ext-instructions (`INSTRUCTIONS_DB`) |
| R2 bucket | `piccolo-assets` | piccolo-core (`ASSETS`) — infrastructure / SPA assets |
| R2 bucket | your bucket name (e.g. `piccolo-workspace`) | ext-r2-tool (`BUCKET`) — agent-writable workspace |
| Service binding | `EXTENSION_*` in core config | piccolo-core extension discovery |
| AI Gateway | `piccolo` (or your slug) | piccolo-core via `CF_AI_GATEWAY_NAME` |

## Summary of secrets set

| Secret | Worker | Value |
|---|---|---|
| `CF_AI_GATEWAY_TOKEN` | `piccolo-core` | CF API token with AI Gateway Write permission |
