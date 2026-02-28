# Pipeline Progress Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add server-side pipeline progress tracking to the backfill command so users see real processing status, not just event emission.

**Architecture:** New batch status endpoint (`POST /api/sessions/batch-status`) returns lifecycle/parse_status for multiple sessions in one query. CLI polls this endpoint after ingestion and renders a second progress bar. Ctrl-C exits the wait without affecting server-side processing.

**Tech Stack:** Express route (server), Zod schema (shared), polling + progress bar (CLI/core)

---

### Task 1: Add Zod Schema for Batch Status Request

**Files:**
- Modify: `packages/shared/src/schemas/session-query.ts`

**Step 1: Add the schema**

At the bottom of `packages/shared/src/schemas/session-query.ts`, add:

```typescript
/**
 * Schema for POST /api/sessions/batch-status request body.
 * Accepts an array of session IDs and returns their lifecycle/parse_status.
 * Capped at 500 to prevent oversized queries.
 */
export const batchStatusRequestSchema = z.object({
  session_ids: z.array(z.string()).min(1).max(500),
});

/** Inferred type for batch status request */
export type BatchStatusRequest = z.infer<typeof batchStatusRequestSchema>;
```

**Step 2: Verify it compiles**

Run: `cd packages/shared && bun run build 2>&1 | tail -5`
Expected: Clean build, no errors

**Step 3: Commit**

```bash
git add packages/shared/src/schemas/session-query.ts
git commit -m "feat: add batchStatusRequestSchema for pipeline progress tracking"
```

---

### Task 2: Add `POST /api/sessions/batch-status` Endpoint

**Files:**
- Modify: `packages/server/src/routes/sessions.ts`

**Step 1: Write the failing test**

Add a new describe block at the end of `packages/server/src/routes/__tests__/sessions.test.ts`:

```typescript
// =========================================================================
// POST /api/sessions/batch-status
// =========================================================================

describe("POST /api/sessions/batch-status", () => {
  test("returns lifecycle and parse_status for requested session IDs", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: ["sess-01", "sess-02", "sess-03"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statuses["sess-01"]).toEqual({ lifecycle: "parsed", parse_status: "completed" });
    expect(body.statuses["sess-02"]).toEqual({ lifecycle: "ended", parse_status: "pending" });
    expect(body.statuses["sess-03"]).toEqual({ lifecycle: "summarized", parse_status: "completed" });
    expect(body.not_found).toEqual([]);
  });

  test("reports not_found for missing session IDs", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: ["sess-01", "nonexistent-id"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statuses["sess-01"]).toEqual({ lifecycle: "parsed", parse_status: "completed" });
    expect(body.not_found).toEqual(["nonexistent-id"]);
  });

  test("returns 400 for empty session_ids array", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: [] }),
    });

    expect(res.status).toBe(400);
  });

  test("returns 400 for missing body", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: { Authorization: AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: ["sess-01"] }),
    });

    expect(res.status).toBe(401);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test src/routes/__tests__/sessions.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: New batch-status tests FAIL (404 — route doesn't exist yet)

**Step 3: Add the endpoint to `sessions.ts`**

In `packages/server/src/routes/sessions.ts`, add this import at the top alongside existing schema imports:

```typescript
import {
  sessionListQuerySchema,
  sessionPatchSchema,
  parseLifecycleParam,
  batchStatusRequestSchema,
} from "@fuel-code/shared";
```

Add the route handler inside `createSessionsRouter()`, before the `return router;` line:

```typescript
  // =========================================================================
  // POST /sessions/batch-status — Batch lifecycle status for multiple sessions
  // =========================================================================
  router.post(
    "/sessions/batch-status",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parseResult = batchStatusRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid request body",
            details: parseResult.error.issues,
          });
          return;
        }

        const { session_ids } = parseResult.data;

        const rows = await sql`
          SELECT id, lifecycle, parse_status
          FROM sessions
          WHERE id IN ${sql(session_ids)}
        `;

        // Build statuses map and detect not_found IDs
        const statuses: Record<string, { lifecycle: string; parse_status: string }> = {};
        const foundIds = new Set<string>();

        for (const row of rows) {
          statuses[row.id as string] = {
            lifecycle: row.lifecycle as string,
            parse_status: row.parse_status as string,
          };
          foundIds.add(row.id as string);
        }

        const not_found = session_ids.filter((id) => !foundIds.has(id));

        res.json({ statuses, not_found });
      } catch (err) {
        next(err);
      }
    },
  );
