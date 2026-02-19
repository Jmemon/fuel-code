/**
 * Tests for the git-session correlator.
 *
 * Uses mock SQL to test correlation logic without a real database.
 * Each test verifies a different correlation scenario:
 *   - Active session found (detected/capturing lifecycle)
 *   - No active session
 *   - Wrong workspace/device
 *   - Multiple active sessions (most recent wins)
 *   - Event timestamp before session started
 */

import { describe, expect, test, mock } from "bun:test";
import { correlateGitEventToSession } from "../git-correlator.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A captured SQL call — template strings and interpolated values */
interface SqlCall {
  strings: string[];
  values: unknown[];
}

/**
 * Create a mock sql tagged template function that returns a single result set.
 * Tracks all calls for assertion.
 */
function createMockSql(resultSet: Record<string, unknown>[]) {
  const calls: SqlCall[] = [];

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(resultSet);
  };

  return { sql: sqlFn as any, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("correlateGitEventToSession", () => {
  test("returns session ID when active session (detected) exists", async () => {
    const { sql } = createMockSql([{ id: "sess-001" }]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-001",
      new Date("2024-06-15T12:00:00.000Z"),
    );

    expect(result.sessionId).toBe("sess-001");
    expect(result.confidence).toBe("active");
  });

  test("returns session ID when active session (capturing) exists", async () => {
    // The mock doesn't differentiate lifecycle states — the SQL query handles that.
    // This test verifies the result mapping works for any active session match.
    const { sql } = createMockSql([{ id: "sess-capturing" }]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-001",
      new Date("2024-06-15T12:00:00.000Z"),
    );

    expect(result.sessionId).toBe("sess-capturing");
    expect(result.confidence).toBe("active");
  });

  test("returns null when no active session exists", async () => {
    const { sql } = createMockSql([]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-001",
      new Date("2024-06-15T12:00:00.000Z"),
    );

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe("none");
  });

  test("returns null when session is ended (not in result set)", async () => {
    // An ended session wouldn't match the SQL WHERE lifecycle IN ('detected','capturing'),
    // so the mock returns empty to simulate this
    const { sql } = createMockSql([]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-001",
      new Date("2024-06-15T12:00:00.000Z"),
    );

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe("none");
  });

  test("returns null when different workspace (not in result set)", async () => {
    // Different workspace means SQL WHERE workspace_id won't match
    const { sql } = createMockSql([]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-different",
      "device-001",
      new Date("2024-06-15T12:00:00.000Z"),
    );

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe("none");
  });

  test("returns null when different device (not in result set)", async () => {
    const { sql } = createMockSql([]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-different",
      new Date("2024-06-15T12:00:00.000Z"),
    );

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe("none");
  });

  test("returns most recently started session when multiple active", async () => {
    // SQL query orders by started_at DESC LIMIT 1, so mock returns the most recent
    const { sql } = createMockSql([{ id: "sess-newest" }]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-001",
      new Date("2024-06-15T14:00:00.000Z"),
    );

    expect(result.sessionId).toBe("sess-newest");
    expect(result.confidence).toBe("active");
  });

  test("returns null when event timestamp is before session started", async () => {
    // The SQL WHERE started_at <= eventTimestamp wouldn't match sessions that
    // started after the event, so the mock returns empty
    const { sql } = createMockSql([]);

    const result = await correlateGitEventToSession(
      sql,
      "ws-001",
      "device-001",
      new Date("2024-06-15T08:00:00.000Z"), // Before any session started
    );

    expect(result.sessionId).toBeNull();
    expect(result.confidence).toBe("none");
  });

  test("passes correct parameters to SQL query", async () => {
    const { sql, calls } = createMockSql([]);

    await correlateGitEventToSession(
      sql,
      "ws-123",
      "device-456",
      new Date("2024-06-15T12:30:00.000Z"),
    );

    // Verify the SQL was called with the correct parameters
    expect(calls).toHaveLength(1);
    const call = calls[0];

    // The query should include workspace_id, device_id, lifecycle filter, and timestamp
    expect(call.values[0]).toBe("ws-123");       // workspace_id
    expect(call.values[1]).toBe("device-456");   // device_id
    // values[2] is the timestamp ISO string
    expect(call.values[2]).toBe("2024-06-15T12:30:00.000Z");
  });
});
