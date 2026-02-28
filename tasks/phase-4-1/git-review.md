# Git Commit Review: 72cfa7b..HEAD

**Range**: 21 commits (5f7941d through ac31128)
**Date range**: 2026-02-22 to 2026-02-23
**Reviewer**: Claude Opus 4.6
**Focus**: Production code changes and their implications

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Production Commit Reviews](#production-commit-reviews)
3. [Test & Infrastructure Commits](#test--infrastructure-commits)
4. [Cross-Cutting Concerns](#cross-cutting-concerns)
5. [Risk Assessment](#risk-assessment)

---

## Executive Summary

This range covers a concentrated 2-day burst of work spanning three major themes:

1. **Hook architecture overhaul** (3a5aec3 -> 7e0010d -> 35f9a9e): Shell script hooks replaced with inline CLI commands, migrated from the `Stop` event to `SessionEnd`, and fixed a critical stdin-capture bug for backgrounded processes.

2. **Backfill reliability** (6ad03cd -> ac31128): Backfill moved from sequential to concurrent processing with abort support, rate limit awareness, robust retry logic, and S3 upload resilience.

3. **Data correctness** (33c1e33, cd6aec2, 02f091f, 0c2e17f): Fixed device names defaulting to "unknown-device", allowed dots in device names, replaced inaccurate cost metrics with token counts, and ensured S3 buckets exist at startup.

Overall assessment: The changes are well-motivated and well-commented. The main concerns are around complexity growth in session-backfill.ts and a few edge cases in the stdin capture approach. No showstopper bugs identified.

---

## Production Commit Reviews

### 1. `5f7941d` -- fix: correct server start command to run from packages/server/ for dotenv

**What changed**: README.md updated to use `cd packages/server && bun run src/index.ts` instead of `bun run packages/server/src/index.ts` from the repo root.

**Problem solved**: `dotenv/config` loads `.env` from `process.cwd()`, not the script's directory. Running from the repo root meant `packages/server/.env` was never loaded, causing missing env vars at startup.

**Concerns**: None. Documentation-only change. Correct fix for a real operational problem.

---

### 2. `cd6aec2` -- fix: allow dots in device name validation

**What changed**: Single-character regex change in `packages/cli/src/commands/init.ts`. `DEVICE_NAME_REGEX` changed from `/^[a-zA-Z0-9_-]{1,64}$/` to `/^[a-zA-Z0-9._-]{1,64}$/`.

**Problem solved**: macOS hostnames (e.g., `Johns-MacBook-Pro.local`) contain dots, so the device name validation was rejecting perfectly valid machine names.

**Concerns**: None. Minimal, targeted fix. The dot character is safe in all contexts where device names are used (URLs, filenames, DB values).

---

### 3. `6982dad` -- feat: dispatch to repo-local git hooks when core.hooksPath is set

**What changed**: All four git hook scripts (`post-commit`, `post-checkout`, `post-merge`, `pre-push`) now check for and dispatch to repo-local `.git/hooks/<hook>` scripts before running the fuel-code logic. A deduplication guard (`head -5 | grep "fuel-code:"`) prevents double execution if the local hook is also a fuel-code hook. Pre-push respects the local hook's exit code (can block the push). Tests added: 4 new test cases covering dispatch, skip-on-duplicate, blocking, and no-local-hook scenarios.

**Problem solved**: When fuel-code sets `core.hooksPath` globally, git completely ignores per-repo `.git/hooks/` scripts. This breaks projects that have their own hooks (linters, formatters, etc.). The fix manually dispatches to local hooks to restore expected behavior.

**Concerns**:
- **Minor**: The `head -5 | grep -q "fuel-code:"` check looks for the string "fuel-code:" in the first 5 lines. If a third-party hook happened to contain "fuel-code:" in its first 5 lines (unlikely but possible), it would be incorrectly skipped. The marker could be more specific (e.g., a UUID-based comment marker).
- **Minor**: `REPO_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)` will resolve to `.git` in most cases, but in worktree scenarios it may point elsewhere. This should still work correctly since worktrees have their own `.git` file that points to the main repo's `.git/worktrees/<name>`, but the hooks dir is typically in the main `.git/hooks/`. This edge case may mean repo-local hooks don't fire in worktrees. Low risk but worth noting.
- **Good**: The `|| true` on post-* hooks means they can never break git operations. Pre-push correctly propagates non-zero exit codes.

---

### 4. `3a5aec3` -- refactor: replace shell script hooks with inline cc-hook CLI commands

**What changed**: Major refactor. Created new `packages/cli/src/commands/cc-hook.ts` (298 lines) containing `session-start` and `session-end` subcommands. `hooks.ts` updated to register inline `bash -c 'fuel-code cc-hook session-start &'` commands in `settings.json` instead of referencing external shell scripts. Added `resolveCliCommand()` to find the fuel-code binary (global or via `bun run`). Workspace resolution logic inlined from the hooks package. `isFuelCodeHookCommand()` replaces the old string-marker approach for identifying fuel-code hooks.

**Problem solved**: Previously, CC hooks referenced absolute paths to shell scripts in the source repo. This was fragile -- if the repo moved, hooks broke. Now the CLI is self-contained; settings.json just calls `fuel-code cc-hook ...` directly.

**Concerns**:
- **Medium**: In `session-end`, the transcript upload is done via a detached `Bun.spawn()` with `stdout: "ignore", stderr: "ignore"`. This means upload failures are completely invisible -- no logs, no retries. (This was fixed in 02f091f.)
- **Minor**: `resolveCliCommand()` falls back to `bun run "${escaped}"` with the current script path. If `bun` is not on PATH in the hook execution context, this will fail silently (which is the correct behavior for hooks, but makes debugging hard).
- **Good**: The `overrideCliCommand()` and `overrideSettingsPath()` test seams are clean and don't pollute production code.

---

### 5. `7e0010d` -- refactor: migrate CC hook from Stop to SessionEnd

**What changed**: All references to the CC `Stop` event replaced with `SessionEnd` across hooks.ts, cc-hook.ts, status.ts, README.md, and tests. Added `mapSessionEndReason()` function that maps `SessionEnd`'s reason values (`prompt_input_exit`, `clear`, `logout`) to fuel-code's end_reason enum. Changed from reading `context.end_reason` to `context.reason`.

**Problem solved**: The `Stop` hook fires on every turn/stop, not just session termination. `SessionEnd` fires exactly once when the session actually terminates, which is what fuel-code needs. This eliminates spurious session.end events and duplicate processing.

**Concerns**:
- **Minor**: The `mapSessionEndReason()` function has a limited mapping. If Claude Code adds new reason values in the future, they'll all map to "exit" via the default case. This is safe but could lose information. Consider logging unknown reasons for observability.
- **Good**: Clean migration. No behavioral regressions. Tests thoroughly updated.

---

### 6. `0c2e17f` -- fix: ensure S3 bucket exists at server startup

**What changed**: Added `ensureBucket()` method to the S3 client that calls `HeadBucket` and, if 404/NotFound, calls `CreateBucket`. Called during server startup (`packages/server/src/index.ts`) before routes are registered. Tests added for both the happy path and error cases.

**Problem solved**: Transcript uploads were failing with `NoSuchBucket` because the `fuel-code-blobs` bucket was never created in LocalStack. This is a first-run setup issue that blocked the entire pipeline.

**Concerns**:
- **Minor**: In production (real S3), auto-creating buckets may not be desirable -- IAM policies might not grant `s3:CreateBucket`, and bucket naming/region decisions should be deliberate. The current code will throw if HeadBucket fails for non-404 reasons (permissions, network), which is correct. But a comment noting this is primarily for local development would clarify intent.
- **Good**: The method is idempotent and well-tested.

---

### 7. `02f091f` -- fix: replace cost display with tokens and fix silent transcript upload

**What changed**: Two changes in one commit:

1. **Token display**: Replaced `formatCost()` with `formatTokensCompact()` across 26 files. Sessions table, status, timeline, workspaces, TUI components all now show "125K/48K" (tokens in/out) instead of "$0.42". Added `tokens_in`/`tokens_out` to API client types. Server-side workspace stats endpoint updated to return token aggregates.

2. **Transcript upload fix**: In `cc-hook.ts session-end`, replaced the detached `Bun.spawn()` transcript upload with a direct `await runTranscriptUpload()` call. The function is wrapped to never throw, logging errors to stderr instead.

**Problem solved**: (1) Cost estimates used hardcoded Sonnet pricing, making them wrong for all other models. Token counts are always accurate. (2) Detached Bun.spawn was silently swallowing transcript upload errors, making debugging impossible.

**Concerns**:
- **Minor**: The commit bundles two unrelated fixes. Better as two separate commits for bisectability.
- **Medium (addressed later)**: The `await runTranscriptUpload()` call means the session-end hook now blocks until the upload completes. Since the hook is already backgrounded via `bash -c '... &'`, this is fine for CC (it doesn't wait). But it means the backgrounded process lives longer. This is acceptable.
- **Good**: The `formatTokensCompact()` function is clean and handles edge cases (zero tokens, missing values).

---

### 8. `33c1e33` -- fix: resolve device name on first registration instead of unknown-device

**What changed**: Three files modified:
1. `emit.ts`: Injects `_device_name` and `_device_type` from CLI config into the event data payload.
2. `device-resolver.ts`: UPSERT now includes a `CASE WHEN devices.name = 'unknown-device' AND ${name} != 'unknown-device' THEN ${name} ELSE devices.name END` clause to update the name if it was previously unknown.
3. `event-processor.ts`: Extracts `_device_name` and `_device_type` from event data and passes them as hints to `resolveOrCreateDevice`.

**Problem solved**: Devices were permanently stuck with "unknown-device" as their name because the first event to register the device didn't carry the configured device name. Subsequent events didn't update it.

**Concerns**:
- **Minor**: Using underscore-prefixed keys (`_device_name`, `_device_type`) in the event data payload is a convention for internal metadata. These fields will be stored in the event's JSON `data` column permanently. Not harmful, but slightly inelegant -- they're transport metadata leaking into persisted data. A cleaner approach might strip them after extraction in the event processor.
- **Good**: The SQL UPSERT logic is correct -- it only updates the name if the current value is "unknown-device", preventing overwriting a user-set name.

---

### 9. `35f9a9e` -- fix: capture stdin before backgrounding CC hooks and remove stale Stop hook

**What changed**: Hook commands in `hooks.ts` changed from:
```bash
bash -c 'fuel-code cc-hook session-start &'
```
to:
```bash
bash -c 'data=$(cat); printf "%s" "$data" | fuel-code cc-hook session-start &'
```

Also adds `removeHook(settings.hooks, "Stop")` to clean up stale Stop hooks from pre-migration installs. Drops unused `--session-id` from the test command.

**Problem solved**: Critical bug. When `bash -c '... &'` backgrounds a process, POSIX non-interactive shell behavior redirects stdin from `/dev/null`. Claude Code pipes context JSON to stdin, but the backgrounded fuel-code process never received it. By capturing stdin synchronously with `data=$(cat)` before backgrounding, the data is preserved and piped into the actual command.

**Concerns**:
- **Medium**: The `data=$(cat)` approach reads the entire stdin into a shell variable. For large payloads, this could hit shell variable size limits (though CC context JSON is typically small, <10KB). If CC ever pipes something large (unlikely), this would truncate or fail.
- **Medium**: There's a subtle race: `data=$(cat)` reads until EOF on stdin. If CC doesn't close stdin promptly, the hook will hang waiting for EOF. This depends on CC's hook execution contract. If CC pipes data and then closes the pipe, this is fine. If CC keeps the pipe open, the hook will block indefinitely. The fact that this fix was deployed and worked suggests CC does close the pipe.
- **Minor**: Using `printf "%s" "$data"` instead of `echo "$data"` is correct (avoids echo's `-e`/`-n` interpretation issues). Good defensive coding.
- **Good**: Cleaning up stale Stop hooks is important for users who installed before the SessionEnd migration.

---

### 10. `6ad03cd` -- feat: concurrent backfill with abort support and robust retries

**What changed**: Major overhaul of `session-backfill.ts` (+269/-73 lines) and minor changes to `backfill.ts` CLI command:

1. **Concurrency**: Sessions now processed concurrently via a worker pool (configurable `--concurrency`, default 10). Uses a `Set<Promise>` to track in-flight work with `Promise.race()` to fill slots.
2. **Abort support**: Added `combinedSignal()` merging user abort + timeout, `abortableSleep()` for retry waits, and abort-aware `Promise.race` in the main loop. Ctrl-C cancels in-flight fetches immediately.
3. **Rate limiting**: Shared `rateLimitUntil` timestamp across all workers. When any worker hits 429, all workers pause. `flushEventBatchWithRateLimit()` retries up to 3 times.
4. **Retry improvements**: `uploadTranscriptWithRetry` increased from 3 to 15 retries with exponential backoff + jitter (capped at 10s). Added 429 detection with Retry-After header parsing. Added transient error detection (EAGAIN, ECONNRESET, ETIMEDOUT).
5. **Event batching**: session.end events batched and flushed periodically. session.start events flushed immediately per-session.

**Problem solved**: Sequential backfill was extremely slow for large session histories. The race condition between session.start event emission and transcript upload (via Redis async processing) caused 404 errors. Rate limiting was not handled, causing cascading failures under load.

**Concerns**:
- **Medium**: The `rateLimitUntil` shared state is a simple timestamp. Since JS is single-threaded, concurrent writes are safe. But the pattern of multiple workers checking `if (rateLimitUntil > now)` independently could lead to thundering-herd behavior when the rate limit expires -- all paused workers resume simultaneously. A more sophisticated approach would stagger resumption.
- **Medium**: The `flushInProgress` flag prevents concurrent batch flushes, but if one flush takes a long time, session.end events accumulate unboundedly in the `eventBatch` array. No cap on batch size growth. In practice, the default batch size of 50 and 5-10 concurrency makes this unlikely to be a problem.
- **Minor**: 15 retries with exponential backoff caps at 10s per retry, giving a theoretical max wait of ~90s. This is documented in comments but could surprise users if the Redis consumer is down -- they'd see the backfill "hang" on a single session for 90s before failing.
- **Minor**: The `abortPromise` is created once and never cleaned up. The abort listener stays attached to the signal for the lifetime of the ingestion. Not a leak per se (it's a single listener), but slightly untidy.
- **Good**: The worker pool pattern is clean and avoids the complexity of a full semaphore/queue library. The abort-aware design is thorough -- every sleep, every fetch, every loop check honors the signal.

---

### 11. `ac31128` -- fix: improve backfill resilience against S3 upload failures

**What changed**: Three targeted fixes:
1. `session-backfill.ts`: Added HTTP 503 to the list of retryable errors.
2. `transcript-upload.ts` (server): Changed from streaming `req` directly to S3 to buffering the entire request body first, then uploading the buffer.
3. `backfill.ts`: Lowered default concurrency from 10 to 5.

**Problem solved**: S3 upload failures were surfacing as 503 errors but weren't being retried. Streaming uploads were fragile because a client disconnect mid-stream could corrupt the S3 upload. High concurrency (10) with streaming uploads was causing resource contention.

**Concerns**:
- **Medium**: Buffering the entire request body into memory before uploading to S3 trades streaming efficiency for reliability. The comment notes memory is bounded by `MAX_UPLOAD_BYTES` (200MB), which is the per-request limit. Under 5 concurrent uploads, worst case is 1GB memory usage. For a single-user system this is probably fine, but the 200MB limit is very generous for transcript files. Consider whether a lower limit (e.g., 50MB) would be more appropriate.
- **Minor**: The change from `s3.uploadStream()` to `s3.upload()` means the entire file is held in memory twice briefly (once as chunks array, once as concatenated buffer). For large files, this doubles peak memory.
- **Good**: Lowering default concurrency from 10 to 5 is a pragmatic adjustment based on observed behavior.

---

## Test & Infrastructure Commits

### `e8108bc` -- fix: e2e test cleanup with ref counting and targeted teardown
Added `cleanFixtures()` that deletes test data by known IDs instead of TRUNCATE, plus a `_e2e_refs` reference-count table so only the last parallel test file performs cleanup. Prevents cross-test data leakage.

### `af9d934` -- test: fix 3 broken emit tests + add 26 cc-hook tests + 11 backfill tests + device hint tests + Stop cleanup test
Large test commit (1127 insertions). Fixed emit tests broken by device hint injection. Comprehensive unit test coverage for the new cc-hook.ts, ingestBackfillSessions, and event-processor device hint extraction.

### `f09327c` -- docs: add E2E test gap coverage design
Design document for three E2E test gaps.

### `d3fad89` -- test: add targeted cleanup helper for E2E tests
`cleanup.ts` utility for deleting test rows by known IDs from multiple tables.

### `2c403f1` -- test: add S3-enabled setup for CLI E2E tests
`setup-s3.ts` providing test infrastructure for S3-dependent E2E tests.

### `478c66a` -- test: add Phase 4 CLI pipeline E2E with S3 (Gap 1)
Full pipeline E2E test: emit -> ingest -> Redis -> process -> S3 upload -> verify. Added `@aws-sdk/client-s3` as devDependency for direct S3 verification.

### `801c77b` -- test: add hooks-to-pipeline E2E with real Claude Code session (Gap 2)
E2E test spawning a real `claude -p` session with hooks, verifying session appears in Postgres. Skipped when `ANTHROPIC_API_KEY` not set.

### `d0af73f` -- test: add backfill ingestion E2E against real server (Gap 3)
E2E test for the full backfill pipeline against real Postgres, Redis, and LocalStack S3. Discovered and fixed two bugs: session-start schema rejected backfill events (missing "backfill" source enum, non-nullable cc_version), and session_id FK violation on start events.

### `46053e8` -- refactor: use Claude Agent SDK for hooks E2E test with full isolation
Replaced broken `spawn("claude -p")` approach with the Agent SDK's `query()` function for in-process execution. Added `@anthropic-ai/claude-agent-sdk` as devDependency.

### `20fc53f` -- chore: update .env.example with S3, Anthropic config and port 3020
Updated `.env.example` template.

### `664496b` -- docs: update README setup flow for bun link and cc-hook refactor
README updates reflecting the new hook architecture.

---

## Cross-Cutting Concerns

### 1. session-backfill.ts Complexity
This file has grown significantly across 6ad03cd and ac31128. It now handles concurrency, abort signaling, rate limiting, retry logic with multiple error classes, shared state across workers, and batch flushing. The file is becoming a candidate for decomposition into smaller modules (e.g., `backfill-worker.ts`, `retry-policy.ts`, `rate-limiter.ts`).

### 2. Convention for Internal Event Data
The `_device_name`/`_device_type` pattern (33c1e33) establishes a convention of underscore-prefixed keys for transport metadata in event data. This should be documented and consistently applied. These fields probably should be stripped before persistence to avoid polluting the event data column.

### 3. Hook Execution Model
The final hook execution model (`data=$(cat); printf "%s" "$data" | fuel-code cc-hook ... &`) is functional but depends on:
- CC closing stdin promptly
- Shell variable size being sufficient for the context JSON
- `fuel-code` being on PATH or `bun` being available

These assumptions should be documented.

### 4. Migration Path
The Stop -> SessionEnd migration (7e0010d + 35f9a9e) includes cleanup of stale Stop hooks on install. Users who don't re-run `hooks install` will keep the old Stop hooks, which will keep firing on every turn. The hook command itself won't crash (it just emits session.end), but it will create duplicate/spurious events. Consider adding a warning in `hooks status` if a stale Stop hook is detected.

---

## Risk Assessment

| Concern | Severity | Commit | Notes |
|---------|----------|--------|-------|
| Buffered uploads use up to 200MB/req memory | Medium | ac31128 | Bounded by MAX_UPLOAD_BYTES; consider lowering |
| stdin capture shell variable size limits | Low | 35f9a9e | CC context JSON is typically small |
| stdin capture depends on CC closing pipe | Low | 35f9a9e | Works in practice; no evidence of issues |
| _device_name/_device_type persisted in event data | Low | 33c1e33 | Functional but slightly inelegant |
| Thundering herd on rate limit expiry | Low | 6ad03cd | JS single-threaded; workers resume in sequence |
| session-backfill.ts growing complexity | Low | 6ad03cd+ac31128 | Works now but harder to maintain over time |
| Stale Stop hooks on non-upgraded installs | Low | 7e0010d | Will cause spurious session.end events |
| head -5 grep for hook dedup could false-positive | Very Low | 6982dad | Requires "fuel-code:" in first 5 lines of 3rd-party hook |

**Overall**: No blocking issues. The codebase has improved materially in reliability (retry logic, abort support, S3 resilience) and correctness (SessionEnd migration, device names, token counts). The main technical debt is the growing complexity of session-backfill.ts, which should be addressed proactively before the next round of changes.
