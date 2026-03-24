# Infrastructure — Specification

Monorepo build system, CI/CD, testing, linting, and release process.

---

## Monorepo Structure

### Workspace Manager

npm workspaces (Node.js ≥ 20 required). All packages are ESM (`"type": "module"`).

**Root `package.json` workspaces:**

```json
{
  "workspaces": [
    "packages/*",
    "packages/web-ui/example",
    "packages/coding-agent/examples/extensions/with-deps",
    "packages/coding-agent/examples/extensions/custom-provider-anthropic",
    "packages/coding-agent/examples/extensions/custom-provider-gitlab-duo",
    "packages/coding-agent/examples/extensions/custom-provider-qwen-cli"
  ]
}
```

### Inter-package Linking

During development: TypeScript's `paths` config resolves `@mariozechner/*` directly to `packages/*/src/index.ts`, bypassing `dist/`. This makes the type checker see the latest source without a build step.

```jsonc
// tsconfig.json (root) paths section
{
  "@mariozechner/pi-ai": ["./packages/ai/src/index.ts"],
  "@mariozechner/pi-agent-core": ["./packages/agent/src/index.ts"],
  "@mariozechner/pi-tui": ["./packages/tui/src/index.ts"],
  "@mariozechner/pi-coding-agent": ["./packages/coding-agent/src/index.ts"],
  // ...
}
```

At runtime (after build): npm workspaces symlinks in `node_modules/@mariozechner/` point to `packages/*/dist/`.

### Lockstep Versioning

All publishable packages under `packages/*` share the same version at all times (`0.62.0` at time of writing). The root monorepo package can have a different version. `scripts/sync-versions.js` enforces package lockstep:
1. Read all `packages/*/package.json`
2. Assert all versions are identical
3. Rewrite all `@mariozechner/*` inter-package dependency pins to `^{current-version}`

---

## TypeScript Configuration

### `tsconfig.base.json` (shared by all packages)

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",   // requires explicit .js extensions in imports
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,  // legacy class field behavior
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "types": ["node"]
  }
}
```

### Root `tsconfig.json`

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,   // root config is only for type-checking
    "paths": {
      // source-level resolution for all internal packages
    }
  },
  "include": [
    "packages/*/src/**/*",
    "packages/*/test/**/*",
    "packages/coding-agent/examples/**/*"
  ],
  "exclude": [
    "packages/web-ui/**/*",   // has its own tsconfig
    "**/dist/**"
  ]
}
```

### Type Checker

**`tsgo`** (`@typescript/native-preview` v7.0.0-dev) — the native Go-based TypeScript compiler. Used for `npm run check` instead of `tsc` for speed. Both produce identical type errors.

---

## Build System

### Build Order (hardcoded sequential)

```
tui → ai → agent → coding-agent → mom → web-ui → pods
```

This order matches the dependency graph: each package's `dist/` must exist before the next is compiled (because `tsconfig.build.json` in each package points to `dist/` of its dependencies, not `src/`).

### Per-package Build Scripts

Each package's `package.json` contains:
```json
{
  "scripts": {
    "build": "tsgo --project tsconfig.build.json"
  }
}
```

Exception — `web-ui`:
```json
{
  "scripts": {
    "build": "tsc -p tsconfig.build.json && tailwindcss -i ./src/app.css -o ./dist/app.css --minify"
  }
}
```

### Root Build

```json
{
  "scripts": {
    "build": "cd packages/tui && npm run build && cd ../ai && npm run build && ..."
  }
}
```

Sequential shell `cd` chain, not a build orchestrator.

---

## Linting and Formatting

### Tool: Biome v2.3.5

Single tool for both lint and format.

### Formatter Settings (`biome.json`)

```jsonc
{
  "formatter": {
    "indentStyle": "tab",
    "indentWidth": 3,
    "lineWidth": 120,
    "formatWithErrors": false
  }
}
```

### Linter Settings

Base: `"recommended"` rules enabled.

| Rule | Setting | Reason |
|------|---------|---------|
| `style/noNonNullAssertion` | off | Allow `!` assertions |
| `style/useConst` | error | Enforce `const` |
| `style/useNodejsImportProtocol` | off | Allow bare `"fs"` without `"node:"` prefix |
| `suspicious/noExplicitAny` | off | `any` permitted where needed |
| `suspicious/noControlCharactersInRegex` | off | Needed for terminal/TUI escape sequences |
| `suspicious/noEmptyInterface` | off | Allow empty interfaces (e.g., `CustomAgentMessages`) |

### File Scope

Included: `src/`, `test/`, `examples/` subdirectories, TypeScript files only.

Excluded:
- `**/node_modules/**/*`
- `**/test-sessions.ts`
- `**/models.generated.ts`
- `packages/web-ui/src/app.css`
- `packages/mom/data/**/*`

### `npm run check` Command

```bash
biome check --write --error-on-warnings . \
  && tsgo --noEmit \
  && npm run check:browser-smoke \
  && cd packages/web-ui && npm run check
```

