# Code Standards — Specification

All implementation decisions, language settings, toolchain choices, and testing requirements for piccolo. This document is the single source of truth for how code is written. `AGENTS.md` contains the rules that make following it non-negotiable.

---

## Language

All code is written in **TypeScript**. No JavaScript source files. No `.js` files in `src/` directories.

---

## TypeScript Configuration

Every package uses the strictest possible TypeScript settings. The shared base `tsconfig.json` at the workspace root:

```jsonc
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],

    // ── Strictness ────────────────────────────────────────────────────────
    "strict": true,                        // enables all strict checks below
    "noImplicitAny": true,                 // no implicit any
    "strictNullChecks": true,              // null and undefined are not assignable to other types
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "useUnknownInCatchVariables": true,    // catch (e) → e is unknown, not any

    // ── Additional strictness ─────────────────────────────────────────────
    "noUncheckedIndexedAccess": true,      // array[i] returns T | undefined
    "exactOptionalPropertyTypes": true,   // optional fields cannot be assigned undefined explicitly
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,

    // ── Module ────────────────────────────────────────────────────────────
    "isolatedModules": true,               // required for Vite/esbuild compatibility
    "verbatimModuleSyntax": true,          // enforces import type for type-only imports
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,

    // ── Output ────────────────────────────────────────────────────────────
    "noEmit": true                         // Vite / Wrangler handle emission; tsc is type-check only
  }
}
```

Each package extends this base:

```jsonc
// packages/agent/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*", "test/**/*"]
}
```

---

## `any` Policy

**`any` is forbidden** except where it is a genuine part of the public API contract and there is no safer alternative.

| Situation | Required type | Rationale |
|---|---|---|
| Unknown JSON from `fetch()` | `unknown` | Force callers to narrow before use |
| Catch clause variables | `unknown` | Enforced by `useUnknownInCatchVariables` |
| Generic record shapes | `Record<string, unknown>` | Never `Record<string, any>` |
| JSON schema objects | `JsonSchema7` | Preferred for tool input schemas and RPC serialization |
| Tool `params` before validation | `unknown` | Validated by the core before `execute()` is called |
| `RpcTarget` method stubs | typed overloads | Never accept `any` in JSRPC method signatures |

When `any` appears in the codebase, it must be accompanied by a comment explaining why it is unavoidable and why `unknown` or a specific type cannot be used instead.

The TypeScript compiler must produce zero `any`-related errors. Running `tsc --noEmit` must succeed with no errors and no suppressions (`@ts-ignore`, `@ts-expect-error` without an explanatory comment).

---

## Package Manager

**pnpm** is the only package manager. `npm` and `yarn` are not used.

```bash
# Install all dependencies
pnpm install

# Add a dependency
pnpm add <package> --filter @piccolo/agent

# Run a script in a specific package
pnpm --filter @piccolo/core test

# Run a script in all packages
pnpm -r test
```

The workspace is defined in `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "extensions/*"
  - "gateways/*"
```

`pnpm-lock.yaml` is committed. `node_modules/` is gitignored.

---

## Build System

**Vite** is used for bundling and development. **Wrangler** handles deployment to Cloudflare Workers (Wrangler uses esbuild internally; Vite is used for development server and unit test bundling).

```bash
# Type-check all packages
pnpm -r exec tsc --noEmit

# Build a package (produces dist/ for local use; Wrangler bundles for deployment)
pnpm --filter @piccolo/agent build

# Deploy a Worker
pnpm --filter @piccolo/core deploy
```

---

## Testing

### Framework

**Vitest** is the test runner for all packages. All tests run under Vitest.

Workers runtime tests (anything that uses Durable Objects, KV, R2, or Cloudflare-specific globals) use `@cloudflare/vitest-pool-workers` to run inside a real Workers runtime sandbox (Miniflare):

```typescript
// vitest.config.ts (Workers packages)
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.template.jsonc" },
      },
    },
  },
});
```

Pure library packages (e.g., `piccolo-agent`) that have no Workers-specific globals use the standard Vitest Node-like runner:

```typescript
// vitest.config.ts (library packages)
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: { provider: "v8" },
  },
});
```

### Coverage requirement

Every public function, class method, and event handler must have at least one test. The minimum enforced coverage thresholds:

