# Phase 1 Implementation Review

## Overview

Phase 1 ("Events flow from hooks to Postgres") was implemented across **8 commits** between Feb 18, 2026, covering all 14 planned tasks. The implementation closely follows the task specifications with a few notable deviations and shortcuts documented below.

---

## Commit History

| Commit | Description | Files Changed | Lines Added |
|--------|-------------|---------------|-------------|
| `df9b512` | Phase 1 Tasks 1-5 — monorepo scaffold, shared types, postgres, redis, CLI | 43 files | +4,153 |
| `427ebe5` | Task 6 — Express server skeleton with auth, health, error handling | 8 files | +687 |
| `b059e50` | Task 7 — workspace resolver, device resolver, workspace-device link | 6 files | +631 |
| `b97b3b6` | Task 8 — event ingest endpoint POST /api/events/ingest | 3 files | +548 |
| `d60d355` | Task 9 — event processor with handler registry (session.start/end) | 6 files | +982 |
| `72ddf25` | Task 10 — CLI emit command with local queue fallback | 6 files | +1,299 |
| `819b9d4` | Task 12 — queue drainer with foreground/background modes | 5 files | +1,397 |
| `458d063` | Task 13 — Claude Code hook scripts and hooks install command | 10 files | +1,198 |
| `1322907` | Task 11 — wire Redis consumer to event processor | 4 files | +916 |
| `709083a` | Task 14 — E2E integration test + fix Redis blocking / DB health bugs | N/A | N/A |

**Total**: ~11,800+ lines of implementation code across ~90+ files.

**Note**: Tasks 1-5 were batched into a single commit (`df9b512`). This is a minor deviation from the one-commit-per-task pattern but acceptable since those tasks are foundational scaffolding with no risk of needing individual rollback.

---

## Task-by-Task Review

### Task 1: Monorepo Scaffold (Group A) — IMPLEMENTED

**Commit**: `df9b512` (batched with Tasks 2-5)

**What was built**:
- Bun workspaces with 5 packages: `shared`, `core`, `server`, `cli`, `hooks`
- Root `package.json`, `bunfig.toml`, `tsconfig.base.json`
- Per-package `package.json`, `tsconfig.json`

**Deviations**: None significant. Matches spec.

---

### Task 2: Shared Types, Zod Schemas, Utilities (Group B) — IMPLEMENTED

**Commit**: `df9b512`

**What was built**:
- 14 event types defined (`packages/shared/src/types/event.ts`)
- Zod schemas for event envelope validation (`packages/shared/src/schemas/event-base.ts`)
- Session start/end payload schemas (`packages/shared/src/schemas/session-start.ts`, `session-end.ts`)
- Payload registry with `validateEventPayload` (`packages/shared/src/schemas/payload-registry.ts`)
- Git remote normalization (`packages/shared/src/canonical.ts`)
- Error hierarchy: `FuelCodeError`, `ConfigError`, `NetworkError`, `ValidationError`, `StorageError` (`packages/shared/src/errors.ts`)
- ULID generation (`packages/shared/src/ulid.ts`)
- Tests: `canonical.test.ts` (130 lines), `schemas.test.ts` (215 lines)

**Deviations**: None. Solid implementation.

---

### Task 3: Postgres Connection, Migrator, Phase 1 Schema (Group C) — IMPLEMENTED

**Commit**: `df9b512`

**What was built**:
- `createDb()` connection pool factory (`packages/server/src/db/postgres.ts`, 105 lines)
- `runMigrations()` with advisory locks and per-migration transactions (`packages/server/src/db/migrator.ts`, 159 lines)
- Initial SQL migration: 5 tables, 8 indexes (`001_initial.sql`, 152 lines)
- Tests: `migrator.test.ts` (211 lines)

**Schema review** (this is critical for downstream phases):
- `workspaces`: TEXT PK (ULID), canonical_id UNIQUE, display_name, default_branch, metadata JSONB
- `devices`: TEXT PK, name, type (CHECK: local/remote), hostname, os, arch, status (CHECK: online/offline/provisioning/terminated), metadata JSONB
- `workspace_devices`: composite PK (workspace_id, device_id), local_path NOT NULL, hooks_installed, git_hooks_installed
- `sessions`: TEXT PK (cc_session_id), workspace_id FK, device_id FK, remote_env_id (nullable, no FK — deferred to Phase 5), lifecycle CHECK (detected/capturing/ended/parsed/summarized/archived/failed), many metrics columns, tags TEXT[], metadata JSONB
- `events`: TEXT PK (ULID), type, timestamp, device_id FK, workspace_id FK, session_id FK (nullable), data JSONB, blob_refs JSONB

