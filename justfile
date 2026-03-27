check:
    pnpm check

deploy-all: deploy-core deploy-web deploy-fetch

deploy-core:
    pnpm deploy:core

deploy-extensions: _extensions deploy-fetch deploy-instructions

deploy-web:
    pnpm deploy:web

deploy-fetch:
    pnpm wrangler deploy --config extensions/fetch-tool/wrangler.jsonc --dispatch-namespace mikea-piccolo-extensions

deploy-instructions:
    pnpm wrangler deploy --config extensions/instructions/wrangler.jsonc --dispatch-namespace mikea-piccolo-extensions

_extensions:
    pnpm wrangler kv key put --binding CONFIG --config packages/core/wrangler.jsonc extensions:registry '["mikea-piccolo-fetch-tool","mikea-piccolo-ext-instructions"]' --remote