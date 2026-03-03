# Task 12: Backfill — Direct DB+S3 Writes (No Synthetic Events)

## Phase: D — Backfill Rewrite
## Dependencies: T7, T8
## Parallelizable With: None (T13 depends on this)

---

## Description

Rewrite `ingestBackfillSessions` to write directly to the database and S3 instead of POSTing synthetic events to the server's HTTP API. This eliminates the fragile event-based ingestion path, the 15-retry transcript upload loop, and the self-HTTP rate limiting.

## Files

- **Modify**: `packages/core/src/session-backfill.ts` — rewrite `ingestBackfillSessions` and `processSession`
- **Modify**: `packages/core/src/session-backfill.ts` — add `ensureSessionRow(sql, seed)`, `endSession(sql, seed)`, `uploadMainTranscript(s3, sql, seed)` helpers

## Key Changes

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

## New Dependencies

`ingestBackfillSessions` needs `sql` (postgres client) and `s3` (S3 client) in its deps, not just an API base URL. This changes the `BackfillDeps` interface.

## How to Test

```bash
cd packages/core && bun test backfill 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

Write integration test:
- Mock SQL + S3
- Call `processSession` with a mock DiscoveredSession
- Verify: INSERT into sessions, S3 upload called, lifecycle transitions correct
- Call again with same session → verify ON CONFLICT DO NOTHING (idempotent)

## Success Criteria

1. No HTTP calls to self (`POST /api/events/ingest`)
2. No synthetic session.start/session.end event construction
3. Sessions created directly in DB with correct lifecycle
4. Transcripts uploaded directly to S3
5. Sessions enqueued for reconcile after upload
6. Live sessions only get a `detected` row (no end/upload)
7. Idempotent: re-running backfill for already-ingested sessions is a no-op
