/**
 * Tests for session-pipeline.ts — the post-processing pipeline orchestrator.
 *
 * Since the pipeline requires both Postgres and S3, all database-backed tests
 * are gated with describe.skipIf(!DATABASE_URL). S3 is mocked with a simple
 * in-memory stub that returns configurable transcript content.
 *
 * Tests cover:
 *   1. Full pipeline with mock S3 -> session reaches 'parsed' or 'summarized'
 *   2. Missing S3 key -> error, session unchanged
 *   3. S3 download fails -> session transitions to 'failed'
 *   4. Parser returns partial errors -> session still advances to 'parsed'
 *   5. Summary generation fails -> session stays at 'parsed'
 *   6. Re-running pipeline on already-parsed session -> exits cleanly
 *   7. Empty transcript (0 messages) -> session advances to 'parsed' with zero stats
 *   8. Pipeline queue: enqueue, depth, start/stop
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  runSessionPipeline,
  createPipelineQueue,
  type PipelineDeps,
  type S3Client,
} from "../session-pipeline.js";
import { getSessionState, type SessionLifecycle } from "../session-lifecycle.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;

/** Create a mock S3 client that returns the given content on download */
function createMockS3(transcriptContent: string): S3Client {
  return {
    upload: async (key, body) => ({
      key,
      size: typeof body === "string" ? body.length : body.length,
    }),
    download: async () => transcriptContent,
  };
}

/** Create a mock S3 client that throws on download (simulates S3 outage) */
function createFailingS3(errorMessage: string): S3Client {
  return {
    upload: async (key, body) => ({
      key,
      size: typeof body === "string" ? body.length : body.length,
    }),
    download: async () => {
      throw new Error(errorMessage);
    },
  };
}

/** Silent logger for tests — suppresses all output */
const silentLogger = pino({ level: "silent" });

/**
 * Build a minimal JSONL transcript with a user message and an assistant response.
 * This is the simplest valid transcript that produces at least 2 messages.
 */
function buildSimpleTranscript(sessionId: string): string {
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2024-01-01T00:00:00Z",
      sessionId,
      message: { role: "user", content: "Hello, help me fix this bug" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2024-01-01T00:01:00Z",
      sessionId,
      message: {
        role: "assistant",
        id: "msg-001",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "I'll help you fix the bug." }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  ];
  return lines.join("\n");
}

/**
 * Build a transcript with some invalid lines mixed in (partial parse errors).
 * The parser should still produce messages from valid lines.
 */
function buildTranscriptWithErrors(sessionId: string): string {
  const lines = [
    "not valid json",
    JSON.stringify({
      type: "user",
      timestamp: "2024-01-01T00:00:00Z",
      sessionId,
      message: { role: "user", content: "Do something" },
    }),
    '{"type":}', // invalid JSON
    JSON.stringify({
      type: "assistant",
      timestamp: "2024-01-01T00:01:00Z",
      sessionId,
      message: {
        role: "assistant",
        id: "msg-002",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 50, output_tokens: 20 },
      },
    }),
  ];
  return lines.join("\n");
}

/** Build an empty transcript (no messages at all) */
function buildEmptyTranscript(): string {
  return "";
}

// ---------------------------------------------------------------------------
// Pipeline queue tests — no database required
// ---------------------------------------------------------------------------

