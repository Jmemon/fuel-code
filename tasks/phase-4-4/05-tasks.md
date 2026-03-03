# Phase 4-4: Session Lifecycle Unification + Agent Teams Support — Implementation Tasks

## Overview

31 tasks across 7 phases (A–G). Unifies the session lifecycle state machine, implements the reconcile pattern, rewrites backfill to direct DB+S3, adds agent team/teammate detection and per-entity summaries, and updates all display surfaces (TUI + CLI).

**What this phase delivers**:
- Single lifecycle state machine replacing `lifecycle` + `parse_status` split-brain
- `reconcileSession()` — one idempotent function for all entry points
- Direct DB+S3 backfill (no synthetic events, no HTTP-to-self)
- Agent team detection from transcripts (teams table, teammates table)
- Per-teammate stitched message feeds
- Per-entity LLM summaries (session + each teammate)
- TUI and CLI display of teammates

---

## Task Summary

| Task | Name | Phase | Dependencies | Parallelizable With |
|------|------|-------|-------------|---------------------|
| 1 | Database Migration 006 | A | — | 2, 3 |
| 2 | Shared Types: Lifecycle, Teammate, SessionSeed, SessionGap | A | — | 1, 3 |
| 3 | Drop `parse_status` from Shared Types + API Contracts | A | — | 1, 2 |
| 4 | Session Lifecycle State Machine Rewrite | B | 1, 2 |  5 |
| 5 | Transition Callers: Update All Handlers | B | 1, 2 | 4 |
| 6 | Recovery Logic: Drop `parse_status`, Use `lifecycle + updated_at` | B | 4 | — |
| 7 | SessionSeed + computeGap() Implementation | C | 2, 4 | 8 |
| 8 | reconcileSession() — Core Pipeline Rewrite | C | 4, 7 | — |
| 9 | Wire transcript-upload to TRANSCRIPT_READY | C | 4, 8 | 10 |
| 10 | Wire session-end handler to simplified logic | C | 4, 8 | 9 |
| 11 | Wire recovery to reconcileSession | C | 6, 8 | — |
| 12 | Backfill: Direct DB+S3 Writes (No Synthetic Events) | D | 7, 8 | 13 |
| 13 | Backfill: Subagent Transcript Upload | D | 12 | — |
| 14 | Backfill: Remove Synthetic Event Construction + Simplify CLI | D | 12, 13 | — |
| 15 | Team Detection: Extract Team Intervals from Content Blocks | E | 8 | 16 |
| 16 | Teammate Identification from Agent Tool Results | E | 15 | — |
| 17 | Map Subagents to Teammates During Subagent Transcript Parsing | E | 16 | 18 |
| 18 | Set `teammate_id` on transcript_messages + content_blocks | E | 16, 17 | — |
| 19 | Session Summary Enhancement for Team Sessions | F | 17, 18 | 20 |
| 20 | Per-Teammate Summary Generation | F | 17, 18 | 19 |
| 21 | Summary Pipeline Integration (SUMMARIZED → COMPLETE) | F | 19, 20 | — |
| 22 | API: Teammate Endpoints | G | 18 | 23, 24, 25 |
| 23 | API: Update Session Detail + List for New Lifecycle | G | 4 | 22, 24, 25 |
| 24 | TUI: SubagentsPanel → Teammates Section | G | 22 | 25, 26 |
| 25 | TUI: TeammateDetailView (Stitched Message Feed) | G | 22 | 24, 26 |
| 26 | TUI: Navigation State Machine Update | G | 24, 25 | — |
| 27 | TUI: SessionsView Teammate Grouping | G | 22, 26 | 28 |
| 28 | CLI: `sessions` Command Teammate Display | G | 22, 23 | 27 |
| 29 | Cleanup: Remove Dead Code (`capturing`, old pipeline triggers) | H | all G | 30, 31 |
| 30 | Cleanup: Remove `parse_status` References Everywhere | H | all G | 29, 31 |
| 31 | E2E Tests + Backward Compatibility Verification | H | 29, 30 | — |

---

## Dependency Graph

```
Phase A ─── T1: Migration 006    T2: Shared Types    T3: Drop parse_status types
               │                      │                    │
        ┌──────┤                      │                    │
        │      │                      │                    │
        ▼      ▼                      ▼                    ▼
Phase B ─── T4: Lifecycle        T5: Transition       T6: Recovery
            Rewrite              Callers              (needs T4)
               │                      │
               └──────┬───────────────┘
                      ▼
Phase C ─── T7: SessionSeed+computeGap
               │
               ▼
            T8: reconcileSession
               │
        ┌──────┼──────┬──────┐
        ▼      ▼      ▼      ▼
      T9:    T10:   T11:   (Phase D,E use T8)
      upload  end   recovery
      route   handler wiring

Phase D ─── T12: Backfill Direct DB+S3
               │
               ▼
            T13: Subagent Transcript Upload
               │
               ▼
            T14: Remove Synthetic Events + Simplify CLI

Phase E ─── T15: Team Interval Detection
               │
               ▼
            T16: Teammate Identification
               │
        ┌──────┼──────┐
        ▼             ▼
      T17: Map      T18: Set
      Subagents     teammate_id
      to Teammates  on messages

Phase F ─── T19: Session Summary    T20: Per-Teammate
            Enhancement             Summary
               │                      │
               └──────┬───────────────┘
                      ▼
                   T21: Pipeline Integration

Phase G ─── T22: Teammate API   T23: Session API    T24: TUI Panel
               │                   │                   │
               ├───────────────────┤                   ▼
               ▼                   ▼                T25: Teammate
            T27: Sessions       T28: CLI              Detail View
            View Grouping       Command                │
                                                       ▼
                                                    T26: Navigation
                                                       │
                                                       ▼
                                                    T27: SessionsView

Phase H ─── T29: Dead Code    T30: parse_status    T31: E2E Tests
            Cleanup           Cleanup
```

---

## Phase A: Foundation (Schema + Types)

All three tasks are fully independent and can run in parallel.

---

### Task 1: Database Migration 006

#### Description

Create migration `006_lifecycle_unification_teams.sql` that implements all schema changes from the design. This supersedes any worktree-based 006 migration. It combines lifecycle changes, team columns cleanup, teammates table creation, and FK additions.

The migration must be idempotent where possible (`IF NOT EXISTS`, `IF EXISTS`) since it modifies populated tables. The migration runner applies each file in a single transaction via `pg_advisory_lock(48756301)`.

#### Files

- **Create**: `packages/server/src/db/migrations/006_lifecycle_unification_teams.sql`

#### Full SQL (from design sections 4.1–4.8)

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

#### Critical Design Choices

- `teams` is DROPped and recreated (existing team data was minimal and will be reconstructed from transcripts going forward)
- `teammates.summary` column stores the per-entity LLM summary
- All `teammate_id` FKs use `ON DELETE SET NULL` — dropping the teammates table leaves core data intact
- `sessions.last_error` replaces both `parse_status` and `parse_error` as the single error tracking field
- The `idx_sessions_needs_recovery` index is recreated to filter on `lifecycle = 'transcript_ready'` instead of the old `parse_status`-based index

#### How to Test

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

#### Success Criteria

1. Migration runs cleanly on a fresh database (001–006 in sequence)
2. Migration runs cleanly on an existing database with data (ALTER TABLE on populated tables)
3. Lifecycle CHECK constraint rejects old states (`capturing`, `archived`)
4. Lifecycle CHECK constraint accepts new states (`transcript_ready`, `complete`)
5. `parse_status` and `parse_error` columns are gone
6. `last_error` column exists
7. `teams` table has new schema with `(session_id, team_name, created_at)` unique constraint
8. `teammates` table exists with correct columns and FKs
9. `teammate_id` FK exists on `subagents`, `transcript_messages`, `content_blocks`
10. `ON DELETE SET NULL` works — deleting a teammate row nullifies FKs
11. `ON DELETE CASCADE` works on teams → teammates

---

### Task 2: Shared Types — Lifecycle, Teammate, SessionSeed, SessionGap

#### Description

Update and create shared types that the rest of the codebase will depend on. This includes the new `SessionLifecycle` union type, `Teammate` interface, `SessionSeed` interface, and `SessionGap` interface.

#### Files

