# Backfill Live Session Detection — Design

**Date:** 2026-03-02

## Problem

`scanForSessions` uses `isSessionActiveAsync` to skip transcripts that belong to
currently-running Claude sessions. That function has two stages:

1. **Stage 1 (exit tag):** read the last 4 lines of the JSONL; if
   `<command-name>/exit</command-name>` is present the session closed gracefully —
   return `false` (not active).
2. **Stage 2 (lsof on file):** run `lsof <transcriptPath>`; if any process has the
   file open return `true` (active).

Stage 2 is broken. Claude Code opens the transcript, appends one event, and immediately
closes it. The file is never held open between events, so `lsof` always exits non-zero
and every session appears inactive — including ones that are currently running.

## Solution

Replace Stage 2 with **process-to-session timestamp correlation**:

1. Find all running Claude processes via `pgrep`.
2. For each PID, resolve its working directory and process start time.
3. Locate the JSONL in the matching project directory whose first-event timestamp is
   closest to the process start time.
4. Build a `Set<sessionId>` of live sessions before the Phase B scan loop.
5. In the scan loop, check the set instead of calling `lsof`.

Stage 1 (exit tag) is preserved as an override: a transcript with `/exit` in its tail
is always treated as closed, even if a matching process is found.

## Fallback

When process detection fails for any reason (pgrep/lsof/ps unavailable, permission
error, no match found), the session is **not** added to the active set and proceeds to
ingest normally (Option A). A partially-ingested active session is non-destructive.

## Architecture

### New function: `buildActiveSessions`

```typescript
export async function buildActiveSessions(projectsDir: string): Promise<Set<string>>
```

**Steps:**

1. `pgrep -x claude` → array of PIDs. Empty/failed → return empty Set immediately.
2. For each PID (in parallel, errors silently swallowed per-PID):
   - `lsof -p <pid> -a -d cwd` → parse the `cwd` line, take the last token as the path.
   - Encode CWD: `cwd.replace(/[/.]/g, '-')` → expected project dir name.
     - Note: Claude encodes path separators and dots to `-`. Additional unknown
       characters may also be encoded; if the encoded path doesn't match an existing
       directory the PID is skipped silently.
   - `path.join(projectsDir, encodedCwd)` → verify dir exists; skip if not.
   - `ps -p <pid> -o lstart=` → parse macOS lstart (`"Mon Jan 19 10:30:00 2026"`)
     to epoch via `new Date(lstart).getTime() / 1000`. On failure: `procStart = null`.
   - Read top-level `*.jsonl` files in the project dir (UUID filenames only).
   - For each candidate JSONL: read first line, parse `timestamp` ISO field → epoch.
   - Best match = candidate with minimum `|first_ts - procStart|`, require diff < 300s.
     If `procStart` is null, take the most-recently-modified JSONL as fallback.
   - If match found → `active.add(sessionId)`.
3. Return the Set.

**Private helpers** (each swallows its own errors):

- `getClaudePids(): Promise<number[]>`
- `getProcessCwd(pid: number): Promise<string | null>`
- `getProcessStartEpoch(pid: number): Promise<number | null>`
- `getJsonlFirstTimestamp(jsonlPath: string): number | null`

### Changes to `scanForSessions`

One call before Phase B:

```typescript
const activeSessions = await buildActiveSessions(projectsDir);
```

**Session worker loop** — replace `isSessionActiveAsync(item.entryPath)` with:

```typescript
const tail = readTailLines(item.entryPath, 4);
const sessionClosed = tail.includes("<command-name>/exit</command-name>");
if (!sessionClosed && activeSessions.has(item.sessionId)) {
  result.skipped.potentiallyActive++;
  sessionFilesProcessed++;
  options?.onProgress?.(...);
  continue;
}
```

**Subagent worker loop** — replace `isSessionActiveAsync(item.saPath)` with:

```typescript
const tail = readTailLines(item.saPath, 4);
const sessionClosed = tail.includes("<command-name>/exit</command-name>");
if (!sessionClosed && activeSessions.has(item.parentSessionId)) {
  result.skipped.activeSubagents++;
  continue;
}
```

(`item.parentSessionId` is already available on `PendingSubagent`.)

### Changes to `isSessionActive` / `isSessionActiveAsync`

Stage 2 (lsof on the transcript file) is removed. Both functions become exit-tag-only
checks. The scan loop no longer calls them — the two-stage logic is inlined directly
using `readTailLines` + the active set. Docstrings updated accordingly.

### Exports

`buildActiveSessions` is added to `packages/core/src/index.ts`.

### Tests

- `isSessionActive` / `isSessionActiveAsync` test comments updated (remove lsof
  references; "no exit tag → not active" cases still pass with Stage 2 removed).
- New unit tests for `buildActiveSessions`: mock the exec-based helpers, verify correct
  sessionId returned when timestamps align, empty Set returned when pgrep fails, no
  throw when per-PID lsof fails.
- New unit tests for private helpers (exported for test access if needed).

### Files changed

| File | Change |
|------|--------|
| `packages/core/src/session-backfill.ts` | Add `buildActiveSessions` + helpers; remove lsof Stage 2 from `isSessionActive`/`isSessionActiveAsync`; update Phase B scan loop |
| `packages/core/src/index.ts` | Export `buildActiveSessions` |
| `packages/core/src/__tests__/session-backfill.test.ts` | Update existing tests; add new tests for `buildActiveSessions` |
| `packages/cli/src/commands/backfill.ts` | No changes |
