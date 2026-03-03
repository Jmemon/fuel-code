# Task 13: Backfill — Subagent Transcript Upload

## Phase: D — Backfill Rewrite
## Dependencies: T12
## Parallelizable With: None

---

## Description

Wire subagent transcript upload into the backfill flow. Currently `ingestSubagentTranscripts` exists but isn't called from the CLI. With direct DB+S3 access, this becomes straightforward.

## Files

- **Modify**: `packages/core/src/session-backfill.ts` — update `ingestSubagentTranscripts` to use direct S3 upload + `UPDATE subagents SET transcript_s3_key`
- **Modify**: `packages/core/src/session-backfill.ts` — call `ingestSubagentTranscripts` from `processSession` (after main transcript upload, before enqueue reconcile)

## Key Changes

Current: `ingestSubagentTranscripts` POSTs to `/api/sessions/:parentId/transcript/upload?subagent_id=<agentId>`
New: Direct S3 upload to `buildSubagentTranscriptKey(canonicalId, sessionId, agentId)` + `UPDATE subagents SET transcript_s3_key` (if subagent row exists; if not, the reconciler will create it during `persistRelationships`)

## How to Test

```bash
cd packages/core && bun test backfill 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Subagent transcripts uploaded to S3 during backfill
2. `subagents.transcript_s3_key` set for known subagents
3. For subagents not yet in DB (no hook data), transcripts are still uploaded to S3 at the correct key — the reconciler will pick them up