- **Modify**: `packages/shared/src/types/session.ts` — update `SessionLifecycle` type, remove `ParseStatus`, add `Teammate`, update `Session` interface (drop `parse_status`, `parse_error`, `team_name`, `team_role`; add `last_error`, `teammates?`)
- **Create**: `packages/shared/src/types/teammate.ts` — `Teammate`, `TeammateDetail`, `TeammateSummary` interfaces
- **Modify**: `packages/shared/src/types/team.ts` — update `Team` interface for new schema (session-scoped, add `session_id`, remove `lead_session_id`, add `teammates?`)
- **Create**: `packages/core/src/types/reconcile.ts` — `SessionSeed`, `SessionGap` interfaces
- **Modify**: `packages/shared/src/types/transcript.ts` — add `teammate_id` to `TranscriptMessage` and `ParsedContentBlock`
- **Modify**: `packages/shared/src/index.ts` — re-export new types

#### Key Type Definitions

```typescript
// SessionLifecycle — new states
type SessionLifecycle = 'detected' | 'ended' | 'transcript_ready' | 'parsed' | 'summarized' | 'complete' | 'failed';

// Teammate — new entity
interface Teammate {
  id: string;
  team_id: string;
  session_id: string;
  name: string;
  cc_teammate_id: string | null;
  color: string | null;
  summary: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

// SessionSeed — normalized input for reconcile
interface SessionSeed {
  ccSessionId: string;
  origin: 'hook' | 'backfill' | 'recovery';
  workspaceCanonicalId: string;
  deviceId: string;
  cwd: string;
  gitBranch: string | null;
  gitRemote: string | null;
  model: string | null;
  ccVersion: string | null;
  source: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  endReason: string | null;
  transcriptRef: { type: 'disk'; path: string } | { type: 's3'; key: string } | null;
  isLive: boolean;
}

// SessionGap — what the reconciler needs to do
interface SessionGap {
  needsTranscriptUpload: boolean;
  needsParsing: boolean;
  needsSubagentParsing: boolean;
  needsTeamDetection: boolean;
  needsStats: boolean;
  needsSummary: boolean;
  needsTeammateSummaries: boolean;
  needsLifecycleAdvance: boolean;
  staleStartedAt: boolean;
  staleDurationMs: boolean;
  staleSubagentCount: boolean;
}
```

#### How to Test

```bash
# Type-check the monorepo
cd packages/shared && bun run typecheck
cd packages/core && bun run typecheck
```

#### Success Criteria

1. All new types compile without errors
2. No downstream compile errors from removing `parse_status`/`parse_error` from `Session` (compile errors are expected and will be fixed in Tasks 3–5)
3. `SessionSeed` captures all data needed from both hooks and backfill
4. `SessionGap` covers every step in the reconcile pipeline
5. `Teammate` type matches the DB schema from Task 1

---

### Task 3: Drop `parse_status` from API Contracts + Batch-Status Endpoint

#### Description

The `POST /api/sessions/batch-status` endpoint currently returns `{ lifecycle, parse_status }` per session. With `parse_status` gone, it should return only `{ lifecycle }`. The backfill CLI polls this endpoint — its polling logic needs to recognize the new terminal states (`complete` instead of `archived`, no `parse_status` to check).

Also update any Zod schemas or validation that reference `parse_status`.

#### Files

- **Modify**: `packages/server/src/routes/sessions.ts` — update `batch-status` response shape, remove `parse_status` from SELECT queries
- **Modify**: `packages/core/src/session-backfill.ts` — update `waitForPipelineCompletion` terminal state check from `['parsed', 'summarized', 'archived', 'failed']` to `['complete', 'failed']`
- **Modify**: `packages/server/src/routes/sessions.ts` — remove `parse_status` from `GET /sessions` and `GET /sessions/:id` responses
- **Modify**: `packages/cli/src/tui/hooks/useSessionDetail.ts` — remove `parse_status` references in `isLive` derivation (use lifecycle only)

#### How to Test

```bash
# Verify batch-status returns new shape
curl -X POST http://localhost:3457/api/sessions/batch-status \
  -H 'Content-Type: application/json' \
  -d '{"session_ids": ["test-id"]}'
# Should return { statuses: { "test-id": { lifecycle: "..." } }, not_found: ["test-id"] }

# Verify session list no longer returns parse_status
curl http://localhost:3457/api/sessions | jq '.sessions[0] | keys' | grep parse_status
# Should return nothing

bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

#### Success Criteria

1. `batch-status` returns `{ lifecycle }` only, no `parse_status`
2. Session list/detail endpoints no longer include `parse_status` or `parse_error`
3. Backfill `waitForPipelineCompletion` treats `complete` as terminal (not `archived`)
4. No runtime references to `parse_status` remain in server routes

---

## Phase B: Lifecycle State Machine

Tasks 4 and 5 can run in parallel. Task 6 depends on Task 4.

---

### Task 4: Session Lifecycle State Machine Rewrite

#### Description

Rewrite `session-lifecycle.ts` to implement the new 7-state machine. This is the most critical task — every other lifecycle-aware component depends on it.

**Current states**: `detected`, `capturing`, `ended`, `parsed`, `summarized`, `archived`, `failed`
**New states**: `detected`, `ended`, `transcript_ready`, `parsed`, `summarized`, `complete`, `failed`

Key changes:
- Remove `capturing` state entirely (never set in production)
- Replace `archived` with `complete`
- Add `transcript_ready` state between `ended` and `parsed`
- `failed` gains a reset path: `failed → ended` (via `resetSessionForReparse`)
- Remove all `parse_status` logic from `transitionSession`, `failSession`, `getSessionState`
- `failSession` now only sets `lifecycle = 'failed'` and `last_error` (no `parse_status`)
- `resetSessionForReparse` resets to `ended` (no `parse_status` reset)
- `findStuckSessions` changes query to `lifecycle = 'transcript_ready' AND updated_at < threshold`

#### Files

- **Modify**: `packages/core/src/session-lifecycle.ts` — full rewrite of TRANSITIONS map, transitionSession, failSession, resetSessionForReparse, findStuckSessions, getSessionState
- **Modify**: `packages/core/src/session-lifecycle.test.ts` (if exists) — update tests for new states

#### Current → New Transition Map

```typescript
// CURRENT
const TRANSITIONS = {
  detected: ["capturing", "ended", "failed"],
  capturing: ["ended", "failed"],
  ended: ["parsed", "failed"],
  parsed: ["summarized", "failed"],
  summarized: ["archived"],
  archived: [],
  failed: [],
};

// NEW
const TRANSITIONS = {
  detected: ["ended", "transcript_ready", "failed"],
  ended: ["transcript_ready", "failed"],
  transcript_ready: ["parsed", "failed"],
  parsed: ["summarized", "failed"],
  summarized: ["complete"],
  complete: [],
  failed: ["ended"],  // reset path for retry
};
```

#### Key Implementation Details

- `transitionSession` currently builds SET clauses including `parse_status` — remove all `parse_status` references
- `UpdatableSessionFields` currently has `parse_status`, `parse_error` — replace with `last_error`
- `failSession` currently uses `sql.unsafe` to set both `lifecycle='failed'` AND `parse_status='failed'` — simplify to only set `lifecycle='failed'` and `last_error`
- `resetSessionForReparse` currently resets `parse_status='pending'` — remove that, just reset `lifecycle='ended'` and `last_error=null`
- `findStuckSessions` currently checks `lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing')` — simplify to `lifecycle = 'transcript_ready' AND updated_at < threshold`
- `getSessionState` currently returns `{ lifecycle, parse_status, parse_error }` — return `{ lifecycle, last_error }` only

#### How to Test

```bash
cd packages/core && bun test session-lifecycle 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Manual validation:
# - transitionSession('detected', 'transcript_ready') succeeds
# - transitionSession('detected', 'capturing') fails (state removed)
# - transitionSession('failed', 'ended') succeeds (reset path)
# - failSession sets last_error, not parse_error
# - findStuckSessions only looks at transcript_ready
```

#### Success Criteria

1. `TRANSITIONS` map matches the design exactly
2. `transitionSession` no longer references `parse_status`
3. `failSession` sets `last_error` instead of `parse_error`/`parse_status`
4. `resetSessionForReparse` moves to `ended` without touching `parse_status`
5. `findStuckSessions` queries `lifecycle = 'transcript_ready'` only
6. `getSessionState` returns `{ lifecycle, last_error }`
7. All existing lifecycle tests pass (updated for new states)
8. `failed → ended` transition works (for retry flow)

---

### Task 5: Transition Callers — Update All Handlers

#### Description

Every call site that invokes `transitionSession()` or checks lifecycle/parse_status values needs updating for the new state names. This is a mechanical but pervasive change.

#### Files

