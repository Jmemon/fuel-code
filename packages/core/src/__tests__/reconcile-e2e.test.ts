/**
 * E2E tests for reconcileSession() — the main pipeline entry point.
 *
 * These tests exercise the full reconciliation pipeline against a real
 * Postgres database. They verify:
 *
 *   1. Full pipeline: transcript_ready -> reconcile -> reaches parsed/summarized/complete
 *   2. Idempotent re-entry: calling reconcileSession on a complete session is a no-op
 *   3. Resume from parsed: reconcileSession on parsed session -> summarized/complete
 *   4. Empty transcript: reconcileSession with empty content -> still advances lifecycle
 *   5. Failed session: reconcileSession on a failed session is a no-op
 *   6. Missing transcript S3 key: returns error, does not crash
 *
 * All tests are gated by DATABASE_URL. Summary is disabled (summaryConfig.enabled = false)
 * to avoid requiring ANTHROPIC_API_KEY.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  reconcileSession,
  type ReconcileDeps,
  type ReconcileS3Client,
} from "../reconcile/reconcile-session.js";
import { getSessionState, type SessionLifecycle } from "../session-lifecycle.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

const silentLogger = pino({ level: "silent" });

/** Create a mock S3 client that returns the given content on download. */
function createMockS3(transcriptContent: string): ReconcileS3Client {
  return {
    upload: async (key, body) => ({
      key,
      size: typeof body === "string" ? body.length : body.length,
    }),
    download: async () => transcriptContent,
  };
}

/** Create a mock S3 that rejects downloads (simulates missing transcript). */
function createFailingS3(): ReconcileS3Client {
  return {
    upload: async (key, body) => ({
      key,
      size: typeof body === "string" ? body.length : body.length,
    }),
    download: async () => {
      throw new Error("S3 NoSuchKey: transcript not found");
    },
  };
}