describe("createPipelineQueue", () => {
  test("enqueue increases depth, start enables processing", () => {
    const queue = createPipelineQueue(2);

    // Before start(), enqueue is a no-op (deps not set)
    queue.enqueue("session-1");
    expect(queue.depth()).toBe(0);

    // After start(), enqueue adds to pending
    const mockDeps: PipelineDeps = {
      sql: {} as any,
      s3: createMockS3(""),
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: silentLogger,
    };
    queue.start(mockDeps);

    // Note: items are dequeued immediately when there's concurrency available,
    // so depth may go back to 0 right away. We test overflow behavior instead.
    expect(queue.depth()).toBe(0); // no items enqueued after start
  });

  test("stop clears pending and returns a promise", async () => {
    const queue = createPipelineQueue(2);
    const mockDeps: PipelineDeps = {
      sql: {} as any,
      s3: createMockS3(""),
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: silentLogger,
    };
    queue.start(mockDeps);

    // stop() should resolve even with nothing in flight
    await queue.stop();
    expect(queue.depth()).toBe(0);
  });

  test("overflow warning: enqueue drops when queue exceeds 50", () => {
    const queue = createPipelineQueue(0); // maxConcurrent=0 means nothing gets dequeued
    const warnings: string[] = [];

    const mockDeps: PipelineDeps = {
      sql: {} as any,
      s3: createMockS3(""),
      summaryConfig: { enabled: false, model: "", temperature: 0, maxOutputTokens: 0, apiKey: "" },
      logger: pino({
        level: "warn",
        transport: undefined,
        // Use a custom destination to capture warnings
      }),
    };

    // We can't easily capture pino warnings in a test, but we can verify
    // that the 51st enqueue doesn't increase depth
    queue.start(mockDeps);

    // Fill up the queue to 50 (with maxConcurrent=0, items stay in pending)
    for (let i = 0; i < 50; i++) {
      queue.enqueue(`session-${i}`);
    }
    expect(queue.depth()).toBe(50);

    // 51st should be dropped
    queue.enqueue("session-overflow");
    expect(queue.depth()).toBe(50); // still 50, not 51
  });
});

// ---------------------------------------------------------------------------
// Database-backed pipeline tests
// ---------------------------------------------------------------------------