- **Modify**: `packages/core/src/handlers/session-start.ts` — no `parse_status` default needed (column gone)
- **Modify**: `packages/core/src/handlers/session-end.ts` — transition from `['detected', 'capturing']` → change to `['detected']` (no `capturing`); the synthetic session insert uses `lifecycle = 'ended'` (unchanged); remove any `parse_status` from insert
- **Modify**: `packages/core/src/session-pipeline.ts` — step 1 checks `lifecycle === 'ended'` → change to `lifecycle === 'transcript_ready'`; step 2 removes `parse_status = 'parsing'` update; step 8 transition `ended → parsed` → change to `transcript_ready → parsed`; step 9 transition `parsed → summarized` (unchanged); add new step: `summarized → complete`; remove `parse_status: 'completed'` from step 8 updates
- **Modify**: `packages/server/src/routes/transcript-upload.ts` — after S3 upload, transition to `transcript_ready` instead of just checking `lifecycle === 'ended'`
- **Modify**: `packages/server/src/routes/session-actions.ts` — reparse endpoint: update allowed source states
- **Modify**: `packages/core/src/session-recovery.ts` — update `recoverStuckSessions` and `recoverUnsummarizedSessions` for new states

#### Specific Changes Per File

**session-end.ts**: The handler currently transitions from `["detected", "capturing"]` to `"ended"`. Remove `"capturing"` from the array. The synthetic session insert for out-of-order events currently sets `parse_status` — remove that column from the INSERT. The backfill override UPDATE currently sets `parse_status` — remove.

**session-pipeline.ts**: The pipeline currently:
- Step 1: checks `lifecycle === 'ended'` → change to `lifecycle === 'transcript_ready'`
- Step 2: `UPDATE sessions SET parse_status = 'parsing'` → remove entirely (no soft-claim needed; the `transcript_ready → parsed` optimistic lock serves this purpose)
- Step 8: `transitionSession(sql, id, 'ended', 'parsed', { parse_status: 'completed', ... })` → `transitionSession(sql, id, 'transcript_ready', 'parsed', { ... })`
- After step 9 summary: add `transitionSession(sql, id, 'summarized', 'complete')` — new terminal transition
- When summary is disabled/empty: `transitionSession(sql, id, 'parsed', 'summarized', { summary: null })` then immediately `transitionSession(sql, id, 'summarized', 'complete')`

**transcript-upload.ts**: After S3 upload and DB update, currently checks `lifecycle === 'ended'` to trigger pipeline. New logic: attempt `transitionSession(sql, id, ['ended', 'detected'], 'transcript_ready')` then trigger pipeline if transition succeeded.

**session-recovery.ts**: `recoverStuckSessions` currently queries `lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing')`. Change to: `lifecycle = 'transcript_ready' AND updated_at < threshold`. `recoverUnsummarizedSessions` currently checks `lifecycle = 'parsed' AND parse_status = 'completed' AND summary IS NULL`. Change to: `lifecycle = 'parsed' AND summary IS NULL AND updated_at < threshold`.

#### How to Test

```bash
cd packages/core && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
cd packages/server && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Grep for any remaining parse_status references:
grep -r "parse_status" packages/core/src/ packages/server/src/ --include="*.ts" | grep -v node_modules | grep -v ".test."
# Should return 0 results (except possibly test files being updated separately)
```

#### Success Criteria

1. No runtime references to `parse_status` in handlers or pipeline
2. Session-end handler transitions from `['detected']` only (no `capturing`)
3. Pipeline checks `transcript_ready` not `ended` as entry state
4. Pipeline advances through `transcript_ready → parsed → summarized → complete`
5. Transcript upload route transitions to `transcript_ready`
6. All handler tests pass with new lifecycle states

---

### Task 6: Recovery Logic — Drop `parse_status`, Use `lifecycle + updated_at`

#### Description

Update `session-recovery.ts` to use the simplified stuck-session detection. With `parse_status` gone, stuck sessions are found purely by `lifecycle = 'transcript_ready' AND updated_at < threshold`.

#### Files

- **Modify**: `packages/core/src/session-recovery.ts` — rewrite both recovery functions
- **Modify**: `packages/server/src/index.ts` — update startup recovery call if needed (states may be referenced in log messages)

#### Key Changes

**`recoverStuckSessions`**:
- Current: `lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing') AND updated_at < threshold`
- New: `lifecycle = 'transcript_ready' AND updated_at < threshold`
- Recovery action: if `transcript_s3_key` exists, enqueue reconcile; if not, `failSession`

**`recoverUnsummarizedSessions`**:
- Current: `lifecycle = 'parsed' AND parse_status = 'completed' AND summary IS NULL AND updated_at < threshold`
- New: `lifecycle = 'parsed' AND summary IS NULL AND updated_at < threshold`
- Recovery action: `resetSessionForReparse` then enqueue pipeline

#### How to Test

```bash
cd packages/core && bun test session-recovery 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. No `parse_status` references in recovery code
2. Stuck session detection uses `lifecycle = 'transcript_ready'`
3. Unsummarized detection uses `lifecycle = 'parsed' AND summary IS NULL`
4. Recovery correctly enqueues sessions for re-processing
5. Recovery handles the case where `transcript_s3_key` is missing (→ failSession)

---

## Phase C: Reconcile Pattern

Task 7 can start as soon as Phase B's Task 4 is done. Task 8 depends on Task 7. Tasks 9, 10, 11 depend on Task 8 and can run in parallel.

---

### Task 7: SessionSeed + computeGap() Implementation

#### Description

Implement the `SessionSeed` construction helpers and `computeGap()` function. The seed is the universal normalized input — both hooks and backfill construct one. `computeGap()` compares current DB state against desired state to determine what work remains.

#### Files

- **Create**: `packages/core/src/reconcile/session-seed.ts` — `buildSeedFromHook(event)`, `buildSeedFromFilesystem(discoveredSession)`, `buildSeedFromRecovery(sessionRow)`
- **Create**: `packages/core/src/reconcile/compute-gap.ts` — `computeGap(session, seed): SessionGap`
- **Create**: `packages/core/src/reconcile/index.ts` — barrel export

#### Key Implementation Details

**`buildSeedFromHook(event)`**: Extracts from Redis stream event data. Has rich data (model, gitRemote, ccVersion from CC's hook payload).

**`buildSeedFromFilesystem(discoveredSession)`**: Extracts from the `DiscoveredSession` type already used by backfill scanner. Less rich — model/ccVersion may be null if not in JSONL header.

**`buildSeedFromRecovery(sessionRow)`**: Constructs from an existing DB row for re-processing. `transcriptRef` is `{ type: 's3', key: session.transcript_s3_key }`.

**`computeGap(session, seed)`**: Compares the session's current `lifecycle` against the full pipeline to determine what's missing:
- `needsTranscriptUpload`: `transcript_s3_key IS NULL AND transcriptRef?.type === 'disk'`
- `needsParsing`: `lifecycle IN ('transcript_ready')`
- `needsSubagentParsing`: `lifecycle IN ('transcript_ready')` (parsed alongside main)
- `needsTeamDetection`: `lifecycle IN ('transcript_ready')` (detected during persistRelationships)
- `needsStats`: `lifecycle IN ('transcript_ready')`
- `needsSummary`: `lifecycle IN ('parsed')`
- `needsTeammateSummaries`: `lifecycle IN ('parsed', 'summarized')`
- `needsLifecycleAdvance`: `lifecycle NOT IN ('complete', 'failed')`
- `staleStartedAt`: `session.started_at === session.ended_at AND seed.startedAt !== seed.endedAt`
- `staleDurationMs`: `session.duration_ms === 0 AND seed.durationMs > 0`
- `staleSubagentCount`: always recomputed from DB

#### How to Test

```bash
cd packages/core && bun test reconcile 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write unit tests for:
- `buildSeedFromHook` with a mock event
- `buildSeedFromFilesystem` with a mock DiscoveredSession
- `computeGap` with sessions at various lifecycle stages

#### Success Criteria

1. All three `buildSeed*` functions produce valid `SessionSeed` objects
2. `computeGap` correctly identifies work needed at each lifecycle stage
3. `computeGap` for a `complete` session returns all-false gap
4. `computeGap` for a `transcript_ready` session returns needsParsing=true
5. Stale field detection works for backfill edge cases

---

### Task 8: reconcileSession() — Core Pipeline Rewrite

#### Description

Implement `reconcileSession()` — the single idempotent function that replaces the current `runSessionPipeline()`. It fetches the session, computes the gap, and closes it step by step. Safe to call from any context (hook, backfill, recovery, reparse).

