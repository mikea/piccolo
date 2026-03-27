# Infrastructure — Specification

Deployment architecture, Workers topology, CI/CD, and development workflow for piccolo. Bindings and storage schemas for `piccolo-core` are specified in [core.md](core.md). Code standards (TypeScript configuration, linting, testing) are specified in [code.md](code.md).

---

## Runtime

All piccolo components run on the **Cloudflare Workers runtime** (V8 isolates). No Node.js runtime is used in production.

---

## Workers Topology

```
┌─────────────────────────────────────────────────────────────────┐
│ Cloudflare Account                                              │
│                                                                 │
│  ┌──────────────┐   JSRPC    ┌──────────────────────────────┐  │
│  │ Web UI       │ ─────────► │ piccolo-core Worker          │  │
│  │ Gateway      │            │  (IPiccoloCore)              │  │
│  └──────────────┘            │                              │  │
│                              │  ┌────────────────────────┐  │  │
│  ┌──────────────┐   JSRPC    │  │ AgentSessionDO         │  │  │
│  │ Telegram     │ ─────────► │  │ (per session)          │  │  │
│  │ Gateway      │            │  └──────────┬─────────────┘  │  │
│  └──────────────┘            └─────────────┼────────────────┘  │
│                                            │ fetch (ai SDK)     │
│                              ┌─────────────▼────────────────┐  │
│                              │ CF AI Gateway                 │  │
│                              │  → Anthropic, OpenAI, Google… │  │
│                              └──────────────────────────────┘  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Extension Dispatch Namespace (piccolo-extensions)        │   │
│  │   ext-fetch-tool / ext-r2-tool / ext-d1-tool            │   │
│  │   ext-instructions / ext-skills / ext-templates          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  KV: piccolo-config  R2: piccolo-assets                         │
│  D1: piccolo-sessions  D1: piccolo-instructions                 │
└─────────────────────────────────────────────────────────────────┘
```

### Workers

| Worker | Role |
|---|---|
| `piccolo-core` | Session orchestration; JSRPC hub for gateways and extensions |
| `piccolo-web-gateway` | Web UI; serves SPA, handles HTTP + SSE |
| `piccolo-telegram-gateway` | Telegram bot; handles webhook updates |

Gateways declare a service binding to `piccolo-core`. They are deployed independently.

### Durable Objects

| DO class | Worker | Purpose |
|---|---|---|
| `AgentSessionDO` | `piccolo-core` | Per-session state, message history, agent loop |
| `TelegramChatDO` | `piccolo-telegram-gateway` | Concurrent update serialisation per Telegram chat |

---

## Gateway Bindings

### `piccolo-web-gateway`

```jsonc
{
  "name": "piccolo-web-gateway",
  "services": [{ "binding": "CORE", "service": "piccolo-core" }],
  "assets": { "directory": "./dist", "not_found_handling": "single-page-application" },
  "vars": { "USER_ID": "default-user" }
}
```

### `piccolo-telegram-gateway`

```jsonc
{
  "name": "piccolo-telegram-gateway",
  "services": [
    { "binding": "CORE", "service": "piccolo-core" }
  ],
  "kv_namespaces": [
    { "binding": "KV", "id": "<TELEGRAM_KV_ID>" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "TELEGRAM_CHAT", "class_name": "TelegramChatDO" }
    ]
  }
  // Secrets: TELEGRAM_BOT_TOKEN
}
```

For `piccolo-core` bindings see [core.md — Bindings](core.md#bindings).

---

## Extension Dispatch Namespace

Extensions are deployed as Workers into the `piccolo-extensions` dispatch namespace, managed via the Cloudflare API.

```bash
# Deploy an extension into the namespace
pnpm wrangler deploy --name ext-my-tool \
  --dispatch-namespace piccolo-extensions \
  --compatibility-date 2024-04-03

# Register in KV so core discovers it
pnpm wrangler kv key put --binding CONFIG \
  extensions:registry '["ext-my-tool", "ext-existing"]'

# Update: re-deploy with the same name (no registry change needed)
# Remove: update registry key, then optionally delete the Worker
```

No `piccolo-core` redeploy is required for any extension operation.

---

## Build Order for Deployment

```
1. piccolo-agent        (npm package; no Workers deploy)
2. piccolo-core         (deploy first — gateways depend on it)
3. piccolo-web-gateway
4. piccolo-telegram-gateway
5. Extensions           (deployed independently; any order)
```

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `ai` | `streamText`, `generateText`, `tool`, `ModelMessage` |
| `ai-gateway-provider` | CF AI Gateway adapter (`createAiGateway`, `createUnified`) |
| JSON Schema (draft-07 style) | Tool input schema definitions |
| `@cloudflare/workers-types` | Workers runtime TypeScript types |
| `wrangler` | Build, dev, deploy |
| `vitest` | Test runner |
| `@cloudflare/vitest-pool-workers` | Run tests inside Workers runtime |
| `biome` | Formatter and linter |

---

## CI/CD

### `ci.yml` — Main CI

**Trigger:** push to `main`, PRs targeting `main`

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
    with: { version: latest }
  - uses: actions/setup-node@v4
    with: { node-version: "22" }
  - run: pnpm install --frozen-lockfile
  - run: pnpm biome check .
  - run: pnpm -r exec tsc --noEmit
  - run: pnpm -r test --coverage
  - run: pnpm -r build
```

### `deploy.yml` — Production Deployment

**Trigger:** push of `v*` tags or manual `workflow_dispatch`

```yaml
env:
  CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}

steps:
  - uses: actions/checkout@v4
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v4
    with: { node-version: "22" }
  - run: pnpm install --frozen-lockfile

  - name: Deploy core
    run: pnpm wrangler deploy
    working-directory: packages/core

  - name: Deploy web gateway
    run: pnpm wrangler deploy
    working-directory: gateways/web

  - name: Deploy telegram gateway
    run: pnpm wrangler deploy
    working-directory: gateways/telegram
```

Provider API keys are managed in CF AI Gateway directly and are not part of this pipeline.

---

## Local Development

```bash
# Install all dependencies
pnpm install

# Type-check all packages
pnpm -r exec tsc --noEmit

# Run all tests
pnpm -r test

# Start core + web gateway together (Miniflare local dev)
pnpm wrangler dev -c packages/core/wrangler.template.jsonc \
                  -c gateways/web/wrangler.template.jsonc

# Lint and format
pnpm biome check --write .
```

---

## Secrets Management

Secrets are set per-Worker via Wrangler and are never committed to source control:

```bash
# Core
pnpm wrangler secret put CF_AI_GATEWAY_TOKEN --env production

# Telegram gateway
pnpm wrangler secret put TELEGRAM_BOT_TOKEN --env production
```

See [core.md — Bindings](core.md#bindings) for the full list of core secrets.
