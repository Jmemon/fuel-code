# Task 5: Transition Callers — Update All Handlers

## Phase: B — Lifecycle State Machine
## Dependencies: T1, T2
## Parallelizable With: T4

---

## Description

Every call site that invokes `transitionSession()` or checks lifecycle/parse_status values needs updating for the new state names. This is a mechanical but pervasive change.

## Files

- **Modify**: `packages/core/src/handlers/session-start.ts` — no `parse_status` default needed (column gone)
- **Modify**: `packages/core/src/handlers/session-end.ts` — transition from `['detected', 'capturing']` → change to `['detected']` (no `capturing`); the synthetic session insert uses `lifecycle = 'ended'` (unchanged); remove any `parse_status` from insert
- **Modify**: `packages/core/src/session-pipeline.ts` — step 1 checks `lifecycle === 'ended'` → change to `lifecycle === 'transcript_ready'`; step 2 removes `parse_status = 'parsing'` update; step 8 transition `ended → parsed` → change to `transcript_ready → parsed`; step 9 transition `parsed → summarized` (unchanged); add new step: `summarized → complete`; remove `parse_status: 'completed'` from step 8 updates
- **Modify**: `packages/server/src/routes/transcript-upload.ts` — after S3 upload, transition to `transcript_ready` instead of just checking `lifecycle === 'ended'`
- **Modify**: `packages/server/src/routes/session-actions.ts` — reparse endpoint: update allowed source states
- **Modify**: `packages/core/src/session-recovery.ts` — update `recoverStuckSessions` and `recoverUnsummarizedSessions` for new states

## Specific Changes Per File

**session-end.ts**: The handler currently transitions from `["detected", "capturing"]` to `"ended"`. Remove `"capturing"` from the array. The synthetic session insert for out-of-order events currently sets `parse_status` — remove that column from the INSERT. The backfill override UPDATE currently sets `parse_status` — remove.

**session-pipeline.ts**: The pipeline currently:
- Step 1: checks `lifecycle === 'ended'` → change to `lifecycle === 'transcript_ready'`
- Step 2: `UPDATE sessions SET parse_status = 'parsing'` → remove entirely (no soft-claim needed; the `transcript_ready → parsed` optimistic lock serves this purpose)
- Step 8: `transitionSession(sql, id, 'ended', 'parsed', { parse_status: 'completed', ... })` → `transitionSession(sql, id, 'transcript_ready', 'parsed', { ... })`
- After step 9 summary: add `transitionSession(sql, id, 'summarized', 'complete')` — new terminal transition
- When summary is disabled/empty: `transitionSession(sql, id, 'parsed', 'summarized', { summary: null })` then immediately `transitionSession(sql, id, 'summarized', 'complete')`

**transcript-upload.ts**: After S3 upload and DB update, currently checks `lifecycle === 'ended'` to trigger pipeline. New logic: attempt `transitionSession(sql, id, ['ended', 'detected'], 'transcript_ready')` then trigger pipeline if transition succeeded.

**session-recovery.ts**: `recoverStuckSessions` currently queries `lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing')`. Change to: `lifecycle = 'transcript_ready' AND updated_at < threshold`. `recoverUnsummarizedSessions` currently checks `lifecycle = 'parsed' AND parse_status = 'completed' AND summary IS NULL`. Change to: `lifecycle = 'parsed' AND summary IS NULL AND updated_at < threshold`.

## How to Test

```bash
cd packages/core && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
cd packages/server && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Grep for any remaining parse_status references:
grep -r "parse_status" packages/core/src/ packages/server/src/ --include="*.ts" | grep -v node_modules | grep -v ".test."
# Should return 0 results (except possibly test files being updated separately)
```

## Success Criteria

1. No runtime references to `parse_status` in handlers or pipeline
2. Session-end handler transitions from `['detected']` only (no `capturing`)
3. Pipeline checks `transcript_ready` not `ended` as entry state
4. Pipeline advances through `transcript_ready → parsed → summarized → complete`
5. Transcript upload route transitions to `transcript_ready`
6. All handler tests pass with new lifecycle states