Steps in order:
1. Biome lint + format (auto-fixes in place, fails on any warnings)
2. Full monorepo type-check via `tsgo` (using root `tsconfig.json` with source paths)
3. Browser smoke bundle test (ensures no Node.js APIs leaked to browser surface)
4. Web-UI specific check (runs its own `tsc --noEmit` + Biome)

**Note:** `npm run check` requires `npm run build` to have been run first. The web-ui type check needs `dist/*.d.ts` files from dependency packages.

---

## Browser Smoke Test (`scripts/check-browser-smoke.mjs`)

Attempts to bundle `scripts/browser-smoke-entry.ts` for the browser platform using `esbuild`:

```typescript
// browser-smoke-entry.ts
import { complete, getModel } from "@mariozechner/pi-ai";
void complete;
void getModel;
```

If bundling fails (e.g., because a Node.js API like `fs` or `path` was imported at module load), the check fails with a detailed error showing which file introduced the browser-incompatible import.

This enforces that the main `pi-ai` entry point is safe to bundle for browser environments.

---

## Testing

### Test Runner: Vitest

Each package has its own `vitest.config.ts`:
```typescript
export default defineConfig({
  test: {
    environment: "node",
    timeout: 30000,
  },
});
```

### Running Tests

```bash
# All packages (from repo root)
npm test           # runs npm test --workspaces --if-present

# Specific test file (from package root, not repo root)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

### `test.sh` — Offline Test Runner

```bash
#!/bin/bash
# Backs up auth credentials, strips all API keys, runs tests

# Backup auth.json
cp ~/.pi/agent/auth.json /tmp/auth.json.bak 2>/dev/null || true

# Cleanup on exit
cleanup() { cp /tmp/auth.json.bak ~/.pi/agent/auth.json 2>/dev/null || true; }
trap cleanup EXIT

# Disable local model discovery
export PI_NO_LOCAL_LLM=1

# Unset ALL known API keys (30+ variables):
unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GROQ_API_KEY
unset CEREBRAS_API_KEY XAI_API_KEY OPENROUTER_API_KEY ZAI_API_KEY
unset MISTRAL_API_KEY MINIMAX_API_KEY KIMI_API_KEY
unset HUGGINGFACE_API_KEY GITHUB_TOKEN GITHUB_COPILOT_API_KEY
unset GOOGLE_CLOUD_API_KEY GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
unset AWS_BEARER_TOKEN_BEDROCK AWS_DEFAULT_REGION
# ... all others

npm test
```

### Test Categories

| Category | Description | API keys required |
|----------|-------------|------------------|
| Unit tests | Logic, algorithms, type validation | No |
| Integration tests | Provider streaming, token counting | Yes (skipped if absent) |
| E2E tests | Full agent loop with tools | Yes (skipped if absent) |

Tests guard against absent credentials with patterns like:
```typescript
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  test.skip("ANTHROPIC_API_KEY not set");
}
```

---

## CI/CD Workflows

### `ci.yml` — Main CI

**Trigger:** push to `main`, PRs targeting `main`.  
**Cancels** in-progress runs for same ref.

**Job: `build-check-test`** (ubuntu-latest, Node 22):

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: "22"
      cache: "npm"
  - name: Install system dependencies
    run: |
      sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev \
        libgif-dev librsvg2-dev fd-find ripgrep
  - run: npm ci
  - run: npm run build
  - run: npm run check
  - run: npm test
```

System deps: `libcairo2`, `libpango`, `libjpeg`, `libgif`, `librsvg2` (for canvas/image processing), `fd-find`, `ripgrep` (for coding-agent file search tools used in tests).

### `build-binaries.yml` — Binary Release

**Trigger:** push of `v*` tags OR manual `workflow_dispatch` with tag input.  
**Permissions:** `contents: write` (creates GitHub releases).

**Steps** (ubuntu-latest):
1. Checkout at tag
2. Setup Bun 1.2.20 (pinned SHA) + Node 22
3. Run `./scripts/build-binaries.sh`
4. Extract changelog excerpt from `packages/coding-agent/CHANGELOG.md` using `awk` pattern match for the version tag
5. Create GitHub Release with 5 archives (or upload to existing release with `--clobber`)

**`build-binaries.sh` steps:**
```bash
npm ci

# Install ALL cross-platform native bindings (for clipboard, image support)
# Forces install for these 5 targets:
# darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64
npm install --force @img/sharp-darwin-arm64 @img/sharp-darwin-x64 ...
# etc.

npm run build

# Compile single-binary executables for each platform
for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64; do
  bun build --compile \
    --target=bun-${platform} \
    --outfile=dist/${platform}/pi \
    packages/coding-agent/dist/bun/cli.js

  # Windows: copy koffi native module alongside binary
  if [[ $platform == "windows-x64" ]]; then
    cp node_modules/koffi/build/koffi.node dist/windows-x64/
  fi
done

# Package each platform
tar -czf dist/pi-linux-x64.tar.gz -C dist/linux-x64 --transform "s|^|pi/|" pi
tar -czf dist/pi-linux-arm64.tar.gz -C dist/linux-arm64 --transform "s|^|pi/|" pi
tar -czf dist/pi-darwin-x64.tar.gz -C dist/darwin-x64 --transform "s|^|pi/|" pi
tar -czf dist/pi-darwin-arm64.tar.gz -C dist/darwin-arm64 --transform "s|^|pi/|" pi
zip dist/pi-windows-x64.zip dist/windows-x64/pi.exe dist/windows-x64/koffi.node
```

