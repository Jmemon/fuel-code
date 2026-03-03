# Task 10: Wire Session-End Handler to Simplified Logic

## Phase: C — Reconcile Pattern
## Dependencies: T4, T8
## Parallelizable With: T9

---

## Description

Simplify `handleSessionEnd` to just transition to `ended` and conditionally enqueue reconcile. Remove the complex 3-way branching for backfill/out-of-order/normal paths.

## Files

- **Modify**: `packages/core/src/handlers/session-end.ts`

## Key Changes

Current handler has three branches on transition failure (session not found → synthetic insert, backfill override, other). The new handler:

1. `transitionSession(sql, id, ['detected'], 'ended', { ended_at, end_reason, duration_ms })`
2. On success: check if `transcript_s3_key` exists. If yes → `transitionSession(sql, id, 'ended', 'transcript_ready')` then `enqueueReconcile(id)`
3. On failure "session not found": create synthetic session at `ended` (same as current)
4. On failure other: log and return

The synthetic session insert no longer needs `parse_status` — just `lifecycle = 'ended'`.

## How to Test

```bash
cd packages/core && bun test session-end 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Normal path: `detected → ended` works
2. Transcript already present: `ended → transcript_ready` triggered automatically
3. Out-of-order: synthetic session created at `ended`
4. No `parse_status` in any INSERT/UPDATE
5. No `capturing` state reference
