# Backfill Live Session Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken per-file `lsof` active-session check in `scanForSessions` with process-to-session timestamp correlation that correctly identifies running Claude instances.

**Architecture:** Before Phase B of `scanForSessions`, call `buildActiveSessions()` once to find all running Claude PIDs, correlate each to its JSONL transcript via CWD + start-time matching, and return a `Set<sessionId>`. In the scan loop, replace the `isSessionActiveAsync` call with a two-stage inline check: exit-tag guard first, then set lookup. The lsof Stage 2 is removed from `isSessionActive`/`isSessionActiveAsync` — it was broken because Claude closes the transcript file after every event write.

**Tech Stack:** TypeScript, bun, Node.js `child_process.exec`, `node:fs`, bun:test

---

### Task 1: Add `selectBestSession` pure function (TDD)

The timestamp-matching logic is the heart of the detection. Implement it as a pure
function so it can be unit-tested without any process mocking.

**Files:**
- Modify: `packages/core/src/session-backfill.ts` (add after `isSessionActiveAsync`, ~line 377)
- Modify: `packages/core/src/__tests__/session-backfill.test.ts` (add after the `isSessionActiveAsync` describe block, ~line 678)

**Step 1: Write the failing tests**

Add this describe block to `session-backfill.test.ts`. Also add `selectBestSession` to the import line at line 20:

```typescript
import { scanForSessions, isSessionActive, isSessionActiveAsync, projectDirToPath, selectBestSession } from "../session-backfill.js";
```

```typescript
// ---------------------------------------------------------------------------
// Tests: selectBestSession
// ---------------------------------------------------------------------------

describe("selectBestSession", () => {
  it("returns the session whose first timestamp is closest to procStart", () => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      { sessionId: "aaa", firstTimestamp: now - 600, mtime: now - 600 },
      { sessionId: "bbb", firstTimestamp: now - 5,   mtime: now - 5 },   // closest
      { sessionId: "ccc", firstTimestamp: now - 200, mtime: now - 200 },
    ];
    expect(selectBestSession(candidates, now)).toBe("bbb");
  });

  it("returns null when no candidate falls within the default 300s threshold", () => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      { sessionId: "aaa", firstTimestamp: now - 600, mtime: now - 600 },
    ];
    expect(selectBestSession(candidates, now)).toBeNull();
  });

  it("falls back to most-recently-modified when procStart is null", () => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      { sessionId: "aaa", firstTimestamp: now - 600, mtime: now - 600 },
      { sessionId: "bbb", firstTimestamp: now - 10,  mtime: now - 10 },  // newest mtime
    ];
    expect(selectBestSession(candidates, null)).toBe("bbb");
  });

  it("returns null for an empty candidates list", () => {
    expect(selectBestSession([], Date.now() / 1000)).toBeNull();
  });

  it("skips candidates with null firstTimestamp when procStart is known", () => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      { sessionId: "aaa", firstTimestamp: null,    mtime: now - 10 },
      { sessionId: "bbb", firstTimestamp: now - 5, mtime: now - 5 },
    ];
    expect(selectBestSession(candidates, now)).toBe("bbb");
  });

  it("accepts a custom threshold", () => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = [
      { sessionId: "aaa", firstTimestamp: now - 20, mtime: now - 20 },
    ];
    // diff is 20s; within 30s threshold → match
    expect(selectBestSession(candidates, now, 30)).toBe("aaa");
    // diff is 20s; outside 10s threshold → null
    expect(selectBestSession(candidates, now, 10)).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd packages/core && bun test 2>&1 | grep -E "selectBestSession|\(fail\)|\(pass\)" | head -20
```

Expected: all `selectBestSession` tests `(fail)` with "selectBestSession is not a function".

**Step 3: Implement `selectBestSession` in `session-backfill.ts`**

Add this exported function after `isSessionActiveAsync` (around line 377). The function is
pure — no I/O, no exec calls:

