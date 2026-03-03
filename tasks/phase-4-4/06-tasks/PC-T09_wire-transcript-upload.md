# Task 9: Wire Transcript-Upload to TRANSCRIPT_READY

## Phase: C — Reconcile Pattern
## Dependencies: T4, T8
## Parallelizable With: T10

---

## Description

Update the transcript upload route to transition sessions to `transcript_ready` and enqueue reconciliation.

## Files

- **Modify**: `packages/server/src/routes/transcript-upload.ts`

## Key Changes

Current flow: after S3 upload, checks `RETURNING lifecycle`. If `lifecycle === 'ended'`, triggers pipeline.

New flow:
1. After S3 upload and DB update (`transcript_s3_key`), attempt `transitionSession(sql, id, ['ended', 'detected'], 'transcript_ready')`
2. If transition succeeds, `enqueueReconcile(id)` (which is `pipelineDeps.enqueueSession`)
3. If transition fails (already at `transcript_ready` or beyond), still enqueue reconcile (idempotent)
4. Response: `202 { status: "uploaded", s3_key, reconcile_enqueued: boolean }`

## How to Test

```bash
cd packages/server && bun test transcript-upload 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Uploading a transcript for an `ended` session transitions it to `transcript_ready`
2. Uploading a transcript for a `detected` session transitions it to `transcript_ready` (out-of-order)
3. Re-uploading for a `transcript_ready` session does not fail (idempotent)
4. Reconcile is enqueued after successful upload