The `pi/` directory wrapper in tar archives is for `mise` compatibility (mise expects the binary at `pi/pi` inside the archive).

### `pr-gate.yml` — Contributor Access Control

**Trigger:** `pull_request_target` opened.

```
1. Skip bots
2. If author has collaborator permission (admin/maintain/write): allow
3. Check .github/APPROVED_CONTRIBUTORS (plain text, one handle per line)
4. Check .github/oss-weekend.json for active weekend mode
5. If OSS weekend active AND author is approved: close PR (resubmit after weekend)
6. If not approved: close PR (open issue first)
7. If approved and no weekend: allow
```

### `approve-contributor.yml` — Automated Approval

**Trigger:** Issue comment created.

```
1. Skip if comment doesn't start with "lgtm" (case-insensitive)
2. Verify commenter has admin/write permission
3. Append issue author's handle to .github/APPROVED_CONTRIBUTORS
4. git commit + push: "chore: approve contributor <handle>"
5. Post confirmation comment on issue
```

### `oss-weekend-issues.yml` — Issue Suppression

**Trigger:** Issue opened.

```
1. Skip bots
2. Skip collaborators
3. Read .github/oss-weekend.json; if absent or active:false: do nothing
4. If active: post comment with reopen date + Discord link; close issue
```

---

## Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| Release (patch) | `npm run release:patch` | Full automated release: bump, changelog, commit, tag, publish, push |
| Release (minor) | `npm run release:minor` | Same but minor version bump |
| Sync versions | `node scripts/sync-versions.js` | Assert lockstep, update all inter-package dep pins |
| Browser smoke | `npm run check:browser-smoke` | Verify pi-ai is browser-bundleable |
| Build binaries | `./scripts/build-binaries.sh` | Cross-platform binary compilation |
| Profile | `node scripts/profile-coding-agent-node.mjs` | Startup performance profiling |
| OSS weekend | `node scripts/oss-weekend.mjs` | Manage OSS weekend mode |
| Edit tool stats | `node scripts/edit-tool-stats.mjs` | Analytics over edit tool usage in sessions |

### `release.mjs` Full Sequence

```
1. Assert clean git working tree (abort if uncommitted changes)

2. npm run version:patch (or minor):
   → npm version patch -ws --no-git-tag-version  (bumps all package.json versions)
   → node scripts/sync-versions.js  (fix inter-package dep pins)
   → shx rm -rf node_modules && npm install  (reinstall with new versions)

3. Read new version from packages/ai/package.json

4. Rewrite all CHANGELOG.md files:
   Find "## [Unreleased]" → replace with "## [{version}] - {YYYY-MM-DD}"

5. git add . && git commit -m "Release v{version}" && git tag v{version}

6. npm run publish:
   → cd each package && npm publish --access public
   (preceded by prepublishOnly: clean → build → check)

7. Re-add "## [Unreleased]\n\n" to all CHANGELOG.md files

8. git add . && git commit -m "Add [Unreleased] section for next cycle"

9. git push origin main && git push origin v{version}
```

---

## Development Workflow

### Standard Code Change Cycle

```bash
# 1. Make changes to packages/*/src/

# 2. Check everything (build artifacts may be required for web-ui checks)
npm run check

# 3. Fix all errors, warnings, and infos
# (biome auto-fixes formatting with --write)

# 4. If you modified test files:
cd packages/<package>
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

### Contributor Guardrails

Repository contributor guidance (AGENTS.md) discourages running heavyweight commands in normal agent workflows:
- avoid `npm run dev`
- avoid full `npm test` (run targeted tests)
- run `npm run check` after code changes

This does not change repository capabilities: CI and release scripts do run `npm run build` and full test suites.

### Interactive Testing

```bash
# Run pi from source with full terminal
./pi-test.sh

# Strip all API keys (offline mode)
./pi-test.sh --no-env

# Test via tmux (controlled dimensions)
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux kill-session -t pi-test
```

### Pre-PR Checklist

```bash
npm run check   # must pass with zero errors/warnings
./test.sh       # must pass (tests without API keys)
```

---

## CHANGELOG Format

Location: `packages/*/CHANGELOG.md`

### Structure

```markdown
# Changelog

## [Unreleased]

### Breaking Changes
- Description ([#123](link))

### Added
- Description ([#456](link))

### Changed
- Description

### Fixed
- Bug fix ([#789](link))

### Removed
- Removed feature

## [0.62.0] - 2026-03-01

### Fixed
- Previous release content (immutable once released)
```

### Rules

1. New entries ALWAYS under `## [Unreleased]`
2. Read existing subsections before adding — append to existing, don't duplicate
3. NEVER modify released version sections
4. Attribution:
   - Internal: `Fixed foo ([#123](https://github.com/badlogic/pi-mono/issues/123))`
   - External: `Added X ([#456](link) by [@user](https://github.com/user))`
