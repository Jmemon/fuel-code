# Task 4: Session Lifecycle State Machine Rewrite

## Phase: B — Lifecycle State Machine
## Dependencies: T1, T2
## Parallelizable With: T5

---

## Description

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

## Files

- **Modify**: `packages/core/src/session-lifecycle.ts` — full rewrite of TRANSITIONS map, transitionSession, failSession, resetSessionForReparse, findStuckSessions, getSessionState
- **Modify**: `packages/core/src/session-lifecycle.test.ts` (if exists) — update tests for new states

## Current → New Transition Map

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

## Key Implementation Details

- `transitionSession` currently builds SET clauses including `parse_status` — remove all `parse_status` references
- `UpdatableSessionFields` currently has `parse_status`, `parse_error` — replace with `last_error`
- `failSession` currently uses `sql.unsafe` to set both `lifecycle='failed'` AND `parse_status='failed'` — simplify to only set `lifecycle='failed'` and `last_error`
- `resetSessionForReparse` currently resets `parse_status='pending'` — remove that, just reset `lifecycle='ended'` and `last_error=null`
- `findStuckSessions` currently checks `lifecycle IN ('ended', 'parsed') AND parse_status IN ('pending', 'parsing')` — simplify to `lifecycle = 'transcript_ready' AND updated_at < threshold`
- `getSessionState` currently returns `{ lifecycle, parse_status, parse_error }` — return `{ lifecycle, last_error }` only

## How to Test

```bash
cd packages/core && bun test session-lifecycle 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"

# Manual validation:
# - transitionSession('detected', 'transcript_ready') succeeds
# - transitionSession('detected', 'capturing') fails (state removed)
# - transitionSession('failed', 'ended') succeeds (reset path)
# - failSession sets last_error, not parse_error
# - findStuckSessions only looks at transcript_ready
```

## Success Criteria

1. `TRANSITIONS` map matches the design exactly
2. `transitionSession` no longer references `parse_status`
3. `failSession` sets `last_error` instead of `parse_error`/`parse_status`
4. `resetSessionForReparse` moves to `ended` without touching `parse_status`
5. `findStuckSessions` queries `lifecycle = 'transcript_ready'` only
6. `getSessionState` returns `{ lifecycle, last_error }`
7. All existing lifecycle tests pass (updated for new states)
8. `failed → ended` transition works (for retry flow)
