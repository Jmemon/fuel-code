# Task 11: Wire Recovery to reconcileSession

## Phase: C — Reconcile Pattern
## Dependencies: T6, T8
## Parallelizable With: None

---

## Description

Update recovery to use `reconcileSession` instead of direct pipeline calls.

## Files

- **Modify**: `packages/core/src/session-recovery.ts` — `recoverStuckSessions` calls `enqueueReconcile` instead of `enqueueSession`/`runSessionPipeline`
- **Modify**: `packages/server/src/index.ts` — startup recovery uses reconcile

## How to Test

```bash
cd packages/core && bun test session-recovery 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Stuck sessions (at `transcript_ready` for >10min) are enqueued for reconcile
2. Unsummarized sessions (at `parsed` with null summary) are reset and reconciled
3. No direct `runSessionPipeline` calls remain in recovery code