This is the largest single task. The current `runSessionPipeline` is ~300 lines and `reconcileSession` will be similar but restructured around the gap pattern.

#### Files

- **Create**: `packages/core/src/reconcile/reconcile-session.ts` — main `reconcileSession(deps, sessionId)` function
- **Modify**: `packages/core/src/session-pipeline.ts` — deprecate `runSessionPipeline`, re-export `reconcileSession` as the primary entry point; update `createPipelineQueue` to call `reconcileSession`
- **Modify**: `packages/core/src/reconcile/index.ts` — export reconcileSession

#### Pipeline Steps (from design §5.3)

```
reconcileSession(deps, sessionId):
  Step 1: Fetch session row, compute gap via computeGap()
  Step 2: If needsTranscriptUpload → cannot proceed, return early
  Step 3: Transition to TRANSCRIPT_READY (if not already there or beyond)
  Step 4: Download and parse main transcript via parseTranscript()
  Step 5: Persist messages + content_blocks (delete-first for idempotency, batches of 500)
  Step 6: persistRelationships() — subagents, teams, teammates, skills, worktrees
  Step 7: Parse subagent transcripts (with subagent_id AND teammate_id on messages)
  Step 8: Fix stale timestamps (backfill started_at = ended_at bug)
  Step 9: Update stats, advance to PARSED
  Step 10: Generate session summary → advance to SUMMARIZED
  Step 11: Generate per-teammate summaries (non-fatal, best-effort)
  Step 12: Advance to COMPLETE
```

#### Key Differences from Current `runSessionPipeline`

1. Uses `computeGap()` to skip already-completed steps (idempotent re-entry)
2. Checks `transcript_ready` not `ended` as entry state
3. No `parse_status = 'parsing'` soft-claim (optimistic lock on lifecycle is sufficient)
4. Steps 6-7 include team detection and teammate_id assignment (new)
5. Steps 10-12 are three transitions instead of one (summary + teammate summaries + complete)
6. Never throws — all errors caught and returned in result

#### How to Test

```bash
cd packages/core && bun test reconcile 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write integration tests:
- Mock S3 + DB, call reconcileSession with a session at `transcript_ready`
- Verify it advances through all states to `complete`
- Call again on a `complete` session — should be a no-op
- Call on a `failed` session — should not advance (needs resetSessionForReparse first)

#### Success Criteria

1. `reconcileSession` advances a `transcript_ready` session to `complete`
2. Idempotent: calling on `complete` session is a no-op
3. Calling on `parsed` session skips parsing, does summary + complete
4. Calling on `summarized` session skips to complete
5. Failed steps set `last_error` and advance to `failed`
6. `createPipelineQueue` now calls `reconcileSession` instead of `runSessionPipeline`
7. Never throws — all errors in result object

---

### Task 9: Wire Transcript-Upload to TRANSCRIPT_READY

#### Description

Update the transcript upload route to transition sessions to `transcript_ready` and enqueue reconciliation.

#### Files

- **Modify**: `packages/server/src/routes/transcript-upload.ts`

#### Key Changes

Current flow: after S3 upload, checks `RETURNING lifecycle`. If `lifecycle === 'ended'`, triggers pipeline.

New flow:
1. After S3 upload and DB update (`transcript_s3_key`), attempt `transitionSession(sql, id, ['ended', 'detected'], 'transcript_ready')`
2. If transition succeeds, `enqueueReconcile(id)` (which is `pipelineDeps.enqueueSession`)
3. If transition fails (already at `transcript_ready` or beyond), still enqueue reconcile (idempotent)
4. Response: `202 { status: "uploaded", s3_key, reconcile_enqueued: boolean }`

#### How to Test

```bash
cd packages/server && bun test transcript-upload 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Uploading a transcript for an `ended` session transitions it to `transcript_ready`
2. Uploading a transcript for a `detected` session transitions it to `transcript_ready` (out-of-order)
3. Re-uploading for a `transcript_ready` session does not fail (idempotent)
4. Reconcile is enqueued after successful upload

---

### Task 10: Wire Session-End Handler to Simplified Logic

#### Description

Simplify `handleSessionEnd` to just transition to `ended` and conditionally enqueue reconcile. Remove the complex 3-way branching for backfill/out-of-order/normal paths.

#### Files

- **Modify**: `packages/core/src/handlers/session-end.ts`

#### Key Changes

Current handler has three branches on transition failure (session not found → synthetic insert, backfill override, other). The new handler:

1. `transitionSession(sql, id, ['detected'], 'ended', { ended_at, end_reason, duration_ms })`
2. On success: check if `transcript_s3_key` exists. If yes → `transitionSession(sql, id, 'ended', 'transcript_ready')` then `enqueueReconcile(id)`
3. On failure "session not found": create synthetic session at `ended` (same as current)
4. On failure other: log and return

The synthetic session insert no longer needs `parse_status` — just `lifecycle = 'ended'`.

#### How to Test

```bash
cd packages/core && bun test session-end 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Normal path: `detected → ended` works
2. Transcript already present: `ended → transcript_ready` triggered automatically
3. Out-of-order: synthetic session created at `ended`
4. No `parse_status` in any INSERT/UPDATE
5. No `capturing` state reference

---

### Task 11: Wire Recovery to reconcileSession

#### Description

Update recovery to use `reconcileSession` instead of direct pipeline calls.

#### Files

- **Modify**: `packages/core/src/session-recovery.ts` — `recoverStuckSessions` calls `enqueueReconcile` instead of `enqueueSession`/`runSessionPipeline`
- **Modify**: `packages/server/src/index.ts` — startup recovery uses reconcile

#### How to Test

```bash
cd packages/core && bun test session-recovery 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Stuck sessions (at `transcript_ready` for >10min) are enqueued for reconcile
2. Unsummarized sessions (at `parsed` with null summary) are reset and reconciled
3. No direct `runSessionPipeline` calls remain in recovery code

---

## Phase D: Backfill Rewrite

Tasks are sequential within this phase. Task 12 can start as soon as Phase C's Task 8 is done.

---

### Task 12: Backfill — Direct DB+S3 Writes (No Synthetic Events)

#### Description

Rewrite `ingestBackfillSessions` to write directly to the database and S3 instead of POSTing synthetic events to the server's HTTP API. This eliminates the fragile event-based ingestion path, the 15-retry transcript upload loop, and the self-HTTP rate limiting.

#### Files

- **Modify**: `packages/core/src/session-backfill.ts` — rewrite `ingestBackfillSessions` and `processSession`
- **Modify**: `packages/core/src/session-backfill.ts` — add `ensureSessionRow(sql, seed)`, `endSession(sql, seed)`, `uploadMainTranscript(s3, sql, seed)` helpers

#### Key Changes

Current `processSession`:
1. GET /api/sessions/:id (dedup check over HTTP)
2. POST /api/events/ingest (synthetic session.start)
3. POST /api/events/ingest (synthetic session.end)
4. POST /api/sessions/:id/transcript/upload (15 retries, race against event processing)

New `processSession`:
1. `SELECT id FROM sessions WHERE id = $1` (direct DB dedup check)
2. `ensureSessionRow(sql, seed)` → `INSERT INTO sessions (...) ON CONFLICT DO NOTHING`
3. For non-live sessions:
   - `endSession(sql, seed)` → `transitionSession(sql, id, ['detected'], 'ended', { ended_at, end_reason, duration_ms })`
   - `uploadMainTranscript(s3, sql, seed)` → S3 upload + `UPDATE sessions SET transcript_s3_key`
   - `transitionSession(sql, id, 'ended', 'transcript_ready')`
   - `enqueueReconcile(seed.ccSessionId)`
4. For live sessions: just ensure the row exists at `detected`

#### New Dependencies

`ingestBackfillSessions` needs `sql` (postgres client) and `s3` (S3 client) in its deps, not just an API base URL. This changes the `BackfillDeps` interface.

#### How to Test

