alias w := watch

all: compile test check


watch *args="all":
    watchexec -rc -w . -- just {{args}}

check:
    mise x -- pnpm check

compile:
    mise x -- pnpm tsc

test:
    mise x -- pnpm test

lint:
    mise x -- pnpm lint

deploy-all: deploy-core deploy-web deploy-extensions

deploy-core:
    mise x -- pnpm deploy:core

deploy-extensions: deploy-fetch deploy-r2 deploy-instructions

deploy-web:
    mise x -- pnpm deploy:web

deploy-fetch:
    mise x -- pnpm wrangler deploy --config extensions/fetch-tool/wrangler.jsonc

deploy-r2:
    mise x -- pnpm wrangler deploy --config extensions/r2-tool/wrangler.jsonc

deploy-instructions:
    mise x -- pnpm wrangler deploy --config extensions/instructions/wrangler.jsonc

deploy-skills:
    mise x -- pnpm wrangler deploy --config extensions/skills/wrangler.jsonc

migrations:
    mise x -- pnpm wrangler d1 migrations apply mikea-piccolo-sessions --remote -c packages/core/wrangler.jsonc
    mise x -- pnpm wrangler d1 migrations apply mikea-piccolo-skills --remote -c extensions/skills/wrangler.jsonc
    mise x -- pnpm wrangler d1 migrations apply mikea-piccolo-instructions --remote -c extensions/instructions/wrangler.jsonc

dev:
    mise x -- pnpm wrangler dev -c gateways/web/wrangler.dev.jsonc -c packages/core/wrangler.dev.jsonc
