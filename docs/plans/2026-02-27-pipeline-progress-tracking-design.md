# Pipeline Progress Tracking for Backfill

**Date**: 2026-02-27
**Status**: Approved

## Problem

The backfill command's progress bar only tracks local event emission and transcript uploads. After it completes, the server-side pipeline (S3 download, parsing, summarization) runs asynchronously and takes substantially longer. This gives users a false impression that sessions are fully processed when they're not.

## Solution

Add a batch status endpoint and a CLI polling phase so the backfill command tracks server-side processing to completion.

## Design

### Server: `POST /api/sessions/batch-status`

Added to the existing sessions router (`packages/server/src/routes/sessions.ts`).

- **Request**: `{ session_ids: string[] }` (max 500 per request)
- **Response**: `{ statuses: { [sessionId]: { lifecycle: string, parse_status: string } }, not_found: string[] }`
- **Query**: `SELECT id, lifecycle, parse_status FROM sessions WHERE id = ANY($1)`
- **Validation**: Zod schema for request body, 400 on invalid input

### CLI: Pipeline Tracking Phase

After `ingestBackfillSessions()` completes, the backfill command enters a polling phase.

**New function** in `packages/core/src/session-backfill.ts`:
```typescript
waitForPipelineCompletion(sessionIds: string[], deps: PipelineWaitDeps): Promise<PipelineWaitResult>
```

- Polls `POST /api/sessions/batch-status` every 3 seconds
- Fires progress callback per poll for the CLI to render a second progress bar
- Terminal condition: all sessions have lifecycle in `{parsed, summarized, archived, failed}`
- Ctrl-C exits cleanly (server-side processing continues unaffected)
- Timeout: 10 minutes (configurable), then exits with a warning

**CLI output** (`packages/cli/src/commands/backfill.ts`):
```
Backfilling:  [████████████] 100/100  ✓
Processing:   [██████░░░░░░]  52/100  24 parsing, 24 queued
```

Final summary after processing completes:
```
Processing complete!
  Summarized: 96
  Parsed:      3
  Failed:      1
```

### Zod Schema

Added to `packages/shared/` — `batchStatusRequestSchema` for server-side validation.

## Files Changed

1. `packages/server/src/routes/sessions.ts` — Add `POST /sessions/batch-status` endpoint
2. `packages/shared/src/schemas.ts` — Add `batchStatusRequestSchema`
3. `packages/core/src/session-backfill.ts` — Add `waitForPipelineCompletion()` + types
4. `packages/cli/src/commands/backfill.ts` — Add pipeline tracking phase after ingestion

## What Doesn't Change

- Pipeline queue, consumer, lifecycle state machine
- Event transport
- Existing endpoints
- The ingestion progress bar