```typescript
// vitest.config.ts
coverage: {
  thresholds: {
    lines: 80,
    functions: 80,
    branches: 70,
  }
}
```

These are minimums, not targets. Aim for 100% on critical paths (agent loop, JSRPC dispatch, tool validation).

### Test structure

Tests live alongside source in a `test/` directory at the package root, not co-located with source files:

```
packages/agent/
├── src/
│   ├── agent.ts
│   └── loop.ts
├── test/
│   ├── agent.test.ts
│   └── loop.test.ts
└── vitest.config.ts
```

Test files follow the naming convention `{subject}.test.ts`.

### What to test

| Layer | What to test |
|---|---|
| `piccolo-agent` | Agent loop state machine, turn transitions, steering/follow-up queuing, tool execution (parallel + sequential), abort, compaction |
| `piccolo-core` | Session lifecycle, extension dispatch merge logic, system prompt assembly, context reconstruction from entries |
| Extensions | Each tool action (all branches), event handler return values, error paths |
| Gateways | HTTP API routing, SSE event formatting, `ISession` method dispatch, auth rejection |

---

## Mocking Infrastructure Dependencies

Real infra bindings (AI Gateway, D1, KV, R2, Durable Objects) must never be required to run unit or integration tests. Every infra dependency is mocked at the boundary.

### AI Gateway mock

The AI Gateway is mocked by intercepting `fetch()`. Provide a `createMockGateway()` helper in `packages/agent/test/mock-gateway.ts`:

```typescript
import type { ModelMessage } from "ai";

export interface MockGatewayOptions {
  // Fixed text to stream back token-by-token
  response?: string;
  // Tool calls to emit before the final text response
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  // Simulate an error response
  error?: string;
  // Simulate a context length exceeded error
  contextOverflow?: boolean;
}

export function createMockGateway(options: MockGatewayOptions = {}) {
  // Returns a vi.fn() that intercepts fetch() calls to the AI Gateway URL
  // and returns a streaming SSE response matching the CF AI Gateway format.
}
```

Usage:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGateway } from "./mock-gateway";
import { Agent } from "../src/agent";

describe("Agent", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", createMockGateway({ response: "Hello, world!" }));
  });

  it("streams a text response", async () => {
    const agent = new Agent({ modelId: "openai/gpt-4o", systemPrompt: "You are helpful." });
    const events: string[] = [];
    agent.subscribe(e => { if (e.type === "text-delta") events.push(e.delta); });
    await agent.prompt("Hi");
    expect(events.join("")).toBe("Hello, world!");
  });
});
```

### Cloudflare binding mocks

For KV, R2, D1, and Durable Object bindings, use in-memory implementations. These are not stubs that throw — they are lightweight implementations that behave correctly for test purposes.

```typescript
// test/mocks/kv.ts
export function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter(k => !prefix || k.startsWith(prefix))
        .map(name => ({ name, expiration: undefined, metadata: undefined }));
      return { keys, list_complete: true, cursor: undefined };
    },
  } as unknown as KVNamespace;  // KVNamespace has many optional methods; cast is acceptable
}

// test/mocks/d1.ts
export function createMockD1(): D1Database {
  // Uses an in-memory SQLite via the `@sqlite.org/sqlite-wasm` or similar
  // to run actual SQL — not stub return values.
}

// test/mocks/r2.ts
export function createMockR2(): R2Bucket {
  const store = new Map<string, { body: ArrayBuffer; meta: R2Object }>();
  // ...
}
```

**Rule:** mocks that return hardcoded values without executing logic are only acceptable for tests of code that explicitly does not depend on the infra behaviour. Tests that exercise storage logic (session persistence, entry reconstruction, compaction) must use functional mocks that actually store and retrieve data.

### `IExtensionContext` mock

Extensions are tested with a mock `IExtensionContext`:

```typescript
// test/mocks/extension-context.ts
import type { IExtensionContext } from "piccolo-core";