```bash
cd packages/core && bun test backfill 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write integration test:
- Mock SQL + S3
- Call `processSession` with a mock DiscoveredSession
- Verify: INSERT into sessions, S3 upload called, lifecycle transitions correct
- Call again with same session → verify ON CONFLICT DO NOTHING (idempotent)

#### Success Criteria

1. No HTTP calls to self (`POST /api/events/ingest`)
2. No synthetic session.start/session.end event construction
3. Sessions created directly in DB with correct lifecycle
4. Transcripts uploaded directly to S3
5. Sessions enqueued for reconcile after upload
6. Live sessions only get a `detected` row (no end/upload)
7. Idempotent: re-running backfill for already-ingested sessions is a no-op

---

### Task 13: Backfill — Subagent Transcript Upload

#### Description

Wire subagent transcript upload into the backfill flow. Currently `ingestSubagentTranscripts` exists but isn't called from the CLI. With direct DB+S3 access, this becomes straightforward.

#### Files

- **Modify**: `packages/core/src/session-backfill.ts` — update `ingestSubagentTranscripts` to use direct S3 upload + `UPDATE subagents SET transcript_s3_key`
- **Modify**: `packages/core/src/session-backfill.ts` — call `ingestSubagentTranscripts` from `processSession` (after main transcript upload, before enqueue reconcile)

#### Key Changes

Current: `ingestSubagentTranscripts` POSTs to `/api/sessions/:parentId/transcript/upload?subagent_id=<agentId>`
New: Direct S3 upload to `buildSubagentTranscriptKey(canonicalId, sessionId, agentId)` + `UPDATE subagents SET transcript_s3_key` (if subagent row exists; if not, the reconciler will create it during `persistRelationships`)

#### How to Test

```bash
cd packages/core && bun test backfill 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Subagent transcripts uploaded to S3 during backfill
2. `subagents.transcript_s3_key` set for known subagents
3. For subagents not yet in DB (no hook data), transcripts are still uploaded to S3 at the correct key — the reconciler will pick them up

---

### Task 14: Backfill — Remove Synthetic Event Construction + Simplify CLI

#### Description

Clean up the backfill code: remove the synthetic event construction functions, HTTP-based ingestion helpers, and the 15-retry transcript upload loop. Update the CLI command to pass SQL+S3 deps instead of API URL.

#### Files

- **Modify**: `packages/core/src/session-backfill.ts` — remove `constructSessionStartEvent`, `constructSessionEndEvent`, HTTP POST helpers, rate limiting logic
- **Modify**: `packages/cli/src/commands/backfill.ts` — update deps construction to pass `sql` and `s3` instead of `apiBaseUrl`; simplify progress display (no longer need separate upload vs pipeline polling)
- **Modify**: `packages/core/src/session-backfill.ts` — simplify `waitForPipelineCompletion` to poll lifecycle directly from DB instead of HTTP batch-status

#### Key Changes to CLI

Current CLI backfill flow:
1. Scan → Show dry-run summary → Ingest via HTTP → Wait for pipeline via HTTP polling

New flow:
1. Scan → Show dry-run summary → Ingest via direct DB+S3 → Wait for reconcile completion via direct DB query

The dual progress bar (upload + pipeline) simplifies to a single progress indicator since upload and reconcile are now sequential per session.

#### How to Test

```bash
# Run backfill in dry-run mode
cd packages/cli && bun run fuel-code backfill --dry-run

# Run actual backfill
cd packages/cli && bun run fuel-code backfill

# Verify no HTTP calls to self
grep -r "events/ingest" packages/core/src/session-backfill.ts
# Should return 0 results
```

#### Success Criteria

1. No synthetic event construction code remains
2. No HTTP-to-self calls in backfill
3. No rate limiting logic against own server
4. No 15-retry transcript upload loop
5. CLI backfill works end-to-end with direct DB+S3
6. `--dry-run` still works
7. `--status` still works
8. State file (`backfill-state.json`) still tracks progress correctly

---

## Phase E: Team Detection

Tasks are mostly sequential. Task 15 can start as soon as Phase C's Task 8 is done.

---

### Task 15: Team Detection — Extract Team Intervals from Content Blocks

#### Description

Implement Phase A of team detection (from design §6.1). After the main transcript is parsed and content_blocks are persisted, scan for `TeamCreate` and `TeamDelete` tool_use blocks to build team intervals. Insert into the `teams` table.

#### Files

- **Modify**: `packages/core/src/session-pipeline.ts` (or `packages/core/src/reconcile/reconcile-session.ts`) — add team detection to `persistRelationships()` step
- **Create**: `packages/core/src/reconcile/team-detection.ts` — `extractTeamIntervals(contentBlocks): TeamInterval[]`, `persistTeams(sql, sessionId, intervals)`

#### Key Implementation

```typescript
interface TeamInterval {
  teamName: string;
  description: string | null;
  createdAt: string;     // from the TeamCreate tool_use block's timestamp
  endedAt: string | null; // from the paired TeamDelete, or null if still active
}

function extractTeamIntervals(contentBlocks: ParsedContentBlock[]): TeamInterval[] {
  const creates = contentBlocks.filter(b => b.block_type === 'tool_use' && b.tool_name === 'TeamCreate');
  const deletes = contentBlocks.filter(b => b.block_type === 'tool_use' && b.tool_name === 'TeamDelete');
  // Pair creates with deletes by ordinal order
  // Build intervals
}
```

#### How to Test

```bash
cd packages/core && bun test team-detection 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write unit tests:
- Content blocks with TeamCreate but no TeamDelete → open-ended interval
- Content blocks with TeamCreate + TeamDelete → closed interval
- Multiple teams created in same session
- TeamCreate → TeamDelete → TeamCreate (same name) → two intervals

#### Success Criteria

1. `extractTeamIntervals` correctly pairs creates with deletes
2. Teams inserted into `teams` table with correct `session_id`
3. Compound unique constraint `(session_id, team_name, created_at)` handles re-creation
4. Team intervals have correct timestamps
5. Non-team sessions produce zero team rows

---

### Task 16: Teammate Identification from Agent Tool Results

#### Description

Implement Phase B of team detection (from design §6.2). When the lead session spawns teammates via the `Agent` tool with `team_name`, the tool_result contains `teammate_spawned` status. Extract teammate names and create `teammates` rows.

#### Files

- **Modify**: `packages/core/src/reconcile/team-detection.ts` — add `extractTeammates(contentBlocks, teams): ParsedTeammate[]`, `persistTeammates(sql, sessionId, teammates)`
- **Modify**: `packages/core/src/transcript-parser.ts` — ensure `Agent` tool_result data (teammate_id, team_name, status) is preserved in content_blocks

#### Key Implementation

```typescript
interface ParsedTeammate {
  teamName: string;
  name: string;           // e.g., "alice"
  ccTeammateId: string;   // e.g., "alice@ping-pong"
  color: string | null;
}

function extractTeammates(contentBlocks: ParsedContentBlock[], teams: TeamRow[]): ParsedTeammate[] {
  return contentBlocks
    .filter(b => b.block_type === 'tool_result' && /* corresponding tool_use is 'Agent' */)
    .map(b => {
      const result = JSON.parse(b.result_text ?? '{}');
      if (result.status !== 'teammate_spawned') return null;
      return {
        teamName: result.team_name,
        name: result.teammate_id?.split('@')[0] ?? result.agent_id,
        ccTeammateId: result.teammate_id ?? result.agent_id,
        color: null,  // CC doesn't provide color in tool result
      };
    })
    .filter(Boolean)
    .filter((t, i, arr) => arr.findIndex(x => x.ccTeammateId === t.ccTeammateId) === i); // dedup
}
```

#### How to Test

```bash
cd packages/core && bun test team-detection 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Teammates extracted from Agent tool results with `teammate_spawned` status
2. Each unique teammate gets one row in `teammates` table
3. `teammate.team_id` correctly references the parent team
4. `teammate.cc_teammate_id` stores the full `"name@team"` identifier
5. Duplicate teammate spawns (same agent re-spawned) produce one row

---

### Task 17: Map Subagents to Teammates During Subagent Transcript Parsing

#### Description

Implement Phase C of team detection (from design §6.3). When parsing subagent transcripts, identify which teammate each subagent belongs to by examining `routing.sender` in SendMessage results and `teamName` fields.

#### Files

- **Modify**: `packages/core/src/session-pipeline.ts` (or reconcile-session.ts) — update `parseSubagentTranscripts` to set `teammate_id` on subagent rows
- **Create**: `packages/core/src/reconcile/teammate-mapping.ts` — `extractTeammateName(parseResult)`, `extractTeamName(parseResult)`, `resolveTeammateId(sql, sessionId, teammateName, teamName)`

#### Key Implementation

From design §6.4:
- Method 1: `routing.sender` from SendMessage tool results in the subagent's content_blocks
- Method 2: `teammate_id` attribute in `<teammate-message>` XML tags in user messages
- Team name: `teamName` field on JSONL lines

After resolving: `UPDATE subagents SET teammate_id = $1 WHERE id = $2`

#### How to Test