**Observations**:
- Schema is forward-looking: includes `parse_status`, `summary`, token/cost columns, `tags`, etc. that won't be populated until Phase 3+. This is good — avoids ALTER TABLE for later phases.
- `remote_env_id` column exists with no FK constraint, with a comment noting it'll be added in Phase 5. This is correct.
- All PKs are TEXT (ULIDs stored as text). The DAG explicitly noted this as a known limitation.

---

### Task 4: Redis Client and Stream Abstraction (Group C) — IMPLEMENTED

**Commit**: `df9b512`

**What was built**:
- `createRedisClient()` with reconnection strategy (`packages/server/src/redis/client.ts`, 149 lines)
- Stream abstraction: `ensureConsumerGroup`, `publishToStream`, `publishBatchToStream`, `readFromStream`, `acknowledgeEntry`, `claimPendingEntries` (`packages/server/src/redis/stream.ts`, 451 lines)
- Constants: `EVENTS_STREAM = "events:incoming"`, `CONSUMER_GROUP = "event-processors"`, `CONSUMER_NAME = hostname-pid`
- Tests: `stream.test.ts` (348 lines)

**Deviations**: None. Clean implementation with proper XAUTOCLAIM fallback.

---

### Task 5: CLI Config Management and `init` Command (Group C) — IMPLEMENTED

**Commit**: `df9b512`

**What was built**:
- CLI entry point with commander (`packages/cli/src/index.ts`)
- Config management: `loadConfig()`, `saveConfig()`, config path at `~/.fuel-code/config.yaml` (`packages/cli/src/lib/config.ts`, 240 lines)
- `fuel-code init` command (`packages/cli/src/commands/init.ts`, 214 lines)
- `fuel-code status` command (`packages/cli/src/commands/status.ts`, 106 lines)
- Tests: `config.test.ts` (228 lines)

**Deviations**: None significant.

---

### Task 6: Express Server Skeleton with Middleware (Group D) — IMPLEMENTED

**Commit**: `427ebe5`

**What was built**:
- `createApp()` factory in `app.ts` (87 lines) — separated from `index.ts` for testability
- Server entry point `index.ts` (199 lines) with full startup sequence
- Middleware stack: `express.json(1mb)`, `helmet()`, `cors({origin: false})`, `pino-http`, auth
- Auth middleware with constant-time comparison (`packages/server/src/middleware/auth.ts`, 66 lines)
- Health endpoint at `GET /api/health` (no auth) (`packages/server/src/routes/health.ts`, 80 lines)
- Error handler mapping ZodError→400, FuelCodeError→mapped status (`packages/server/src/middleware/error-handler.ts`, 83 lines)
- Graceful shutdown on SIGTERM/SIGINT with 30s timeout
- Tests: `auth.test.ts` (143 lines)

**Key design**: Health endpoint is mounted BEFORE auth middleware so it bypasses auth. This is correct and important for Railway health probes.

**Notable**: Server creates TWO Redis clients — one for the app (health checks, XADD) and one for the consumer (blocking XREADGROUP). This was a bug fix discovered during Task 14 E2E testing — sharing a single client causes health check PINGs to queue behind the blocked XREADGROUP.

---

### Task 7: Workspace/Device Resolvers (Group D) — IMPLEMENTED

**Commit**: `b059e50`

**What was built**:
- `resolveOrCreateWorkspace()`: INSERT ON CONFLICT upsert (`packages/core/src/workspace-resolver.ts`, 93 lines)
- `resolveOrCreateDevice()`: INSERT ON CONFLICT with COALESCE for partial updates (`packages/core/src/device-resolver.ts`, 78 lines)
- `ensureWorkspaceDeviceLink()` (`packages/core/src/workspace-device-link.ts`, 41 lines)
- Tests: `workspace-resolver.test.ts` (200 lines), `device-resolver.test.ts` (198 lines)

**Observations**:
- Uses mocked SQL in tests (not real Postgres). This is fine for unit tests — E2E tests cover real DB.
- `resolveOrCreateDevice()` defaults device name to "unknown-device" and type to "local" when hints aren't provided. This means events from uninitialized devices will create rows with generic names. **This is a shortcut** — the spec implies the device should have been registered via `fuel-code init` first, but the resolver doesn't enforce this.