```

**Step 4: Update the mock SQL handler in the test file**

The existing `buildMockSql` query handler in `sessions.test.ts` needs to handle the batch-status query. Find the query handler function and add a case that matches `SELECT $, lifecycle, parse_status` (the mock joins template parts with `$`). It should return the matching session fixtures filtered by the requested IDs from the `IN` clause:

```typescript
// Batch status: SELECT id, lifecycle, parse_status FROM sessions WHERE id IN (...)
if (queryText.includes("lifecycle") && queryText.includes("parse_status") && !queryText.includes("workspace")) {
  const requestedIds = values[0] as string[];
  return ALL_SESSIONS
    .filter((s) => requestedIds.includes(s.id))
    .map((s) => ({ id: s.id, lifecycle: s.lifecycle, parse_status: s.parse_status }));
}
```

**Step 5: Run tests to verify they pass**

Run: `cd packages/server && bun test src/routes/__tests__/sessions.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All tests PASS including new batch-status tests

**Step 6: Commit**

```bash
git add packages/server/src/routes/sessions.ts packages/server/src/routes/__tests__/sessions.test.ts
git commit -m "feat: add POST /api/sessions/batch-status endpoint"
```

---

### Task 3: Add `waitForPipelineCompletion()` to Core

**Files:**
- Modify: `packages/core/src/session-backfill.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Write the failing test**

Add a new test file `packages/core/src/__tests__/pipeline-wait.test.ts`:

```typescript
/**
 * Unit tests for waitForPipelineCompletion.
 *
 * Mocks globalThis.fetch to simulate the batch-status endpoint returning
 * sessions progressing through lifecycle states across multiple polls.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { waitForPipelineCompletion } from "../session-backfill.js";
import type { PipelineWaitDeps, PipelineWaitResult } from "../session-backfill.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<PipelineWaitDeps> = {}): PipelineWaitDeps {
  return {
    serverUrl: "http://localhost:3000",
    apiKey: "test-key",
    pollIntervalMs: 50,   // Fast polling for tests
    timeoutMs: 5000,
    ...overrides,
  };
}

/** Mock fetch that returns different statuses on successive calls */
function mockFetchSequence(
  responses: Array<Record<string, { lifecycle: string; parse_status: string }>>,
): void {
  let callIndex = 0;
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const idx = Math.min(callIndex++, responses.length - 1);
    const statuses = responses[idx];
    return Promise.resolve(
      new Response(JSON.stringify({ statuses, not_found: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForPipelineCompletion", () => {
  it("resolves immediately when all sessions are already in terminal state", async () => {
    mockFetchSequence([
      {
        "sess-01": { lifecycle: "summarized", parse_status: "completed" },
        "sess-02": { lifecycle: "parsed", parse_status: "completed" },
      },
    ]);

    const progressCalls: any[] = [];
    const result = await waitForPipelineCompletion(
      ["sess-01", "sess-02"],
      makeDeps({ onProgress: (p) => progressCalls.push({ ...p }) }),
    );

    expect(result.completed).toBe(true);
    expect(result.summary.summarized).toBe(1);
    expect(result.summary.parsed).toBe(1);
  });

  it("polls until sessions reach terminal states", async () => {
    mockFetchSequence([
      // Poll 1: still processing
      {
        "sess-01": { lifecycle: "ended", parse_status: "parsing" },
        "sess-02": { lifecycle: "ended", parse_status: "pending" },
      },
      // Poll 2: one done
      {
        "sess-01": { lifecycle: "summarized", parse_status: "completed" },
        "sess-02": { lifecycle: "ended", parse_status: "parsing" },
      },
      // Poll 3: all done
      {
        "sess-01": { lifecycle: "summarized", parse_status: "completed" },
        "sess-02": { lifecycle: "parsed", parse_status: "completed" },
      },
    ]);

    const result = await waitForPipelineCompletion(
      ["sess-01", "sess-02"],
      makeDeps(),
    );

    expect(result.completed).toBe(true);
    expect(result.summary.summarized).toBe(1);
    expect(result.summary.parsed).toBe(1);
  });

  it("reports failed sessions in summary", async () => {
    mockFetchSequence([
      {
        "sess-01": { lifecycle: "summarized", parse_status: "completed" },
        "sess-02": { lifecycle: "failed", parse_status: "failed" },
      },
    ]);

    const result = await waitForPipelineCompletion(
      ["sess-01", "sess-02"],
      makeDeps(),
    );

    expect(result.completed).toBe(true);
    expect(result.summary.summarized).toBe(1);
    expect(result.summary.failed).toBe(1);
  });

  it("times out and returns partial results", async () => {
    // Always return non-terminal state
    mockFetchSequence([
      {
        "sess-01": { lifecycle: "ended", parse_status: "parsing" },
      },
    ]);

    const result = await waitForPipelineCompletion(
      ["sess-01"],
      makeDeps({ timeoutMs: 200, pollIntervalMs: 50 }),
    );

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("respects abort signal", async () => {
    mockFetchSequence([
      { "sess-01": { lifecycle: "ended", parse_status: "parsing" } },
    ]);

    const controller = new AbortController();
    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    const result = await waitForPipelineCompletion(
      ["sess-01"],
      makeDeps({ signal: controller.signal, timeoutMs: 10000 }),
    );

    expect(result.completed).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it("returns empty result for empty session list", async () => {
    const result = await waitForPipelineCompletion([], makeDeps());
    expect(result.completed).toBe(true);
    expect(result.summary.summarized).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && bun test src/__tests__/pipeline-wait.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|error:"`
Expected: FAIL — `waitForPipelineCompletion` not exported from session-backfill.js

**Step 3: Add types and implementation to `session-backfill.ts`**

At the bottom of `packages/core/src/session-backfill.ts`, add these types and the function:

```typescript
// ---------------------------------------------------------------------------
// Pipeline progress tracking — poll server for processing completion
// ---------------------------------------------------------------------------

/** Terminal lifecycle states where no further processing will occur */
const TERMINAL_LIFECYCLES = new Set(["parsed", "summarized", "archived", "failed"]);

/** Progress callback data during pipeline wait phase */
export interface PipelineWaitProgress {
  /** Total sessions being tracked */
  total: number;
  /** Sessions that have reached a terminal lifecycle state */
  completed: number;
  /** Breakdown by current lifecycle state */
  byLifecycle: Record<string, number>;
}

/** Dependencies for waitForPipelineCompletion */
export interface PipelineWaitDeps {
  /** Base URL of the fuel-code backend */
  serverUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Milliseconds between status polls (default: 3000) */
  pollIntervalMs?: number;
  /** Maximum time to wait before giving up (default: 600000 = 10 min) */
  timeoutMs?: number;
  /** AbortSignal for clean cancellation (Ctrl-C) */
  signal?: AbortSignal;
  /** Progress callback fired after each poll */
  onProgress?: (progress: PipelineWaitProgress) => void;
}

/** Result of waiting for pipeline completion */
export interface PipelineWaitResult {
  /** Whether all sessions reached terminal state */
  completed: boolean;
  /** Whether the wait timed out */
  timedOut: boolean;
  /** Whether the wait was aborted by signal */
  aborted: boolean;
  /** Count of sessions per terminal lifecycle state */
  summary: {
    parsed: number;
    summarized: number;
    archived: number;
    failed: number;
    pending: number;
  };
}

/**
 * Poll the batch-status endpoint until all sessions reach a terminal
 * lifecycle state (parsed, summarized, archived, or failed).
 *
 * Used by the backfill command to show server-side processing progress
 * after the local event emission phase completes.
 *
 * @param sessionIds - Session IDs to track
 * @param deps       - Server URL, API key, polling config, and callbacks
 * @returns PipelineWaitResult with completion status and per-state counts
 */
export async function waitForPipelineCompletion(
  sessionIds: string[],
  deps: PipelineWaitDeps,
): Promise<PipelineWaitResult> {
  if (sessionIds.length === 0) {
    return {
      completed: true,
      timedOut: false,
      aborted: false,
      summary: { parsed: 0, summarized: 0, archived: 0, failed: 0, pending: 0 },
    };
  }

  const baseUrl = deps.serverUrl.replace(/\/+$/, "");
  const pollInterval = deps.pollIntervalMs ?? 3000;
  const timeout = deps.timeoutMs ?? 600_000;
  const startTime = Date.now();

  // Poll in batches of 500 (endpoint limit)
  const idBatches: string[][] = [];
  for (let i = 0; i < sessionIds.length; i += 500) {
    idBatches.push(sessionIds.slice(i, i + 500));
  }

  while (true) {
    // Check abort signal
    if (deps.signal?.aborted) {
      return buildResult(sessionIds, {}, true, false);
    }

    // Check timeout
    if (Date.now() - startTime > timeout) {
      return buildResult(sessionIds, await fetchAllStatuses(baseUrl, deps.apiKey, idBatches, deps.signal), false, true);
    }

    // Fetch current statuses
    const statuses = await fetchAllStatuses(baseUrl, deps.apiKey, idBatches, deps.signal);

    // Report progress
    if (deps.onProgress) {
      const byLifecycle: Record<string, number> = {};
      let completedCount = 0;
      for (const id of sessionIds) {
        const lifecycle = statuses[id]?.lifecycle ?? "unknown";
        byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
        if (TERMINAL_LIFECYCLES.has(lifecycle)) completedCount++;
      }
      deps.onProgress({ total: sessionIds.length, completed: completedCount, byLifecycle });
    }

    // Check if all sessions are in terminal state
    const allTerminal = sessionIds.every((id) => {
      const lifecycle = statuses[id]?.lifecycle;
      return lifecycle && TERMINAL_LIFECYCLES.has(lifecycle);
    });

    if (allTerminal) {
      return buildResult(sessionIds, statuses, false, false);
    }

    // Wait before next poll (abort-aware)
    try {
      await abortableSleep(pollInterval, deps.signal);
    } catch {
      return buildResult(sessionIds, statuses, true, false);
    }
  }
}

/** Fetch statuses from all batches and merge into a single map */
async function fetchAllStatuses(
  baseUrl: string,
  apiKey: string,
  idBatches: string[][],
  signal?: AbortSignal,
): Promise<Record<string, { lifecycle: string; parse_status: string }>> {
  const merged: Record<string, { lifecycle: string; parse_status: string }> = {};

  for (const batch of idBatches) {
    try {
      const response = await fetch(`${baseUrl}/api/sessions/batch-status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ session_ids: batch }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        const data = await response.json() as {
          statuses: Record<string, { lifecycle: string; parse_status: string }>;
        };
        Object.assign(merged, data.statuses);
      }
    } catch {
      // On fetch error, skip this batch — will retry on next poll
    }
  }

  return merged;
}

/** Build the final PipelineWaitResult from collected statuses */
function buildResult(
  sessionIds: string[],
  statuses: Record<string, { lifecycle: string; parse_status: string }>,
  aborted: boolean,
  timedOut: boolean,
): PipelineWaitResult {
  const summary = { parsed: 0, summarized: 0, archived: 0, failed: 0, pending: 0 };
  let allTerminal = true;

  for (const id of sessionIds) {
    const lifecycle = statuses[id]?.lifecycle;
    if (lifecycle === "parsed") summary.parsed++;
    else if (lifecycle === "summarized") summary.summarized++;
    else if (lifecycle === "archived") summary.archived++;
    else if (lifecycle === "failed") summary.failed++;
    else { summary.pending++; allTerminal = false; }
  }

  return {
    completed: allTerminal && !aborted && !timedOut,
    timedOut,
    aborted,
    summary,
  };
}
```

**Step 4: Export from `packages/core/src/index.ts`**

Add to the existing session-backfill export block:

```typescript
export {
  scanForSessions,
  ingestBackfillSessions,
  waitForPipelineCompletion,
  projectDirToPath,
  type DiscoveredSession,
  type ScanResult,
  type BackfillProgress,
  type IngestDeps,
  type PipelineWaitDeps,
  type PipelineWaitProgress,
  type PipelineWaitResult,
} from "./session-backfill.js";
```

**Step 5: Run tests to verify they pass**

Run: `cd packages/core && bun test src/__tests__/pipeline-wait.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All PASS

**Step 6: Run existing backfill tests to verify no regressions**

Run: `cd packages/core && bun test src/__tests__/ingest-backfill.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)"`
Expected: All PASS

**Step 7: Commit**

```bash
git add packages/core/src/session-backfill.ts packages/core/src/index.ts packages/core/src/__tests__/pipeline-wait.test.ts
git commit -m "feat: add waitForPipelineCompletion for pipeline progress tracking"
```

---

### Task 4: Integrate Pipeline Tracking into Backfill Command

**Files:**
- Modify: `packages/cli/src/commands/backfill.ts`

**Step 1: Add imports**

Update the import from `@fuel-code/core` in `backfill.ts`:

```typescript
import {
  scanForSessions,
  ingestBackfillSessions,
  waitForPipelineCompletion,
  loadBackfillState,
  saveBackfillState,
  type DiscoveredSession,
  type ScanResult,
  type BackfillProgress,
  type BackfillState,
  type PipelineWaitProgress,
} from "@fuel-code/core";
```

**Step 2: Add pipeline tracking after ingestion**

In the `runBackfill` function, after the "Print results" block (after `console.log(\`  Failed:    ${result.failed}\`)`), and before the errors block, add the pipeline wait phase:

```typescript
    // Phase 4: Wait for server-side processing (parse + summarize)
    // Collect all session IDs that were successfully ingested
    const ingestedIds = scanResult.discovered
      .filter((s) => !alreadyIngested.has(s.sessionId))
      .slice(0, result.ingested)
      .map((s) => s.sessionId);

    if (ingestedIds.length > 0) {
      console.error("");
      console.error("Waiting for server-side processing...");

      const pipelineResult = await waitForPipelineCompletion(ingestedIds, {
        serverUrl: config.backend.url,
        apiKey: config.backend.api_key,
        signal: abortController.signal,
        onProgress: (progress: PipelineWaitProgress) => {
          const bar = buildProgressBar(progress.completed, progress.total, 30);
          // Build status breakdown string
          const parts: string[] = [];
          for (const [state, count] of Object.entries(progress.byLifecycle)) {
            if (count > 0 && state !== "parsed" && state !== "summarized" && state !== "archived" && state !== "failed") {
              parts.push(`${count} ${state}`);
            }
          }
          const statusStr = parts.length > 0 ? `  ${parts.join(", ")}` : "";
          process.stderr.write(
            `\rProcessing:  ${bar} ${progress.completed}/${progress.total}${statusStr}    `,
          );
        },
      });

      // Clear progress line
      process.stderr.write("\r" + " ".repeat(80) + "\r");

      if (pipelineResult.completed) {
        console.log("Processing complete!");
      } else if (pipelineResult.timedOut) {
        console.log("Processing timed out (server is still working in the background).");
      } else if (pipelineResult.aborted) {
        console.log("Processing watch cancelled (server is still working in the background).");
      }

      // Show processing summary
      const ps = pipelineResult.summary;
      if (ps.summarized > 0) console.log(`  Summarized: ${ps.summarized}`);
      if (ps.parsed > 0)     console.log(`  Parsed:     ${ps.parsed}`);
      if (ps.archived > 0)   console.log(`  Archived:   ${ps.archived}`);
      if (ps.failed > 0)     console.log(`  Failed:     ${ps.failed}`);
      if (ps.pending > 0)    console.log(`  Pending:    ${ps.pending}`);
    }
```

**Step 3: Verify the full backfill command compiles**

Run: `cd packages/cli && bun run build 2>&1 | tail -5`
Expected: Clean build, no errors

**Step 4: Commit**

```bash
git add packages/cli/src/commands/backfill.ts
git commit -m "feat: add pipeline progress tracking to backfill command"
```

---

### Task 5: Run Full Test Suite and Verify

**Step 1: Run all server tests**

Run: `cd packages/server && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`
Expected: All PASS, no regressions

**Step 2: Run all core tests**

Run: `cd packages/core && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`
Expected: All PASS, no regressions

**Step 3: Run CLI build**

Run: `cd packages/cli && bun run build 2>&1 | tail -5`
Expected: Clean build

**Step 4: Commit if any fixes were needed, otherwise done**
