# Task 14: End-to-End Integration Test

## Parallel Group: G

## Description

Build an integration test suite that verifies the complete Phase 1 pipeline: hook fires → `fuel-code emit` → HTTP POST → Redis Stream → Event Processor → Postgres. Also verify the fallback path: emit fails → local queue → drain → Postgres. This is the final verification that Phase 1 works end-to-end.

### Prerequisites
- Docker Compose for local Postgres and Redis (or use existing instances)
- All Phase 1 tasks (1-13) complete

### Files to Create

**`docker-compose.test.yml`** (root):
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: fuel_code_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5433:5432"    # non-standard port to avoid conflicts
    tmpfs:
      - /var/lib/postgresql/data  # RAM disk for speed

  redis:
    image: redis:7-alpine
    ports:
      - "6380:6379"    # non-standard port to avoid conflicts
```

**`packages/server/src/__tests__/e2e/pipeline.test.ts`**:

Test setup:
- Import `createApp` from `../app.ts` and `createDb`, `createRedisClient`, `runMigrations`, etc.
- Use test-specific env vars: `DATABASE_URL=postgresql://test:test@localhost:5433/fuel_code_test`, `REDIS_URL=redis://localhost:6380`.
- `beforeAll`: run migrations, flush Redis, start consumer.
- `afterAll`: stop consumer, close connections.
- `afterEach`: clean up test data (TRUNCATE tables, but preserve schema).

Helper:
```typescript
// Poll Postgres until a condition is met (for async consumer processing)
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number = 5000,
  intervalMs: number = 200
): Promise<T>
```

**Test 1: Happy path — session.start flows through pipeline**:
1. Construct a valid `session.start` event with unique IDs.
2. POST to `/api/events/ingest` with valid auth.
3. Assert 202 response with `{ ingested: 1 }`.
4. `waitFor` event to appear in `events` table (consumer is async).
5. Assert: `events` row has correct type, timestamp, device_id.
6. Assert: `events.workspace_id` is a ULID (not the canonical string).
7. Assert: `workspaces` row exists with correct `canonical_id` and `display_name`.
8. Assert: `devices` row exists with the event's `device_id`.
9. Assert: `workspace_devices` junction row exists.
10. Assert: `sessions` row exists with `lifecycle = 'detected'`, correct `git_branch`, `model`.

**Test 2: Session lifecycle — start then end**:
1. POST `session.start` event. Wait for processing.
2. POST `session.end` event (same session ID, same device, same workspace).
3. `waitFor` session lifecycle to be `ended`.
4. Assert: `sessions.ended_at` is set.
5. Assert: `sessions.duration_ms` matches payload.
6. Assert: `sessions.end_reason` matches payload.
7. Assert: two events in `events` table (start + end).

**Test 3: Duplicate event deduplication**:
1. Construct an event with a specific ULID.
2. POST it twice.
3. Assert: both return 202.
4. Wait for processing.
5. Assert: exactly ONE row in `events` table with that ID.
6. Assert: exactly ONE workspace row (not duplicated).

**Test 4: Batch ingest**:
1. Construct 10 events: different ULIDs, same device, same workspace.
2. POST as a single batch.
3. Assert: 202 with `{ ingested: 10 }`.
4. Wait for all 10 to be processed.
5. Assert: 10 rows in `events` table.
6. Assert: 1 workspace row (same canonical ID).
7. Assert: 1 device row (same device ID).

**Test 5: Invalid payload rejection**:
1. POST event with `type: "session.start"` but `data: {}` (missing required fields).
2. Assert: 202 with `{ ingested: 0, rejected: 1, errors: [{ index: 0, error: "..." }] }`.
3. Assert: no event in Redis stream (rejected before publishing).

**Test 6: Auth failure**:
1. POST without `Authorization` header. Assert 401.
2. POST with wrong API key. Assert 401.

**Test 7: Health endpoint**:
1. GET `/api/health`. Assert 200 with `{ status: "ok", checks: { db: { ok: true }, redis: { ok: true } } }`.

**`packages/cli/src/__tests__/e2e/emit-pipeline.test.ts`**:

Uses a running server instance (started in beforeAll).

**Test 8: emit → backend → Postgres**:
1. Start the server.
2. Run `fuel-code emit session.start --data '...' --workspace-id '...' --session-id '...'` as a subprocess.
3. Assert: exit code 0.
4. Wait for event in Postgres.
5. Assert: event and session rows exist.

**Test 9: emit → queue → drain → Postgres**:
1. Do NOT start the server.
2. Run `fuel-code emit session.start --data '...'`.
3. Assert: exit code 0.
4. Assert: file exists in `~/.fuel-code/queue/`.
5. Start the server.
6. Run `fuel-code queue drain`.
7. Assert: queue is empty.
8. Assert: event is in Postgres.

**Test 10: Queue drain with server reconnection (full offline path)**:
1. Start the server + consumer. Verify health endpoint.
2. Stop the server (simulate backend going down).
3. Run `fuel-code emit session.start --data '...'` (should fail HTTP, fall back to queue).
4. Assert: event file exists in `~/.fuel-code/queue/`.
5. Restart the server + consumer.
6. Run `fuel-code queue drain`.
7. Assert: queue is empty (all files drained).
8. `waitFor` event to appear in `events` table.
9. Assert: event, session, workspace, device rows all exist in Postgres.
10. This verifies the complete resilience path: emit → queue fallback → drain → pipeline → Postgres.

**Test 11: emit wall-clock time with dead backend**:
1. Do NOT start the server.
2. Time `fuel-code emit session.start --data '...'`.
3. Assert: completes in < 3000ms (2s timeout + overhead).

### Test Runner Configuration

Create `packages/server/bunfig.toml` (or use root):
```toml
[test]
timeout = 30000  # 30s timeout for integration tests (async processing)
```

### Manual Verification Script

**`scripts/verify-e2e.sh`**:
```bash
#!/usr/bin/env bash
# Manual verification of the full Phase 1 pipeline.
# Prerequisites: docker-compose up -d (Postgres + Redis), server running.
echo "=== Phase 1 E2E Verification ==="
echo "1. Sending session.start event..."
# ... curl commands to POST events and query results
echo "2. Checking Postgres..."
# ... psql queries to verify rows
echo "=== All checks passed ==="
```

## Relevant Files
- `docker-compose.test.yml` (create)
- `packages/server/src/__tests__/e2e/pipeline.test.ts` (create)
- `packages/cli/src/__tests__/e2e/emit-pipeline.test.ts` (create)
- `scripts/verify-e2e.sh` (create)

## Success Criteria
1. All 7 server integration tests pass.
2. All 4 CLI integration tests pass.
3. Test 1 verifies the complete pipeline: POST → Redis → Processor → Postgres with all tables populated correctly.
4. Test 2 verifies session lifecycle: detected → ended.
5. Test 3 verifies deduplication: same ULID produces exactly one row.
6. Test 5 verifies payload validation: invalid data is rejected before reaching Redis.
7. Test 9 verifies the offline fallback: emit → queue → drain → Postgres.
8. Test 10 verifies the full resilience path: server up → server down → queue fallback → server restart → drain → Postgres.
9. Test 11 proves wall-clock time < 3 seconds with dead backend.
10. Tests are isolated: running twice produces the same results (cleanup between tests).
11. `docker-compose.test.yml` starts Postgres and Redis on non-standard ports (5433, 6380) to avoid conflicts.
12. All tests can run with `bun test packages/server/src/__tests__/e2e/ && bun test packages/cli/src/__tests__/e2e/`.
13. The manual verification script works as a smoke test.