```bash
cd packages/core && bun test teammate-mapping 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Subagents with SendMessage routing.sender are mapped to correct teammate
2. Subagents with teammate-message XML tags are mapped correctly
3. `subagents.teammate_id` FK is set correctly
4. Non-team subagents have `teammate_id = NULL`
5. Fallback: if no teammate mapping found, subagent remains unmapped (not an error)

---

### Task 18: Set `teammate_id` on transcript_messages + content_blocks

#### Description

When persisting subagent transcript messages and content blocks, set the `teammate_id` FK alongside `subagent_id`. This enables the stitched message feed query.

#### Files

- **Modify**: `packages/core/src/session-pipeline.ts` — update `batchInsertMessages` and `batchInsertContentBlocks` to accept and insert `teammate_id`
- **Modify**: `packages/core/src/reconcile/reconcile-session.ts` — pass `teammateId` through subagent transcript parsing

#### Key Changes

Current batch insert for messages has columns like:
```sql
INSERT INTO transcript_messages (id, session_id, subagent_id, ...)
```

Add `teammate_id` to the column list:
```sql
INSERT INTO transcript_messages (id, session_id, subagent_id, teammate_id, ...)
```

For main transcript messages: both `subagent_id` and `teammate_id` are NULL.
For subagent messages: `subagent_id` is set; `teammate_id` is set if the subagent is team-affiliated.

#### How to Test

```bash
cd packages/core && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Verify FK integrity
psql $DATABASE_URL -c "
  SELECT COUNT(*) FROM transcript_messages
  WHERE teammate_id IS NOT NULL
    AND teammate_id NOT IN (SELECT id FROM teammates)
"
# Should return 0
```

#### Success Criteria

1. `teammate_id` column populated on transcript_messages for team subagent messages
2. `teammate_id` column populated on content_blocks for team subagent blocks
3. Main transcript messages have `teammate_id = NULL`
4. Non-team subagent messages have `teammate_id = NULL`
5. FK integrity maintained (no orphaned teammate_id values)

---

## Phase F: Summaries

Tasks 19 and 20 can run in parallel. Task 21 depends on both.

---

### Task 19: Session Summary Enhancement for Team Sessions

#### Description

Enhance `generateSummary` to include team context for sessions that have teammates. The session summary should mention the team structure and each teammate's work.

#### Files

- **Modify**: `packages/core/src/summary-generator.ts` — update `renderTranscriptForSummary` to include teammate context; update system prompt for team sessions

#### Key Changes

For team sessions (those with rows in `teammates` table):
1. Query `teammates` for the session
2. If teammates exist, append teammate context to the rendered transcript:
   ```
   ## Teammate work
   - alice: [teammate summary or "No summary yet"]
   - bob: [teammate summary or "No summary yet"]
   ```
3. Update system prompt to mention multi-agent coordination

For non-team sessions: no change to current behavior.

Note: teammate summaries are generated in Task 20 (parallel). The session summary runs first (Step 10), so teammate summaries won't be available yet. The session summary will show "No summary yet" for teammates on first pass. This is acceptable — the session summary focuses on the lead's orchestration.

#### How to Test

```bash
cd packages/core && bun test summary 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Non-team session summaries unchanged
2. Team session summaries mention teammate names
3. System prompt updated for team context
4. Handles edge case: team with 0 teammates (TeamCreate but no Agent spawns)

---

### Task 20: Per-Teammate Summary Generation

#### Description

After the session reaches PARSED, generate a 1-2 sentence summary for each teammate based on their stitched message feed.

#### Files

- **Create**: `packages/core/src/reconcile/teammate-summary.ts` — `generateTeammateSummaries(deps, sessionId)`
- **Modify**: `packages/core/src/summary-generator.ts` — add `generateTeammateSummary(messages, blocks, context)` variant

#### Key Implementation

```typescript
async function generateTeammateSummaries(deps: ReconcileDeps, sessionId: string) {
  const teammates = await deps.sql`SELECT * FROM teammates WHERE session_id = ${sessionId}`;

  for (const teammate of teammates) {
    const messages = await deps.sql`
      SELECT * FROM transcript_messages WHERE teammate_id = ${teammate.id} ORDER BY timestamp
    `;
    const blocks = await deps.sql`
      SELECT * FROM content_blocks WHERE teammate_id = ${teammate.id} ORDER BY block_order
    `;

    const rendered = renderTranscriptForSummary(messages, blocks);
    const result = await generateSummary(rendered, {
      systemPrompt: `Summarize this agent teammate's work in 1-2 sentences, past tense.
        This is "${teammate.name}", a member of team "${teamName}".
        Focus on what they accomplished, not how they communicated.`,
      maxTokens: 100,
    });

    if (result.success && result.summary) {
      await deps.sql`UPDATE teammates SET summary = ${result.summary} WHERE id = ${teammate.id}`;
    }
  }
}
```

#### How to Test

```bash
cd packages/core && bun test teammate-summary 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Each teammate gets a summary stored in `teammates.summary`
2. Summaries are 1-2 sentences, past tense
3. Failures are non-fatal — missing summaries don't block lifecycle
4. Sessions with no teammates skip this step entirely
5. Empty teammate message feeds produce a sensible summary (e.g., "No recorded activity")

---

### Task 21: Summary Pipeline Integration (SUMMARIZED → COMPLETE)

#### Description

Wire teammate summary generation into the reconcile pipeline between SUMMARIZED and COMPLETE states. Ensure the lifecycle advances correctly: `parsed → summarized → complete`.

#### Files

- **Modify**: `packages/core/src/reconcile/reconcile-session.ts` — add Step 11 (teammate summaries) between Step 10 (session summary) and Step 12 (advance to complete)

#### Key Changes

```typescript
// In reconcileSession:
// Step 10: Session summary → SUMMARIZED
await transitionSession(sql, id, 'parsed', 'summarized', { summary });

// Step 11: Per-teammate summaries (non-fatal)
try {
  await generateTeammateSummaries(deps, sessionId);
} catch (err) {
  logger.warn('Teammate summary generation failed', { sessionId, error: err });
  // Do NOT fail the session — this is best-effort
}

// Step 12: SUMMARIZED → COMPLETE
await transitionSession(sql, id, 'summarized', 'complete');
```

#### How to Test

```bash
cd packages/core && bun test reconcile 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Pipeline advances `parsed → summarized → complete` for all sessions
2. Teammate summary failure does not prevent `summarized → complete`
3. Non-team sessions skip Step 11 entirely (no teammates query)
4. `complete` is the terminal state (no further transitions possible)

---

## Phase G: API + TUI + CLI

Tasks 22–25 can run in parallel (they touch different files). Tasks 26–28 depend on earlier tasks in this phase.

---

### Task 22: API — Teammate Endpoints

#### Description

Add new API endpoints for teammate data. These power both the TUI and CLI.

#### Files

- **Modify**: `packages/server/src/routes/sessions.ts` — add `GET /sessions/:id/teammates` and `GET /sessions/:id/teammates/:teammateId/messages`

#### Endpoints

**`GET /sessions/:id/teammates`**
```sql
SELECT tm.*, t.team_name
FROM teammates tm
JOIN teams t ON t.id = tm.team_id
WHERE tm.session_id = $1
ORDER BY tm.created_at
```
Response: `{ teammates: Teammate[] }`

**`GET /sessions/:id/teammates/:teammateId/messages`**
```sql
SELECT msg.*, sa.agent_id, sa.agent_name,
  COALESCE(json_agg(
    json_build_object('id', cb.id, 'block_type', cb.block_type, 'content_text', cb.content_text,
      'thinking_text', cb.thinking_text, 'tool_name', cb.tool_name, 'tool_use_id', cb.tool_use_id,
      'tool_input', cb.tool_input, 'tool_result_id', cb.tool_result_id, 'is_error', cb.is_error,
      'result_text', cb.result_text, 'metadata', cb.metadata)
    ORDER BY cb.block_order
  ) FILTER (WHERE cb.id IS NOT NULL), '[]') AS content_blocks
FROM transcript_messages msg
JOIN subagents sa ON sa.id = msg.subagent_id
LEFT JOIN content_blocks cb ON cb.message_id = msg.id
WHERE msg.teammate_id = $1
GROUP BY msg.id, sa.agent_id, sa.agent_name
ORDER BY msg.timestamp
```
Response: `{ messages: TranscriptMessageWithBlocks[] }`

#### How to Test

```bash
cd packages/server && bun test sessions 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Manual test
curl http://localhost:3457/api/sessions/<session-with-team>/teammates | jq
curl http://localhost:3457/api/sessions/<session-id>/teammates/<teammate-id>/messages | jq
```

