# Task 12: Phase 2 E2E Integration Tests

## Parallel Group: G

## Description

Build an integration test suite verifying the complete Phase 2 pipeline: session.end with transcript → S3 upload → parse → summarize → lifecycle reaches `summarized`. Also verify the query API, reparse flow, tag management, and backfill path. This is the final verification that Phase 2 works end-to-end.

### Prerequisites
- Docker Compose for Postgres, Redis, and LocalStack (S3)
- All Phase 2 tasks (1–11) complete

### Test Infrastructure

**Extend `docker-compose.test.yml`** with LocalStack for S3:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: fuel_code_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6380:6379"

  localstack:
    image: localstack/localstack:latest
    environment:
      SERVICES: s3
      DEFAULT_REGION: us-east-1
    ports:
      - "4566:4566"
```

### Test Setup

- Use test-specific env vars: `DATABASE_URL=postgresql://test:test@localhost:5433/fuel_code_test`, `REDIS_URL=redis://localhost:6380`, `S3_ENDPOINT=http://localhost:4566`, `S3_BUCKET=fuel-code-test`, `S3_FORCE_PATH_STYLE=true`.
- `beforeAll`: run migrations, flush Redis, create S3 test bucket, start consumer, load test transcript fixture.
- `afterAll`: stop consumer, close connections.
- `afterEach`: TRUNCATE tables (preserve schema), clean S3 test objects.

### Test Fixtures

**`packages/server/src/__tests__/e2e/fixtures/test-transcript.jsonl`**:

A realistic 10-line JSONL transcript with:
- 1 `file-history-snapshot` line (should be skipped by parser)
- 1 `user` text message (the initial prompt)
- 3 `assistant` lines with same `message.id` (thinking + text + tool_use)
- 1 `user` tool_result message
- 1 `assistant` text response
- 1 `progress` line (should be skipped)
- Token usage data on assistant messages

This fixture validates: line classification, assistant message grouping, content block extraction, stat computation, and non-message line filtering.

### Files to Create

**`packages/server/src/__tests__/e2e/phase2-pipeline.test.ts`**:

**Test 1: Full pipeline — session.start + transcript upload + session.end → summarized**:
1. POST `session.start` event with unique IDs. Wait for session to appear with `lifecycle = 'detected'`.
2. POST transcript file to `/api/sessions/:id/transcript/upload`.
3. Assert: 202, `s3_key` returned.
4. POST `session.end` event (same session ID). This triggers the pipeline since S3 key is set.
5. `waitFor` session lifecycle to reach `parsed` (or `summarized` if summary enabled in test).
6. Assert: `sessions.transcript_s3_key` is set and matches expected pattern.
7. Assert: `sessions.parse_status = 'completed'`.
8. Assert: `sessions.total_messages > 0`, `sessions.user_messages > 0`, `sessions.assistant_messages > 0`.
9. Assert: `sessions.tool_use_count > 0` (fixture has tool_use).
10. Assert: `sessions.tokens_in > 0`.
11. Assert: `sessions.initial_prompt` is set (first user message).
12. Assert: `transcript_messages` rows exist for this session.
13. Assert: `content_blocks` rows exist with correct `block_type` values.
14. Assert: Content blocks reference valid message IDs.

**Test 2: Session.end without transcript upload → lifecycle stays ended**:
1. POST `session.start`, then `session.end` WITHOUT uploading transcript.
2. Wait briefly. Assert: `lifecycle = 'ended'`. No S3 key. No parsing.

**Test 3: Session lifecycle state machine guards**:
1. Create a parsed session.
2. Try to POST another `session.start` event for the same session ID.
3. Assert: session stays `parsed` (duplicate start ignored).
4. Try to reparse (Task 10 handles this, but verify guard):
   - If session has no transcript_s3_key, reparse returns 409.

**Test 4: Reparse flow**:
1. Complete the full pipeline (Test 1 flow) → session is `parsed`/`summarized`.
2. POST `/api/sessions/:id/reparse`.
3. Assert: 202 response.
4. Wait for session lifecycle to reach `parsed` again.
5. Assert: `transcript_messages` have new IDs (old deleted, new inserted).
6. Assert: Stats are repopulated.