```typescript
/**
 * Given candidate JSONLs (with their first-event timestamps and mtimes) and
 * the process start epoch, return the session ID whose first-event timestamp
 * is closest to procStart within thresholdSeconds.
 *
 * Falls back to the most-recently-modified candidate when procStart is null
 * (ps failed to provide a start time).
 *
 * Exported for unit testing.
 */
export function selectBestSession(
  candidates: Array<{ sessionId: string; firstTimestamp: number | null; mtime: number }>,
  procStart: number | null,
  thresholdSeconds = 300,
): string | null {
  if (candidates.length === 0) return null;

  if (procStart !== null) {
    let best: { sessionId: string; diff: number } | null = null;
    for (const c of candidates) {
      if (c.firstTimestamp === null) continue;
      const diff = Math.abs(c.firstTimestamp - procStart);
      if (diff <= thresholdSeconds && (best === null || diff < best.diff)) {
        best = { sessionId: c.sessionId, diff };
      }
    }
    if (best) return best.sessionId;
  }

  // Fallback: most-recently-modified candidate
  let bestMtime = -Infinity;
  let bestId: string | null = null;
  for (const c of candidates) {
    if (c.mtime > bestMtime) {
      bestMtime = c.mtime;
      bestId = c.sessionId;
    }
  }
  return bestId;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/core && bun test 2>&1 | grep -E "selectBestSession|\(fail\)" | head -20
```

Expected: all `selectBestSession` tests `(pass)`, no `(fail)`.

**Step 5: Commit**

```bash
git add packages/core/src/session-backfill.ts packages/core/src/__tests__/session-backfill.test.ts
git commit -m "feat(backfill): add selectBestSession pure function for process-session timestamp correlation"
```

---

### Task 2: Add private helpers and `buildActiveSessions`

Add four private helpers (process queries, first-timestamp reader) and the main
`buildActiveSessions` function that composes them.

**Files:**
- Modify: `packages/core/src/session-backfill.ts`
- Modify: `packages/core/src/__tests__/session-backfill.test.ts`

**Step 1: Write a smoke test for `buildActiveSessions`**

Add `buildActiveSessions` to the import in the test file:

```typescript
import { scanForSessions, isSessionActive, isSessionActiveAsync, projectDirToPath, selectBestSession, buildActiveSessions } from "../session-backfill.js";
```

Add this describe block after the `selectBestSession` tests:

```typescript
// ---------------------------------------------------------------------------
// Tests: buildActiveSessions
// ---------------------------------------------------------------------------

describe("buildActiveSessions", () => {
  it("returns a Set and does not throw when called with a temp dir", async () => {
    // tmpDir has no claude project dirs matching any real CWD, so the result
    // will be an empty Set regardless of whether any Claude PIDs are found.
    const result = await buildActiveSessions(tmpDir);
    expect(result).toBeInstanceOf(Set);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/core && bun test 2>&1 | grep -E "buildActiveSessions|\(fail\)" | head -10
```

Expected: `(fail)` with "buildActiveSessions is not a function".

**Step 3: Add the private helpers and `buildActiveSessions` to `session-backfill.ts`**

Add these after `selectBestSession`. The four helpers are private (not exported); only
`buildActiveSessions` is exported:

