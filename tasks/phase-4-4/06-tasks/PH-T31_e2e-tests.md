# Task 31: E2E Tests + Backward Compatibility Verification

## Phase: H — Cleanup + Tests
## Dependencies: T29, T30
## Parallelizable With: None

---

## Description

Comprehensive integration testing of the full lifecycle, reconcile, backfill, and team detection pipeline.

## Files

- **Create**: `packages/core/src/__tests__/lifecycle-e2e.test.ts` — full lifecycle state machine tests
- **Create**: `packages/core/src/__tests__/reconcile-e2e.test.ts` — reconcileSession end-to-end
- **Create**: `packages/core/src/__tests__/team-detection-e2e.test.ts` — team/teammate detection
- **Modify**: Existing test files — update for new lifecycle states

## Test Scenarios

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

## How to Test

```bash
bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

## Success Criteria

1. All lifecycle state transitions work correctly
2. reconcileSession is idempotent and handles all entry states
3. Team detection correctly identifies teams and teammates from transcripts
4. Backfill creates sessions without HTTP-to-self
5. API endpoints return correct data shapes
6. No backward compatibility regressions
7. All existing tests pass with updated lifecycle states