---

### Task 8: Event Ingest Endpoint (Group E) — IMPLEMENTED

**Commit**: `b97b3b6`

**What was built**:
- `POST /api/events/ingest` endpoint (`packages/server/src/routes/events.ts`, 168 lines)
- Validates envelope with `ingestRequestSchema` (Zod)
- Validates per-event payloads via `validateEventPayload`
- Publishes valid events to Redis Stream
- Returns 202 with `{ ingested, duplicates, rejected, results, errors }`
- Redis failure → 503
- Tests: `events.test.ts` (378 lines)

**Observation**: `duplicates` is hardcoded to `0` in the response (line 159). The deduplication actually happens downstream in the event processor (ON CONFLICT DO NOTHING in Postgres), not at the ingest level. This is correct — the ingest endpoint doesn't check for duplicates, it just publishes to Redis. The response field exists for API compatibility but is always 0 at this stage.

---

### Task 9: Event Processor with Handler Registry (Group E) — IMPLEMENTED

**Commit**: `d60d355`

**What was built**:
- `processEvent()` function: resolves workspace/device, inserts event, dispatches to handler (`packages/core/src/event-processor.ts`, 200 lines)
- `EventHandlerRegistry` class: Map<EventType, EventHandler> (`packages/core/src/event-processor.ts`)
- `handleSessionStart()`: inserts session row with lifecycle="detected" (`packages/core/src/handlers/session-start.ts`, 53 lines)
- `handleSessionEnd()`: updates session to lifecycle="ended" (`packages/core/src/handlers/session-end.ts`, 55 lines)
- Handler index: `createHandlerRegistry()` registers both handlers (`packages/core/src/handlers/index.ts`, 33 lines)
- Tests: `event-processor.test.ts` (624 lines)