export function createMockContext(overrides: Partial<IExtensionContext> = {}): IExtensionContext {
  return {
    sessionId: "test-session",
    userId: "test-user",
    getName: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
    getModel: vi.fn().mockResolvedValue("openai/gpt-4o"),
    setModel: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    getActiveTools: vi.fn().mockResolvedValue([]),
    setActiveTools: vi.fn().mockResolvedValue(undefined),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    sendFollowUp: vi.fn().mockResolvedValue(undefined),
    appendCustomMessage: vi.fn().mockResolvedValue(undefined),
    appendCustomEntry: vi.fn().mockResolvedValue(undefined),
    getEntries: vi.fn().mockResolvedValue([]),
    abort: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockResolvedValue({ inputTokens: 0, contextWindowTokens: 200000, usedFraction: 0 }),
    compact: vi.fn().mockResolvedValue(undefined),
    getSystemPrompt: vi.fn().mockResolvedValue(""),
    ...overrides,
  } as IExtensionContext;
}
```

---

## Linting and Formatting

**Biome** is the formatter and linter. No ESLint, no Prettier.

```jsonc
// biome.json (Biome 2.x)
{
  "$schema": "https://biomejs.dev/schemas/2.4.8/schema.json",
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error"   // enforced by linter in addition to tsc
      },
      "style": {
        "noNonNullAssertion": "warn"  // prefer explicit null checks; warn rather than error
      }
    }
  },
  // In Biome 2, import sorting moved from organizeImports to assist.actions.source.
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

```bash
# Check and auto-fix
pnpm biome check --write .

# Check only (CI)
pnpm biome check .
```

---

## Directory Structure

```
piccolo/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── packages/
│   ├── agent/              piccolo-agent npm package
│   │   ├── src/
│   │   ├── test/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vitest.config.ts
│   └── core/               piccolo-core Cloudflare Worker
│       ├── src/
│       ├── test/
│       ├── package.json
│       ├── tsconfig.json
│       ├── wrangler.template.jsonc
│       └── vitest.config.ts
├── gateways/
│   ├── web/                piccolo-web-gateway Worker
│   └── telegram/           piccolo-telegram-gateway Worker
└── extensions/
    ├── r2-tool/            ext-r2-tool Worker
    ├── d1-tool/            ext-d1-tool Worker
    ├── skills/             ext-skills Worker
    └── templates/          ext-templates Worker
```

---

## CI Checks

Every commit must pass all of the following before merging. These are not optional:

```bash
# 1. Format / lint
pnpm biome check .

# 2. Type-check
pnpm -r exec tsc --noEmit

# 3. Tests
pnpm -r test --coverage

# 4. No `any` introduced
# (enforced by biome noExplicitAny: error + tsc noImplicitAny: true)
```

CI fails if any of these steps produce errors or warnings that were not present in the base branch.

---

## Naming Conventions

| Construct | Convention | Example |
|---|---|---|
| Interface (JSRPC surface) | `I` prefix + PascalCase | `IPiccoloCore`, `ISession`, `ITool` |
| Interface (data/result shape) | PascalCase, no prefix | `SessionRecord`, `ToolResult` |
| Type alias | PascalCase | `AgentEvent`, `GatewayId` |
| Class | PascalCase | `AgentSessionDO`, `GreetTool` |
| Function | camelCase | `createMockGateway`, `buildSessionContext` |
| Constant | SCREAMING_SNAKE_CASE for module-level | `MAX_RETRY_ATTEMPTS`, `DEFAULT_KEEP_TOKENS` |
| File | kebab-case | `agent-session-do.ts`, `mock-gateway.ts` |
| Test file | `{subject}.test.ts` | `agent.test.ts`, `tool-dispatch.test.ts` |

---

## Import Rules

- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`)
- Group imports: Cloudflare Workers runtime → external packages → internal packages → relative
- No barrel `index.ts` re-exports unless the package has a well-defined public API surface
- Import from the package entry point, not deep internal paths, when consuming sibling packages

---

## Error Handling

- Never swallow errors silently. Every `catch` block either re-throws, returns an error result, or logs with structured context.
- Use `unknown` in catch clauses (enforced by `useUnknownInCatchVariables`). Narrow before accessing properties:
  ```typescript
  try { ... }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // ...
  }
  ```
- Prefer `throw new Error(message)` over `throw message`. Include enough context in the message to debug without a stack trace.
- Tool `execute()` methods signal failure by throwing — never by returning `{ isError: true }`.
