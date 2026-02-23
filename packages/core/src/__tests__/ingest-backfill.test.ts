/**
 * Unit tests for ingestBackfillSessions.
 *
 * Mocks globalThis.fetch to simulate backend responses for:
 *   - GET /api/sessions/:id  — dedup check (200 = exists, 404 = new)
 *   - POST /api/events/ingest — event ingestion
 *   - POST /api/sessions/:id/transcript/upload — transcript upload
 *
 * Each test creates temporary JSONL files for transcriptPath fields
 * and tears them down in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ingestBackfillSessions } from "../session-backfill.js";
import type { BackfillResult } from "../backfill-state.js";
import type { DiscoveredSession, IngestDeps, BackfillProgress } from "../session-backfill.js";

// ---------------------------------------------------------------------------
// Temp directory setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-ingest-test-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  // Restore original fetch — mockFetch() overwrites globalThis.fetch directly,
  // so mock.restore() alone won't undo it.
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal JSONL transcript file and return its absolute path. */
function createTranscript(sessionId: string, lines = 2): string {
  const filePath = path.join(tmpDir, `${sessionId}.jsonl`);
  const content = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({
      type: i === 0 ? "user" : "assistant",
      timestamp: `2025-06-01T10:0${i}:00.000Z`,
      message: { role: i === 0 ? "user" : "assistant", content: `msg-${i}` },
    }),
  ).join("\n") + "\n";
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Build a DiscoveredSession fixture with a real transcript file on disk. */
function makeSession(overrides: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const sessionId = overrides.sessionId ?? crypto.randomUUID();
  const transcriptPath = overrides.transcriptPath ?? createTranscript(sessionId);
  const fileSizeBytes = overrides.fileSizeBytes ?? fs.statSync(transcriptPath).size;

  return {
    sessionId,
    transcriptPath,
    projectDir: "-Users-test-Desktop-proj",
    resolvedCwd: "/Users/test/Desktop/proj",
    workspaceCanonicalId: "github.com/test/proj",
    gitBranch: "main",
    firstPrompt: "Hello",
    firstTimestamp: "2025-06-01T10:00:00.000Z",
    lastTimestamp: "2025-06-01T10:05:00.000Z",
    fileSizeBytes,
    messageCount: 2,
    ...overrides,
  };
}

/** Default deps with fast settings for testing. */
function makeDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    serverUrl: "http://localhost:3000",
    apiKey: "test-key",
    deviceId: "test-device",
    throttleMs: 0,
    batchSize: 50,
    concurrency: 5,
    ...overrides,
  };
}

/**
 * Create a mock fetch that dispatches based on URL and method.
 *
 * handlers is a map of `"METHOD path-pattern"` to response factories.
 * Path patterns are matched as substrings of the URL. The first matching
 * handler wins. Unmatched requests return 500.
 */
function mockFetch(
  handlers: Record<string, (url: string, init?: RequestInit) => Response>,
): void {
  const mockFn = mock((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const method = (init?.method ?? "GET").toUpperCase();

    for (const [pattern, handler] of Object.entries(handlers)) {
      const [patMethod, ...pathParts] = pattern.split(" ");
      const patPath = pathParts.join(" ");
      if (method === patMethod && urlStr.includes(patPath)) {
        return Promise.resolve(handler(urlStr, init));
      }
    }

    // Default: unmatched requests return 500
    return Promise.resolve(new Response("Unmatched mock request", { status: 500 }));
  });

  globalThis.fetch = mockFn as typeof fetch;
}

