check:
    pnpm check

deploy-all: deploy-core deploy-web deploy-fetch

deploy-core:
    pnpm deploy:core

deploy-web:
    pnpm deploy:web


deploy-fetch:
    pnpm wrangler deploy --config extensions/fetch-tool/wrangler.jsonc --dispatch-namespace mikea-piccolo-extensions

deploy-extensions: _extensions deploy-fetch

_extensions:
    pnpm wrangler kv key put --binding CONFIG --config packages/core/wrangler.jsonc extensions:registry '["mikea-piccolo-fetch-tool"]' --remote