**Test 5: Query API pagination**:
1. Create 5 sessions via event pipeline (5 session.start events with different IDs/workspaces).
2. `GET /api/sessions?limit=2` → 2 results + cursor + `has_more = true`.
3. `GET /api/sessions?limit=2&cursor=...` → next 2 results + cursor.
4. `GET /api/sessions?limit=2&cursor=...` → 1 result + null cursor + `has_more = false`.
5. Total across all pages = 5 sessions, no duplicates.

**Test 6: Query API filtering**:
1. Create sessions with different workspaces and lifecycles.
2. `GET /api/sessions?workspace_id=<id>`: returns only matching.
3. `GET /api/sessions?lifecycle=parsed,summarized`: returns only those.
4. `GET /api/sessions?after=<timestamp>`: correct temporal filter.

**Test 7: Session detail + transcript endpoints**:
1. Complete pipeline for one session (Test 1 flow).
2. `GET /api/sessions/:id` → full session with stats.
3. `GET /api/sessions/:id/transcript` → messages with nested content blocks.
4. Assert: messages ordered by ordinal.
5. Assert: content blocks nested correctly within messages.
6. `GET /api/sessions/:id/transcript/raw` → presigned URL (302 or 200).
7. Assert: presigned URL starts with "http".

**Test 8: Tag management**:
1. Create a session.
2. `PATCH /api/sessions/:id { tags: ["bugfix"] }` → tags updated.
3. `PATCH /api/sessions/:id { add_tags: ["auth"] }` → tags = ["auth", "bugfix"].
4. `PATCH /api/sessions/:id { remove_tags: ["bugfix"] }` → tags = ["auth"].
5. `GET /api/sessions?tag=auth` → includes this session.
6. `GET /api/sessions?tag=bugfix` → does NOT include this session.

**Test 9: Duplicate session.end handling**:
1. POST `session.start`, upload transcript, POST `session.end`.
2. POST `session.end` again (duplicate).
3. Assert: session is at `parsed`/`summarized`. No error. No duplicate data.
4. Assert: `transcript_messages` count is the same (not doubled).

**Test 10: Pipeline failure — missing transcript in S3**:
1. POST `session.start` then `session.end`.
2. Directly set `transcript_s3_key` to a non-existent S3 key on the session.
3. Trigger pipeline (or reparse).
4. Assert: session transitions to `failed` with `parse_error` describing S3 download failure.

**Test 11: Backfill scanner dry-run**:
1. Create a temporary directory mimicking `~/.claude/projects/` with a project dir containing a copy of the test fixture JSONL.
2. Call `scanForSessions(tempDir)`.
3. Assert: discovers the correct number of sessions.
4. Assert: session ID extracted from filename.
5. Assert: skipped counts are correct (0 subagents, 0 non-JSONL in this test).

### Helpers

Reuse the `waitFor` helper from Phase 1 E2E tests:
```typescript
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number = 10000,
  intervalMs: number = 500
): Promise<T>
```

### Test Runner Configuration

Pipeline processing is async, so tests need generous timeouts:
```toml
[test]
timeout = 60000  # 60s per test
```

## Relevant Files
- `docker-compose.test.yml` (modify — add localstack service)
- `packages/server/src/__tests__/e2e/phase2-pipeline.test.ts` (create)
- `packages/server/src/__tests__/e2e/fixtures/test-transcript.jsonl` (create)

## Success Criteria
1. Test 1 verifies the complete Phase 2 pipeline: upload → parse → lifecycle reaches `parsed`/`summarized`.
2. Test 2 verifies sessions without transcripts stay at `ended`.
3. Test 3 verifies lifecycle state machine rejects invalid transitions.
4. Test 4 verifies the full reparse flow (reset + re-process).
5. Test 5 verifies cursor-based pagination produces stable, non-overlapping pages.
6. Test 6 verifies all query filters (workspace, lifecycle, date range).
7. Test 7 verifies session detail, transcript, and raw transcript endpoints.
8. Test 8 verifies tag management (set, add, remove, query by tag).
9. Test 9 verifies idempotent handling of duplicate session.end events.
10. Test 10 verifies pipeline failure transitions session to `failed` with error.
11. Test 11 verifies the backfill scanner discovers sessions correctly.
12. All Phase 1 E2E tests still pass (backward compatible).
13. Tests are isolated: each test cleans up. Running twice produces same results.
14. All tests pass with `bun test packages/server/src/__tests__/e2e/phase2-pipeline.test.ts`.
