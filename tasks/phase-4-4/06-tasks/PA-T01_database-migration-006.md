# Task 1: Database Migration 006

## Phase: A — Foundation
## Dependencies: None
## Parallelizable With: T2, T3

---

## Description

Create migration `006_lifecycle_unification_teams.sql` that implements all schema changes from the design. This supersedes any worktree-based 006 migration. It combines lifecycle changes, team columns cleanup, teammates table creation, and FK additions.

The migration must be idempotent where possible (`IF NOT EXISTS`, `IF EXISTS`) since it modifies populated tables. The migration runner applies each file in a single transaction via `pg_advisory_lock(48756301)`.

## Files

- **Create**: `packages/server/src/db/migrations/006_lifecycle_unification_teams.sql`

## Full SQL (from design sections 4.1–4.8)

1. Update lifecycle CHECK constraint — drop old, add new with states: `detected`, `ended`, `transcript_ready`, `parsed`, `summarized`, `complete`, `failed`
2. Migrate existing rows: `archived` → `complete`, `summarized` → `complete` (current behavior: summarized is pre-terminal and archived is terminal; new model: complete is the single terminal state), `capturing` → `detected`
3. Drop `parse_status`, `parse_error` columns; add `last_error TEXT`
4. New recovery index on `(lifecycle, updated_at) WHERE lifecycle = 'transcript_ready'`
5. Drop `team_name`, `team_role` from sessions (moved to dedicated tables)
6. Drop `resumed_from_session_id` from sessions (subsumed from worktree 006)
7. Add `is_inferred BOOLEAN NOT NULL DEFAULT false` to subagents (subsumed from worktree 006)
8. DROP and recreate `teams` table with new schema (session-scoped, ULID PK, compound unique on `(session_id, team_name, created_at)`)
9. Create `teammates` table
10. Drop `team_name` from subagents, add `teammate_id` FK
11. Add `teammate_id` FK to `transcript_messages`
12. Add `teammate_id` FK to `content_blocks`

## Critical Design Choices

- `teams` is DROPped and recreated (existing team data was minimal and will be reconstructed from transcripts going forward)
- `teammates.summary` column stores the per-entity LLM summary
- All `teammate_id` FKs use `ON DELETE SET NULL` — dropping the teammates table leaves core data intact
- `sessions.last_error` replaces both `parse_status` and `parse_error` as the single error tracking field
- The `idx_sessions_needs_recovery` index is recreated to filter on `lifecycle = 'transcript_ready'` instead of the old `parse_status`-based index

## How to Test

```bash
# Fresh database (all migrations in sequence)
cd packages/server && bun run db:reset && bun run db:migrate

# Verify new tables exist
psql $DATABASE_URL -c "\d teammates"
psql $DATABASE_URL -c "\d teams"

# Verify lifecycle constraint
psql $DATABASE_URL -c "INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at) VALUES ('test', 'w', 'd', 'capturing', now())"
# Should FAIL — 'capturing' is no longer valid

psql $DATABASE_URL -c "INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at) VALUES ('test', 'w', 'd', 'transcript_ready', now())"
# Should SUCCEED

# Verify parse_status is gone
psql $DATABASE_URL -c "SELECT parse_status FROM sessions LIMIT 1"
# Should FAIL — column dropped

# Verify teammate_id FK on transcript_messages
psql $DATABASE_URL -c "\d transcript_messages" | grep teammate_id
```

## Success Criteria

1. Migration runs cleanly on a **fresh** database (001–006 in sequence)
2. Migration runs cleanly on an **existing** database with data (ALTER TABLE on populated tables)
3. Lifecycle CHECK constraint rejects old states (`capturing`, `archived`)
4. Lifecycle CHECK constraint accepts new states (`transcript_ready`, `complete`)
5. `parse_status` and `parse_error` columns are gone
6. `last_error` column exists
7. `teams` table has new schema with `(session_id, team_name, created_at)` unique constraint
8. `teammates` table exists with correct columns and FKs
9. `teammate_id` FK exists on `subagents`, `transcript_messages`, `content_blocks`
10. `ON DELETE SET NULL` works — deleting a teammate row nullifies FKs
11. `ON DELETE CASCADE` works on teams → teammates
