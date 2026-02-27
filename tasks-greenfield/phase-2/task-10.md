# Task 10: Reparse Endpoint + Stuck Session Recovery

## Parallel Group: E

## Description

Build the `POST /api/sessions/:id/reparse` endpoint for re-triggering the parse+summarize pipeline, and the server-startup recovery mechanism for sessions stuck in intermediate pipeline states (server crashed mid-processing).

### Files to Create/Modify

**Add to `packages/server/src/routes/sessions.ts`** (or create a separate `packages/server/src/routes/session-actions.ts`):

**`POST /api/sessions/:id/reparse`**:

1. Get session: `SELECT id, lifecycle, parse_status, transcript_s3_key FROM sessions WHERE id = $1`.
2. If not found: 404.
3. If `transcript_s3_key` is null: `409 { error: "No transcript available. Cannot reparse." }`.
4. If `parse_status = 'parsing'`: `409 { error: "Session is currently being processed. Try again later." }`.
5. If lifecycle is `detected` or `capturing`: `409 { error: "Session has not ended yet." }`.
6. Call `resetSessionForReparse(sql, sessionId)` (from Task 4). This:
   - Deletes existing `transcript_messages` and `content_blocks` for the session.
   - Resets lifecycle to `ended`, clears stats, summary, parse_error.
   - Preserves `transcript_s3_key`.
7. If reset failed (session in wrong state — race condition): `409 { error: "Session cannot be reparsed from current state" }`.
8. Trigger pipeline asynchronously: `runSessionPipeline(pipelineDeps, sessionId).catch(err => ...)`.
9. Return `202 { message: "Reparse initiated", session_id: id, lifecycle: "ended" }`.

The caller can poll `GET /api/sessions/:id` to watch lifecycle progression: `ended → parsed → summarized`.

---

### Stuck Session Recovery

**`packages/core/src/session-recovery.ts`**:

```typescript
// Recover sessions stuck in intermediate pipeline states.
// Called on server startup to handle sessions where the server crashed mid-processing.
//
// Finds sessions where:
// - lifecycle = 'ended' AND parse_status IN ('pending', 'parsing') AND updated_at < threshold
// - These are sessions that entered the pipeline but never completed (crash, timeout, etc.)
//
// Does NOT touch:
// - Sessions in 'detected' or 'capturing' (may still be active)
// - Sessions in 'parsed', 'summarized', 'archived' (completed states)
// - Recently updated sessions (may be currently processing)

interface RecoveryResult {
  found: number;
  retried: number;
  errors: Array<{ sessionId: string; error: string }>;
}

async function recoverStuckSessions(
  sql: postgres.Sql,
  pipelineDeps: PipelineDeps,
  options?: {
    stuckThresholdMs?: number;  // default: 600_000 (10 minutes)
    maxRetries?: number;        // default: 10 (limit to prevent overwhelming on startup)
    dryRun?: boolean;           // if true, just report without retrying
  }
): Promise<RecoveryResult>
```

Implementation:
1. Query stuck sessions using `findStuckSessions(sql, stuckThresholdMs)` from Task 4.
2. Log: "Found {N} sessions needing recovery".
3. For each (up to `maxRetries`):
   - If session has `transcript_s3_key`: re-trigger `runSessionPipeline`.
   - If session has no `transcript_s3_key`: transition to `failed` with error "No transcript available for recovery".
   - On pipeline error: log and continue to next session.
4. Return `RecoveryResult`.

### Wire into Server Startup

**Modify `packages/server/src/index.ts`**:

```typescript
// After consumer starts, recover stuck sessions (delayed to let services stabilize)
setTimeout(async () => {
  try {
    const result = await recoverStuckSessions(sql, pipelineDeps);
    if (result.found > 0) {
      logger.info(result, "Session recovery completed on startup");
    }
  } catch (err) {
    logger.error({ error: err.message }, "Session recovery failed on startup");
  }
}, 5000);
```

### Tests

**`packages/server/src/routes/__tests__/session-reparse.test.ts`** (requires Postgres + S3):

1. Reparse a `parsed` session: resets to `ended`, clears stats, deletes transcript_messages/content_blocks, triggers pipeline. Eventually reaches `summarized`.
2. Reparse a `failed` session: resets to `ended`, clears parse_error, triggers pipeline.
3. Reparse a `summarized` session: resets, re-processes. New transcript data has fresh IDs.
4. Reparse a `detected` session: 409.
5. Reparse a `capturing` session: 409.
6. Reparse a session with no `transcript_s3_key`: 409.
7. Reparse a session currently being processed (`parse_status = 'parsing'`): 409.
8. Reparse non-existent session: 404.
9. After reparse completes, session has new stats (may differ from original if parser changed).
10. Concurrent reparse on same session: only one succeeds (state machine guard).

**`packages/core/src/__tests__/session-recovery.test.ts`** (requires Postgres):

1. Create a session stuck at `ended` with `parse_status = 'parsing'` and `updated_at` > 10 minutes ago. Recovery finds and retries it.
2. Create a session at `ended` with `parse_status = 'pending'` and old `updated_at`. Recovery retries it.
3. Session stuck for only 1 minute (below threshold): NOT recovered.
4. Session in `parsed` lifecycle: NOT recovered (already completed parsing).
5. `dryRun = true`: reports stuck sessions without retrying.
6. Session with no `transcript_s3_key`: recovery transitions to `failed` with error.

## Relevant Files
- `packages/server/src/routes/sessions.ts` (modify — add reparse endpoint) OR `packages/server/src/routes/session-actions.ts` (create)
- `packages/core/src/session-recovery.ts` (create)
- `packages/server/src/index.ts` (modify — add startup recovery)
- `packages/server/src/routes/__tests__/session-reparse.test.ts` (create)
- `packages/core/src/__tests__/session-recovery.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export recovery)

## Success Criteria
1. `POST /api/sessions/:id/reparse` returns 202 and initiates re-parsing.
2. After reparse, session progresses through `ended → parsed → summarized`.
3. Old `transcript_messages` and `content_blocks` are deleted before new data is inserted.
4. Reparse preserves `transcript_s3_key` (raw JSONL stays in S3).
5. Reparse of `detected`/`capturing` session returns 409.
6. Reparse of session without S3 transcript returns 409.
7. Reparse of session currently processing returns 409.
8. Concurrent reparse is safe (only one succeeds via state machine).
9. Server startup recovery finds sessions stuck > 10 minutes.
10. Recovery does not touch sessions in terminal or active states.
11. Recovery with `dryRun = true` reports without modifying data.
12. Recovery processes are limited (`maxRetries`) to avoid overwhelming on restart.
