/**
 * Unit tests for waitForPipelineCompletion.
 *
 * Uses a mock SQL tagged template to simulate direct DB lifecycle queries.
 * Each test uses fast poll intervals (50ms) to keep suite execution quick.
 */

import { describe, it, expect } from "bun:test";
import { waitForPipelineCompletion } from "../session-backfill.js";
import type { PipelineWaitDeps, PipelineWaitProgress } from "../session-backfill.js";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock SQL tagged template function that returns lifecycle rows.
 * The handler receives the session IDs from the ANY($1) parameter and
 * returns an array of { id, lifecycle } rows.
 */
function createMockSql(
  handler: (sessionIds: string[]) => Array<{ id: string; lifecycle: string }>,
): Sql {
  // The mock mimics postgres tagged template behavior:
  // sql`SELECT id, lifecycle FROM sessions WHERE id = ANY(${sessionIds})`
  // The first interpolated value is the sessionIds array.
  const mockSql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    const sessionIds = values[0] as string[];
    return Promise.resolve(handler(sessionIds));
  }) as unknown as Sql;
  return mockSql;
}

/** Default deps with fast poll interval for testing. */
function makeDeps(overrides: Partial<PipelineWaitDeps>): PipelineWaitDeps {
  return {
    sql: undefined as unknown as Sql, // Must be overridden
    pollIntervalMs: 50,
    ...overrides,
  };
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

    const sql = createMockSql(() => [
      { id: "s1", lifecycle: "complete" },
      { id: "s2", lifecycle: "complete" },
      { id: "s3", lifecycle: "failed" },
    ]);

    const result = await waitForPipelineCompletion(ids, makeDeps({ sql }));

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.summary.complete).toBe(2);
    expect(result.summary.failed).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 2. Polls until sessions reach terminal states
  // -----------------------------------------------------------------------
  it("polls until all sessions reach terminal states", async () => {
    const ids = ["s1", "s2"];
    let callCount = 0;

    const sql = createMockSql(() => {
      callCount++;
      if (callCount === 1) {
        // First poll: s1 still processing, s2 done
        return [
          { id: "s1", lifecycle: "ended" },
          { id: "s2", lifecycle: "complete" },
        ];
      }
      if (callCount === 2) {
        // Second poll: s1 still processing, s2 done
        return [
          { id: "s1", lifecycle: "transcript_ready" },
          { id: "s2", lifecycle: "complete" },
        ];
      }
      // Third poll: both done
      return [
        { id: "s1", lifecycle: "complete" },
        { id: "s2", lifecycle: "complete" },
      ];
    });

    const progressCalls: PipelineWaitProgress[] = [];
    const result = await waitForPipelineCompletion(
      ids,
      makeDeps({ sql, onProgress: (p) => progressCalls.push({ ...p }) }),
    );

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.summary.complete).toBe(2);

    // Should have polled at least 3 times
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Progress should have been called each poll
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);

    // First progress call should show 1 completed (s2 complete) out of 2
    expect(progressCalls[0].total).toBe(2);
    expect(progressCalls[0].completed).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 3. Reports failed sessions in summary
  // -----------------------------------------------------------------------
  it("reports failed sessions correctly in the summary", async () => {
    const ids = ["s1", "s2", "s3"];

    const sql = createMockSql(() => [
      { id: "s1", lifecycle: "complete" },
      { id: "s2", lifecycle: "failed" },
      { id: "s3", lifecycle: "complete" },
    ]);

    const result = await waitForPipelineCompletion(ids, makeDeps({ sql }));

    expect(result.completed).toBe(true);
    expect(result.summary.complete).toBe(2);
    expect(result.summary.failed).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 4. Times out and returns partial results
  // -----------------------------------------------------------------------
  it("times out and returns partial results when sessions don't complete", async () => {
    const ids = ["s1", "s2"];

    // Always return non-terminal states
    const sql = createMockSql(() => [
      { id: "s1", lifecycle: "ended" },
      { id: "s2", lifecycle: "transcript_ready" },
    ]);

    const result = await waitForPipelineCompletion(
      ids,
      makeDeps({ sql, timeoutMs: 200, pollIntervalMs: 50 }),
    );

    expect(result.completed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.summary.ended).toBe(1);
    expect(result.summary.transcript_ready).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 5. Respects abort signal
  // -----------------------------------------------------------------------
  it("respects abort signal and returns aborted result", async () => {
    const ids = ["s1", "s2"];
    const controller = new AbortController();

    // Always return non-terminal states so it keeps polling
    const sql = createMockSql(() => [
      { id: "s1", lifecycle: "ended" },
      { id: "s2", lifecycle: "transcript_ready" },
    ]);

    // Abort after 100ms
    setTimeout(() => controller.abort(), 100);

    const result = await waitForPipelineCompletion(
      ids,
      makeDeps({ sql, signal: controller.signal, pollIntervalMs: 50 }),
    );

    expect(result.completed).toBe(false);
    expect(result.aborted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. Returns empty result for empty session list
  // -----------------------------------------------------------------------
  it("returns empty completed result for empty session list", async () => {
    let sqlCalled = false;
    const sql = createMockSql(() => {
      sqlCalled = true;
      return [];
    });

    const result = await waitForPipelineCompletion([], makeDeps({ sql }));

    expect(result.completed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.summary).toEqual({});
    expect(sqlCalled).toBe(false);
  });
});
