# E2E Test Gap Coverage Design

## Problem

Three significant E2E test gaps exist in the fuel-code test suite:

1. **Phase 4 CLI E2E doesn't use S3** — transcript upload and pipeline processing are untested from CLI commands
2. **No hooks-to-pipeline E2E** — no test verifies the full flow from CC hooks through Redis consumer to Postgres
3. **No backfill ingestion E2E** — `ingestBackfillSessions()` is only tested against mocked fetch, never a real server

## Infrastructure

All tests use the existing docker-compose.test.yml containers:
- Postgres on port 5433
- Redis on port 6380
- LocalStack (S3) on port 4566

No new infrastructure needed.

## Cleanup Strategy

All tests use **targeted row deletion** (not TRUNCATE CASCADE). Each test captures the IDs it creates (session IDs, workspace IDs, device IDs) and deletes those specific rows in `afterEach`/`afterAll`. This prevents interference with other parallel test files and avoids destroying data created by other tests.

Deletion order respects FK constraints:
1. `content_blocks` (FK → transcript_messages)
2. `transcript_messages` (FK → sessions)
3. `events` (FK → sessions, workspaces, devices)
4. `git_activity` (FK → sessions)
5. `sessions` (FK → workspaces, devices)
6. `workspace_devices` (FK → workspaces, devices)
7. `workspaces`
8. `devices`

S3 objects are also cleaned up by key.

---

## Gap 1: Phase 4 CLI E2E with S3 + Pipeline

### File: `packages/cli/src/__tests__/e2e/phase4-pipeline.test.ts`

### Setup

Create a new setup variant `setupTestServerWithS3()` in `setup.ts` (or a separate `setup-s3.ts`) that extends the existing setup:
- Creates a LocalStack S3 bucket (same pattern as phase2-pipeline.test.ts)
- Creates an `FuelCodeS3Client` via `createS3Client()`
- Builds `PipelineDeps` with summaries disabled
- Passes `s3` and `pipelineDeps` to `createApp()` and `createEventHandler()`/`startConsumer()`
- Returns all standard context plus `s3`

### Tests

1. **Full CLI lifecycle via emit commands**: `fuel-code emit session.start` → wait for session row → `fuel-code transcript upload` → `fuel-code emit session.end` → verify lifecycle reaches `parsed`, transcript_messages/content_blocks populated
2. **Session without transcript**: emit start + end without upload → verify lifecycle stays at `ended`

### How CLI commands are invoked

Spawn `bun packages/cli/src/index.ts emit session.start --data '...' --workspace-id '...'` as a child process with:
- `HOME` → temp dir containing `.fuel-code/config.yaml` pointing at test server
- Capture stderr for debugging (CLI writes no stdout on success)

For transcript upload: `bun packages/cli/src/index.ts transcript upload --session-id <id> --file <path>`

### Cleanup

Delete rows by captured session/workspace/device IDs. Remove S3 objects by key.

---

## Gap 2: Hooks-to-Pipeline via Real CC Session

### File: `packages/cli/src/__tests__/e2e/phase4-hooks-pipeline.test.ts`

### Prerequisite

Requires `ANTHROPIC_API_KEY` env var. Test uses `test.skipIf(!process.env.ANTHROPIC_API_KEY)`.

### Setup

Same S3-enabled server as Gap 1. Additionally creates a temp HOME directory structure:

```
$TEMP_HOME/
  .claude/
    settings.json          # CC hooks config
  .fuel-code/
    config.yaml            # fuel-code CLI config pointing at test server
```

**settings.json contents:**
```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "bun /absolute/path/to/packages/cli/src/index.ts cc-hook session-start"
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "bun /absolute/path/to/packages/cli/src/index.ts cc-hook session-end"
      }]
    }]
  }
}
```

**config.yaml contents:**
```yaml
backend:
  url: http://127.0.0.1:<test-server-port>
  api_key: test-api-key-123
device:
  id: test-e2e-device
  name: e2e-test-machine
  type: local
pipeline:
  queue_path: $TEMP_HOME/.fuel-code/queue
  drain_interval_seconds: 30
  batch_size: 50
  post_timeout_ms: 5000
```

### Test Flow

1. Spawn `claude -p "Say hello" --max-turns 1 --output-format json` with:
   - `env: { ...process.env, HOME: tempDir }`
   - `cwd` set to a temp directory (or the project root)
2. Wait for the subprocess to exit
3. Poll Postgres for a session row created by the SessionStart hook
4. Wait for lifecycle to reach `parsed` (SessionEnd hook triggers pipeline)
5. Assert:
   - Session row exists with lifecycle `parsed`
   - transcript_messages populated
   - content_blocks populated
   - S3 key set on session row

### HOME Scoping

The `HOME` env var is set only on the spawned `claude` subprocess via `child_process.spawn()` env option. It does not affect the parent test process or any other process on the machine. When `claude` invokes `fuel-code cc-hook`, the child inherits the modified HOME, so both tools read from the temp directory.

### Timeout

The test has a generous timeout (90-120s) since it involves:
- CC startup + API call (~5-15s)
- Hook execution (~2-5s)
- Redis consumer processing (~1-5s)
- Pipeline processing (~2-10s)

### Cleanup

- Delete specific rows from Postgres by session/workspace/device IDs
- Delete S3 objects by key
- Remove temp HOME directory (`fs.rmSync(tempDir, { recursive: true, force: true })`)

---

## Gap 3: Backfill Ingestion E2E

### File: `packages/server/src/__tests__/e2e/phase2-backfill-ingest.test.ts`

### Setup

Reuses the Phase 2 E2E setup pattern (Postgres + Redis + LocalStack S3 + consumer). Copy the setup from `phase2-pipeline.test.ts`.

### Tests

1. **Full backfill ingestion**: Create temp `~/.claude/projects/` directory structure with test transcript JSONL → `scanForSessions()` → `ingestBackfillSessions()` against real server → verify session row, lifecycle reaches `parsed`, transcript_messages populated
2. **Dedup verification**: Run `ingestBackfillSessions()` again with same sessions → verify `result.skipped === 1`, no duplicate rows
3. **Progress callback**: Verify `onProgress` fires with correct counts

### Temp Directory Structure

```
$TEMP_DIR/
  -Users-testuser-Desktop-test-project/
    <uuid>.jsonl            # copy of test-transcript.jsonl
```

File mtime set to 10 minutes ago (past the active session threshold).

### Cleanup

- Delete specific rows from Postgres by session IDs
- Delete S3 objects by session key prefix
- Remove temp directory

---

## Test File Summary

| Gap | New File | Location | Requires API Key |
|-----|----------|----------|------------------|
| 1 | `phase4-pipeline.test.ts` | `packages/cli/src/__tests__/e2e/` | No |
| 2 | `phase4-hooks-pipeline.test.ts` | `packages/cli/src/__tests__/e2e/` | Yes (ANTHROPIC_API_KEY) |
| 3 | `phase2-backfill-ingest.test.ts` | `packages/server/src/__tests__/e2e/` | No |

## Shared Helpers

A `cleanup.ts` helper in each E2E directory provides a `deleteTestData(sql, ids)` function that takes captured IDs and deletes rows in FK-safe order.
