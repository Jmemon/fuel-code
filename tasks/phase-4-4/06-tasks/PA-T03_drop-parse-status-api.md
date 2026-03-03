# Task 3: Drop `parse_status` from API Contracts + Batch-Status Endpoint

## Phase: A — Foundation
## Dependencies: None
## Parallelizable With: T1, T2

---

## Description

The `POST /api/sessions/batch-status` endpoint currently returns `{ lifecycle, parse_status }` per session. With `parse_status` gone, it should return only `{ lifecycle }`. The backfill CLI polls this endpoint — its polling logic needs to recognize the new terminal states (`complete` instead of `archived`, no `parse_status` to check).

Also update any Zod schemas or validation that reference `parse_status`.

## Files

- **Modify**: `packages/server/src/routes/sessions.ts` — update `batch-status` response shape, remove `parse_status` from SELECT queries
- **Modify**: `packages/core/src/session-backfill.ts` — update `waitForPipelineCompletion` terminal state check from `['parsed', 'summarized', 'archived', 'failed']` to `['complete', 'failed']`
- **Modify**: `packages/server/src/routes/sessions.ts` — remove `parse_status` from `GET /sessions` and `GET /sessions/:id` responses
- **Modify**: `packages/cli/src/tui/hooks/useSessionDetail.ts` — remove `parse_status` references in `isLive` derivation (use lifecycle only)

## How to Test

```bash
# Verify batch-status returns new shape
curl -X POST http://localhost:3457/api/sessions/batch-status \
  -H 'Content-Type: application/json' \
  -d '{"session_ids": ["test-id"]}'
# Should return { statuses: { "test-id": { lifecycle: "..." } }, not_found: ["test-id"] }

# Verify session list no longer returns parse_status
curl http://localhost:3457/api/sessions | jq '.sessions[0] | keys' | grep parse_status
# Should return nothing

bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "
```

## Success Criteria

1. `batch-status` returns `{ lifecycle }` only, no `parse_status`
2. Session list/detail endpoints no longer include `parse_status` or `parse_error`
3. Backfill `waitForPipelineCompletion` treats `complete` as terminal (not `archived`)
4. No runtime references to `parse_status` remain in server routes
