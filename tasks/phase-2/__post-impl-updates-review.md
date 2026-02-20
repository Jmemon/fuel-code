# Phase 2 Post-Implementation Updates

## Context

After completing Phase 2 (12 tasks across commits 03cb16c..f8b4241), two review documents were produced:

1. **`tasks/phase-2-implementation-review.md`** — Found 7 implementation issues (5 fixable, 1 intentional deferral, 1 spec issue for Phase 3)
2. **`tasks/phase-2-downstream-review.md`** — Analyzed downstream impact on Phases 3-7, found 1 critical issue (git correlation) and 3 low-severity issues

This document covers all changes made to resolve those issues, plus build system fixes discovered during the process.

---

## Part 1: Phase 2 Issue Fixes (commit 88a5fd5)

### Fix 1: Pipeline Queue Not Wired Into Server (Issue #1, Medium)

**Problem**: `createPipelineQueue()` was defined in core but never instantiated. All pipeline callers (transcript upload, session.end handler, reparse endpoint, recovery) called `runSessionPipeline()` directly with unbounded concurrency. During backfill of 500 sessions, this could spawn 500 parallel pipeline runs.

**Fix**:
- Added optional `enqueueSession?: (sessionId: string) => void` to `PipelineDeps` interface (`session-pipeline.ts`)
- Created queue in `server/src/index.ts`: `createPipelineQueue(3)` with `pipelineDeps.enqueueSession` wired in
- Added queue drain to shutdown sequence (before consumer.stop())
- All 4 pipeline call sites now use a `triggerPipeline()` helper that prefers the queue and falls back to direct call (for tests without queue):
  - `transcript-upload.ts`
  - `session-actions.ts` (reparse)
  - `session-end.ts` handler
  - `session-recovery.ts`

### Fix 2: Transcript Upload Buffered 200MB in Memory (Issue #2, Medium)

**Problem**: `express.raw({ limit: "200mb" })` middleware buffered the entire transcript body into memory before uploading to S3.

**Fix**:
- Added `uploadStream(key, stream, contentLength, contentType)` method to `FuelCodeS3Client` interface and implementation in `aws/s3.ts`
- Rewrote `transcript-upload.ts`: removed `express.raw()` middleware, streams `req` (a Node Readable) directly to S3's `PutObjectCommand`
- Added `Content-Length` header validation (required, max 200MB)
- Updated test: added `uploadStream` mock to `createMockS3()`, updated empty-body test expectation

### Fix 3: Backfill Event Ordering Bug (Issue #3, Critical)

**Problem**: `ingestBackfillSessions()` uploaded transcripts before emitting session.start events. The upload endpoint returns 404 because the session row doesn't exist yet (session.start handler creates it).

**Fix**:
- Reordered: emit session.start event first, flush immediately, then upload transcript
- Added `uploadTranscriptWithRetry()` with exponential backoff (3 retries, 1s/2s/3s delays) on 404 responses, to handle race conditions between event processing and upload

### Fix 4: No Summary Retry for Parsed Sessions (Issue #4, Low)

**Problem**: Sessions that complete parsing but fail summary generation stay at `lifecycle = 'parsed'` with no automatic retry. Over time these accumulate.

**Fix**:
- Added `recoverUnsummarizedSessions()` to `session-recovery.ts`
- Query: `lifecycle = 'parsed' AND parse_status = 'completed' AND summary IS NULL AND updated_at < now() - interval`
- Wired into server startup recovery sweep in `server/src/index.ts`

### Fix 5: Backup Key Built With Fragile Regex (Issue #6, Low)

**Problem**: `transcriptKey.replace(/raw\.jsonl$/, "parsed.json")` would silently produce wrong keys if the transcript key format changed.

**Fix**:
- Replaced with `buildParsedBackupKey()` from `@fuel-code/shared` (same module that builds all S3 key paths)

### Not Fixed (By Design)

- **Issue #5 (Intentional)**: Transcript messages not exposed via WebSocket. Deferred to Phase 4 (WebSocket is a Phase 4 deliverable).
- **Issue #7 (Phase 3 Spec)**: Git correlation queries `lifecycle = 'capturing'` but sessions never reach that state. Fix specified in downstream review: Phase 3 Task 3 must use `lifecycle IN ('detected', 'capturing')`.

---

## Part 2: Build System Fixes (uncommitted)

### Problem

After the Phase 2 fixes were committed, `git status` showed dozens of uncommitted `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` files inside `packages/core/src/`. These were build artifacts that `tsc` was emitting directly alongside the source TypeScript files, instead of into `dist/`.

**Root cause**: The build scripts used plain `tsc` instead of `tsc -b` (build mode). With TypeScript project references (`references` in tsconfig) and `composite: true`, plain `tsc` does not properly respect `outDir` and can emit artifacts in-place. `tsc -b` is the correct invocation for project reference builds.

### Changes Made

#### Build Scripts: `tsc` -> `tsc -b`

Changed all 4 packages from `"build": "tsc"` to `"build": "tsc -b"`:

| Package | File |
|---------|------|
| `@fuel-code/shared` | `packages/shared/package.json` |
| `@fuel-code/core` | `packages/core/package.json` |
| `@fuel-code/server` | `packages/server/package.json` |
| `@fuel-code/cli` | `packages/cli/package.json` |

#### TypeScript Configuration

**All package tsconfigs** (`packages/*/tsconfig.json`):
- Added `"composite": true` — required for `tsc -b` and project references
- Added `"exclude": ["src/**/__tests__"]` — prevents test files from being compiled to `dist/`, which caused bun test to discover and run duplicate tests from both `src/` and `dist/`

**CLI tsconfig** (`packages/cli/tsconfig.json`):
- Added missing `{ "path": "../core" }` to `references` array — CLI imports from `@fuel-code/core` but didn't declare the project reference, causing `tsc -b` to follow the `paths` mapping directly into core's source and hit `rootDir` constraint errors

**`tsconfig.base.json`**: No changes (the base config with `paths`, `strict`, `declaration`, etc. is unchanged).

#### Pre-Existing Type Errors Fixed

`tsc -b` requires a clean build (zero errors) before emitting output. The codebase had pre-existing type errors that `bun` ignores at runtime. All fixes are minimal type-level changes — no runtime behavior changed.

**postgres.js TransactionSql typing** (3 files):
- `packages/core/src/session-lifecycle.ts:328` — `sql.begin(async (tx: any) => { ... })`
- `packages/core/src/session-pipeline.ts:184` — `sql.begin(async (tx: any) => { ... })`
- `packages/server/src/db/migrator.ts:89` — `sql.begin(async (tx: any) => { ... })`

The `TransactionSql` type from postgres.js v3 is missing the template literal call signature that `Sql` has. At runtime, `tx` supports tagged template literals identically to `sql`. This is a known postgres.js typing gap. The `tx: any` annotation sidesteps it.

**postgres.js sql.unsafe() parameter types** (3 sites):
- `packages/core/src/session-lifecycle.ts:187` — `values as any[]`
- `packages/core/src/session-pipeline.ts:388` — `values as any[]`
- `packages/core/src/session-pipeline.ts:443` — `values as any[]`

`sql.unsafe()` expects `ParameterOrJSON<never>[]` but the dynamically-built `values` arrays are `unknown[]`. The cast is safe — these are SQL parameter values built inline.

**Anthropic SDK type** (`packages/core/src/summary-generator.ts:346`):
- Changed `error: Anthropic.APIError` to `error: InstanceType<typeof Anthropic.APIError>`
- `Anthropic.APIError` is a class (value), not a type. Using it directly as a type annotation is a TS error.

**Anthropic SDK headers access** (`packages/core/src/summary-generator.ts:350`):
- Changed `headers["retry-after"]` to `headers.get("retry-after")`
- The `Headers` type doesn't support index signature access; `.get()` is the correct API.

**null vs undefined** (`packages/core/src/session-pipeline.ts:214`):
- Changed `initial_prompt: initialPrompt` to `initial_prompt: initialPrompt ?? undefined`
- `extractInitialPrompt()` returns `string | null` but the transition options field expects `string | undefined`.

**Express v5 req.params type** (2 route files):
- `packages/server/src/routes/session-actions.ts:74` — `req.params.id as string`
- `packages/server/src/routes/transcript-upload.ts:82` — `req.params.id as string`

Express v5's `@types/express` types `req.params[key]` as `string | string[]`. For single `:id` params, the value is always a string.

**catch handler err type** (2 route files):
- `packages/server/src/routes/session-actions.ts:34` — `.catch((err: unknown) => { ... })`
- `packages/server/src/routes/transcript-upload.ts:37` — `.catch((err: unknown) => { ... })`

Added explicit `unknown` type to catch handler parameters to satisfy strict mode.

**Redis xadd return type** (`packages/server/src/redis/stream.ts:156`):
- Changed `return streamId` to `return streamId!`
- `redis.xadd()` returns `string | null` but null only occurs when using `MAXLEN ~ 0` or similar edge cases. The non-null assertion is safe for normal `xadd("*", ...)` usage.

**Event ingest type flow** (`packages/server/src/routes/events.ts`):
- Changed `parsed` type from `{ events: Event[] }` to `ReturnType<typeof ingestRequestSchema.parse>` — Zod-parsed events don't include `ingested_at` (server-side field)
- Changed event push: spread event + add `ingested_at` as a new `Event` object instead of mutating the Zod-parsed object

**PipelineDeps type annotation** (`packages/server/src/index.ts:134`):
- Changed `const pipelineDeps = { ... }` to `const pipelineDeps: PipelineDeps = { ... }` — the inferred type didn't include the optional `enqueueSession` field, so assignment on line 142 failed

