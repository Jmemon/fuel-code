# Task 21: Summary Pipeline Integration (SUMMARIZED → COMPLETE)

## Phase: F — Summaries
## Dependencies: T19, T20
## Parallelizable With: None

---

## Description

Wire teammate summary generation into the reconcile pipeline between SUMMARIZED and COMPLETE states. Ensure the lifecycle advances correctly: `parsed → summarized → complete`.

## Files

- **Modify**: `packages/core/src/reconcile/reconcile-session.ts` — add Step 11 (teammate summaries) between Step 10 (session summary) and Step 12 (advance to complete)

## Key Changes

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

## How to Test

```bash
cd packages/core && bun test reconcile 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Pipeline advances `parsed → summarized → complete` for all sessions
2. Teammate summary failure does not prevent `summarized → complete`
3. Non-team sessions skip Step 11 entirely (no teammates query)
4. `complete` is the terminal state (no further transitions possible)
