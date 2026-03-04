/**
 * E2E tests for the session lifecycle state machine.
 *
 * Validates the full lifecycle progression and edge cases using the pure logic
 * functions (isValidTransition, TRANSITIONS) and the database-backed mutation
 * functions (transitionSession, failSession, resetSessionForReparse).
 *
 * Organized into two sections:
 *   1. Pure logic tests: No database required. Verify the full happy-path
 *      transition chain, invalid transition rejection, and failed-state rules.
 *   2. Database-backed tests: Full lifecycle walk-through using real Postgres.
 *      Gated by DATABASE_URL.
 *
 * These tests complement session-lifecycle.test.ts by focusing on E2E
 * scenarios that exercise the entire lifecycle chain end-to-end rather than
 * individual transitions.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  TRANSITIONS,
  isValidTransition,
  transitionSession,
  failSession,
  resetSessionForReparse,
  getSessionState,
  type SessionLifecycle,
} from "../session-lifecycle.js";

// ---------------------------------------------------------------------------
// Pure logic tests — no database required
// ---------------------------------------------------------------------------

describe("lifecycle E2E (pure logic)", () => {
  // -------------------------------------------------------------------------
  // 1. Happy path: full chain detected -> ended -> transcript_ready -> parsed
  //    -> summarized -> complete
  // -------------------------------------------------------------------------

  test("happy path: all transitions in the standard pipeline are valid", () => {
    const chain: [SessionLifecycle, SessionLifecycle][] = [
      ["detected", "ended"],
      ["ended", "transcript_ready"],
      ["transcript_ready", "parsed"],
      ["parsed", "summarized"],
      ["summarized", "complete"],
    ];

    for (const [from, to] of chain) {
      expect(isValidTransition(from, to)).toBe(true);
    }
  });

  test("happy path: fast-track detected -> transcript_ready is valid", () => {
    // In some flows (e.g., backfill), a session can go directly from
    // detected to transcript_ready, skipping 'ended'.
    expect(isValidTransition("detected", "transcript_ready")).toBe(true);
  });

  test("complete is truly terminal: cannot transition to any state", () => {
    const allStates: SessionLifecycle[] = [
      "detected", "ended", "transcript_ready", "parsed",
      "summarized", "complete", "failed",
    ];

    for (const target of allStates) {
      expect(isValidTransition("complete", target)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Invalid transitions: skipping states is rejected
  // -------------------------------------------------------------------------

  test("skipping states is rejected: detected -> parsed", () => {
    expect(isValidTransition("detected", "parsed")).toBe(false);
  });

  test("skipping states is rejected: detected -> summarized", () => {
    expect(isValidTransition("detected", "summarized")).toBe(false);
  });

  test("skipping states is rejected: detected -> complete", () => {
    expect(isValidTransition("detected", "complete")).toBe(false);
  });

  test("skipping states is rejected: ended -> parsed", () => {
    expect(isValidTransition("ended", "parsed")).toBe(false);
  });

  test("skipping states is rejected: ended -> summarized", () => {
    expect(isValidTransition("ended", "summarized")).toBe(false);
  });

  test("skipping states is rejected: ended -> complete", () => {
    expect(isValidTransition("ended", "complete")).toBe(false);
  });

  test("skipping states is rejected: transcript_ready -> summarized", () => {
    expect(isValidTransition("transcript_ready", "summarized")).toBe(false);
  });

  test("skipping states is rejected: transcript_ready -> complete", () => {
    expect(isValidTransition("transcript_ready", "complete")).toBe(false);
  });

  test("skipping states is rejected: parsed -> complete", () => {
    expect(isValidTransition("parsed", "complete")).toBe(false);
  });

  test("backward transitions are rejected: parsed -> ended", () => {
    expect(isValidTransition("parsed", "ended")).toBe(false);
  });

  test("backward transitions are rejected: summarized -> parsed", () => {
    expect(isValidTransition("summarized", "parsed")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Failed state: reachable from any non-terminal state
  // -------------------------------------------------------------------------

  test("failed is reachable from detected, ended, transcript_ready, parsed", () => {
    const canFail: SessionLifecycle[] = [
      "detected", "ended", "transcript_ready", "parsed",
    ];
    for (const state of canFail) {
      expect(isValidTransition(state, "failed")).toBe(true);
    }
  });

  test("failed is NOT reachable from summarized (only complete allowed)", () => {
    expect(isValidTransition("summarized", "failed")).toBe(false);
  });

  test("failed is NOT reachable from complete (terminal)", () => {
    expect(isValidTransition("complete", "failed")).toBe(false);
  });

  test("failed is NOT reachable from failed (no self-transitions)", () => {
    expect(isValidTransition("failed", "failed")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. Reset path: failed -> ended
  // -------------------------------------------------------------------------

  test("failed -> ended is valid (reset for retry)", () => {
    expect(isValidTransition("failed", "ended")).toBe(true);
  });

  test("failed -> anything other than ended is invalid", () => {
    const nonEnded: SessionLifecycle[] = [
      "detected", "transcript_ready", "parsed", "summarized", "complete", "failed",
    ];
    for (const target of nonEnded) {
      expect(isValidTransition("failed", target)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Transition map structure validation
  // -------------------------------------------------------------------------

  test("every state in TRANSITIONS has a defined entry", () => {
    const allStates: SessionLifecycle[] = [
      "detected", "ended", "transcript_ready", "parsed",
      "summarized", "complete", "failed",
    ];
    for (const state of allStates) {
      expect(TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(TRANSITIONS[state])).toBe(true);
    }
  });

  test("no self-transitions exist in the map", () => {
    const allStates: SessionLifecycle[] = [
      "detected", "ended", "transcript_ready", "parsed",
      "summarized", "complete", "failed",
    ];
    for (const state of allStates) {
      expect(TRANSITIONS[state]).not.toContain(state);
    }
  });

  test("all target states in TRANSITIONS are valid lifecycle states", () => {
    const validStates = new Set<string>([
      "detected", "ended", "transcript_ready", "parsed",
      "summarized", "complete", "failed",
    ]);

    for (const targets of Object.values(TRANSITIONS)) {
      for (const target of targets) {
        expect(validStates.has(target)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Database-backed tests — full lifecycle walk-through
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("lifecycle E2E (database)", () => {
  let sql: import("postgres").Sql;

  const workspaceId = "test-ws-e2e-lifecycle-001";
  const deviceId = "test-device-e2e-lifecycle-001";

  let sessionCounter = 0;
  function nextSessionId(): string {
    sessionCounter++;
    return `test-sess-e2e-lc-${sessionCounter}-${Date.now()}`;
  }

  beforeAll(async () => {
    const mod = await import("postgres");
    sql = mod.default(DATABASE_URL!);

    await sql`
      INSERT INTO workspaces (id, canonical_id, display_name)
      VALUES (${workspaceId}, ${"test-canonical-e2e-lc"}, ${"test-e2e-lifecycle-repo"})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO devices (id, name, type)
      VALUES (${deviceId}, ${"test-e2e-lifecycle-device"}, ${"local"})
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM content_blocks WHERE session_id LIKE 'test-sess-e2e-lc-%'`;
    await sql`DELETE FROM transcript_messages WHERE session_id LIKE 'test-sess-e2e-lc-%'`;
    await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    await sql.end();
  });

  async function insertSession(lifecycle: SessionLifecycle = "detected"): Promise<string> {
    const id = nextSessionId();
    await sql`
      INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, updated_at)
      VALUES (${id}, ${workspaceId}, ${deviceId}, ${lifecycle}, ${new Date().toISOString()}, now())
    `;
    return id;
  }

  // -------------------------------------------------------------------------
  // Full happy-path walk-through
  // -------------------------------------------------------------------------

  test("full pipeline walk: detected -> ended -> transcript_ready -> parsed -> summarized -> complete", async () => {
    const sessionId = await insertSession("detected");

    // detected -> ended
    const r1 = await transitionSession(sql, sessionId, "detected", "ended");
    expect(r1.success).toBe(true);
    expect(r1.newLifecycle).toBe("ended");

    // ended -> transcript_ready
    const r2 = await transitionSession(sql, sessionId, "ended", "transcript_ready");
    expect(r2.success).toBe(true);
    expect(r2.newLifecycle).toBe("transcript_ready");

    // transcript_ready -> parsed (with stats)
    const r3 = await transitionSession(sql, sessionId, "transcript_ready", "parsed", {
      total_messages: 10,
      user_messages: 4,
      assistant_messages: 6,
      tokens_in: 5000,
      tokens_out: 2500,
      cost_estimate_usd: 0.05,
    });
    expect(r3.success).toBe(true);
    expect(r3.newLifecycle).toBe("parsed");

    // parsed -> summarized
    const r4 = await transitionSession(sql, sessionId, "parsed", "summarized", {
      summary: "Fixed a typo in README.md",
    });
    expect(r4.success).toBe(true);
    expect(r4.newLifecycle).toBe("summarized");

    // summarized -> complete
    const r5 = await transitionSession(sql, sessionId, "summarized", "complete");
    expect(r5.success).toBe(true);
    expect(r5.newLifecycle).toBe("complete");

    // Verify final state
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("complete");
    expect(state?.last_error).toBeNull();

    // Verify stats were preserved through transitions
    const rows = await sql`
      SELECT total_messages, summary FROM sessions WHERE id = ${sessionId}
    `;
    expect(rows[0].total_messages).toBe(10);
    expect(rows[0].summary).toBe("Fixed a typo in README.md");
  });

  // -------------------------------------------------------------------------
  // Fail and recovery walk-through
  // -------------------------------------------------------------------------

  test("fail and reset cycle: transcript_ready -> failed -> ended -> transcript_ready", async () => {
    const sessionId = await insertSession("transcript_ready");

    // Fail the session
    const r1 = await failSession(sql, sessionId, "Parser crashed: OOM");
    expect(r1.success).toBe(true);
    expect(r1.newLifecycle).toBe("failed");

    // Verify error is recorded
    const failedState = await getSessionState(sql, sessionId);
    expect(failedState?.lifecycle).toBe("failed");
    expect(failedState?.last_error).toBe("Parser crashed: OOM");

    // Reset for retry
    const resetResult = await resetSessionForReparse(sql, sessionId);
    expect(resetResult.reset).toBe(true);

    // Verify reset state
    const resetState = await getSessionState(sql, sessionId);
    expect(resetState?.lifecycle).toBe("ended");
    expect(resetState?.last_error).toBeNull();

    // Can re-enter pipeline
    const r2 = await transitionSession(sql, sessionId, "ended", "transcript_ready");
    expect(r2.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Invalid transition is rejected at DB level
  // -------------------------------------------------------------------------

  test("invalid transition at DB level: detected -> parsed returns failure", async () => {
    const sessionId = await insertSession("detected");

    const result = await transitionSession(sql, sessionId, "detected", "parsed");
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Invalid transition");

    // Session is unchanged
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("detected");
  });

  // -------------------------------------------------------------------------
  // resetSessionForReparse clears derived stats
  // -------------------------------------------------------------------------

  test("resetSessionForReparse from parsed clears all derived stats", async () => {
    const sessionId = await insertSession("parsed");

    // Set some derived stats
    await sql`
      UPDATE sessions SET
        summary = 'Test summary',
        total_messages = 42,
        user_messages = 20,
        assistant_messages = 22,
        tokens_in = 10000,
        tokens_out = 5000,
        cost_estimate_usd = 0.50
      WHERE id = ${sessionId}
    `;

    const resetResult = await resetSessionForReparse(sql, sessionId);
    expect(resetResult.reset).toBe(true);

    // Verify all stats are cleared
    const rows = await sql`
      SELECT lifecycle, summary, total_messages, user_messages,
             assistant_messages, tokens_in, tokens_out, cost_estimate_usd
      FROM sessions WHERE id = ${sessionId}
    `;
    expect(rows[0].lifecycle).toBe("ended");
    expect(rows[0].summary).toBeNull();
    expect(rows[0].total_messages).toBeNull();
    expect(rows[0].user_messages).toBeNull();
    expect(rows[0].assistant_messages).toBeNull();
    expect(rows[0].tokens_in).toBeNull();
    expect(rows[0].tokens_out).toBeNull();
    expect(rows[0].cost_estimate_usd).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cannot operate on complete sessions
  // -------------------------------------------------------------------------

  test("complete session rejects all mutations", async () => {
    const sessionId = await insertSession("complete");

    // Cannot fail
    const failResult = await failSession(sql, sessionId, "too late");
    expect(failResult.success).toBe(false);

    // Cannot reset
    const resetResult = await resetSessionForReparse(sql, sessionId);
    expect(resetResult.reset).toBe(false);

    // Cannot transition
    const transResult = await transitionSession(sql, sessionId, "complete", "ended");
    expect(transResult.success).toBe(false);

    // State is unchanged
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("complete");
  });
});