```typescript
// ---------------------------------------------------------------------------
// Live session detection helpers
// ---------------------------------------------------------------------------

/**
 * Return PIDs of running `claude` processes.
 * Uses `pgrep -x claude` (exact name match). Returns [] on failure.
 */
async function getClaudePids(): Promise<number[]> {
  return new Promise((resolve) => {
    exec("pgrep -x claude", (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      const pids = stdout
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n));
      resolve(pids);
    });
  });
}

/**
 * Return the current working directory of a process via lsof.
 * Parses the `cwd` file descriptor entry; the path is the last whitespace-
 * delimited token on that line. Returns null on failure.
 */
async function getProcessCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`lsof -p ${pid} -a -d cwd`, { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      for (const line of stdout.split("\n")) {
        if (line.includes(" cwd ")) {
          const parts = line.trim().split(/\s+/);
          resolve(parts[parts.length - 1] || null);
          return;
        }
      }
      resolve(null);
    });
  });
}

/**
 * Return the process start time as a Unix epoch (seconds) via `ps -o lstart=`.
 * macOS lstart format: "Mon Jan 19 10:30:00 2026". Returns null on failure.
 */
async function getProcessStartEpoch(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    exec(`ps -p ${pid} -o lstart=`, { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return; }
      const epoch = new Date(stdout.trim()).getTime();
      resolve(isNaN(epoch) ? null : epoch / 1000);
    });
  });
}

/**
 * Read the first line of a JSONL file and parse the `timestamp` field to a
 * Unix epoch (seconds). Returns null on any parse failure or I/O error.
 */
function getJsonlFirstTimestamp(jsonlPath: string): number | null {
  try {
    const fd = fs.openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as { timestamp?: string };
      if (!parsed.timestamp) return null;
      const epoch = new Date(parsed.timestamp).getTime();
      return isNaN(epoch) ? null : epoch / 1000;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Build the set of session IDs that belong to currently-running Claude
 * processes. Called once before Phase B of scanForSessions.
 *
 * Strategy: pgrep → per-PID CWD via lsof → encode CWD to project dir name →
 * read first-event timestamps of candidate JSONLs → timestamp-correlate to
 * the running process via selectBestSession.
 *
 * On any failure at any stage (pgrep unavailable, lsof error, no timestamp
 * match) the function returns an empty Set so the scan proceeds normally
 * without skipping anything (Option A fallback — non-destructive).
 *
 * CWD encoding: Claude replaces path separators and dots with hyphens when
 * naming project directories (e.g. /Users/john.doe/repo → -Users-john-doe-repo).
 * Additional character substitutions may exist; if the encoded path doesn't
 * match an existing directory the PID is silently skipped.
 */
export async function buildActiveSessions(projectsDir: string): Promise<Set<string>> {
  const active = new Set<string>();

  const pids = await getClaudePids();
  if (pids.length === 0) return active;

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const cwd = await getProcessCwd(pid);
        if (!cwd) return;

        // Encode the CWD to match Claude's project directory naming scheme.
        // Known substitutions: / → - and . → -
        const encodedCwd = cwd.replace(/[/.]/g, "-");
        const projectDir = path.join(projectsDir, encodedCwd);
        if (!fs.existsSync(projectDir)) return;

        const procStart = await getProcessStartEpoch(pid);

        // Collect top-level JSONL files with valid UUID names
        const candidates = fs
          .readdirSync(projectDir)
          .filter(
            (f) =>
              f.endsWith(".jsonl") &&
              UUID_REGEX.test(f.replace(/\.jsonl$/, "")),
          )
          .map((f) => {
            const fullPath = path.join(projectDir, f);
            return {
              sessionId: f.replace(/\.jsonl$/, ""),
              firstTimestamp: getJsonlFirstTimestamp(fullPath),
              mtime: fs.statSync(fullPath).mtimeMs / 1000,
            };
          });

        const sessionId = selectBestSession(candidates, procStart);
        if (sessionId) active.add(sessionId);
      } catch {
        // Per Option A: silently ignore per-PID failures — the session
        // will be ingested rather than incorrectly skipped.
      }
    }),
  );

  return active;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd packages/core && bun test 2>&1 | grep -E "buildActiveSessions|\(fail\)" | head -10
```

Expected: `buildActiveSessions` test `(pass)`, no new `(fail)`.

**Step 5: Commit**

```bash
git add packages/core/src/session-backfill.ts packages/core/src/__tests__/session-backfill.test.ts
git commit -m "feat(backfill): add buildActiveSessions with process-timestamp correlation"
```

---

### Task 3: Strip lsof Stage 2 from `isSessionActive` / `isSessionActiveAsync`

The lsof Stage 2 is broken and its role is now filled by `buildActiveSessions`. Remove
it from both functions. Existing tests all pass without it — they only exercise paths
where the file is closed or nonexistent.

