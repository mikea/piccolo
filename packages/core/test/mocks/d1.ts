/**
 * D1 test helper.
 *
 * `setupTestDb` applies all pending migrations to a real Miniflare D1 instance.
 * Use this in `beforeEach` to get a clean, fully-migrated database per test.
 *
 * The `migrations` value comes from `inject("migrations")` in the test, which
 * was populated via `test.provide` in vitest.config.ts using `readD1Migrations`.
 *
 * Spec ref: specs/code.md §Mocks, specs/implementation_plan.md §3.1
 */

import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
// D1Migration is exported from the main package entry point in 0.13+.

/**
 * Apply all migrations to the given D1 database.
 * Idempotent: migrations already applied (tracked in `d1_migrations` table) are skipped.
 */
export async function setupTestDb(db: D1Database, migrations: D1Migration[]): Promise<void> {
  await applyD1Migrations(db, migrations);
}
