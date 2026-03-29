all: compile test check

check:
    pnpm check

compile:
    pnpm tsc

test:
    pnpm test

deploy-all: deploy-core deploy-web deploy-fetch

deploy-core:
    pnpm deploy:core

deploy-extensions: _extensions deploy-fetch deploy-instructions

deploy-web:
    pnpm deploy:web

deploy-fetch:
    pnpm wrangler deploy --config extensions/fetch-tool/wrangler.jsonc --dispatch-namespace mikea-piccolo-extensions

deploy-r2:
    pnpm wrangler deploy --config extensions/r2-tool/wrangler.jsonc --dispatch-namespace mikea-piccolo-extensions

deploy-instructions:
    pnpm wrangler deploy --config extensions/instructions/wrangler.jsonc --dispatch-namespace mikea-piccolo-extensions

_extensions:
    pnpm wrangler kv key put --binding CONFIG --config packages/core/wrangler.jsonc extensions:registry '["mikea-piccolo-fetch-tool","mikea-piccolo-ext-instructions","mikea-piccolo-ext-r2-tool"]' --remote