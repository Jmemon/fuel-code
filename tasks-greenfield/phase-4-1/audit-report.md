# Phase 4.1 — Code Audit & Quality Review

**Date**: 2026-02-23
**Scope**: All commits since 72cfa7b (Feb 22–23), full workflow validation, edge case testing
**Reviewer**: Claude Opus 4.6
**Environment**: macOS, Docker Compose (Postgres:5433, Redis:6380, LocalStack:4566), Server on port 3020

---

## Table of Contents

1. [Breakage Assessment](#breakage-assessment)
2. [Action Items](#action-items)
3. [README Updates](#readme-updates)
4. [Workflow Validation Results](#workflow-validation-results)
5. [Edge Case Testing](#edge-case-testing)
6. [Production vs Local Gaps](#production-vs-local-gaps)

---

## Breakage Assessment

### CRITICAL — Must Fix Before Phase 5

#### 1. `duration_ms` is always 0 for live sessions

**Files**: `packages/cli/src/commands/cc-hook.ts:168`, `packages/core/src/handlers/session-end.ts:33`

The session-end hook sends `duration_ms: 0` with a comment saying "the server computes actual duration" — but the server handler reads `duration_ms` directly from event data and stores it verbatim. Nobody computes `ended_at - started_at`.

**Impact**: All live sessions show "-" or "0s" for duration. Workspace total time is 0. Timeline duration data is meaningless. Any Phase 5/6 analytics over session duration will be wrong.

**Fix**: In `session-end.ts`, compute duration as `ended_at - started_at` when the incoming `duration_ms` is 0 or missing:
```typescript
const computedDuration = durationMs > 0
  ? durationMs
  : Math.max(0, Date.now() - new Date(session.started_at).getTime());
```

#### 2. `capturing` lifecycle state is never reached

**Files**: `packages/core/src/handlers/session-start.ts:47`

The session-start handler creates sessions with `lifecycle = 'detected'` and nothing ever transitions them to `capturing`. The state machine defines `detected → capturing` as valid, but no code triggers it.

**Impact**: `fuel-code sessions --live` (which filters `lifecycle = capturing`) always returns empty results. The documented lifecycle flow `detected → capturing → ended → ...` is incomplete. Any Phase 5 real-time monitoring that relies on the `capturing` state will have no data.

**Fix**: Either:
- (a) Transition to `capturing` when the first non-start event arrives for a session, OR
- (b) Remove `capturing` from the state machine and document `detected` as the "active" state, updating `--live` to filter on `detected` instead.

Option (b) is simpler and more honest about the current behavior.

---

### HIGH — Should Fix Before Phase 5

#### 3. Backfill `--status` always says "No backfill has been run yet"

Despite hundreds of successfully backfilled sessions, `fuel-code backfill --status` reports no backfill has occurred. The status tracking mechanism doesn't persist across CLI invocations.

**Impact**: Users can't determine whether backfill has run or what its results were. Makes it hard to debug backfill issues.

**Fix**: Persist backfill status (timestamp, session counts, errors) either in a local config file (~/.fuel-code/backfill-status.json) or via a server API endpoint.

#### 4. `_device_name` / `_device_type` leak into persisted event data

**Files**: `packages/cli/src/commands/emit.ts:146-149`, `packages/core/src/event-processor.ts`

The emit command injects `_device_name` and `_device_type` into the event's JSON `data` field. The event processor extracts them but never strips them before persisting. These internal transport hints are stored permanently in the events table.

**Impact**: Pollutes event data with internal metadata. Any export, API response, or Phase 5 analysis will include these artifacts. Not harmful but messy, and grows worse over time.

**Fix**: Strip `_device_name` and `_device_type` from `event.data` in the event processor after extraction:
```typescript
delete eventData._device_name;
delete eventData._device_type;
```

---

### MEDIUM — Fix When Convenient

#### 5. Stale `Stop` hooks on non-upgraded installs

Users who installed hooks before the Stop→SessionEnd migration (commit 7e0010d) and haven't re-run `fuel-code hooks install` still have Stop hooks registered. These fire on every CC turn, emitting spurious `session.end` events.

**Impact**: Duplicate/incorrect session end events, potential pipeline confusion. Only affects users who haven't reinstalled hooks.

**Fix**: Add a warning in `fuel-code hooks status` if a stale Stop hook is detected. The cleanup logic already exists in `hooks install`; users just need to know to run it.

#### 6. API key desync after `fuel-code init --force`

Running `fuel-code init --force` can create a state where the CLI's stored API key doesn't match the server's API_KEY env var (e.g., after server restart with different .env). The init command validates connectivity at init time but there's no persistent check.

**Impact**: All CLI commands silently fail with "Invalid API key" after server restart.

**Fix**: Add a quick health/auth check in the CLI's API client initialization, with a clear error message pointing to `fuel-code init`.

#### 7. `session-backfill.ts` complexity growth

This file has grown to ~1080 lines across commits 6ad03cd and ac31128, handling concurrency, abort signaling, rate limiting, retry logic, shared state, and batch flushing. It works correctly but is becoming hard to reason about.

**Impact**: Increases risk of bugs in future changes. Makes code review harder.

**Fix**: Decompose into smaller modules: `backfill-worker.ts`, `retry-policy.ts`, `rate-limiter.ts`. Not urgent but should happen before the next round of backfill changes.

---

## Action Items

Prioritized for reaching a fully working state for Phase 5:

| # | Priority | Item | Effort | Files |
|---|----------|------|--------|-------|
| 1 | **P0** | Fix `duration_ms: 0` — compute from timestamps in session-end handler | Small | `session-end.ts` |
| 2 | **P0** | Fix `capturing` lifecycle — update `--live` to use `detected` or add transition | Small | `session-start.ts` or `session-lifecycle.ts`, CLI filter |
| 3 | **P1** | Persist backfill status across runs | Medium | `session-backfill.ts`, new status file/endpoint |
| 4 | **P1** | Strip `_device_name`/`_device_type` from persisted event data | Small | `event-processor.ts` |
| 5 | **P1** | Update README to match actual behavior (see section below) | Medium | `README.md` |
| 6 | **P2** | Warn about stale Stop hooks in `hooks status` | Small | `hooks.ts` |
| 7 | **P2** | Add API key validation on CLI startup | Small | API client |
| 8 | **P2** | Decompose `session-backfill.ts` | Medium | New files |
| 9 | **P3** | Lower MAX_UPLOAD_BYTES from 200MB to 50MB | Trivial | `transcript-upload.ts` |
| 10 | **P3** | Add comment about `ensureBucket()` being for local dev | Trivial | `s3.ts` |

---

## README Updates

The following README sections need updates to match actual behavior:

### 1. COST column → TOKENS column

**Section**: Workflow 1 (Health & Status), Workflow 4 (Sessions), Workflow 7 (Timeline), Workflow 8 (Workspaces)

All example outputs showing a `COST` column (e.g., `$0.42`) need to be updated to show `TOKENS` (e.g., `125K/48K`). This was changed in commit 02f091f.

### 2. Session lifecycle display

**Section**: Workflow 4 (Sessions)

Example output shows lifecycle as lowercase text (`summarized`, `ended`). Actual CLI output uses uppercase with checkmarks: `✓ DONE`, `✓ ENDED`. The README examples should match.

### 3. `--live` flag behavior

**Section**: Workflow 4

The `--live` flag documentation implies it shows actively running sessions. In practice it shows nothing because no sessions ever reach `capturing` state. Either fix the lifecycle (Action Item #2) or update the docs to reflect reality.

### 4. Backfill `--status` output

**Section**: Workflow 10 (Backfill)

The documented `--status` output shows detailed statistics. In practice it always says "No backfill has been run yet." Update docs after fixing Action Item #3.

### 5. Duration display

**Section**: Multiple workflows

Example outputs show session durations like `1h 23m`. In practice, live sessions show `-` or `0s` due to the duration bug. Update examples after fixing Action Item #1.

### 6. Missing workflow: transcript upload

The transcript upload endpoint (`POST /api/sessions/:id/transcript/upload`) is a key part of the pipeline but isn't documented as a verifiable workflow. Consider adding it as a workflow or at minimum documenting it in the API reference.

---

## Workflow Validation Results

### Tested Workflows

| # | Workflow | Status | Notes |
|---|----------|--------|-------|
| 1 | Health & Status | **PASS** | Shows tokens instead of cost (correct post-02f091f) |
| 2 | Hook Install/Uninstall | **PASS** | Full install→uninstall→reinstall cycle works |
| 3 | Live Session Detection | **SKIP** | Requires interactive CC session |
| 4 | Session List | **PASS*** | Works but duration shows "-", lifecycle shows "DONE" not "summarized" |
| 5 | Session Detail | **PASS** | Transcript and events render correctly |
| 6 | TUI Navigation | **SKIP** | Requires interactive TUI |
| 7 | Timeline | **PASS** | Filters work (--workspace, --since, --until) |
| 8 | Workspaces | **PASS*** | Works but total time shows "0s" (duration bug) |
| 9 | WebSocket | **SKIP** | Requires WebSocket client |
| 10 | Backfill | **PASS*** | Dry-run works; --status broken (always "no backfill run") |
| 11 | Queue Management | **PASS** | Drain works, dead-letter empty |
| 12 | Export | **PASS** | JSON and Markdown formats both work |
| 13 | Tagging/Reparse | **PASS** | Both work correctly |
| 14 | Config/Init | **SKIP** | Tested partially (init --force caused key desync) |
| 15 | Hooks Test | **PASS*** | Works but test session stays at DETECTED, never reaches CAPTURING |

\* = passes with known issues documented above

### Workflows Not Tested

- **Workflow 3** (Live Session Detection): Requires spawning a real CC session; tested indirectly via E2E test in commit 801c77b
- **Workflow 6** (TUI Navigation): Requires interactive terminal
- **Workflow 9** (WebSocket): Requires WebSocket client; server has the endpoint
- **Workflow 14** (Config/Init): Partially tested; full cycle has key desync risk

---

## Edge Case Testing

| Test | Result | Notes |
|------|--------|-------|
| Nonexistent workspace filter | **PASS** | Returns proper error with list of available workspaces |
| Invalid lifecycle filter | **PASS** | Returns 400 with valid options |
| Nonexistent session ID | **PASS** | Returns clear "not found" error |
| Malformed JSON in `fuel-code emit` | **PASS** | Wraps as `{_raw: ...}`, exits 0, doesn't crash |
| Missing event type argument | **PASS** | Fails with proper error message |
| Custom/unknown event type | **PASS** | Server rejects with validation error; CLI queues locally; exits 0 |
| Bad auth token on API | **PASS** | Returns 401 with clear error |
| Empty transcript upload | **PASS** | Returns 400 "Content-Length header required" |
| Oversized upload (>200MB Content-Length) | **PASS** | Returns 413 with size details |
| Duplicate transcript upload | **PASS** | Returns 200 "already_uploaded" (idempotent) |
| Concurrent CLI commands | **PASS** | No locking issues observed |

---

## Production vs Local Gaps

### 1. S3 Bucket Auto-Creation

`ensureBucket()` calls `CreateBucket` if the bucket doesn't exist. In production AWS, IAM policies may not grant `s3:CreateBucket`. The bucket should be pre-provisioned via IaC (Terraform/CloudFormation).

**Recommendation**: Add a startup flag `--skip-ensure-bucket` or only run `ensureBucket()` when `S3_ENDPOINT` points to localhost/LocalStack.

### 2. No Health Check Auth

The `/health` endpoint is unauthenticated (correct for load balancer probes), but all other endpoints require auth. If the server starts with a wrong/missing `API_KEY`, the health check still passes but nothing works.

**Recommendation**: Add an `/api/auth/verify` endpoint or include an auth status field in the health check response.

### 3. Memory Under Concurrent Load

The buffered transcript upload holds up to 200MB per request in memory. With 5 concurrent uploads (backfill default), worst case is ~1GB. Single-user system makes this unlikely but production should have lower limits.

**Recommendation**: Consider 50MB limit or streaming with chunked upload to S3 using multipart upload API.

### 4. Redis Connection Resilience

No explicit reconnection logic visible in the Redis Streams consumer. If Redis restarts, the consumer may not automatically reconnect and resume processing.

**Recommendation**: Verify Redis client has reconnection enabled (most clients do by default) and add a health check for the consumer.

### 5. No Graceful Shutdown

Server doesn't appear to handle SIGTERM gracefully (drain in-flight requests, flush Redis consumer, close DB pool). On Railway, deploys send SIGTERM before SIGKILL.

**Recommendation**: Add graceful shutdown handler before production deployment.

---

## Companion Documents

- [Git Commit Review](./git-review.md) — Detailed review of all 21 commits with risk assessment

---

*Report generated 2026-02-23*