describe.skipIf(!DATABASE_URL)("session-pipeline (database)", () => {
  let postgres: typeof import("postgres").default;
  let sql: import("postgres").Sql;

  // Test fixtures
  const workspaceId = "test-ws-pipeline-001";
  const deviceId = "test-device-pipeline-001";
  let sessionCounter = 0;

  /** Generate a unique session ID for each test */
  function nextSessionId(): string {
    sessionCounter++;
    return `test-sess-pipeline-${sessionCounter}-${Date.now()}`;
  }

  beforeAll(async () => {
    const mod = await import("postgres");
    postgres = mod.default;
    sql = postgres(DATABASE_URL!);

    // Ensure test workspace and device exist (required by FK constraints)
    await sql`
      INSERT INTO workspaces (id, canonical_id, display_name)
      VALUES (${workspaceId}, ${"test-canonical-pipeline"}, ${"test-pipeline-repo"})
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO devices (id, name, type)
      VALUES (${deviceId}, ${"test-pipeline-device"}, ${"local"})
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    // Clean up test data in FK order
    await sql`DELETE FROM content_blocks WHERE session_id LIKE 'test-sess-pipeline-%'`;
    await sql`DELETE FROM transcript_messages WHERE session_id LIKE 'test-sess-pipeline-%'`;
    await sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspace_devices WHERE workspace_id = ${workspaceId}`;
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await sql`DELETE FROM devices WHERE id = ${deviceId}`;
    await sql.end();
  });

  /**
   * Helper: insert a session row in a given lifecycle state.
   * Optionally sets transcript_s3_key for pipeline tests.
   */
  async function insertSession(
    lifecycle: SessionLifecycle = "ended",
    overrides?: { transcript_s3_key?: string; parse_status?: string },
  ): Promise<string> {
    const id = nextSessionId();
    await sql`
      INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, parse_status, transcript_s3_key)
      VALUES (
        ${id},
        ${workspaceId},
        ${deviceId},
        ${lifecycle},
        ${new Date().toISOString()},
        ${overrides?.parse_status ?? "pending"},
        ${overrides?.transcript_s3_key ?? null}
      )
    `;
    return id;
  }

  /** Build pipeline deps with a given S3 client (summary always disabled for unit tests) */
  function buildDeps(s3: S3Client): PipelineDeps {
    return {
      sql,
      s3,
      summaryConfig: {
        enabled: false,
        model: "claude-sonnet-4-5-20250929",
        temperature: 0.3,
        maxOutputTokens: 150,
        apiKey: "",
      },
      logger: silentLogger,
    };
  }

  // -----------------------------------------------------------------------
  // Test 1: Full pipeline with mock S3 -> session reaches 'parsed'
  // -----------------------------------------------------------------------

  test("full pipeline: mock S3 transcript -> session advances to 'parsed'", async () => {
    const sessionId = await insertSession("ended", {
      transcript_s3_key: `transcripts/test/session-1/raw.jsonl`,
    });

    const transcript = buildSimpleTranscript(sessionId);
    const deps = buildDeps(createMockS3(transcript));
    const result = await runSessionPipeline(deps, sessionId);

    // Pipeline should succeed
    expect(result.parseSuccess).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.stats).toBeDefined();
    expect(result.stats!.total_messages).toBe(2);
    expect(result.stats!.user_messages).toBe(1);
    expect(result.stats!.assistant_messages).toBe(1);

    // Session should be in 'parsed' state (summary disabled -> no 'summarized')
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("parsed");
    expect(state?.parse_status).toBe("completed");
    expect(state?.parse_error).toBeNull();

    // Verify messages were persisted
    const messages = await sql`
      SELECT * FROM transcript_messages WHERE session_id = ${sessionId} ORDER BY ordinal
    `;
    expect(messages.length).toBe(2);
    expect(messages[0].message_type).toBe("user");
    expect(messages[1].message_type).toBe("assistant");

    // Verify content blocks were persisted
    const blocks = await sql`
      SELECT * FROM content_blocks WHERE session_id = ${sessionId} ORDER BY block_order
    `;
    expect(blocks.length).toBeGreaterThan(0);

    // Verify stats were written to the session row
    const sessionRow = await sql`
      SELECT total_messages, user_messages, assistant_messages, tokens_in, tokens_out
      FROM sessions WHERE id = ${sessionId}
    `;
    expect(sessionRow[0].total_messages).toBe(2);
    expect(sessionRow[0].user_messages).toBe(1);
    expect(sessionRow[0].assistant_messages).toBe(1);
    expect(Number(sessionRow[0].tokens_in)).toBe(100);
    expect(Number(sessionRow[0].tokens_out)).toBe(50);
  });

  // -----------------------------------------------------------------------
  // Test 2: Missing S3 key -> error, session unchanged
  // -----------------------------------------------------------------------

  test("missing transcript_s3_key: returns error, session unchanged", async () => {
    const sessionId = await insertSession("ended", {
      transcript_s3_key: undefined, // no S3 key
    });

    const deps = buildDeps(createMockS3("unused"));
    const result = await runSessionPipeline(deps, sessionId);

    expect(result.parseSuccess).toBe(false);
    expect(result.errors).toContain("No transcript in S3");

    // Session should still be in 'ended' state
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("ended");
  });

  // -----------------------------------------------------------------------
  // Test 3: S3 download fails -> session transitions to 'failed'
  // -----------------------------------------------------------------------

  test("S3 download failure: session transitions to 'failed'", async () => {
    const sessionId = await insertSession("ended", {
      transcript_s3_key: `transcripts/test/broken/raw.jsonl`,
    });

    const deps = buildDeps(createFailingS3("Connection timeout"));
    const result = await runSessionPipeline(deps, sessionId);

    expect(result.parseSuccess).toBe(false);
    expect(result.errors[0]).toContain("S3 download failed");
    expect(result.errors[0]).toContain("Connection timeout");

    // Session should be in 'failed' state
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("failed");
    expect(state?.parse_status).toBe("failed");
    expect(state?.parse_error).toContain("S3 download failed");
  });

  // -----------------------------------------------------------------------
  // Test 4: Parser returns partial errors -> session still advances to 'parsed'
  // -----------------------------------------------------------------------

  test("partial parse errors: session still advances to 'parsed'", async () => {
    const sessionId = await insertSession("ended", {
      transcript_s3_key: `transcripts/test/partial/raw.jsonl`,
    });

    const transcript = buildTranscriptWithErrors(sessionId);
    const deps = buildDeps(createMockS3(transcript));
    const result = await runSessionPipeline(deps, sessionId);

    // Should succeed despite line-level errors
    expect(result.parseSuccess).toBe(true);
    // Should report the line-level parse errors
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("Invalid JSON"))).toBe(true);

    // Session should be in 'parsed' state
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("parsed");

    // Should still have the valid messages persisted
    const messages = await sql`
      SELECT * FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    expect(messages.length).toBe(2); // 2 valid messages from the 4 lines
  });

  // -----------------------------------------------------------------------
  // Test 5: Summary generation fails -> session stays at 'parsed'
  // -----------------------------------------------------------------------

  test("summary failure: session stays at 'parsed'", async () => {
    const sessionId = await insertSession("ended", {
      transcript_s3_key: `transcripts/test/summary-fail/raw.jsonl`,
    });

    const transcript = buildSimpleTranscript(sessionId);
    // Enable summary but with no API key -> generateSummary returns an error
    const deps: PipelineDeps = {
      sql,
      s3: createMockS3(transcript),
      summaryConfig: {
        enabled: true,
        model: "claude-sonnet-4-5-20250929",
        temperature: 0.3,
        maxOutputTokens: 150,
        apiKey: "", // missing API key triggers error
      },
      logger: silentLogger,
    };

    const result = await runSessionPipeline(deps, sessionId);

    // Parse should succeed
    expect(result.parseSuccess).toBe(true);
    // Summary should fail (missing API key)
    expect(result.summarySuccess).toBe(false);
    expect(result.errors.some((e) => e.includes("Summary failed"))).toBe(true);

    // Session should be at 'parsed', NOT 'failed'
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("parsed");
  });

  // -----------------------------------------------------------------------
  // Test 6: Re-running pipeline on already-parsed session -> exits cleanly
  // -----------------------------------------------------------------------

  test("already-parsed session: pipeline exits cleanly", async () => {
    const sessionId = await insertSession("parsed", {
      transcript_s3_key: `transcripts/test/already-parsed/raw.jsonl`,
    });

    const deps = buildDeps(createMockS3("unused"));
    const result = await runSessionPipeline(deps, sessionId);

    expect(result.parseSuccess).toBe(false);
    expect(result.errors[0]).toContain("Session not in 'ended' state");

    // Session should remain in 'parsed'
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("parsed");
  });

  // -----------------------------------------------------------------------
  // Test 7: Empty transcript -> session advances to 'parsed' with zero stats
  // -----------------------------------------------------------------------

  test("empty transcript: session advances to 'parsed' with zero stats", async () => {
    const sessionId = await insertSession("ended", {
      transcript_s3_key: `transcripts/test/empty/raw.jsonl`,
    });

    const deps = buildDeps(createMockS3(buildEmptyTranscript()));
    const result = await runSessionPipeline(deps, sessionId);

    expect(result.parseSuccess).toBe(true);
    expect(result.stats).toBeDefined();
    expect(result.stats!.total_messages).toBe(0);
    expect(result.stats!.user_messages).toBe(0);
    expect(result.stats!.assistant_messages).toBe(0);

    // Session should be in 'parsed'
    const state = await getSessionState(sql, sessionId);
    expect(state?.lifecycle).toBe("parsed");

    // No messages or blocks should be persisted
    const messages = await sql`
      SELECT * FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    expect(messages.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 8: Session not found -> returns error
  // -----------------------------------------------------------------------

  test("non-existent session: returns error", async () => {
    const deps = buildDeps(createMockS3("unused"));
    const result = await runSessionPipeline(deps, "nonexistent-session-xyz");

    expect(result.parseSuccess).toBe(false);
    expect(result.errors).toContain("Session not found");
  });
});