**Files:**
- Modify: `packages/core/src/session-backfill.ts` (lines 328-375)
- Modify: `packages/core/src/__tests__/session-backfill.test.ts` (update comments at lines 124, 131, 668, 671, 676)

**Step 1: Update `isSessionActive` (line 328)**

Replace the full function body. The lsof Stage 2 block (`// Stage 2: no /exit found...` through the final `catch`) is removed:

```typescript
export function isSessionActive(filePath: string): boolean {
  // Check for /exit command — definitive signal that the session closed gracefully.
  // (The lsof file-open check has been removed: Claude closes the transcript after
  // every event write, so lsof never reports the file as open mid-session.)
  try {
    const tail = readTailLines(filePath, 4);
    return !tail.includes("<command-name>/exit</command-name>");
  } catch {
    return false;
  }
}
```

Wait — `isSessionActive` previously returned `false` for "no exit tag, lsof finds nothing". With Stage 2 removed, "no exit tag" now returns `true`. That changes the exported semantics.

Check the test at line 121: *"returns false when file has no /exit and no process holds it open (abandoned)"* — this currently returns `false` because lsof exits non-zero. After removing Stage 2, this would return `true`.

To preserve backward-compatible test behaviour AND accurately model the new reality (we don't know if a session is active without the active set), the function needs an optional `activeSet` param:

```typescript
/**
 * Returns true if the session at filePath appears to be active.
 *
 * Stage 1: if the transcript's tail contains /exit, the session closed
 *   gracefully — return false immediately.
 * Stage 2: if activeSet is provided, return whether sessionId is in it.
 *   Without activeSet, returns false (unknown — callers that need accurate
 *   live detection should use buildActiveSessions + scanForSessions).
 *
 * The former lsof Stage 2 has been removed: Claude closes the transcript
 * after every event write, so lsof never reports the file as open.
 */
export function isSessionActive(
  filePath: string,
  activeSet?: Set<string>,
): boolean {
  try {
    const tail = readTailLines(filePath, 4);
    if (tail.includes("<command-name>/exit</command-name>")) return false;
  } catch {
    return false;
  }
  if (!activeSet) return false;
  const sessionId = path.basename(filePath, ".jsonl");
  return activeSet.has(sessionId);
}
```

And `isSessionActiveAsync`:

```typescript
/**
 * Async version of isSessionActive. See isSessionActive for full docs.
 */
export async function isSessionActiveAsync(
  filePath: string,
  activeSet?: Set<string>,
): Promise<boolean> {
  try {
    const tail = readTailLines(filePath, 4);
    if (tail.includes("<command-name>/exit</command-name>")) return false;
  } catch {
    return false;
  }
  if (!activeSet) return false;
  const sessionId = path.basename(filePath, ".jsonl");
  return activeSet.has(sessionId);
}
```

**Step 2: Update test comments**

In `session-backfill.test.ts`, the comments referencing lsof are now stale. Update:

Line 124: change `// No process has this file open, so lsof will exit non-zero → not active`
to: `// No activeSet provided → returns false (unknown activity state)`

Line 668 (isSessionActiveAsync counterpart): same comment update.

Update the file-level doc comment at line 9 from:
`*   - Active session detection (content-based /exit check + lsof)`
to:
`*   - Active session detection (content-based /exit check + process set lookup)`

**Step 3: Run all existing tests**

```bash
cd packages/core && bun test 2>&1 | grep -E "\(fail\)|\(pass\)|^\s+\d+ (pass|fail)" | tail -10
```

Expected: all tests pass. No failures.

**Step 4: Commit**

```bash
git add packages/core/src/session-backfill.ts packages/core/src/__tests__/session-backfill.test.ts
git commit -m "refactor(backfill): remove broken lsof Stage 2 from isSessionActive/isSessionActiveAsync"
```

---

### Task 4: Update Phase B scan loop in `scanForSessions`

Replace both `isSessionActiveAsync` call sites with `buildActiveSessions` + inline
two-stage check.

**Files:**
- Modify: `packages/core/src/session-backfill.ts` (lines ~540-595)

**Step 1: Add `buildActiveSessions` call before Phase B**

Find the comment `// ---------- Phase B: Concurrent process (worker pool) ----------` (~line 540).
Insert one line directly above it:

```typescript
  // Build active session set once before Phase B — O(live_processes), not O(sessions)
  const activeSessions = await buildActiveSessions(projectsDir);

  // ---------- Phase B: Concurrent process (worker pool) ----------
```

Also update the Phase B comment on the next line from:
`// Each worker: isSessionActiveAsync → readJsonlMetadata → resolveWorkspaceFromPath`
to:
`// Each worker: exit-tag + active-set check → readJsonlMetadata → resolveWorkspaceFromPath`

**Step 2: Replace the subagent active check (~line 556)**

Replace:
```typescript
        if (await isSessionActiveAsync(item.saPath)) {
          result.skipped.activeSubagents++;
          continue;
        }
```

With:
```typescript
        // Stage 1: /exit tag → definitely closed
        // Stage 2: parent session in active set → live, skip
        try {
          const saTail = readTailLines(item.saPath, 4);
          if (!saTail.includes("<command-name>/exit</command-name>") &&
              activeSessions.has(item.parentSessionId)) {
            result.skipped.activeSubagents++;
            continue;
          }
        } catch {
          // Can't read tail — proceed with ingest (non-destructive)
        }
```

**Step 3: Replace the session active check (~line 590)**

Replace:
```typescript
        // Check if session is active (async lsof)
        if (await isSessionActiveAsync(item.entryPath)) {
          result.skipped.potentiallyActive++;
          sessionFilesProcessed++;
          options?.onProgress?.({ current: sessionFilesProcessed, total: totalSessionFiles, currentDir: item.projectDir });
          continue;
        }
```

With:
```typescript
        // Stage 1: /exit tag → definitely closed, proceed with ingest
        // Stage 2: session in active set → currently live, skip
        let sessionIsActive = false;
        try {
          const tail = readTailLines(item.entryPath, 4);
          if (!tail.includes("<command-name>/exit</command-name>") &&
              activeSessions.has(item.sessionId)) {
            sessionIsActive = true;
          }
        } catch {
          // Can't read tail — proceed with ingest (non-destructive)
        }
        if (sessionIsActive) {
          result.skipped.potentiallyActive++;
          sessionFilesProcessed++;
          options?.onProgress?.({ current: sessionFilesProcessed, total: totalSessionFiles, currentDir: item.projectDir });
          continue;
        }
```

**Step 4: Run the full test suite**

```bash
cd packages/core && bun test 2>&1 | grep -E "\(fail\)|\(pass\)|^\s+\d+ (pass|fail)" | tail -10
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add packages/core/src/session-backfill.ts
git commit -m "feat(backfill): replace lsof active-session check with process-set lookup in scan loop"
```

---

### Task 5: Export `buildActiveSessions` from `packages/core`

**Files:**
- Modify: `packages/core/src/index.ts` (the backfill exports block, ~line 98)

**Step 1: Add `buildActiveSessions` to the export block**

The current block at ~line 98:
```typescript
export {
  scanForSessions,
  isSessionActive,
  isSessionActiveAsync,
  ingestBackfillSessions,
  ...
```

Add `buildActiveSessions` and `selectBestSession` to the list:
```typescript
export {
  scanForSessions,
  buildActiveSessions,
  selectBestSession,
  isSessionActive,
  isSessionActiveAsync,
  ingestBackfillSessions,
  ...
```

**Step 2: Run full test suite one final time**

```bash
cd packages/core && bun test 2>&1 | grep -E "\(fail\)|\(pass\)|^\s+\d+ (pass|fail)" | tail -5
```

Expected: all pass.

**Step 3: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "chore(backfill): export buildActiveSessions and selectBestSession from core"
```