/** Shortcut to build a 200 OK JSON response. */
function ok(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Shortcut to build a 404 Not Found response. */
function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestBackfillSessions", () => {
  // -----------------------------------------------------------------------
  // 1. Session dedup via alreadyIngested set
  // -----------------------------------------------------------------------
  it("skips sessions present in alreadyIngested set without making HTTP calls", async () => {
    const s1 = makeSession();
    const s2 = makeSession();

    let fetchCalled = false;
    mockFetch({
      "GET /api/sessions/": () => { fetchCalled = true; return ok(); },
      "POST /api/events/ingest": () => { fetchCalled = true; return ok(); },
      "POST /api/sessions/": () => { fetchCalled = true; return ok(); },
    });

    const result = await ingestBackfillSessions(
      [s1, s2],
      makeDeps({ alreadyIngested: new Set([s1.sessionId, s2.sessionId]) }),
    );

    expect(result.skipped).toBe(2);
    expect(result.ingested).toBe(0);
    expect(result.failed).toBe(0);
    expect(fetchCalled).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 2. Session dedup via backend check (GET returns 200)
  // -----------------------------------------------------------------------
  it("skips sessions that already exist in the backend (GET 200)", async () => {
    const s1 = makeSession();

    mockFetch({
      // Backend says session already exists
      "GET /api/sessions/": () => ok({ id: s1.sessionId }),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => ok(),
    });

    const result = await ingestBackfillSessions([s1], makeDeps());

    expect(result.skipped).toBe(1);
    expect(result.ingested).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 3. Successful ingestion flow
  // -----------------------------------------------------------------------
  it("ingests a session when GET returns 404 and all POSTs succeed", async () => {
    const s1 = makeSession({ fileSizeBytes: 1234 });

    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => ok(), // transcript upload
    });

    const result = await ingestBackfillSessions([s1], makeDeps());

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.totalSizeBytes).toBe(1234);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.errors).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 4. Transcript upload retry on 404
  // -----------------------------------------------------------------------
  it("retries transcript upload when the first attempt returns 404", async () => {
    const s1 = makeSession();
    let uploadAttempt = 0;

    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => {
        uploadAttempt++;
        // First upload attempt fails with 404 (session not yet created by consumer)
        if (uploadAttempt === 1) {
          return new Response("Session not found", { status: 404 });
        }
        return ok();
      },
    });

    const result = await ingestBackfillSessions([s1], makeDeps());

    expect(result.ingested).toBe(1);
    expect(result.failed).toBe(0);
    expect(uploadAttempt).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // 5. AbortSignal cancellation
  // -----------------------------------------------------------------------
  it("stops processing remaining sessions when abort signal fires", async () => {
    // Create many sessions so the abort has time to take effect
    const sessions = Array.from({ length: 20 }, () => makeSession());
    const controller = new AbortController();

    let ingestCallCount = 0;
    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => {
        ingestCallCount++;
        // Abort after a few session.start events have been sent
        if (ingestCallCount >= 3) {
          controller.abort();
        }
        return ok();
      },
      "POST /api/sessions/": () => ok(),
    });

    const result = await ingestBackfillSessions(
      sessions,
      makeDeps({ signal: controller.signal, concurrency: 2 }),
    );

    // Not all sessions should have been processed
    const totalProcessed = result.ingested + result.skipped + result.failed;
    expect(totalProcessed).toBeLessThan(sessions.length);
  });

  // -----------------------------------------------------------------------
  // 6. Resume with alreadyIngested set (mix of ingested and new)
  // -----------------------------------------------------------------------
  it("processes only non-ingested sessions when alreadyIngested is partial", async () => {
    const s1 = makeSession();
    const s2 = makeSession();
    const s3 = makeSession();

    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => ok(),
    });

    const result = await ingestBackfillSessions(
      [s1, s2, s3],
      makeDeps({ alreadyIngested: new Set([s1.sessionId]) }),
    );

    // s1 skipped via alreadyIngested, s2 and s3 ingested
    expect(result.skipped).toBe(1);
    expect(result.ingested).toBe(2);
    expect(result.failed).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 7. Progress callback accuracy
  // -----------------------------------------------------------------------
  it("calls onProgress with accurate total/completed/skipped counts", async () => {
    const s1 = makeSession();
    const s2 = makeSession();

    mockFetch({
      "GET /api/sessions/": (url) => {
        // s1 exists, s2 does not
        if (url.includes(s1.sessionId)) return ok();
        return notFound();
      },
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => ok(),
    });

    const progressCalls: BackfillProgress[] = [];

    const result = await ingestBackfillSessions(
      [s1, s2],
      makeDeps({
        onProgress: (p) => progressCalls.push({ ...p }),
        concurrency: 1, // serialize for deterministic progress
      }),
    );

    expect(result.skipped).toBe(1);
    expect(result.ingested).toBe(1);

    // Progress should have been called at least once
    expect(progressCalls.length).toBeGreaterThan(0);

    // All progress calls should report total = 2
    for (const p of progressCalls) {
      expect(p.total).toBe(2);
    }

    // The final progress call should reflect all sessions processed
    const last = progressCalls[progressCalls.length - 1];
    expect(last.completed).toBe(2); // 1 skipped + 1 ingested
    expect(last.skipped).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 8. Partial failure (some sessions fail, others succeed)
  // -----------------------------------------------------------------------
  it("records correct counts when some sessions fail and others succeed", async () => {
    const sGood = makeSession();
    const sBad = makeSession();

    let uploadCallCount: Record<string, number> = {};

    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": (url) => {
        // Determine which session this upload is for from the URL
        if (url.includes(sBad.sessionId)) {
          // Track attempts for the bad session
          uploadCallCount[sBad.sessionId] = (uploadCallCount[sBad.sessionId] ?? 0) + 1;
          // Always fail with 500 (non-retryable after maxRetries)
          return new Response("Internal server error", { status: 500 });
        }
        return ok();
      },
    });

    const result = await ingestBackfillSessions(
      [sGood, sBad],
      makeDeps({ concurrency: 1 }),
    );

    expect(result.ingested).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].sessionId).toBe(sBad.sessionId);
    expect(result.errors[0].error).toContain("500");
  });

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  it("returns zero counts for an empty sessions array", async () => {
    mockFetch({});

    const result = await ingestBackfillSessions([], makeDeps());

    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.totalSizeBytes).toBe(0);
  });

  it("accumulates totalSizeBytes across multiple ingested sessions", async () => {
    const s1 = makeSession({ fileSizeBytes: 1000 });
    const s2 = makeSession({ fileSizeBytes: 2000 });

    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => ok(),
    });

    const result = await ingestBackfillSessions([s1, s2], makeDeps());

    expect(result.ingested).toBe(2);
    expect(result.totalSizeBytes).toBe(3000);
  });

  it("handles concurrent ingestion with concurrency > 1", async () => {
    const sessions = Array.from({ length: 8 }, () => makeSession());

    mockFetch({
      "GET /api/sessions/": () => notFound(),
      "POST /api/events/ingest": () => ok(),
      "POST /api/sessions/": () => ok(),
    });

    const result = await ingestBackfillSessions(
      sessions,
      makeDeps({ concurrency: 4 }),
    );

    expect(result.ingested).toBe(8);
    expect(result.failed).toBe(0);
  });
});