**Test file type fixes** (test-only, no runtime impact):
- `packages/core/src/__tests__/session-lifecycle.test.ts:142` — `typeof import("postgres")` (removed `.default`)
- `packages/core/src/__tests__/session-pipeline.test.ts:202` — same
- `packages/core/src/__tests__/session-recovery.test.ts:46` — same
- `packages/server/src/routes/__tests__/session-reparse.test.ts:41` — same
- `packages/server/src/middleware/__tests__/auth.test.ts` — `mock(() => {}) as any as NextFunction` (7 instances)
- `packages/server/src/pipeline/__tests__/consumer.test.ts` — `(overrides._processEvent as any).mockImplementation(...)` (2 instances), `(mock.calls as any[])` (3 instances)
- `packages/server/src/routes/__tests__/transcript-upload.test.ts:253` — `body as BodyInit`
- `packages/server/src/__tests__/e2e/phase2-pipeline.test.ts:363` — `body as unknown as BodyInit`
- `packages/cli/src/commands/__tests__/emit.test.ts` — `as unknown as typeof fetch` (13 instances)
- `packages/cli/src/commands/__tests__/transcript.test.ts` — `as unknown as typeof fetch` (3 instances)

#### Stale Artifacts Cleaned

- Deleted all `.js`, `.d.ts`, `.js.map`, `.d.ts.map` files from `packages/core/src/` and `packages/core/src/handlers/`
- Deleted all `packages/*/dist/` directories (rebuilt fresh)
- Deleted all `tsconfig.tsbuildinfo` files (rebuilt fresh)

---

## Part 3: Verification

### Build

All 4 packages build cleanly with `tsc -b --force`:

```
shared  → 0 errors, output in dist/
core    → 0 errors, output in dist/
server  → 0 errors, output in dist/
cli     → 0 errors, output in dist/
```

Zero build artifacts in any `src/` directory. Test files (`__tests__/`) excluded from compilation.

### Tests

```
393 pass
 64 skip
  0 fail
457 tests across 30 files [6.67s]
```

The 64 skipped tests are DB integration tests that require a running PostgreSQL instance (port 5433). The 2 E2E tests (requiring Docker) are excluded from the standard test run.

Test count matches exactly pre-change (457 tests / 30 files), confirming no duplicate test discovery from `dist/`.

---

## Summary of All Changed Files

| File | Change Type | Category |
|------|------------|----------|
| `tsconfig.base.json` | (unchanged) | — |
| `packages/shared/tsconfig.json` | added composite, exclude | Build config |
| `packages/shared/package.json` | tsc -> tsc -b | Build config |
| `packages/core/tsconfig.json` | added composite, exclude | Build config |
| `packages/core/package.json` | tsc -> tsc -b | Build config |
| `packages/server/tsconfig.json` | added composite, exclude | Build config |
| `packages/server/package.json` | tsc -> tsc -b | Build config |
| `packages/cli/tsconfig.json` | added composite, exclude, core ref | Build config |
| `packages/cli/package.json` | tsc -> tsc -b | Build config |
| `packages/core/src/session-lifecycle.ts` | tx typing, unsafe cast | Type fix |
| `packages/core/src/session-pipeline.ts` | tx typing, unsafe cast, null coalesce | Type fix |
| `packages/core/src/summary-generator.ts` | APIError type, headers.get | Type fix |
| `packages/server/src/index.ts` | PipelineDeps type annotation | Type fix |
| `packages/server/src/routes/events.ts` | parsed type, event spread | Type fix |
| `packages/server/src/routes/session-actions.ts` | params cast, err type | Type fix |
| `packages/server/src/routes/transcript-upload.ts` | params cast, err type | Type fix |
| `packages/server/src/redis/stream.ts` | non-null assertion | Type fix |
| `packages/server/src/db/migrator.ts` | tx typing | Type fix |
| `packages/core/src/__tests__/session-lifecycle.test.ts` | postgres import type | Test type fix |
| `packages/core/src/__tests__/session-pipeline.test.ts` | postgres import type | Test type fix |
| `packages/core/src/__tests__/session-recovery.test.ts` | postgres import type | Test type fix |
| `packages/server/src/middleware/__tests__/auth.test.ts` | mock cast | Test type fix |
| `packages/server/src/pipeline/__tests__/consumer.test.ts` | mock casts | Test type fix |
| `packages/server/src/routes/__tests__/session-reparse.test.ts` | postgres import type | Test type fix |
| `packages/server/src/routes/__tests__/transcript-upload.test.ts` | body cast | Test type fix |
| `packages/server/src/__tests__/e2e/phase2-pipeline.test.ts` | body cast | Test type fix |
| `packages/cli/src/commands/__tests__/emit.test.ts` | fetch mock casts | Test type fix |
| `packages/cli/src/commands/__tests__/transcript.test.ts` | fetch mock casts | Test type fix |

---

## Remaining Known Issues

1. **CORE.md deleted from git tracking** — The file was moved to `tasks/CORE.md`. Git shows it as deleted + untracked. Needs to be committed as a move or the deletion reverted.

2. **`dist/` directories are gitignored** — The root `.gitignore` has `dist/`. Build artifacts are ephemeral and don't need to be committed. This is correct behavior.

3. **Pre-existing E2E tests require Docker** — 2 E2E tests in `packages/server/src/__tests__/e2e/` require PostgreSQL (5433) and Redis (6380). These aren't run in the standard test suite.
