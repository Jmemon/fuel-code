# Phase 2 Implementation Review

## Overview

Phase 2 ("Session Post-Processing Pipeline") was implemented across 12 tasks in 13 commits (03cb16c..f8b4241). The phase turns sessions from simple detected/ended records into fully parsed, searchable, summarized objects with structured transcript data, LLM-generated summaries, and query APIs.

---

## Task-by-Task Assessment

### Task 1: Database Migration (002_transcript_tables.sql) — PASS

- **Spec**: Create `transcript_messages` and `content_blocks` tables with indexes + recovery index on sessions.
- **Implementation**: All columns present. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` for idempotency. CASCADE deletes wired correctly (session -> transcript_messages -> content_blocks). 6 content indexes + 1 recovery index on sessions.
- **Verdict**: Complete and correct.

### Task 2: Shared Transcript Types + S3 Key Utilities — PASS

- **Spec**: transcript.ts types, s3-keys.ts utilities, session-compact.ts Zod schema, register in payload registry.
- **Implementation**: All types defined (RawTranscriptLine, TokenUsage, RawContentBlock, TranscriptMessage, ParsedContentBlock, ParseResult, TranscriptStats). S3 key utilities with tests. session.compact schema registered. Barrel exports updated.
- **Verdict**: Complete. 62 + 86 test assertions.

### Task 3: S3 Client Abstraction — PASS

- **Spec**: FuelCodeS3Client with upload, uploadFile, download, downloadStream, presignedUrl, headObject, delete, healthCheck. Retries, error handling, config from env.
- **Implementation**: Full interface implemented with StorageError wrapping, 3-retry via SDK config, presigned URL generation, streaming support. 347-line test file.
- **Verdict**: Complete and well-tested.

### Task 4: Session Lifecycle State Machine — PASS

- **Spec**: TRANSITIONS map, transitionSession with optimistic locking, failSession, resetSessionForReparse, getSessionState, findStuckSessions.
- **Implementation**: All functions exported. Optimistic locking via `WHERE lifecycle = ANY($from)`. Dynamic SET clause construction via `sql.unsafe`. `resetSessionForReparse` runs in a transaction (delete content_blocks, delete transcript_messages, reset session columns).
- **Verdict**: Complete. 603-line test file with DB integration tests.

### Task 5: Transcript Parser — PASS

- **Spec**: Pure function (string/stream -> ParseResult), assistant line grouping by message.id, token/cost extraction, content block classification, stats aggregation.
- **Implementation**: 797-line parser with all specified features. Handles empty input, malformed JSON, oversized lines, truncation. Cost computation matches spec rates ($3/MTok input, $15/MTok output, etc.).
- **Verdict**: Complete. 848-line test file, 26 tests.

### Task 6: Summary Generator — PASS

- **Spec**: Render condensed transcript, call Claude Sonnet, 1-3 sentence past-tense summary, truncation, never throws.
- **Implementation**: 373-line module with configurable prompt, 8000-char truncation (3000 head + 3000 tail), timeout handling, rate limit detection. `extractInitialPrompt` helper included.
- **Verdict**: Complete. 476-line test file.

### Task 7: Session Pipeline Orchestrator — PASS with ISSUES

- **Spec**: `runSessionPipeline` orchestrator, `createPipelineQueue` bounded queue (3 concurrent, 50 max depth), upgrade session.end handler, wire into server startup.
- **Implementation**: `runSessionPipeline` fully implemented (download -> parse -> persist -> transition -> summarize -> backup). `createPipelineQueue` defined with all queue semantics. Session.end handler upgraded with lifecycle transitions and pipeline trigger.
- **Issues**: See [Issue #1: Pipeline queue created but never used](#issue-1-pipeline-queue-unused).

### Task 8: Transcript Upload Endpoint + Hook Modifications — PASS with ISSUES

- **Spec**: POST endpoint accepting up to 200MB, "streams directly to S3 (NO express.raw() buffering)", CLI command, hook integration.
- **Implementation**: Endpoint created, CLI command works, hook spawns background upload.
- **Issues**: See [Issue #2: Upload uses express.raw() buffering](#issue-2-upload-buffering).

### Task 9: Session API Endpoints — PASS

- **Spec**: 7 REST endpoints with cursor-based pagination, Zod validation, filters.
- **Implementation**: All 7 endpoints implemented. Cursor encoding/decoding correct (base64 JSON `{s, i}`). Dynamic WHERE clause construction using postgres.js fragments. Git activity stub returns `[]` (correct — Phase 3 fills it in).
- **Verdict**: Complete. 724-line test file.

### Task 10: Reparse Endpoint + Stuck Session Recovery — PASS

- **Spec**: POST /api/sessions/:id/reparse with 5 guard checks, `recoverStuckSessions` utility, wire into startup with 5-second delay.
- **Implementation**: All guards implemented (404, 409 no transcript, 409 parsing, 409 not ended, 409 reset failed). Recovery wired into server startup via `setTimeout(5000)`.
- **Verdict**: Complete. 240 + 258 test lines.

### Task 11: Historical Session Backfill Scanner + CLI — FAIL (critical ordering bug)

- **Spec**: Scan ~/.claude/projects/ for JSONL files, deduplicate, upload transcripts, emit synthetic events, batched processing.
- **Implementation**: Scanner, ingestion, state persistence, CLI with --dry-run/--status/--force all implemented. Auto-trigger from init and hooks install.
- **Issues**: See [Issue #3: Backfill ordering bug — transcript upload before session exists](#issue-3-backfill-ordering).

### Task 12: Phase 2 E2E Integration Tests — PASS

- **Spec**: 11 test scenarios covering full pipeline, lifecycle, reparse, pagination, filtering, tags, backfill.
- **Implementation**: 1127-line test file, LocalStack in docker-compose.test.yml, 10-line JSONL fixture.
- **Note**: The backfill E2E test only covers dry-run mode, so it does NOT catch Issue #3.

---

## Issues Found

### Issue #1: Pipeline Queue Unused {#issue-1-pipeline-queue-unused}

**Severity**: Medium
**Location**: `packages/core/src/session-pipeline.ts`, `packages/server/src/index.ts`

The spec explicitly requires a bounded async work queue with concurrency limit of 3 and overflow protection at 50 pending items. `createPipelineQueue()` is implemented and exported, but **never instantiated or used**. Instead, `runSessionPipeline()` is called directly as fire-and-forget in three places:

1. `transcript-upload.ts:133` — `runSessionPipeline(pipelineDeps, sessionId).catch(...)`
2. `session-actions.ts:106` — `runSessionPipeline(pipelineDeps, sessionId).catch(...)`
3. `session-end.ts:70` — `runSessionPipeline(ctx.pipelineDeps, ccSessionId).catch(...)`
4. `session-recovery.ts:127` — `runSessionPipeline(pipelineDeps, session.id).catch(...)`

**Impact**: During backfill or high-throughput periods, there's no concurrency limit on pipeline runs. If 100 sessions end simultaneously, 100 pipeline runs will compete for Postgres connections and Anthropic API quota. This could overwhelm both systems.

**Fix**: Instantiate the pipeline queue in `server/src/index.ts`, wire it into `pipelineDeps`, and replace all direct `runSessionPipeline()` calls with `queue.enqueue(sessionId)`.

---

### Issue #2: Upload Uses express.raw() Buffering {#issue-2-upload-buffering}

**Severity**: Medium
**Location**: `packages/server/src/routes/transcript-upload.ts:59`

The spec says: "streams directly to S3 (NO express.raw() buffering)". The implementation uses `express.raw({ type: "*/*", limit: "200mb" })` which buffers the **entire** request body into a `Buffer` in memory before uploading to S3.

**Impact**: A 144MB transcript (the known maximum from real-world data) will consume ~144MB of server memory per concurrent upload. During backfill of ~1,130 sessions, even moderate concurrency could OOM the server.

**Fix**: Use `req.pipe()` or `req` as a ReadableStream to pipe directly to the S3 `PutObjectCommand`'s `Body` parameter. The AWS SDK v3 accepts ReadableStream as body.

---

### Issue #3: Backfill Ordering Bug — Transcript Upload Before Session Exists {#issue-3-backfill-ordering}

**Severity**: **Critical**
**Location**: `packages/core/src/session-backfill.ts` (ingestBackfillSessions)

The backfill ingestion flow is:
```
For each session:
  1. checkSessionExists() — returns false for new sessions
  2. uploadTranscript()   — POST /api/sessions/:id/transcript/upload
  3. Push synthetic session.start + session.end events to batch
  4. (Eventually) flushEventBatch() sends events to ingest
