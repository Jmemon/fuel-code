/**
 * Tests for pipeline relationship persistence (Phase 4-2).
 *
 * Verifies that the session pipeline correctly persists sub-agents, teams,
 * skills, and worktrees extracted from transcripts into the database.
 * Also tests idempotency (reparse produces the same final state) and
 * hook-parser convergence (hook inserts + parser upserts = one row).
 *
 * These tests require a real Postgres database (DATABASE_URL env var).
 * S3 is mocked with an in-memory stub.
 *
 * Uses reconcileSession (the current pipeline entry point) instead of the
 * removed runSessionPipeline.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  reconcileSession,
  type ReconcileDeps,
  type ReconcileS3Client,
} from "../reconcile/reconcile-session.js";
import { getSessionState } from "../session-lifecycle.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

function createMockS3(transcriptContent: string): ReconcileS3Client {
  return {
    upload: async (key, body) => ({
      key,
      size: typeof body === "string" ? body.length : body.length,
    }),
    download: async () => transcriptContent,
  };
}

const silentLogger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Database-backed tests
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)("pipeline relationship persistence", () => {
  let postgres: typeof import("postgres");
  let sql: import("postgres").Sql;

  const workspaceId = "test-ws-rel-001";
  const deviceId = "test-device-rel-001";
  let sessionCounter = 0;

  function nextSessionId(): string {
    sessionCounter++;
    return `test-sess-rel-${sessionCounter}-${Date.now()}`;
  }

  beforeAll(async () => {
    const mod = await import("postgres");
    postgres = mod.default;
    sql = postgres(DATABASE_URL!);

    await sql`
      INSERT INTO workspaces (id, canonical_id, display_name)
      VALUES (${workspaceId}, ${"test-canonical-rel"}, ${"test-rel-repo"})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO devices (id, name, type)
      VALUES (${deviceId}, ${"test-rel-device"}, ${"local"})
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Clean up in FK order
    await sql`DELETE FROM content_blocks WHERE session_id LIKE 'test-sess-rel-%'`;
    await sql`DELETE FROM transcript_messages WHERE session_id LIKE 'test-sess-rel-%'`;
    await sql`DELETE FROM session_skills WHERE session_id LIKE 'test-sess-rel-%'`;
    await sql`DELETE FROM session_worktrees WHERE session_id LIKE 'test-sess-rel-%'`;
    await sql`DELETE FROM subagents WHERE session_id LIKE 'test-sess-rel-%'`;
    await sql`DELETE FROM teams WHERE lead_session_id LIKE 'test-sess-rel-%'`;
    await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    await sql.end();
  });

  /** Insert a session at 'transcript_ready' with an S3 key for reconcileSession */
  async function insertSession(overrides?: {
    transcript_s3_key?: string;
  }): Promise<string> {
    const id = nextSessionId();
    await sql`
      INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, transcript_s3_key)
      VALUES (${id}, ${workspaceId}, ${deviceId}, ${"transcript_ready"}, ${new Date().toISOString()}, ${overrides?.transcript_s3_key ?? "transcripts/test-canonical-rel/rel/raw.jsonl"})
    `;
    return id;
  }

  function buildDeps(s3: ReconcileS3Client): ReconcileDeps {
    return {
      sql,
      s3,
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: silentLogger,
    };
  }

  // -----------------------------------------------------------------------
  // 1. Pipeline persists subagents from transcript
  // -----------------------------------------------------------------------

  test("pipeline persists subagents extracted from transcript", async () => {
    const sessionId = await insertSession();
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-with-subagents.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    // Verify subagent rows
    const subagents = await sql`
      SELECT * FROM subagents WHERE session_id = ${sessionId} ORDER BY started_at
    `;
    expect(subagents.length).toBe(3);
    expect(subagents[0].agent_id).toBe("agent-aaa111");
    expect(subagents[0].agent_type).toBe("code");
    expect(subagents[0].status).toBe("completed");
    expect(subagents[1].agent_id).toBe("agent-bbb222");
    expect(subagents[2].agent_id).toBe("agent-ccc333");
    expect(subagents[2].agent_type).toBe("test-runner");

    // Verify session.subagent_count was updated
    const sessionRow = await sql`
      SELECT subagent_count FROM sessions WHERE id = ${sessionId}
    `;
    expect(Number(sessionRow[0].subagent_count)).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // 2. Pipeline persists teams from transcript
  // -----------------------------------------------------------------------

  test("pipeline persists teams extracted from transcript", async () => {
    const sessionId = await insertSession();
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-with-team.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    // Verify team rows exist (team data is now in the teams table,
    // not on the session row — team_name/team_role columns were dropped)
    const teams = await sql`
      SELECT * FROM teams WHERE session_id = ${sessionId}
    `;
    expect(teams.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // 3. Pipeline persists skills from transcript
  // -----------------------------------------------------------------------

  test("pipeline persists skills extracted from transcript", async () => {
    const sessionId = await insertSession();
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-with-skills.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    // Verify skill rows
    const skills = await sql`
      SELECT * FROM session_skills WHERE session_id = ${sessionId} ORDER BY invoked_at
    `;
    expect(skills.length).toBe(2);
    expect(skills[0].skill_name).toBe("commit");
    expect(skills[0].invoked_by).toBe("user");
    expect(skills[0].args).toBe("-m 'Add auth module'");
    expect(skills[1].skill_name).toBe("review-pr");
    expect(skills[1].invoked_by).toBe("claude");
    expect(skills[1].args).toBe("42");
  });

  // -----------------------------------------------------------------------
  // 4. Pipeline persists worktrees from transcript
  // -----------------------------------------------------------------------

  test("pipeline persists worktrees from transcript with EnterWorktree", async () => {
    const sessionId = await insertSession();

    // Build a transcript with an EnterWorktree call
    const transcript = [
      JSON.stringify({
        type: "user",
        timestamp: "2025-07-01T10:00:00.000Z",
        message: { role: "user", content: "Work in a worktree" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2025-07-01T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_wt_pipe",
          content: [
            { type: "tool_use", id: "toolu_wt_pipe", name: "EnterWorktree", input: { name: "bugfix-42" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ].join("\n");

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    const worktrees = await sql`
      SELECT * FROM session_worktrees WHERE session_id = ${sessionId}
    `;
    expect(worktrees.length).toBe(1);
    expect(worktrees[0].worktree_name).toBe("bugfix-42");
  });

  // -----------------------------------------------------------------------
  // 5. Reparse idempotency — running pipeline twice = same state
  // -----------------------------------------------------------------------

  test("reparse idempotency: skills/worktrees are replaced, subagents are upserted", async () => {
    const sessionId = await insertSession();
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-with-skills.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));

    // Run pipeline once
    const result1 = await reconcileSession(deps, sessionId);
    expect(result1.parseSuccess).toBe(true);

    const skills1 = await sql`
      SELECT * FROM session_skills WHERE session_id = ${sessionId}
    `;
    expect(skills1.length).toBe(2);

    // Reset session to 'transcript_ready' so pipeline can run again
    await sql`
      UPDATE sessions SET lifecycle = ${"transcript_ready"}
      WHERE id = ${sessionId}
    `;

    // Run pipeline a second time
    const result2 = await reconcileSession(deps, sessionId);
    expect(result2.parseSuccess).toBe(true);

    // Skills should still be exactly 2 (delete-first + reinsert)
    const skills2 = await sql`
      SELECT * FROM session_skills WHERE session_id = ${sessionId}
    `;
    expect(skills2.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 6. Hook-parser convergence: hook row + parser upsert = one row
  // -----------------------------------------------------------------------

  test("hook-parser convergence: pre-existing subagent row is upserted by parser", async () => {
    const sessionId = await insertSession();

    // Simulate what handleSubagentStart would do: insert a subagent row with status='running'
    const { generateId } = await import("@fuel-code/shared");
    await sql`
      INSERT INTO subagents (id, session_id, agent_id, agent_type, status, started_at, metadata)
      VALUES (${generateId()}, ${sessionId}, ${"agent-aaa111"}, ${"unknown"}, ${"running"}, ${new Date().toISOString()}, ${"{}"}::jsonb)
    `;

    // Verify the pre-existing row
    const before = await sql`
      SELECT * FROM subagents WHERE session_id = ${sessionId} AND agent_id = ${"agent-aaa111"}
    `;
    expect(before.length).toBe(1);
    expect(before[0].status).toBe("running");
    expect(before[0].agent_type).toBe("unknown");

    // Now run the pipeline with the subagents fixture — parser will upsert with COALESCE
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-with-subagents.jsonl"),
      "utf-8",
    );
    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    // The hook row and parser upsert should converge into exactly one row
    const after = await sql`
      SELECT * FROM subagents WHERE session_id = ${sessionId} AND agent_id = ${"agent-aaa111"}
    `;
    expect(after.length).toBe(1);
    // Parser upsert fills in the agent_type with COALESCE
    expect(after[0].agent_type).toBe("code");

    // Total subagents should be 3 (aaa111 merged, bbb222 and ccc333 new)
    const all = await sql`
      SELECT * FROM subagents WHERE session_id = ${sessionId}
    `;
    expect(all.length).toBe(3);
  });

  // -----------------------------------------------------------------------
  // 7. Backward compatibility — old transcript
  // -----------------------------------------------------------------------

  test("old transcript: pipeline persists no relationships, session reaches parsed", async () => {
    const sessionId = await insertSession();
    const transcript = readFileSync(
      join(import.meta.dir, "fixtures", "transcript-plain.jsonl"),
      "utf-8",
    );

    const deps = buildDeps(createMockS3(transcript));
    const result = await reconcileSession(deps, sessionId);

    expect(result.parseSuccess).toBe(true);

    // Verify no relationship rows exist
    const subagents = await sql`SELECT count(*)::int as c FROM subagents WHERE session_id = ${sessionId}`;
    const skills = await sql`SELECT count(*)::int as c FROM session_skills WHERE session_id = ${sessionId}`;
    const worktrees = await sql`SELECT count(*)::int as c FROM session_worktrees WHERE session_id = ${sessionId}`;

    expect(subagents[0].c).toBe(0);
    expect(skills[0].c).toBe(0);
    expect(worktrees[0].c).toBe(0);

    // Session should have progressed past 'parsed'
    const state = await getSessionState(sql, sessionId);
    expect(["parsed", "summarized", "complete"]).toContain(state?.lifecycle);

    // Session should NOT have resume metadata set
    const sessionRow = await sql`
      SELECT resumed_from_session_id, subagent_count, permission_mode
      FROM sessions WHERE id = ${sessionId}
    `;
    expect(sessionRow[0].resumed_from_session_id).toBeNull();
    expect(Number(sessionRow[0].subagent_count)).toBe(0);
  });
});
