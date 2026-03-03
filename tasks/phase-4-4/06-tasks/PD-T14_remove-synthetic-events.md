# Task 14: Backfill — Remove Synthetic Event Construction + Simplify CLI

## Phase: D — Backfill Rewrite
## Dependencies: T12, T13
## Parallelizable With: None

---

## Description

Clean up the backfill code: remove the synthetic event construction functions, HTTP-based ingestion helpers, and the 15-retry transcript upload loop. Update the CLI command to pass SQL+S3 deps instead of API URL.

## Files

- **Modify**: `packages/core/src/session-backfill.ts` — remove `constructSessionStartEvent`, `constructSessionEndEvent`, HTTP POST helpers, rate limiting logic
- **Modify**: `packages/cli/src/commands/backfill.ts` — update deps construction to pass `sql` and `s3` instead of `apiBaseUrl`; simplify progress display (no longer need separate upload vs pipeline polling)
- **Modify**: `packages/core/src/session-backfill.ts` — simplify `waitForPipelineCompletion` to poll lifecycle directly from DB instead of HTTP batch-status

## Key Changes to CLI

Current CLI backfill flow:
1. Scan → Show dry-run summary → Ingest via HTTP → Wait for pipeline via HTTP polling

New flow:
1. Scan → Show dry-run summary → Ingest via direct DB+S3 → Wait for reconcile completion via direct DB query

The dual progress bar (upload + pipeline) simplifies to a single progress indicator since upload and reconcile are now sequential per session.

## How to Test

```bash
# Run backfill in dry-run mode
cd packages/cli && bun run fuel-code backfill --dry-run

# Run actual backfill
cd packages/cli && bun run fuel-code backfill

# Verify no HTTP calls to self
grep -r "events/ingest" packages/core/src/session-backfill.ts
# Should return 0 results
```

## Success Criteria

1. No synthetic event construction code remains
2. No HTTP-to-self calls in backfill
3. No rate limiting logic against own server
4. No 15-retry transcript upload loop
5. CLI backfill works end-to-end with direct DB+S3
6. `--dry-run` still works
7. `--status` still works
8. State file (`backfill-state.json`) still tracks progress correctly