```

But `uploadTranscript()` calls `POST /api/sessions/:id/transcript/upload`, which does:
```sql
SELECT id, lifecycle, workspace_id, transcript_s3_key
FROM sessions WHERE id = ${sessionId}
```

If the session doesn't exist yet (step 3 hasn't run, or the events haven't been processed by Redis consumer), this returns **404**. The backfill uploads the transcript BEFORE the session exists in the database.

**Impact**: **Every new session in the backfill will fail with 404.** The backfill is non-functional for its primary use case (ingesting historical sessions that don't yet exist in the DB).

**Fix**: Reorder the backfill flow to:
1. Emit `session.start` event → wait for processing (or flush batch synchronously)
2. Upload transcript
3. Emit `session.end` event

OR: Modify the upload endpoint to create a placeholder session row if one doesn't exist (using `INSERT ... ON CONFLICT DO NOTHING`).

---

### Issue #4: Summary Retry Gap Not Addressed

**Severity**: Low
**Location**: `packages/server/src/index.ts`, `packages/core/src/session-recovery.ts`

The Task 7 spec states: "Summary retry gap mitigation: periodic job for sessions at parsed without summary for >10 min." This was **not implemented**.

The recovery system only looks for sessions with `parse_status IN ('pending', 'parsing')`. Sessions that completed parsing but failed summary generation have `parse_status = 'completed'` and `lifecycle = 'parsed'` — the recovery system ignores them.

**Impact**: Sessions that fail summary generation (LLM timeout, rate limit, API key issue) permanently remain at `lifecycle = 'parsed'` without a summary. There's no automatic retry.

**Fix**: Add a query in `recoverStuckSessions` (or a separate function) that finds sessions at `lifecycle = 'parsed'` with `summary IS NULL` and `updated_at < now() - interval '10 minutes'`, then re-runs summary generation.

---

### Issue #5: `result_s3_key` Never Populated in Content Blocks Insert

**Severity**: Low (design gap, not a bug)
**Location**: `packages/core/src/session-pipeline.ts:428-435`

The `content_blocks` table has a `result_s3_key` column for externalizing large tool results to S3. The `ParsedContentBlock` TypeScript type includes this field. But the pipeline's batch insert for content blocks inserts only 14 columns, omitting `result_s3_key`. The parser never sets it either.

**Impact**: Large tool results (e.g., file reads returning thousands of lines) are stored inline in `result_text` or truncated. No S3 externalization occurs. The column defaults to NULL.

**Note**: This appears to be an intentional deferral (the parser doesn't know about S3), but the spec doesn't explicitly call this out. No downstream task depends on this being populated.

---

### Issue #6: Backup Key Derivation Is Fragile

**Severity**: Low
**Location**: `packages/core/src/session-pipeline.ts:288`

```typescript
const backupKey = transcriptKey.replace(/raw\.jsonl$/, "parsed.json");
```

This regex replacement assumes the S3 key always ends in `raw.jsonl`. It currently does (via `buildTranscriptKey`), but if the key format changes, this silently produces wrong keys.

**Fix**: Use `buildParsedBackupKey()` from `@fuel-code/shared/s3-keys.ts` instead of ad-hoc regex.

---

### Issue #7: `capturing` Lifecycle State Never Used

**Severity**: Medium (blocks Phase 3)
**Location**: `packages/core/src/handlers/session-start.ts:44`

Sessions are created with `lifecycle = 'detected'`. The session.end handler transitions from `['detected', 'capturing'] -> 'ended'`. But **nothing in Phase 1 or Phase 2 ever transitions a session to `capturing`**.

The `capturing` state exists in the TRANSITIONS map and the SQL CHECK constraint, but no code path reaches it. Sessions always go `detected -> ended`.

**Impact**: Phase 3's git-session correlation queries for `lifecycle = 'capturing'` (see Phase 3 Task 3). If sessions are never in `capturing`, git events will never correlate with sessions. See downstream review for full analysis.

---

## Design Patterns Assessment

### Positive Patterns

1. **Dependency Injection Throughout**: All route factories, pipeline functions, and handlers accept injected deps. Testability is excellent.

2. **Optimistic Locking**: `transitionSession` uses `WHERE lifecycle = ANY($from)` for safe concurrent transitions. This is the correct pattern for the lifecycle state machine.

3. **Batch Inserts with sql.unsafe**: The pipeline uses parameterized batch inserts to avoid exceeding Postgres parameter limits. Correct approach for bulk operations.

4. **Fire-and-Forget Pipeline with Error Isolation**: Pipeline errors don't propagate to the HTTP response (upload returns 202 immediately). Summary failure doesn't regress lifecycle.

5. **Graceful Degradation**: S3 and pipeline deps are optional in `AppDeps`, maintaining backward compatibility with Phase 1 code.

### Patterns to Reconsider

1. **Direct Pipeline Calls vs Queue**: The queue abstraction exists but isn't used. Should be wired in before production use.

2. **`sql.unsafe` for Dynamic Queries**: Used in `transitionSession`, batch inserts, and `failSession`. While parameterized, `sql.unsafe` bypasses postgres.js's type safety. Consider using postgres.js's `.values()` helper for batch inserts.

3. **Dynamic Import for Circular Dep**: `session-end.ts:69` uses `await import("../session-pipeline.js")` to avoid circular dependency. This is a code smell — consider restructuring so the handler receives the pipeline trigger as an injected function.

---

## Test Coverage Assessment

| Module | Unit Tests | Integration Tests | E2E Tests |
|--------|-----------|-------------------|-----------|
| Migration | N/A | Verified by E2E | Yes |
| Types/S3 Keys | 62 + 86 assertions | N/A | N/A |
| S3 Client | 347 lines (mocked) | LocalStack (skipped by default) | Yes |
| Lifecycle | 603 lines | DB integration | Yes |
| Parser | 848 lines, 26 tests | N/A | Yes |
| Summary Generator | 476 lines | N/A | Yes |
| Pipeline | 509 lines | N/A | Yes |
| Transcript Upload | 331 lines | N/A | Yes |
| Sessions API | 724 lines | N/A | Yes |
| Reparse/Recovery | 240 + 258 lines | N/A | Yes |
| Backfill | 487 + 197 lines | N/A | Dry-run only |

**Gap**: Backfill E2E only tests dry-run mode. A full ingestion E2E test would have caught Issue #3.

---

## Summary of Findings

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Pipeline queue unused | Medium | **FIXED** — queue wired into server startup, all callers route through `enqueueSession` |
| 2 | Upload buffers entire body | Medium | **FIXED** — removed express.raw(), streams req directly to S3 via `uploadStream` |
| 3 | Backfill ordering bug | **Critical** | **FIXED** — reordered to emit session.start first, upload transcript with retry on 404 |
| 4 | Summary retry gap | Low | **FIXED** — `recoverUnsummarizedSessions()` added to startup recovery sweep |
| 5 | result_s3_key never populated | Low | Intentional deferral |
| 6 | Fragile backup key derivation | Low | **FIXED** — uses `buildParsedBackupKey` from shared s3-keys.ts |
| 7 | `capturing` state unreachable | Medium | Deferred — Phase 3 spec will use `IN ('detected', 'capturing')` for correlation |

**Overall Verdict**: The core pipeline (parse -> persist -> summarize) is solid and well-tested. The session lifecycle, API endpoints, and recovery mechanisms are correctly implemented. Issues 1-4 and 6 have been fixed. Issue 7 (`capturing` state) will be addressed in Phase 3's spec by using `IN ('detected', 'capturing')` for git-session correlation.