#### Success Criteria

1. `GET /teammates` returns all teammates for a session with team_name
2. `GET /teammates/:id/messages` returns stitched message feed with content_blocks
3. Each message includes the `agent_id` and `agent_name` of the emitting subagent
4. Messages ordered by timestamp
5. 404 for unknown session or teammate
6. Empty array for sessions with no teammates

---

### Task 23: API — Update Session Detail + List for New Lifecycle

#### Description

Update session API endpoints for new lifecycle values and teammate data.

#### Files

- **Modify**: `packages/server/src/routes/sessions.ts` — update `GET /sessions` and `GET /sessions/:id`
- **Modify**: `packages/server/src/routes/teams.ts` — update to query from new teams table schema

#### Key Changes

**`GET /sessions/:id`**:
- Add `teammates` array to response (JOIN through teams → teammates)
- Remove `team` field (was from old `team_name` column on sessions)
- Remove `parse_status` from response
- Add `last_error` to response

**`GET /sessions`**:
- Remove `?team` and `?has_team` filter params (or reimplement through teams table JOIN)
- Replace `has_team` with a subquery: `EXISTS (SELECT 1 FROM teams WHERE session_id = s.id)`
- Add `num_teammates` computed field (subquery count)

**`GET /teams`** and **`GET /teams/:name`**:
- Update to query from new schema (session-scoped teams, teammates as members instead of subagents)
- `GET /teams/:name` returns teammates (not subagents) as members

**`POST /sessions/batch-status`**:
- Return only `{ lifecycle }` per session (no `parse_status`)
- Recognize `complete` as terminal state

#### How to Test

```bash
cd packages/server && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. Session detail includes `teammates[]` array
2. No `parse_status` in any response
3. `lifecycle` values use new state names
4. Teams API returns session-scoped teams with teammate members
5. `batch-status` uses new terminal states

---

### Task 24: TUI — SubagentsPanel → Teammates Section

#### Description

Update the SubagentsPanel to show teammates when a session has team-affiliated subagents. Non-team subagents remain in a separate "Other Subagents" section.

#### Files

- **Modify**: `packages/cli/src/tui/components/SubagentsPanel.tsx` — split into Teammates section + Other Subagents section
- **Modify**: `packages/cli/src/tui/components/Sidebar.tsx` — pass teammates data to panel

#### Display Format (from design §9.2)

```
┌─ Teammates ──────────────────┐
│ ● alice (30 agents) ✓        │
│ ● bob (29 agents) ✓          │
│ ● player-a (11 agents) ✓    │
├─ Other Subagents ────────────┤
│ ● code-executor ✓            │
│ ● researcher ✓               │
│ ...8 more                    │
└──────────────────────────────┘
```

Each teammate row shows:
- Color indicator (from `teammate.color` or assigned based on index — different subagents within a teammate should receive distinct colors for visual distinction, as noted in 04-notes.md)
- Teammate name
- Count of component subagents (subagents with this `teammate_id`)
- Aggregate status icon

Non-team subagents (those without `teammate_id`) are shown in the "Other" section.

#### How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Visual test: open TUI for a session with teams
cd packages/cli && bun run fuel-code tui
```

#### Success Criteria

1. Teammates section appears when session has team data
2. Each teammate shows name, subagent count, status
3. Non-team subagents shown separately as "Other"
4. No teammates section for non-team sessions (backwards compatible)
5. Color indicators differentiate teammates visually

---

### Task 25: TUI — TeammateDetailView (Stitched Message Feed)

#### Description

Create a new view showing the stitched message feed for a single teammate, pulled from all subagents belonging to that teammate. This is the teammate equivalent of the transcript viewer.

#### Files

- **Create**: `packages/cli/src/tui/TeammateDetailView.tsx` — new view component
- **Create**: `packages/cli/src/tui/hooks/useTeammateDetail.ts` — data fetching hook

#### Display Format (from design §9.3)

```
┌─ Teammate: alice (Team: ping-pong) ─────────────────────┐
│ Summary: Played 15 rounds of ping-pong, escalating...   │
├──────────────────────────────────────────────────────────┤
│ [1] User (agent-a113f) 18:42:28                         │
│   ├─ <teammate-message from bob>: "Round 1..."          │
│   └─ Tool uses:                                         │
│       ├─ SendMessage → bob                              │
│       └─ Write: /test/round-1.txt                       │
│                                                          │
│ [2] Assistant (agent-a113f) 18:42:35                     │
│   ├─ "I'll respond with 42891..."                       │
│   └─ SendMessage → bob: "Round 1 response"              │
│                                                          │
│ Message 1 of 142  │  [b]ack  [j/k] scroll               │
└──────────────────────────────────────────────────────────┘
```

Each message shows the `agent_id` of the subagent that emitted it.

#### Key Implementation

```typescript
// useTeammateDetail hook
function useTeammateDetail(api: FuelApiClient, sessionId: string, teammateId: string) {
  // GET /api/sessions/:sessionId/teammates/:teammateId (for summary, team info)
  // GET /api/sessions/:sessionId/teammates/:teammateId/messages (stitched feed)
  return { teammate, messages, loading, error };
}
```

#### How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Visual test
cd packages/cli && bun run fuel-code tui
# Navigate to a session with teammates → click a teammate
```

#### Success Criteria

1. Shows teammate summary at top
2. Shows stitched message feed across all subagents for that teammate
3. Each message shows the source subagent's `agent_id`
4. Scrollable with j/k keys
5. Back button returns to session detail
6. Handles empty message feeds gracefully

---

### Task 26: TUI — Navigation State Machine Update

#### Description

Add `teammate-detail` to the navigation state machine in `App.tsx`.

#### Files

- **Modify**: `packages/cli/src/tui/App.tsx` — add `teammate-detail` view type and navigation handlers

#### Key Changes

```typescript
type View =
  | { name: "workspaces" }
  | { name: "sessions"; workspace: WorkspaceSummary }
  | { name: "session-detail"; sessionId: string; fromView: "sessions" | "team-detail"; workspace?: WorkspaceSummary; teamName?: string }
  | { name: "teams-list"; fromView: "workspaces" | "sessions"; workspace?: WorkspaceSummary }
  | { name: "team-detail"; teamName: string; fromView: "workspaces" | "sessions"; workspace?: WorkspaceSummary }
  | { name: "teammate-detail"; teammateId: string; sessionId: string; fromView: "session-detail"; workspace?: WorkspaceSummary }  // NEW
```

Navigation flow:
- From session-detail sidebar → click teammate → `teammate-detail`
- From teammate-detail → press `b` → back to `session-detail`

#### How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

#### Success Criteria

1. `teammate-detail` view renders `TeammateDetailView`
2. Navigation from session-detail to teammate-detail works
3. Back navigation from teammate-detail returns to session-detail
4. `fromView` context properly preserved through navigation chain

---

### Task 27: TUI — SessionsView Teammate Grouping

#### Description

Update the sessions list to show teammates grouped under sessions instead of the current team_name-based grouping.

#### Files

- **Modify**: `packages/cli/src/tui/SessionsView.tsx` — update `buildGroupedItems` and `buildDisplayList` to use teammates data
- **Modify**: `packages/cli/src/tui/components/TeamGroupRow.tsx` — update to show teammates (not team_name-grouped sessions)
- **Modify**: `packages/cli/src/tui/components/SessionRow.tsx` — add teammate annotation line

#### Display Changes

Current: sessions grouped by `team_name` (lead + members as separate session rows)
New: sessions with teammates show a teammate annotation line:

```
● 2h15m  Session abc123 (claude-opus-4.6)
│  "Implement agent teams support"
│  └─ Teammates: alice, bob, player-a, player-b
│  └─ Other: 10 utility agents
```

The `TeamGroupRow` component is updated to show teammate names instead of session members.

#### How to Test

```bash
cd packages/cli && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Visual test
cd packages/cli && bun run fuel-code tui
```

#### Success Criteria

1. Sessions with teammates show teammate names in annotation
2. Non-team subagents shown as "Other: N agents"
3. Sessions without teams display unchanged
4. Team group expansion shows teammate details
5. Session counts and stats accurate

---

### Task 28: CLI — `sessions` Command Teammate Display

#### Description

Update the non-TUI `fuel-code sessions` command to display teammate information. This was called out in 04-notes.md — the design only specifies TUI changes but the CLI sessions command should also reflect teammates.

#### Files

- **Modify**: `packages/cli/src/commands/sessions.ts` — update `formatSessionsTable` to show teammates instead of team_name-based grouping
- **Modify**: `packages/cli/src/commands/sessions.ts` — add `--teammates` flag or include by default

#### Display Changes

Current grouping uses `team_name` on sessions to build box-drawing groups:
```
┌─ Team: ping-pong ─
│ ★ lead  Session abc123  ...
│ member  Session def456  ...
└──
```

New grouping: sessions with teammates show a teammates annotation line (similar to TUI):
```
● Session abc123 (claude-opus-4.6)  2h15m  [complete]
  "Implement agent teams support"
  └─ Teammates: alice, bob, player-a, player-b
  └─ Other: 10 utility agents
