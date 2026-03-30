all: compile test check

check:
    pnpm check

compile:
    pnpm tsc

test:
    pnpm test

deploy-all: deploy-extensions deploy-core deploy-web

deploy-core:
    pnpm deploy:core

deploy-extensions: deploy-fetch deploy-r2 deploy-instructions

deploy-web:
    pnpm deploy:web

deploy-fetch:
    pnpm wrangler deploy --config extensions/fetch-tool/wrangler.jsonc

deploy-r2:
    pnpm wrangler deploy --config extensions/r2-tool/wrangler.jsonc

deploy-instructions:
    pnpm wrangler deploy --config extensions/instructions/wrangler.jsonc
