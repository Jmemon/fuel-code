/**
 * Tests for session-lifecycle.ts — the session lifecycle state machine.
 *
 * Split into two sections:
 *
 * 1. Pure logic tests (no DB): Validate the transition map and isValidTransition.
 *    These always run.
 *
 * 2. Database-backed tests: Exercise transitionSession, failSession,
 *    resetSessionForReparse, getSessionState, and findStuckSessions against
 *    a real Postgres. These are wrapped in describe.skipIf(!DATABASE_URL)
 *    so they don't fail in environments without a DB.
 *
 * The mock SQL approach from existing tests is used where possible to avoid
 * requiring Postgres for basic validation.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  TRANSITIONS,
  isValidTransition,
  transitionSession,
  failSession,
  resetSessionForReparse,
  getSessionState,
  findStuckSessions,
  type SessionLifecycle,
} from "../session-lifecycle.js";

// ---------------------------------------------------------------------------
// Pure logic tests — no database required
// ---------------------------------------------------------------------------

describe("TRANSITIONS map", () => {
  test("detected allows capturing, ended, and failed", () => {
    expect(TRANSITIONS.detected).toEqual(["capturing", "ended", "failed"]);
  });

  test("capturing allows ended and failed", () => {
    expect(TRANSITIONS.capturing).toEqual(["ended", "failed"]);
  });

  test("ended allows parsed and failed", () => {
    expect(TRANSITIONS.ended).toEqual(["parsed", "failed"]);
  });

  test("parsed allows summarized and failed", () => {
    expect(TRANSITIONS.parsed).toEqual(["summarized", "failed"]);
  });

  test("summarized allows only archived", () => {
    expect(TRANSITIONS.summarized).toEqual(["archived"]);
  });

  test("archived is terminal (no transitions)", () => {
    expect(TRANSITIONS.archived).toEqual([]);
  });

  test("failed is terminal (no transitions)", () => {
    expect(TRANSITIONS.failed).toEqual([]);
  });
});

describe("isValidTransition", () => {
  test("detected -> capturing is valid", () => {
    expect(isValidTransition("detected", "capturing")).toBe(true);
  });

  test("detected -> ended is valid (short sessions skip capturing)", () => {
    expect(isValidTransition("detected", "ended")).toBe(true);
  });

  test("detected -> parsed is NOT valid (must go through ended)", () => {
    expect(isValidTransition("detected", "parsed")).toBe(false);
  });

  test("failed -> ended is NOT valid (terminal state)", () => {
    expect(isValidTransition("failed", "ended")).toBe(false);
  });

  test("summarized -> archived is valid", () => {
    expect(isValidTransition("summarized", "archived")).toBe(true);
  });

  test("summarized -> failed is NOT valid (only archived allowed)", () => {
    // summarized can only go to archived per the transition map
    expect(isValidTransition("summarized", "failed")).toBe(false);
  });

  test("archived -> anything is NOT valid (terminal)", () => {
    const allStates: SessionLifecycle[] = [
      "detected", "capturing", "ended", "parsed", "summarized", "archived", "failed",
    ];
    for (const target of allStates) {
      expect(isValidTransition("archived", target)).toBe(false);
    }
  });

  test("failed -> anything is NOT valid (terminal)", () => {
    const allStates: SessionLifecycle[] = [
      "detected", "capturing", "ended", "parsed", "summarized", "archived", "failed",
    ];
    for (const target of allStates) {
      expect(isValidTransition("failed", target)).toBe(false);
    }
  });

  test("every state -> itself is NOT valid (no self-transitions)", () => {
    const allStates: SessionLifecycle[] = [
      "detected", "capturing", "ended", "parsed", "summarized", "archived", "failed",
    ];
    for (const state of allStates) {
      expect(isValidTransition(state, state)).toBe(false);
    }
  });

  test("ended -> parsed is valid (normal pipeline progression)", () => {
    expect(isValidTransition("ended", "parsed")).toBe(true);
  });

  test("parsed -> summarized is valid", () => {
    expect(isValidTransition("parsed", "summarized")).toBe(true);
  });

  test("capturing -> ended is valid", () => {
    expect(isValidTransition("capturing", "ended")).toBe(true);
  });

  test("capturing -> failed is valid", () => {
    expect(isValidTransition("capturing", "failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Database-backed tests — require a real Postgres connection
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("session-lifecycle (database)", () => {
  // Dynamically import postgres only when we have a DATABASE_URL
  let postgres: typeof import("postgres");
  let sql: import("postgres").Sql;

  // Test fixtures: IDs for workspace, device, and sessions
  const workspaceId = "test-ws-lifecycle-001";
  const deviceId = "test-device-lifecycle-001";

  // Counter to generate unique session IDs per test
  let sessionCounter = 0;
  function nextSessionId(): string {
    sessionCounter++;
    return `test-sess-lifecycle-${sessionCounter}-${Date.now()}`;
  }

  beforeAll(async () => {
    // Dynamic import so the test file can load even without postgres installed
    const mod = await import("postgres");
    postgres = mod.default;
    sql = postgres(DATABASE_URL!);

    // Ensure test workspace and device exist (required by FK constraints)
    await sql`
      INSERT INTO workspaces (id, canonical_id, display_name)
      VALUES (${workspaceId}, ${"test-canonical-lifecycle"}, ${"test-lifecycle-repo"})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO devices (id, name, type)
      VALUES (${deviceId}, ${"test-lifecycle-device"}, ${"local"})
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Clean up test data. Delete sessions first (FK from events), then workspace/device.
    await sql`DELETE FROM content_blocks WHERE session_id LIKE 'test-sess-lifecycle-%'`;
    await sql`DELETE FROM transcript_messages WHERE session_id LIKE 'test-sess-lifecycle-%'`;
    await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    await sql.end();
  });

  /**
   * Helper: insert a session row in a given lifecycle state for testing.
   * Returns the session ID.
   */
  async function insertSession(
    lifecycle: SessionLifecycle = "detected",
    overrides?: { parse_status?: string; updated_at?: string },
  ): Promise<string> {
    const id = nextSessionId();
    await sql`
      INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, parse_status, updated_at)
      VALUES (
        ${id},
        ${workspaceId},
        ${deviceId},
        ${lifecycle},
        ${new Date().toISOString()},
        ${overrides?.parse_status ?? "pending"},
        ${overrides?.updated_at ? new Date(overrides.updated_at) : sql`now()`}
      )
    `;
    return id;
  }

  // -----------------------------------------------------------------------
  // transitionSession
  // -----------------------------------------------------------------------

  describe("transitionSession", () => {
    test("with correct from state: updates lifecycle, returns success", async () => {
      const sessionId = await insertSession("detected");

      const result = await transitionSession(sql, sessionId, "detected", "capturing");

      expect(result.success).toBe(true);
      expect(result.newLifecycle).toBe("capturing");

      // Verify in DB
      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("capturing");
    });

    test("with wrong from state: returns failure, session unchanged", async () => {
      const sessionId = await insertSession("detected");

      // Try to transition from "ended" but session is "detected"
      const result = await transitionSession(sql, sessionId, "ended", "parsed");

      expect(result.success).toBe(false);
      expect(result.reason).toContain("detected");
      expect(result.reason).toContain("ended");

      // Verify session is still in original state
      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("detected");
    });

    test("with from array: succeeds if session is in any listed state", async () => {
      const sessionId = await insertSession("capturing");

      // Transition from either detected or capturing -> ended
      const result = await transitionSession(
        sql,
        sessionId,
        ["detected", "capturing"],
        "ended",
      );

      expect(result.success).toBe(true);
      expect(result.newLifecycle).toBe("ended");

      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("ended");
    });

    test("with additional updates: sets extra columns alongside lifecycle", async () => {
      const sessionId = await insertSession("ended");

      const result = await transitionSession(
        sql,
        sessionId,
        "ended",
        "parsed",
        {
          parse_status: "completed",
          total_messages: 42,
          user_messages: 20,
          assistant_messages: 22,
          tokens_in: 10000,
          tokens_out: 5000,
          cost_estimate_usd: 0.15,
        },
      );

      expect(result.success).toBe(true);

      // Verify the extra columns were set
      const rows = await sql`
        SELECT lifecycle, parse_status, total_messages, user_messages,
               assistant_messages, tokens_in, tokens_out, cost_estimate_usd
        FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0].lifecycle).toBe("parsed");
      expect(rows[0].parse_status).toBe("completed");
      expect(rows[0].total_messages).toBe(42);
      expect(rows[0].user_messages).toBe(20);
      expect(rows[0].assistant_messages).toBe(22);
      expect(Number(rows[0].tokens_in)).toBe(10000);
      expect(Number(rows[0].tokens_out)).toBe(5000);
      expect(Number(rows[0].cost_estimate_usd)).toBeCloseTo(0.15, 4);
    });

    test("non-existent session: returns failure with 'Session not found'", async () => {
      const result = await transitionSession(
        sql,
        "nonexistent-session-999",
        "detected",
        "capturing",
      );

      expect(result.success).toBe(false);
      expect(result.reason).toBe("Session not found");
    });

    test("invalid transition: returns failure before hitting DB", async () => {
      const sessionId = await insertSession("detected");

      // detected -> parsed is not valid (must go through ended)
      const result = await transitionSession(sql, sessionId, "detected", "parsed");

      expect(result.success).toBe(false);
      expect(result.reason).toContain("Invalid transition");
    });

    test("concurrent transitions: only one succeeds", async () => {
      const sessionId = await insertSession("ended");

      // Fire two concurrent ended -> parsed transitions
      const [result1, result2] = await Promise.all([
        transitionSession(sql, sessionId, "ended", "parsed"),
        transitionSession(sql, sessionId, "ended", "parsed"),
      ]);

      // Exactly one should succeed
      const successes = [result1, result2].filter((r) => r.success);
      const failures = [result1, result2].filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      // The failure should report the session is now in "parsed"
      expect(failures[0].reason).toContain("parsed");

      // DB should show "parsed"
      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("parsed");
    });
  });

  // -----------------------------------------------------------------------
  // failSession
  // -----------------------------------------------------------------------

  describe("failSession", () => {
    test("sets lifecycle to failed and records error", async () => {
      const sessionId = await insertSession("ended");

      const result = await failSession(sql, sessionId, "Parser crashed: out of memory");

      expect(result.success).toBe(true);
      expect(result.newLifecycle).toBe("failed");

      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("failed");
      expect(state?.parse_status).toBe("failed");
      expect(state?.parse_error).toBe("Parser crashed: out of memory");
    });

    test("works from any non-terminal state", async () => {
      // Test from "detected"
      const s1 = await insertSession("detected");
      const r1 = await failSession(sql, s1, "err");
      expect(r1.success).toBe(true);

      // Test from "capturing"
      const s2 = await insertSession("capturing");
      const r2 = await failSession(sql, s2, "err");
      expect(r2.success).toBe(true);

      // Test from "parsed"
      const s3 = await insertSession("parsed");
      const r3 = await failSession(sql, s3, "err");
      expect(r3.success).toBe(true);
    });

    test("does NOT fail an already-failed session", async () => {
      const sessionId = await insertSession("failed");

      const result = await failSession(sql, sessionId, "second error");

      expect(result.success).toBe(false);
      expect(result.reason).toContain("failed");
    });

    test("does NOT fail an archived session", async () => {
      const sessionId = await insertSession("archived");

      const result = await failSession(sql, sessionId, "too late");

      expect(result.success).toBe(false);
      expect(result.reason).toContain("archived");
    });

    test("non-existent session: returns failure", async () => {
      const result = await failSession(sql, "no-such-session-fail", "error");

      expect(result.success).toBe(false);
      expect(result.reason).toBe("Session not found");
    });
  });

  // -----------------------------------------------------------------------
  // resetSessionForReparse
  // -----------------------------------------------------------------------

  describe("resetSessionForReparse", () => {
    test("from summarized: resets to ended, clears stats", async () => {
      const sessionId = await insertSession("summarized");

      // Set some derived stats that should be cleared
      await sql`
        UPDATE sessions
        SET parse_status = 'completed',
            summary = 'test summary',
            total_messages = 10,
            tokens_in = 5000
        WHERE id = ${sessionId}
      `;

      const result = await resetSessionForReparse(sql, sessionId);

      expect(result.reset).toBe(true);
      // RETURNING gives us the new lifecycle ('ended'), not the old one
      expect(result.previousLifecycle).toBe("ended");

      // Verify the session was reset
      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("ended");
      expect(state?.parse_status).toBe("pending");
      expect(state?.parse_error).toBeNull();

      // Verify derived stats were cleared
      const rows = await sql`
        SELECT summary, total_messages, tokens_in, transcript_s3_key
        FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0].summary).toBeNull();
      expect(rows[0].total_messages).toBeNull();
      expect(rows[0].tokens_in).toBeNull();
    });

    test("from failed: resets to ended", async () => {
      const sessionId = await insertSession("failed");
      await sql`
        UPDATE sessions SET parse_error = 'some error' WHERE id = ${sessionId}
      `;

      const result = await resetSessionForReparse(sql, sessionId);

      expect(result.reset).toBe(true);

      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("ended");
      expect(state?.parse_error).toBeNull();
    });

    test("from detected: returns reset=false (not allowed)", async () => {
      const sessionId = await insertSession("detected");

      const result = await resetSessionForReparse(sql, sessionId);

      expect(result.reset).toBe(false);
      expect(result.previousLifecycle).toBeNull();

      // Session should still be "detected"
      const state = await getSessionState(sql, sessionId);
      expect(state?.lifecycle).toBe("detected");
    });

    test("from capturing: returns reset=false (not allowed)", async () => {
      const sessionId = await insertSession("capturing");

      const result = await resetSessionForReparse(sql, sessionId);

      expect(result.reset).toBe(false);
      expect(result.previousLifecycle).toBeNull();
    });

    test("preserves transcript_s3_key", async () => {
      const sessionId = await insertSession("parsed");
      await sql`
        UPDATE sessions
        SET transcript_s3_key = 's3://bucket/transcript.jsonl'
        WHERE id = ${sessionId}
      `;

      await resetSessionForReparse(sql, sessionId);

      const rows = await sql`
        SELECT transcript_s3_key FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0].transcript_s3_key).toBe("s3://bucket/transcript.jsonl");
    });

    test("non-existent session: returns reset=false", async () => {
      const result = await resetSessionForReparse(sql, "no-such-session-reset");

      expect(result.reset).toBe(false);
      expect(result.previousLifecycle).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getSessionState
  // -----------------------------------------------------------------------

  describe("getSessionState", () => {
    test("returns lifecycle, parse_status, parse_error for existing session", async () => {
      const sessionId = await insertSession("ended");

      const state = await getSessionState(sql, sessionId);

      expect(state).not.toBeNull();
      expect(state!.lifecycle).toBe("ended");
      expect(state!.parse_status).toBe("pending");
      expect(state!.parse_error).toBeNull();
    });

    test("returns null for non-existent session", async () => {
      const state = await getSessionState(sql, "absolutely-no-such-session");

      expect(state).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // findStuckSessions
  // -----------------------------------------------------------------------

  describe("findStuckSessions", () => {
    test("finds sessions stuck longer than threshold", async () => {
      // Insert a session with updated_at far in the past
      const stuckId = await insertSession("ended", {
        parse_status: "pending",
        updated_at: "2020-01-01T00:00:00Z",
      });

      const stuck = await findStuckSessions(sql, 1000); // 1 second threshold

      const found = stuck.find((s) => s.id === stuckId);
      expect(found).toBeDefined();
      expect(found!.lifecycle).toBe("ended");
      expect(found!.parse_status).toBe("pending");
    });

    test("ignores recently updated sessions", async () => {
      // Insert a session updated very recently (now)
      const recentId = await insertSession("ended", {
        parse_status: "pending",
      });

      // Use a huge threshold so nothing is "stuck"
      const stuck = await findStuckSessions(sql, 86_400_000); // 24 hours

      const found = stuck.find((s) => s.id === recentId);
      expect(found).toBeUndefined();
    });

    test("ignores sessions not in ended/parsed lifecycle", async () => {
      // A "detected" session with pending parse_status should NOT be found
      const detectedId = await insertSession("detected", {
        parse_status: "pending",
        updated_at: "2020-01-01T00:00:00Z",
      });

      const stuck = await findStuckSessions(sql, 1000);

      const found = stuck.find((s) => s.id === detectedId);
      expect(found).toBeUndefined();
    });

    test("finds sessions stuck in 'parsing' parse_status", async () => {
      const parsingId = await insertSession("ended", {
        parse_status: "parsing",
        updated_at: "2020-01-01T00:00:00Z",
      });

      const stuck = await findStuckSessions(sql, 1000);

      const found = stuck.find((s) => s.id === parsingId);
      expect(found).toBeDefined();
      expect(found!.parse_status).toBe("parsing");
    });

    test("ignores sessions with completed parse_status", async () => {
      const completedId = await insertSession("ended", {
        parse_status: "completed",
        updated_at: "2020-01-01T00:00:00Z",
      });

      const stuck = await findStuckSessions(sql, 1000);

      const found = stuck.find((s) => s.id === completedId);
      expect(found).toBeUndefined();
    });
  });
});