```

The ROLE column changes:
- `★ lead` → shown when session has teams (it IS the lead)
- `member` → removed (teammates are shown inline, not as separate sessions)

#### How to Test

```bash
# Run sessions command
cd packages/cli && bun run fuel-code sessions --json | jq '.sessions[0].teammates'
cd packages/cli && bun run fuel-code sessions
```

#### Success Criteria

1. Sessions with teammates show teammate names
2. Non-team sessions display unchanged
3. `--json` output includes teammates array
4. No reference to old `team_name`/`team_role` columns
5. ROLE column updated for new team model

---

## Phase H: Cleanup + Tests

Tasks 29 and 30 can run in parallel. Task 31 depends on both.

---

### Task 29: Cleanup — Remove Dead Code (`capturing`, Old Pipeline Triggers)

#### Description

Remove all references to the `capturing` lifecycle state and consolidate pipeline trigger logic. Currently the pipeline can be triggered from 4 scattered locations — after this cleanup, all entry points funnel through `enqueueReconcile`.

#### Files

- **Modify**: `packages/core/src/session-lifecycle.ts` — remove `capturing` from any comments or documentation
- **Modify**: `packages/core/src/handlers/session-end.ts` — remove `capturing` from transition arrays
- **Modify**: `packages/core/src/session-pipeline.ts` — remove `runSessionPipeline` export (replaced by `reconcileSession`); keep `createPipelineQueue` but it now calls `reconcileSession`
- **Modify**: `packages/server/src/routes/transcript-upload.ts` — remove direct `runSessionPipeline` fallback (always use queue)
- **Modify**: `packages/server/src/routes/session-actions.ts` — reparse uses `enqueueReconcile`
- **Modify**: Various test files — remove `capturing` state references

#### How to Test

```bash
# Grep for dead references
grep -r "capturing" packages/ --include="*.ts" | grep -v node_modules | grep -v ".test."
grep -r "runSessionPipeline" packages/ --include="*.ts" | grep -v node_modules
# Both should return 0 results (except re-exports for backwards compat if needed)

bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

#### Success Criteria

1. No runtime references to `capturing` state
2. No direct `runSessionPipeline` calls (all go through `reconcileSession`)
3. Pipeline trigger consolidated to `enqueueReconcile` at all entry points
4. All tests pass

---

### Task 30: Cleanup — Remove `parse_status` References Everywhere

#### Description

Final sweep to remove all `parse_status` references from the codebase.

#### Files

- **Modify**: All files with `parse_status` references (grep to find)
- Expected locations: test files, API client types, TUI components that display status

#### How to Test

```bash
grep -r "parse_status" packages/ --include="*.ts" | grep -v node_modules
# Should return 0 results

grep -r "parse_error" packages/ --include="*.ts" | grep -v node_modules
# Should return 0 results (replaced by last_error)

bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

#### Success Criteria

1. Zero `parse_status` references in production code
2. Zero `parse_error` references in production code
3. `last_error` used consistently as the error field
4. All tests pass

---

### Task 31: E2E Tests + Backward Compatibility Verification

#### Description

Comprehensive integration testing of the full lifecycle, reconcile, backfill, and team detection pipeline.

#### Files

- **Create**: `packages/core/src/__tests__/lifecycle-e2e.test.ts` — full lifecycle state machine tests
- **Create**: `packages/core/src/__tests__/reconcile-e2e.test.ts` — reconcileSession end-to-end
- **Create**: `packages/core/src/__tests__/team-detection-e2e.test.ts` — team/teammate detection
- **Modify**: Existing test files — update for new lifecycle states

#### Test Scenarios

**Lifecycle Tests**:
1. Happy path: `detected → ended → transcript_ready → parsed → summarized → complete`
2. Out-of-order transcript: `detected → transcript_ready → ended → transcript_ready` (no-op second transition)
3. Failure and retry: `transcript_ready → failed → ended → transcript_ready → parsed → ... → complete`
4. Stuck session recovery: session at `transcript_ready` for >10min → recovered
5. Unsummarized recovery: session at `parsed` without summary → reset and reprocessed

**Reconcile Tests**:
6. Idempotent re-entry: call reconcileSession on `complete` session → no-op
7. Resume from parsed: call reconcileSession on `parsed` session → summary + complete
8. Resume from summarized: call reconcileSession on `summarized` session → complete
9. Concurrent reconcile: two calls on same `transcript_ready` session → only one wins

**Team Detection Tests**:
10. Session with TeamCreate → teams row created
11. Session with TeamCreate + Agent(team_name) → teammates rows created
12. Subagent mapped to teammate via SendMessage routing.sender
13. Session with no teams → zero team/teammate rows
14. Multiple teams in one session

**Backfill Tests**:
15. Direct DB backfill creates session → uploads transcript → reconcile advances to complete
16. Live session backfill: only creates `detected` row
17. Idempotent re-run: already-ingested sessions skipped

**API Tests**:
18. `GET /sessions/:id/teammates` returns correct data
19. `GET /sessions/:id/teammates/:id/messages` returns stitched feed
20. Session detail includes teammates array
21. `batch-status` returns only lifecycle (no parse_status)

#### How to Test

```bash
bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

#### Success Criteria

1. All lifecycle state transitions work correctly
2. reconcileSession is idempotent and handles all entry states
3. Team detection correctly identifies teams and teammates from transcripts
4. Backfill creates sessions without HTTP-to-self
5. API endpoints return correct data shapes
6. No backward compatibility regressions
7. All existing tests pass with updated lifecycle states

---

## Dependency Graph (Precise Edges)

- T1 → T4, T5 (migration needed for new lifecycle constraint)
- T2 → T4, T7 (types needed for implementation)
- T3 → T14 (batch-status changes needed for backfill polling)
- T4 → T5, T6, T7, T8, T9, T10, T11 (lifecycle rewrite is foundation)
- T5 → T9, T10, T11 (callers must be updated before wiring)
- T6 → T11 (recovery logic needed before wiring)
- T7 → T8 (computeGap needed for reconcile)
- T8 → T9, T10, T11, T12, T15 (reconcile is the core)
- T12 → T13 (main backfill before subagent)
- T13 → T14 (subagent upload before cleanup)
- T15 → T16 (teams before teammates)
- T16 → T17, T18 (teammates before mapping)
- T17, T18 → T19, T20 (mapping before summaries)
- T19, T20 → T21 (summaries before pipeline integration)
- T18 → T22 (teammate_id populated before API)
- T4 → T23 (lifecycle changes before API updates)
- T22 → T24, T25, T27, T28 (API before UI)
- T24, T25 → T26 (components before navigation)
- T26 → T27 (navigation before session grouping)
- T22, T23 → T28 (API before CLI)
- All G → T29, T30 (cleanup after all features)
- T29, T30 → T31 (tests after cleanup)

## Critical Path

```
T1 → T4 → T8 → T15 → T16 → T17 → T18 → T22 → T25 → T26 → T27 → T31
```

Estimated: 12 sequential steps. Phases A–C are the foundation. Phases D–E add data. Phase F adds intelligence. Phase G adds display. Phase H verifies.

## Parallelization Summary

| Phase | Parallel Tasks | Sequential Tasks |
|-------|---------------|-----------------|
| A | T1, T2, T3 (all parallel) | — |
| B | T4, T5 (parallel) | T6 (after T4) |
| C | T9, T10 (parallel after T8) | T7 → T8, T11 (after T6+T8) |
| D | — | T12 → T13 → T14 (sequential chain) |
| E | — | T15 → T16 → T17, T18 (mostly sequential) |
| F | T19, T20 (parallel) | T21 (after both) |
| G | T22, T23, T24, T25 (4-way parallel) | T26 (after T24+T25), T27 (after T26), T28 (after T22+T23) |
| H | T29, T30 (parallel) | T31 (after both) |
