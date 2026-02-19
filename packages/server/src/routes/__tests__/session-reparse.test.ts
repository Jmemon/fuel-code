/**
 * Integration tests for POST /api/sessions/:id/reparse.
 *
 * Gated with DATABASE_URL — these tests require a real Postgres connection
 * to verify the full reparse flow: session lookup, precondition checks,
 * reset, and pipeline triggering.
 *
 * Test coverage:
 *   1. Reparse a 'parsed' session: resets to ended, returns 202
 *   2. Reparse a 'failed' session: resets to ended, returns 202
 *   3. Reparse a 'detected' session: 409
 *   4. Reparse with no transcript_s3_key: 409
 *   5. Reparse currently processing (parse_status = 'parsing'): 409
 *   6. Reparse non-existent session: 404
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Server } from "node:http";
import type { Sql } from "postgres";
import pino from "pino";
import type { SessionLifecycle } from "@fuel-code/core";

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_reparse";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// Test fixture IDs for workspace and device (FK requirements)
const WORKSPACE_ID = "test-ws-reparse-001";
const DEVICE_ID = "test-device-reparse-001";

// ---------------------------------------------------------------------------
// DB-backed test suite
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)("POST /api/sessions/:id/reparse", () => {
  let postgres: typeof import("postgres").default;
  let sql: Sql;
  let server: Server;
  let baseUrl: string;

  // Counter to generate unique session IDs per test
  let sessionCounter = 0;
  function nextSessionId(): string {
    sessionCounter++;
    return `test-sess-reparse-${sessionCounter}-${Date.now()}`;
  }

  /**
   * Helper: insert a test session row with configurable state.
   */
  async function insertSession(
    lifecycle: SessionLifecycle,
    overrides?: {
      parse_status?: string;
      transcript_s3_key?: string | null;
    },
  ): Promise<string> {
    const id = nextSessionId();
    await sql`
      INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, parse_status, transcript_s3_key)
      VALUES (
        ${id},
        ${WORKSPACE_ID},
        ${DEVICE_ID},
        ${lifecycle},
        ${new Date().toISOString()},
        ${overrides?.parse_status ?? "pending"},
        ${overrides?.transcript_s3_key ?? null}
      )
    `;
    return id;
  }

  /**
   * Helper: send a POST to /api/sessions/:id/reparse.
   */
  async function reparse(sessionId: string): Promise<Response> {
    return fetch(`${baseUrl}/api/sessions/${sessionId}/reparse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
    });
  }

  beforeAll(async () => {
    // Dynamic import so the test file can load without postgres installed
    const mod = await import("postgres");
    postgres = mod.default;
    sql = postgres(DATABASE_URL!);

    // Ensure test workspace and device exist (FK constraints)
    await sql`
      INSERT INTO workspaces (id, canonical_id, display_name)
      VALUES (${WORKSPACE_ID}, ${"test-canonical-reparse"}, ${"test-reparse-repo"})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO devices (id, name, type)
      VALUES (${DEVICE_ID}, ${"test-reparse-device"}, ${"local"})
      ON CONFLICT (id) DO NOTHING
    `;

    // Create Express app with mock S3 pipeline deps.
    // The pipeline will fire-and-forget; we use a mock S3 that returns empty content
    // so the pipeline won't actually do meaningful work (it just needs to not crash the test).
    const { createApp } = await import("../../app.js");
    const silentLogger = pino({ level: "silent" });

    const mockS3 = {
      upload: async (key: string, body: Buffer | string) => ({
        key,
        size: typeof body === "string" ? body.length : body.length,
      }),
      download: async () => "",
    };

    const pipelineDeps = {
      sql,
      s3: mockS3,
      summaryConfig: { enabled: false },
      logger: silentLogger,
    };

    const app = createApp({
      sql,
      redis: { ping: async () => "PONG" } as any,
      apiKey: TEST_API_KEY,
      pipelineDeps: pipelineDeps as any,
    });

    // Start on OS-assigned port
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Clean up test data
    await sql`DELETE FROM content_blocks WHERE session_id LIKE 'test-sess-reparse-%'`;
    await sql`DELETE FROM transcript_messages WHERE session_id LIKE 'test-sess-reparse-%'`;
    await sql`DELETE FROM events WHERE workspace_id = ${WORKSPACE_ID}`;
    await sql`DELETE FROM sessions WHERE workspace_id = ${WORKSPACE_ID}`;
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ${WORKSPACE_ID}`;
    await sql`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`;
    await sql`DELETE FROM devices WHERE id = ${DEVICE_ID}`;
    await sql.end();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // -----------------------------------------------------------------------
  // Test cases
  // -----------------------------------------------------------------------

  test("reparse a 'parsed' session: resets to ended, returns 202", async () => {
    const sessionId = await insertSession("parsed", {
      parse_status: "completed",
      transcript_s3_key: "transcripts/test/raw.jsonl",
    });

    const res = await reparse(sessionId);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.message).toBe("Reparse initiated");
    expect(body.session_id).toBe(sessionId);
    expect(body.lifecycle).toBe("ended");

    // Verify session was reset in DB
    const rows = await sql`
      SELECT lifecycle, parse_status FROM sessions WHERE id = ${sessionId}
    `;
    expect(rows[0].lifecycle).toBe("ended");
    expect(rows[0].parse_status).toBe("pending");
  });

  test("reparse a 'failed' session: resets to ended, returns 202", async () => {
    const sessionId = await insertSession("failed", {
      parse_status: "failed",
      transcript_s3_key: "transcripts/test/raw.jsonl",
    });

    const res = await reparse(sessionId);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.message).toBe("Reparse initiated");
    expect(body.session_id).toBe(sessionId);

    // Verify session was reset in DB
    const rows = await sql`
      SELECT lifecycle, parse_status FROM sessions WHERE id = ${sessionId}
    `;
    expect(rows[0].lifecycle).toBe("ended");
    expect(rows[0].parse_status).toBe("pending");
  });

  test("reparse a 'detected' session: 409", async () => {
    const sessionId = await insertSession("detected", {
      transcript_s3_key: "transcripts/test/raw.jsonl",
    });

    const res = await reparse(sessionId);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("Session has not ended yet.");
  });

  test("reparse with no transcript_s3_key: 409", async () => {
    const sessionId = await insertSession("parsed", {
      parse_status: "completed",
      transcript_s3_key: null,
    });

    const res = await reparse(sessionId);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("No transcript available. Cannot reparse.");
  });

  test("reparse currently processing (parse_status = 'parsing'): 409", async () => {
    const sessionId = await insertSession("ended", {
      parse_status: "parsing",
      transcript_s3_key: "transcripts/test/raw.jsonl",
    });

    const res = await reparse(sessionId);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toBe("Session is currently being processed. Try again later.");
  });

  test("reparse non-existent session: 404", async () => {
    const res = await reparse("nonexistent-session-999");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });
});
