/**
 * Unit tests for waitForPipelineCompletion.
 *
 * Mocks globalThis.fetch to simulate the batch-status endpoint responses.
 * Each test uses fast poll intervals (50ms) to keep suite execution quick.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { waitForPipelineCompletion } from "../session-backfill.js";
import type { PipelineWaitDeps, PipelineWaitProgress } from "../session-backfill.js";

// ---------------------------------------------------------------------------
// Setup / teardown — save and restore globalThis.fetch
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

/** Default deps with fast poll interval for testing. */
function makeDeps(overrides: Partial<PipelineWaitDeps> = {}): PipelineWaitDeps {
  return {
    serverUrl: "http://localhost:3000",
    apiKey: "test-key",
    pollIntervalMs: 50,
    ...overrides,
  };
}

/**
 * Build a mock batch-status response body.
 * Maps session IDs to lifecycle states.
 */
function batchStatusResponse(
  statuses: Record<string, string>,
): { statuses: Record<string, { lifecycle: string; parse_status: string }> } {
  const mapped: Record<string, { lifecycle: string; parse_status: string }> = {};
  for (const [id, lifecycle] of Object.entries(statuses)) {
    mapped[id] = { lifecycle, parse_status: lifecycle === "failed" ? "error" : "complete" };
  }
  return { statuses: mapped };
}

/** Create a mock fetch that returns the given response body for POST batch-status. */
function mockBatchStatus(
  handler: (body: { session_ids: string[] }) => Response,
): void {
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "POST" && urlStr.includes("/api/sessions/batch-status")) {
      const reqBody = JSON.parse(init?.body as string);
      return Promise.resolve(handler(reqBody));
    }

    return Promise.resolve(new Response("Unmatched", { status: 500 }));
  }) as typeof fetch;
}

/** Build a 200 OK JSON response. */
function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForPipelineCompletion", () => {
  // -----------------------------------------------------------------------
  // 1. All sessions already in terminal state — resolves immediately
  // -----------------------------------------------------------------------
  it("resolves immediately when all sessions are already in a terminal state", async () => {
    const ids = ["s1", "s2", "s3"];

    mockBatchStatus(() =>
      ok(batchStatusResponse({ s1: "parsed", s2: "summarized", s3: "archived" })),
    );

    const result = await waitForPipelineCompletion(ids, makeDeps());

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.summary.parsed).toBe(1);
    expect(result.summary.summarized).toBe(1);
    expect(result.summary.archived).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.pending).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2. Polls until sessions reach terminal states
  // -----------------------------------------------------------------------
  it("polls until all sessions reach terminal states", async () => {
    const ids = ["s1", "s2"];
    let callCount = 0;

    mockBatchStatus(() => {
      callCount++;
      if (callCount === 1) {
        // First poll: s1 still processing, s2 done
        return ok(batchStatusResponse({ s1: "ended", s2: "parsed" }));
      }
      if (callCount === 2) {
        // Second poll: s1 still processing, s2 done
        return ok(batchStatusResponse({ s1: "uploading", s2: "parsed" }));
      }
      // Third poll: both done
      return ok(batchStatusResponse({ s1: "summarized", s2: "parsed" }));
    });

    const progressCalls: PipelineWaitProgress[] = [];
    const result = await waitForPipelineCompletion(
      ids,
      makeDeps({ onProgress: (p) => progressCalls.push({ ...p }) }),
    );

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.summary.summarized).toBe(1);
    expect(result.summary.parsed).toBe(1);
    expect(result.summary.pending).toBe(0);

    // Should have polled at least 3 times
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Progress should have been called each poll
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);

    // First progress call should show 1 completed (s2 parsed) out of 2
    expect(progressCalls[0].total).toBe(2);
    expect(progressCalls[0].completed).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. Reports failed sessions in summary
  // -----------------------------------------------------------------------
  it("reports failed sessions correctly in the summary", async () => {
    const ids = ["s1", "s2", "s3"];

    mockBatchStatus(() =>
      ok(batchStatusResponse({ s1: "parsed", s2: "failed", s3: "summarized" })),
    );

    const result = await waitForPipelineCompletion(ids, makeDeps());

    expect(result.completed).toBe(true);
    expect(result.summary.parsed).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.summarized).toBe(1);
    expect(result.summary.archived).toBe(0);
    expect(result.summary.pending).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 4. Times out and returns partial results
  // -----------------------------------------------------------------------
  it("times out and returns partial results when sessions don't complete", async () => {
    const ids = ["s1", "s2"];

    // Always return non-terminal states
    mockBatchStatus(() =>
      ok(batchStatusResponse({ s1: "ended", s2: "uploading" })),
    );

    const result = await waitForPipelineCompletion(
      ids,
      makeDeps({ timeoutMs: 200, pollIntervalMs: 50 }),
    );

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.summary.pending).toBe(2);
    expect(result.summary.parsed).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 5. Respects abort signal
  // -----------------------------------------------------------------------
  it("respects abort signal and returns aborted result", async () => {
    const ids = ["s1", "s2"];
    const controller = new AbortController();

    // Always return non-terminal states so it keeps polling
    mockBatchStatus(() =>
      ok(batchStatusResponse({ s1: "ended", s2: "uploading" })),
    );

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    const result = await waitForPipelineCompletion(
      ids,
      makeDeps({ signal: controller.signal, pollIntervalMs: 50 }),
    );

    expect(result.completed).toBe(false);
    expect(result.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. Returns empty result for empty session list
  // -----------------------------------------------------------------------
  it("returns empty completed result for empty session list", async () => {
    // Should not even call fetch
    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response("", { status: 500 }));
    }) as typeof fetch;

    const result = await waitForPipelineCompletion([], makeDeps());

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.summary).toEqual({
      parsed: 0,
      summarized: 0,
      archived: 0,
      failed: 0,
      pending: 0,
    });
    expect(fetchCalled).toBe(false);
  });
});