// ---------------------------------------------------------------------------
// Database-backed tests
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)("reconcile E2E", () => {
  let sql: import("postgres").Sql;

  const workspaceId = "test-ws-e2e-reconcile-001";
  const deviceId = "test-device-e2e-reconcile-001";
  let sessionCounter = 0;

  function nextSessionId(): string {
    sessionCounter++;
    return `test-sess-e2e-rec-${sessionCounter}-${Date.now()}`;
  }

  beforeAll(async () => {
    const mod = await import("postgres");
    sql = mod.default(DATABASE_URL!);

    await sql`
      INSERT INTO workspaces (id, canonical_id, display_name)
      VALUES (${workspaceId}, ${"test-canonical-e2e-rec"}, ${"test-e2e-reconcile-repo"})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO devices (id, name, type)
      VALUES (${deviceId}, ${"test-e2e-reconcile-device"}, ${"local"})
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Clean up in FK order
    await sql`DELETE FROM teammates WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM teams WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM content_blocks WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM transcript_messages WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM session_skills WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM session_worktrees WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM subagents WHERE session_id LIKE 'test-sess-e2e-rec-%'`;
    await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    await sql.end();
  });

  /** Insert a session at a given lifecycle state with an S3 key. */
  async function insertSession(
    lifecycle: SessionLifecycle,
    overrides?: { transcript_s3_key?: string | null },
  ): Promise<string> {
    const id = nextSessionId();
    await sql`
      INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, transcript_s3_key)
      VALUES (
        ${id},
        ${workspaceId},
        ${deviceId},
        ${lifecycle},
        ${new Date().toISOString()},
        ${overrides?.transcript_s3_key ?? "transcripts/test-canonical-e2e-rec/rec/raw.jsonl"}
      )
    `;
    return id;
  }

  /** Build ReconcileDeps with a given S3 mock and summary disabled. */
  function buildDeps(s3: ReconcileS3Client): ReconcileDeps {
    return {
      sql,
      s3,
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: silentLogger,
    };
  }

  // -----------------------------------------------------------------------
  // 1. Full pipeline: transcript_ready -> parsed (summary disabled -> complete)
  // -----------------------------------------------------------------------

  test("full pipeline: transcript_ready session reaches parsed then complete", async () => {
    const sessionId = await insertSession("transcript_ready");
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-plain.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    // Parsing should succeed
    expect(result.parseSuccess).toBe(true);
    expect(result.errors.filter(e => !e.startsWith("Line "))).toEqual([]);

    // Steps should include key pipeline stages
    expect(result.stepsExecuted).toContain("computeGap");
    expect(result.stepsExecuted).toContain("downloadTranscript");
    expect(result.stepsExecuted).toContain("parseTranscript");
    expect(result.stepsExecuted).toContain("persistMessages");
    expect(result.stepsExecuted).toContain("transitionToParsed");

    // Session should be at parsed or beyond (summary is disabled so it
    // advances through summarized to complete)
    const state = await getSessionState(sql, sessionId);
    expect(["parsed", "summarized", "complete"]).toContain(state?.lifecycle);

    // Verify transcript messages were persisted
    const messages = await sql`
      SELECT count(*)::int as c FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    expect(messages[0].c).toBeGreaterThan(0);

    // Verify content blocks were persisted
    const blocks = await sql`
      SELECT count(*)::int as c FROM content_blocks WHERE session_id = ${sessionId}
    `;
    expect(blocks[0].c).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 2. Idempotent re-entry: complete session is a no-op
  // -----------------------------------------------------------------------

  test("idempotent: reconcileSession on complete session is a no-op", async () => {
    const sessionId = await insertSession("complete");

    const deps = buildDeps(createMockS3(""));
    const result = await reconcileSession(deps, sessionId);

    // Should report success without doing anything
    expect(result.parseSuccess).toBe(true);
    expect(result.summarySuccess).toBe(true);
    expect(result.finalLifecycle).toBe("complete");
    expect(result.errors).toEqual([]);

    // No substantial steps should have been executed
    expect(result.stepsExecuted).not.toContain("downloadTranscript");
    expect(result.stepsExecuted).not.toContain("parseTranscript");
    expect(result.stepsExecuted).not.toContain("persistMessages");
  });

  // -----------------------------------------------------------------------
  // 3. Resume from parsed: skip parsing, attempt summary
  // -----------------------------------------------------------------------

  test("resume from parsed: skips parsing, advances lifecycle", async () => {
    const sessionId = await insertSession("parsed");

    // Insert some pre-existing messages so the session has data
    const { generateId } = await import("@fuel-code/shared");
    const msgId = generateId();
    await sql`
      INSERT INTO transcript_messages (id, session_id, line_number, ordinal, message_type, role,
        compact_sequence, is_compacted, has_text, has_thinking, has_tool_use, has_tool_result, metadata)
      VALUES (${msgId}, ${sessionId}, 1, 1, 'user', 'user',
        0, false, true, false, false, false, '{}')
    `;

    const deps = buildDeps(createMockS3(""));
    const result = await reconcileSession(deps, sessionId);

    // Parsing should report as already done
    expect(result.parseSuccess).toBe(true);

    // Should NOT have re-downloaded or re-parsed
    expect(result.stepsExecuted).not.toContain("downloadTranscript");
    expect(result.stepsExecuted).not.toContain("parseTranscript");

    // Session should have advanced past parsed (summary disabled -> complete)
    const state = await getSessionState(sql, sessionId);
    expect(["summarized", "complete"]).toContain(state?.lifecycle);
  });

  // -----------------------------------------------------------------------
  // 4. Empty transcript: still advances lifecycle
  // -----------------------------------------------------------------------

  test("empty transcript: pipeline handles gracefully and advances lifecycle", async () => {
    const sessionId = await insertSession("transcript_ready");

    // Empty transcript content
    const deps = buildDeps(createMockS3(""));
    const result = await reconcileSession(deps, sessionId);

    // Parsing should succeed even with empty content (0 messages parsed)
    expect(result.parseSuccess).toBe(true);

    // Session should advance past transcript_ready
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).not.toBe("transcript_ready");
    expect(["parsed", "summarized", "complete"]).toContain(state?.lifecycle);
  });

  // -----------------------------------------------------------------------
  // 5. Failed session: reconcileSession is a no-op
  // -----------------------------------------------------------------------

  test("failed session: reconcileSession returns error and does not modify", async () => {
    const sessionId = await insertSession("failed");
    await sql`
      UPDATE sessions SET last_error = 'Previous error' WHERE id = ${sessionId}
    `;

    const deps = buildDeps(createMockS3(""));
    const result = await reconcileSession(deps, sessionId);

    // Should report failure
    expect(result.parseSuccess).toBe(false);
    expect(result.summarySuccess).toBe(false);
    expect(result.finalLifecycle).toBe("failed");
    expect(result.errors).toContain("Session is in failed state");

    // Session state should be unchanged
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("failed");
    expect(state?.last_error).toBe("Previous error");
  });

  // -----------------------------------------------------------------------
  // 6. Non-existent session: returns error
  // -----------------------------------------------------------------------

  test("non-existent session: returns error without crashing", async () => {
    const deps = buildDeps(createMockS3(""));
    const result = await reconcileSession(deps, "nonexistent-session-e2e-999");

    expect(result.parseSuccess).toBe(false);
    expect(result.summarySuccess).toBe(false);
    expect(result.errors).toContain("Session not found");
  });

  // -----------------------------------------------------------------------
  // 7. S3 download failure: session transitions to failed
  // -----------------------------------------------------------------------

  test("S3 download failure: session transitions to failed with error", async () => {
    const sessionId = await insertSession("transcript_ready");

    const deps = buildDeps(createFailingS3());
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(false);
    expect(result.finalLifecycle).toBe("failed");
    expect(result.errors.some(e => e.includes("S3 download failed"))).toBe(true);

    // Verify the session is now failed in DB
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("failed");
    expect(state?.last_error).toContain("S3");
  });

  // -----------------------------------------------------------------------
  // 8. Session without S3 key at detected/ended: returns error
  // -----------------------------------------------------------------------

  test("session at ended without S3 key: returns error about missing key", async () => {
    const sessionId = await insertSession("ended", { transcript_s3_key: null });

    const deps = buildDeps(createMockS3(""));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(false);
    expect(result.errors.some(e => e.includes("transcript"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 9. Pipeline with team transcript: persists teams
  // -----------------------------------------------------------------------

  test("pipeline with team transcript: persists teams from TeamCreate blocks", async () => {
    const sessionId = await insertSession("transcript_ready");
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-with-team.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    // Verify team rows exist
    const teams = await sql`
      SELECT * FROM teams WHERE session_id = ${sessionId}
    `;
    expect(teams.length).toBeGreaterThanOrEqual(1);
  });
});
