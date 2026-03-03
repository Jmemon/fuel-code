# Task 8: reconcileSession() — Core Pipeline Rewrite

## Phase: C — Reconcile Pattern
## Dependencies: T4, T7
## Parallelizable With: None (T9, T10, T11 depend on this)

---

## Description

Implement `reconcileSession()` — the single idempotent function that replaces the current `runSessionPipeline()`. It fetches the session, computes the gap, and closes it step by step. Safe to call from any context (hook, backfill, recovery, reparse).

This is the largest single task. The current `runSessionPipeline` is ~300 lines and `reconcileSession` will be similar but restructured around the gap pattern.

## Files

- **Create**: `packages/core/src/reconcile/reconcile-session.ts` — main `reconcileSession(deps, sessionId)` function
- **Modify**: `packages/core/src/session-pipeline.ts` — deprecate `runSessionPipeline`, re-export `reconcileSession` as the primary entry point; update `createPipelineQueue` to call `reconcileSession`
- **Modify**: `packages/core/src/reconcile/index.ts` — export reconcileSession

## Pipeline Steps (from design §5.3)

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

## Key Differences from Current `runSessionPipeline`

1. Uses `computeGap()` to skip already-completed steps (idempotent re-entry)
2. Checks `transcript_ready` not `ended` as entry state
3. No `parse_status = 'parsing'` soft-claim (optimistic lock on lifecycle is sufficient)
4. Steps 6-7 include team detection and teammate_id assignment (new)
5. Steps 10-12 are three transitions instead of one (summary + teammate summaries + complete)
6. Never throws — all errors caught and returned in result

## How to Test

```bash
cd packages/core && bun test reconcile 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write integration tests:
- Mock S3 + DB, call reconcileSession with a session at `transcript_ready`
- Verify it advances through all states to `complete`
- Call again on a `complete` session — should be a no-op
- Call on a `failed` session — should not advance (needs resetSessionForReparse first)

## Success Criteria

1. `reconcileSession` advances a `transcript_ready` session to `complete`
2. Idempotent: calling on `complete` session is a no-op
3. Calling on `parsed` session skips parsing, does summary + complete
4. Calling on `summarized` session skips to complete
5. Failed steps set `last_error` and advance to `failed`
6. `createPipelineQueue` now calls `reconcileSession` instead of `runSessionPipeline`
7. Never throws — all errors in result object