**Key behavior**: Handler errors are swallowed (logged but don't fail the process). The event row is still persisted even if the handler fails. This is the correct design per spec.

**Observation**: `handleSessionStart` does NOT set `transcript_s3_key` in the session row even though the event data contains `transcript_path`. This seems intentional — the transcript isn't uploaded at session start, and the spec says transcript handling is Phase 3 (transcript parser). But it means Phase 3 will need to update the session row with the S3 key when it processes the transcript.

---

### Task 10: CLI `emit` Command (Group E) — IMPLEMENTED

**Commit**: `72ddf25`

**What was built**:
- `fuel-code emit <event-type>` command (`packages/cli/src/commands/emit.ts`, 163 lines)
- `ApiClient` with timeout (`packages/cli/src/lib/api-client.ts`, 117 lines)
- Local queue with atomic writes (`packages/cli/src/lib/queue.ts`, 190 lines)
- Tests: `emit.test.ts` (526 lines), `queue.test.ts` (297 lines)

**Key behaviors verified**:
- Exit code always 0 (never throws)
- No stdout on success
- Falls back to local queue on any HTTP failure
- Atomic writes: tmp file + rename
- ULID filenames for chronological sorting

**Potential shortcut**: The `emit` command casts `eventType as EventType` without validation (line 122). If an invalid event type is passed, it will construct an Event with a bad type and either fail Zod validation at the server or be queued with an invalid type. This isn't a major issue since `emit` is called by hooks that always pass valid types, but it's a gap in local validation.

---

### Task 11: Redis Consumer Loop (Group F) — IMPLEMENTED

**Commit**: `1322907`

**What was built**:
- `startConsumer()` with `ConsumerHandle.stop()` (`packages/server/src/pipeline/consumer.ts`, 316 lines)
- Startup: reclaims pending entries from crashed consumers via XAUTOCLAIM
- Main loop: reads 10 entries, blocks 5s, processes each, acknowledges
- Retry logic: 3 retries then dead-letter (ack + error log)
- Stats logging every 60s
- Wiring layer: `wire.ts` (43 lines) connects core to consumer
- Tests: `consumer.test.ts` (545 lines)

**Key design**: Consumer uses dependency injection with `ConsumerOverrides` for testing. All stream/processor functions can be replaced with mocks. This is well-designed.

**Observation**: Dead-lettered events are only logged, not moved to a dead-letter stream or table. The spec doesn't explicitly require a dead-letter stream, and storing them in logs is sufficient for Phase 1. Phase 2+ may want a proper dead-letter queue in Redis or Postgres.

---

### Task 12: Queue Drainer (Group F) — IMPLEMENTED

**Commit**: `819b9d4`

**What was built**:
- `drainQueue()` with batch delivery (`packages/cli/src/lib/drain.ts`, 326 lines)
- Background drain with lockfile (`packages/cli/src/lib/drain-background.ts`, 178 lines)
- CLI commands: `fuel-code queue drain`, `fuel-code queue status`, `fuel-code queue dead-letter` (`packages/cli/src/commands/queue.ts`, 223 lines)
- Tests: `drain.test.ts` (663 lines)

**Key behaviors**: Events exceeding 100 attempts → dead-letter directory. Corrupted files → dead-letter immediately. 401 response → stop draining (bad API key). Lockfile prevents concurrent drains.

---

### Task 13: Claude Code Hook Scripts (Group F) — IMPLEMENTED

**Commit**: `458d063`

**What was built**:
- `SessionStart.sh`, `SessionEnd.sh` bash wrappers
- TypeScript helpers: `session-start.ts` (120 lines), `session-end.ts` (103 lines)
- Shared `resolve-workspace.ts` (102 lines)
- `fuel-code hooks install/status/test` commands (`packages/cli/src/commands/hooks.ts`, 404 lines)
- Tests: `hooks.test.ts` (279 lines), `resolve-workspace.test.ts` (155 lines)

**Key design**: Bash scripts background the TS helper and exit 0 immediately, so Claude Code startup is never blocked. All `execSync` calls have 5s timeouts and are wrapped in try/catch.

**Observation**: The hook scripts use `bun run` to execute the TS helper. This means `bun` must be in the PATH when Claude Code fires the hook. If `bun` is installed via a version manager (e.g., proto, asdf), it might not be available in the hook's PATH. The spec doesn't address this, but it's a potential runtime issue.

---

### Task 14: E2E Integration Tests (Group G) — PARTIALLY IMPLEMENTED

**Commit**: `709083a`

**What was built**:
- Server E2E tests: `packages/server/src/__tests__/e2e/pipeline.test.ts` (515 lines)
- `docker-compose.test.yml` with Postgres (5433) and Redis (6380)
- Bug fixes discovered during E2E: dual Redis clients for blocking/non-blocking

**Tests implemented** (7 of 11 spec'd):
1. Test 0: Health endpoint (/api/health returns 200)
2. Test 1: Happy path session.start through full pipeline
3. Test 2: Session lifecycle (start then end)
4. Test 3: Duplicate event deduplication
5. Test 4: Batch ingest (10 events)
6. Test 5: Invalid payload rejection
7. Tests 6/6b: Auth failure (missing + wrong key)

**Tests NOT implemented** (4 missing):
- Test 8: CLI emit → backend → Postgres (subprocess test)
- Test 9: CLI emit → queue → drain → Postgres (offline fallback)
- Test 10: Full resilience path (server up → down → queue → restart → drain)
- Test 11: emit wall-clock time <3s with dead backend

**Missing**: `packages/cli/src/__tests__/e2e/emit-pipeline.test.ts` (the CLI-side E2E tests were never created)
**Missing**: `scripts/verify-e2e.sh` (manual verification script was never created)

**This is the biggest shortcut in Phase 1.** The server-side E2E tests are solid, but the CLI E2E tests that verify the full offline/queue/drain path were not implemented. The individual unit tests for emit, queue, and drain exist, but the integrated test that proves the complete resilience path (emit → queue → drain → Postgres) was never built.

---

## Shortcuts and Deviations Summary

### Significant Shortcuts

1. **Missing CLI E2E tests (Task 14)**: The 4 CLI-side E2E tests were not implemented. This leaves the offline queue → drain → Postgres path untested at the integration level. Unit tests exist but don't prove the full path works end-to-end.

2. **Missing `scripts/verify-e2e.sh`**: The manual verification script specified in Task 14 was never created.

3. **Tasks 1-5 batched in one commit**: While not a code shortcut, it makes it harder to bisect issues in the foundational code.

### Minor Shortcuts

4. **Device resolver defaults to "unknown-device"**: Events from uninitialized devices create rows with generic names instead of rejecting the event.

5. **Emit command doesn't validate event type locally**: Casts the string to EventType without checking it's valid.

6. **`duplicates` always 0 in ingest response**: Not actually counted at the ingest level (dedup happens downstream). The field exists for API compatibility.

7. **Consumer dead-letters via logging only**: No dead-letter stream or table — failed events are logged and acknowledged.

### Things That Were Fixed During Implementation

8. **Dual Redis clients** (discovered in Task 14): The original Task 6 spec didn't mention needing separate Redis clients. During E2E testing, it was discovered that sharing a single client causes health check PINGs to queue behind the blocked XREADGROUP command. The fix (two clients) was applied in the Task 14 commit.

---

## Test Coverage Summary

| Package | Test Files | Approx Lines |
|---------|-----------|--------------|
| `shared` | `canonical.test.ts`, `schemas.test.ts` | 345 |
| `server/db` | `migrator.test.ts` | 211 |
| `server/redis` | `stream.test.ts` | 348 |
| `server/middleware` | `auth.test.ts` | 143 |
| `server/routes` | `events.test.ts` | 378 |
| `server/pipeline` | `consumer.test.ts` | 545 |
| `server/e2e` | `pipeline.test.ts` | 515 |
| `core` | `workspace-resolver.test.ts`, `device-resolver.test.ts`, `event-processor.test.ts` | 1,022 |
| `cli` | `config.test.ts`, `queue.test.ts`, `emit.test.ts`, `drain.test.ts`, `hooks.test.ts` | 1,993 |
| `hooks` | `resolve-workspace.test.ts` | 155 |
| **Total** | **17 test files** | **~5,655 lines** |

---

## Architecture Assessment

### What Was Done Well

1. **Clean separation of concerns**: `core/` has no HTTP/UI knowledge. `server/` exposes API. `cli/` is a consumer. This matches the spec's "UI swappability" requirement perfectly.

2. **Dependency injection everywhere**: `createApp(deps)`, `startConsumer(deps, overrides)`, resolvers accept `sql` — everything is testable without live services.

3. **Atomic operations**: Queue writes use tmp+rename. Postgres upserts use ON CONFLICT. Dedup uses event ULID as PK.

4. **Forward-looking schema**: Sessions table includes columns for transcript parsing, token counting, and cost estimation that Phase 3+ will populate. No ALTER TABLE needed for the analysis layer.

5. **Error resilience**: emit always exits 0, hooks background the TS helper, consumer survives Redis reconnection, queue drainer handles corrupted files.

6. **Two Redis clients**: The bug fix for blocking XREADGROUP was caught and fixed during E2E testing. The final architecture is correct.

### What Could Be Improved

1. **CLI E2E coverage gap**: The offline path (emit → queue → drain → Postgres) has no integration-level test.

2. **No `ingested_at` field in Zod schema**: The `eventSchema` doesn't include `ingested_at` but the Event interface does. The server sets it at ingest time (line 104 of events.ts), but the type mismatch between the Zod schema and the TS interface could cause confusion.

3. **Hook PATH dependency**: The bash hooks assume `bun` is available in the shell's PATH, which may not be true in all environments.

---

## Files to Inspect for Each Task

For future reference, here are the primary files per task:

- **Task 1**: Root `package.json`, `bunfig.toml`, `tsconfig.base.json`, per-package configs
- **Task 2**: `packages/shared/src/` (types, schemas, canonical, errors, ulid)
- **Task 3**: `packages/server/src/db/` (postgres.ts, migrator.ts, migrations/001_initial.sql)
- **Task 4**: `packages/server/src/redis/` (client.ts, stream.ts, index.ts)
- **Task 5**: `packages/cli/src/` (index.ts, commands/init.ts, commands/status.ts, lib/config.ts)
- **Task 6**: `packages/server/src/` (app.ts, index.ts, logger.ts, middleware/, routes/health.ts)
- **Task 7**: `packages/core/src/` (workspace-resolver.ts, device-resolver.ts, workspace-device-link.ts)
- **Task 8**: `packages/server/src/routes/events.ts`
- **Task 9**: `packages/core/src/` (event-processor.ts, handlers/)
- **Task 10**: `packages/cli/src/` (commands/emit.ts, lib/api-client.ts, lib/queue.ts)
- **Task 11**: `packages/server/src/pipeline/` (consumer.ts, wire.ts)
- **Task 12**: `packages/cli/src/` (commands/queue.ts, lib/drain.ts, lib/drain-background.ts)
- **Task 13**: `packages/hooks/claude/` (*.sh, _helpers/*.ts), `packages/cli/src/commands/hooks.ts`
- **Task 14**: `packages/server/src/__tests__/e2e/pipeline.test.ts`, `docker-compose.test.yml`
