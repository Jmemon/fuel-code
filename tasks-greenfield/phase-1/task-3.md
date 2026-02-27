# Task 3: PostgreSQL Connection, Migration Runner, and Phase 1 Schema

## Parallel Group: C

## Description

Create the Postgres infrastructure: connection pool management, a custom migration runner using raw SQL files, and the Phase 1 database schema. The migration runner tracks applied migrations in a `_migrations` table and uses advisory locks to prevent concurrent migration runs (important for Railway restarts).

### Dependencies to install
```bash
cd packages/server && bun add postgres pino dotenv
```

### Files to Create

**`packages/server/src/db/postgres.ts`**:
- `createDb(connectionString: string, options?: { max?: number }): postgres.Sql` — creates a postgres.js client. Default pool: `max: 10`, `idle_timeout: 20`, `connect_timeout: 10`. If `connectionString` is empty/undefined, throw `StorageError` with code `STORAGE_DB_URL_MISSING` and message "DATABASE_URL environment variable is required."
- `checkDbHealth(sql: postgres.Sql): Promise<{ ok: boolean; latency_ms: number; error?: string }>` — runs `SELECT 1` with 5-second timeout. Returns `{ ok: true, latency_ms }` on success, `{ ok: false, error: message }` on failure.
- **Do not log the connection string** (contains credentials). Log only host and port for diagnostics.

**`packages/server/src/db/migrator.ts`**:
- `runMigrations(sql: postgres.Sql, migrationsDir: string): Promise<MigrationResult>`:
  - `MigrationResult = { applied: string[]; skipped: string[]; errors: Array<{ name: string; error: string }> }`
  - Step 1: Create `_migrations` table if not exists: `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  - Step 2: Acquire advisory lock: `SELECT pg_advisory_lock(48756301)` (arbitrary constant). This prevents two Railway containers from migrating simultaneously.
  - Step 3: Read all `.sql` files from `migrationsDir`, sort lexicographically.
  - Step 4: Query `SELECT name FROM _migrations` to get already-applied list.
  - Step 5: For each unapplied migration, wrap in a transaction (`BEGIN`/`COMMIT`). On failure, `ROLLBACK` that migration, add to errors, continue to next.
  - Step 6: Release advisory lock: `SELECT pg_advisory_unlock(48756301)`.
  - Step 7: Return results.
  - **If the migrations directory does not exist or is empty**: return `{ applied: [], skipped: [], errors: [] }` (no-op, not an error).
  - **If a migration file is unreadable**: add to errors, continue.

**`packages/server/src/db/migrations/001_initial.sql`**:
Full Phase 1 schema from CORE.md. Include these tables:

1. **`workspaces`** — exactly as CORE.md lines 307-316
2. **`devices`** — exactly as CORE.md lines 321-334
3. **`workspace_devices`** — exactly as CORE.md lines 339-347
4. **`sessions`** — as CORE.md lines 352-403, BUT:
   - `remote_env_id TEXT` WITHOUT the FK constraint (since `remote_envs` table doesn't exist yet). Add SQL comment: `-- FK to remote_envs added in Phase 5 migration`
5. **`events`** — exactly as CORE.md lines 413-428
6. All indexes from CORE.md for these tables (sessions: 4 indexes, events: 4 indexes)

Tables NOT included in Phase 1 (deferred):
- `transcript_messages` (Phase 2)
- `content_blocks` (Phase 2)
- `git_activity` (Phase 3)
- `remote_envs` (Phase 5)
- `blueprints` (Phase 5)

Use `CREATE TABLE IF NOT EXISTS` for all tables (belt-and-suspenders with the migrator).
Use `CREATE INDEX IF NOT EXISTS` for all indexes.

### Tests

**`packages/server/src/db/__tests__/migrator.test.ts`**:
- Test with a temp directory containing test SQL files
- Verify: first run applies all migrations
- Verify: second run is a no-op (all skipped)
- Verify: migration with bad SQL is reported as error, other migrations still apply
- Verify: `_migrations` table contains correct entries after run

## Relevant Files
- `packages/server/src/db/postgres.ts` (create)
- `packages/server/src/db/migrator.ts` (create)
- `packages/server/src/db/migrations/001_initial.sql` (create)
- `packages/server/src/db/__tests__/migrator.test.ts` (create)

## Success Criteria
1. Running `runMigrations` on an empty database creates `_migrations` plus all 5 Phase 1 tables.
2. Running again is a no-op: `{ applied: [], skipped: ["001_initial.sql"], errors: [] }`.
3. `checkDbHealth` returns `{ ok: true, latency_ms: N }` against a running Postgres (N < 100 for local).
4. `checkDbHealth` returns `{ ok: false, error: "..." }` when Postgres is down, within 5 seconds.
5. All tables match CORE.md schema: correct column names, types, constraints, defaults.
6. `events.session_id` is nullable (allows NULL for git events outside CC sessions).
7. `sessions.remote_env_id` exists as TEXT but has no FK constraint.
8. All 8 indexes are created (4 sessions + 4 events).
9. `workspace_devices` has a composite PK on `(workspace_id, device_id)`.
10. Two simultaneous `runMigrations` calls do not corrupt the schema (advisory lock prevents it).
11. The connection string is never logged (verify by inspecting log output).
12. `createDb` with an empty string throws `StorageError`.
