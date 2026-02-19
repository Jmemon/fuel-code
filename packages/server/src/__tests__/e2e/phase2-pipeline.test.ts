/**
 * End-to-end integration tests for the Phase 2 session pipeline.
 *
 * Verifies the complete flow:
 *   POST session.start → transcript upload to S3 → POST session.end
 *   → pipeline: download transcript → parse → persist → lifecycle reaches "parsed"
 *
 * Also verifies:
 *   - Query API (pagination, filtering, session detail, transcript endpoints)
 *   - Reparse flow (reset + re-process)
 *   - Tag management (set, add, remove, query)
 *   - Lifecycle state machine guards
 *   - Duplicate session.end idempotency
 *   - Pipeline failure handling (missing S3 object)
 *   - Backfill scanner discovery
 *
 * These tests require REAL Postgres, Redis, and LocalStack (S3) running via
 * docker-compose.test.yml (ports 5433, 6380, 4566 respectively).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { S3Client as AwsS3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

import { createApp } from "../../app.js";
import { createDb } from "../../db/postgres.js";
import { runMigrations } from "../../db/migrator.js";
import { createRedisClient } from "../../redis/client.js";
import { ensureConsumerGroup } from "../../redis/stream.js";
import { startConsumer, type ConsumerHandle } from "../../pipeline/consumer.js";
import { createEventHandler } from "../../pipeline/wire.js";
import { createS3Client } from "../../aws/s3.js";
import type { FuelCodeS3Client } from "../../aws/s3.js";
import { logger } from "../../logger.js";
import { generateId } from "@fuel-code/shared";
import { scanForSessions } from "@fuel-code/core";
import type { PipelineDeps, SummaryConfig } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Configuration — test-specific env vars for isolated Postgres, Redis, and S3
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";

/** S3/LocalStack configuration for test environment */
const S3_ENDPOINT = "http://localhost:4566";
const S3_BUCKET = "fuel-code-test";
const S3_REGION = "us-east-1";

/** Path to the SQL migrations directory */
const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");

/** Path to the test transcript JSONL fixture */
const TEST_TRANSCRIPT_PATH = join(import.meta.dir, "fixtures/test-transcript.jsonl");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

/** postgres.js connection pool */
let sql: ReturnType<typeof createDb>;

/** ioredis client for app operations (health checks, XADD) — non-blocking */
let redis: ReturnType<typeof createRedisClient>;

/** ioredis client for consumer (XREADGROUP BLOCK) — dedicated blocking connection */
let redisConsumer: ReturnType<typeof createRedisClient>;

/** Consumer handle (stop() for graceful shutdown) */
let consumer: ConsumerHandle;

/** Express HTTP server listening on a random port */
let server: Server;

/** Base URL for fetch() calls (e.g., "http://127.0.0.1:12345") */
let baseUrl: string;

/** S3 client for the test suite */
let s3: FuelCodeS3Client;

/** Pipeline dependencies passed to the app and consumer */
let pipelineDeps: PipelineDeps;

/** Raw transcript JSONL content loaded from the fixture file */
let testTranscriptContent: Buffer;

// ---------------------------------------------------------------------------
// waitFor helper — polls Postgres until a condition is met
// ---------------------------------------------------------------------------

/**
 * Poll an async function until it returns a non-null value or times out.
 * Used to wait for the async consumer to process events into Postgres.
 *
 * @param fn - Async function that returns T when the condition is met, or null to keep polling
 * @param timeoutMs - Maximum time to wait before throwing (default 10s)
 * @param intervalMs - Polling interval (default 200ms)
 * @returns The non-null result of fn()
 * @throws Error if the timeout is reached without fn() returning non-null
 */
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number = 10_000,
  intervalMs: number = 200,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Create database connection pool
  sql = createDb(DATABASE_URL, { max: 5 });

  // 2. Run all SQL migrations to create the schema (Phase 1 + Phase 2 tables)
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(
      `Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`,
    );
  }

  // 3. Create two Redis clients: one for the app (non-blocking), one for the
  //    consumer (blocking XREADGROUP). Sharing causes health check PINGs to
  //    queue behind the blocked XREADGROUP command.
  redis = createRedisClient(REDIS_URL);
  redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);

  // 4. Flush Redis to ensure a clean stream state
  await redis.flushall();

  // 5. Set up the consumer group on the events stream
  await ensureConsumerGroup(redis);

  // 6. Create the S3 test bucket in LocalStack
  const rawS3 = new AwsS3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    // LocalStack doesn't need real AWS credentials
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await rawS3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch (err: any) {
    // Ignore BucketAlreadyOwnedByYou / BucketAlreadyExists — idempotent
    if (
      err.name !== "BucketAlreadyOwnedByYou" &&
      err.name !== "BucketAlreadyExists"
    ) {
      throw err;
    }
  }
  rawS3.destroy();

  // 7. Create the fuel-code S3 client pointing at LocalStack
  s3 = createS3Client(
    {
      bucket: S3_BUCKET,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
    },
    logger,
  );

  // 8. Build pipeline dependencies with summaries DISABLED (no Anthropic API in tests)
  const summaryConfig: SummaryConfig = {
    enabled: false,
    model: "claude-sonnet-4-20250514",
    temperature: 0.3,
    maxOutputTokens: 150,
    apiKey: "",
  };

  pipelineDeps = { sql, s3, summaryConfig, logger };

  // 9. Wire up the event handler registry with pipeline deps so session.end
  //    triggers the pipeline, then start the consumer
  const { registry } = createEventHandler(sql, logger, pipelineDeps);
  consumer = startConsumer({ redis: redisConsumer, sql, registry, logger, pipelineDeps });

  // 10. Create the Express app with S3 and pipeline deps enabled
  const app = createApp({
    sql,
    redis,
    apiKey: API_KEY,
    s3,
    pipelineDeps,
  });
  server = app.listen(0); // port 0 = OS picks a random available port
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  // 11. Load the test transcript fixture into memory
  testTranscriptContent = fs.readFileSync(TEST_TRANSCRIPT_PATH);
}, 30_000); // 30s timeout — includes migrations, LocalStack bucket creation, etc.

afterAll(async () => {
  // Tear down in reverse order to avoid dangling references

  // 1. Stop the consumer loop
  if (consumer) {
    await consumer.stop();
  }

  // 2. Close the HTTP server
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // 3. Disconnect both Redis clients
  if (redisConsumer) {
    await redisConsumer.quit();
  }
  if (redis) {
    await redis.quit();
  }

  // 4. Close the Postgres connection pool
  if (sql) {
    await sql.end();
  }
}, 15_000);

afterEach(async () => {
  // 1. Flush Redis FIRST — removes the stream so the consumer loop stops
  //    picking up new work. This prevents the consumer from holding Postgres
  //    transactions that would block the TRUNCATE below.
  await redis.flushall();

  // 2. Brief pause to let any in-flight consumer processing finish its
  //    Postgres transaction. Without this, TRUNCATE can deadlock against
  //    the consumer's open transaction (TRUNCATE needs ACCESS EXCLUSIVE lock).
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 3. Truncate all data tables between tests to isolate them.
  //    CASCADE handles FK constraints. Schema (tables, indexes) is preserved.
  //    Includes Phase 2 tables: transcript_messages and content_blocks.
  await sql`TRUNCATE events, sessions, workspace_devices, workspaces, devices, transcript_messages, content_blocks CASCADE`;

  // 4. Recreate consumer group so the next test starts clean
  await ensureConsumerGroup(redis);
});

// ---------------------------------------------------------------------------
// Helpers — construct valid event payloads
// ---------------------------------------------------------------------------

/**
 * Build a valid session.start event with unique IDs.
 * workspace_id is a canonical string (e.g., "github.com/user/repo")
 * which the processor will resolve to a ULID.
 */
function makeSessionStartEvent(overrides?: {
  id?: string;
  device_id?: string;
  workspace_id?: string;
  cc_session_id?: string;
}): Record<string, unknown> {
  return {
    id: overrides?.id ?? generateId(),
    type: "session.start",
    timestamp: new Date().toISOString(),
    device_id: overrides?.device_id ?? `device-${generateId()}`,
    workspace_id: overrides?.workspace_id ?? "github.com/test-user/test-repo",
    session_id: null, // null because the session row doesn't exist yet
    data: {
      cc_session_id: overrides?.cc_session_id ?? `cc-sess-${generateId()}`,
      cwd: "/home/user/test-repo",
      git_branch: "main",
      git_remote: "https://github.com/test-user/test-repo.git",
      cc_version: "1.0.0",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: `s3://transcripts/test-${generateId()}.json`,
    },
    blob_refs: [],
  };
}

/**
 * Build a valid session.end event that references an existing session.
 * Must use the same cc_session_id, device_id, and workspace_id as the
 * corresponding session.start event.
 */
function makeSessionEndEvent(params: {
  device_id: string;
  workspace_id: string;
  cc_session_id: string;
  session_id?: string;
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "session.end",
    timestamp: new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    session_id: params.session_id ?? null,
    data: {
      cc_session_id: params.cc_session_id,
      duration_ms: 60_000,
      end_reason: "exit",
      transcript_path: `s3://transcripts/${params.cc_session_id}.json`,
    },
    blob_refs: [],
  };
}

/**
 * POST events to the ingest endpoint.
 * Returns the raw Response for the caller to inspect status/body.
 */
async function postEvents(
  events: Record<string, unknown>[],
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/events/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
    body: JSON.stringify({ events }),
  });
}

/**
 * Upload a transcript for a session.
 * Sends raw binary body with appropriate content type.
 */
async function uploadTranscript(
  sessionId: string,
  content?: Buffer,
): Promise<Response> {
  return fetch(`${baseUrl}/api/sessions/${sessionId}/transcript/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: (content ?? testTranscriptContent) as unknown as BodyInit,
  });
}

/**
 * Helper: run a session through the complete pipeline.
 * Sends session.start, waits for detection, uploads transcript, sends
 * session.end, then waits for lifecycle to reach the target state.
 *
 * Returns the session ID and other identifiers for further assertions.
 */
async function runFullPipeline(overrides?: {
  workspace_id?: string;
  targetLifecycle?: string;
}): Promise<{
  ccSessionId: string;
  deviceId: string;
  workspaceCanonical: string;
}> {
  const deviceId = `device-${generateId()}`;
  const workspaceCanonical = overrides?.workspace_id ?? "github.com/test-user/test-repo";
  const ccSessionId = `cc-sess-${generateId()}`;
  const targetLifecycle = overrides?.targetLifecycle ?? "parsed";

  // 1. POST session.start
  const startEvent = makeSessionStartEvent({
    device_id: deviceId,
    workspace_id: workspaceCanonical,
    cc_session_id: ccSessionId,
  });
  const startRes = await postEvents([startEvent]);
  expect(startRes.status).toBe(202);

  // 2. Wait for session to appear with lifecycle = 'detected'
  await waitFor(async () => {
    const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
  });

  // 3. Upload transcript
  const uploadRes = await uploadTranscript(ccSessionId);
  expect(uploadRes.status).toBe(202);

  // 4. POST session.end — this triggers the pipeline since S3 key is now set
  const endEvent = makeSessionEndEvent({
    device_id: deviceId,
    workspace_id: workspaceCanonical,
    cc_session_id: ccSessionId,
  });
  const endRes = await postEvents([endEvent]);
  expect(endRes.status).toBe(202);

  // 5. Wait for lifecycle to reach the target (parsed with summaries disabled)
  await waitFor(
    async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      if (rows.length > 0 && rows[0].lifecycle === targetLifecycle) {
        return rows[0];
      }
      return null;
    },
    30_000, // generous timeout for async pipeline processing
    500,
  );

  return { ccSessionId, deviceId, workspaceCanonical };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 2 E2E Pipeline", () => {
  // -----------------------------------------------------------------------
  // Test 1: Full pipeline — session.start + transcript upload + session.end
  // -----------------------------------------------------------------------
  test("Test 1: Full pipeline — session.start + upload + session.end reaches parsed", async () => {
    const { ccSessionId } = await runFullPipeline();

    // Assert: session row has expected stats from parsed transcript
    const sessionRows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(sessionRows.length).toBe(1);

    const session = sessionRows[0];

    // Lifecycle should be 'parsed' (summaries disabled)
    expect(session.lifecycle).toBe("parsed");

    // S3 key is set and matches expected pattern
    expect(session.transcript_s3_key).toBeTruthy();
    expect(session.transcript_s3_key).toContain("transcripts/");
    expect(session.transcript_s3_key).toContain(ccSessionId);

    // Parse status is completed
    expect(session.parse_status).toBe("completed");

    // Message counts from the fixture (summary=1, user=2, assistant=3 unique ids)
    expect(session.total_messages).toBeGreaterThan(0);
    expect(session.user_messages).toBeGreaterThan(0);
    expect(session.assistant_messages).toBeGreaterThan(0);

    // Tool use count > 0 (fixture has Read and Edit tool uses)
    expect(session.tool_use_count).toBeGreaterThan(0);

    // Token usage (fixture has non-zero input tokens on assistant messages)
    // postgres.js returns bigint columns as strings; coerce before comparing
    expect(Number(session.tokens_in)).toBeGreaterThan(0);

    // Initial prompt should be set (first user message text)
    expect(session.initial_prompt).toBeTruthy();
    expect(session.initial_prompt).toContain("authentication bug");

    // Assert: transcript_messages rows exist for this session
    const msgRows = await sql`
      SELECT * FROM transcript_messages WHERE session_id = ${ccSessionId} ORDER BY ordinal
    `;
    expect(msgRows.length).toBeGreaterThan(0);

    // Assert: content_blocks rows exist
    const blockRows = await sql`
      SELECT * FROM content_blocks WHERE session_id = ${ccSessionId}
    `;
    expect(blockRows.length).toBeGreaterThan(0);

    // Assert: content blocks have various types (text, thinking, tool_use, tool_result)
    const blockTypes = new Set(blockRows.map((b: any) => b.block_type));
    expect(blockTypes.has("text")).toBe(true);
    expect(blockTypes.has("tool_use")).toBe(true);

    // Assert: content blocks reference valid message IDs
    const messageIds = new Set(msgRows.map((m: any) => m.id));
    for (const block of blockRows) {
      expect(messageIds.has(block.message_id)).toBe(true);
    }
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 2: Session.end without transcript → lifecycle stays ended
  // -----------------------------------------------------------------------
  test("Test 2: Session.end without transcript upload stays at ended", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test-user/no-transcript-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // POST session.start
    const startEvent = makeSessionStartEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    await postEvents([startEvent]);

    // Wait for session to appear
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // POST session.end WITHOUT uploading transcript
    const endEvent = makeSessionEndEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    await postEvents([endEvent]);

    // Wait for lifecycle to reach 'ended'
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      if (rows.length > 0 && rows[0].lifecycle === "ended") return rows[0];
      return null;
    });

    // Brief wait to ensure no further pipeline processing happens
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Assert: session is still at 'ended' — no S3 key, no parsing
    const sessionRows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(sessionRows[0].lifecycle).toBe("ended");
    expect(sessionRows[0].transcript_s3_key).toBeNull();
    expect(sessionRows[0].parse_status).toBe("pending");

    // Assert: no transcript messages or content blocks for this session
    const msgRows = await sql`
      SELECT * FROM transcript_messages WHERE session_id = ${ccSessionId}
    `;
    expect(msgRows.length).toBe(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 3: Lifecycle state machine guards
  // -----------------------------------------------------------------------
  test("Test 3: Duplicate session.start on parsed session is ignored", async () => {
    // Run full pipeline to reach 'parsed'
    const { ccSessionId, deviceId, workspaceCanonical } = await runFullPipeline();

    // Verify session is at 'parsed'
    const beforeRows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(beforeRows[0].lifecycle).toBe("parsed");

    // Send another session.start for the same cc_session_id
    const duplicateStart = makeSessionStartEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    await postEvents([duplicateStart]);

    // Brief wait for any processing
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Assert: session stays at 'parsed' — duplicate start is a no-op
    const afterRows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(afterRows[0].lifecycle).toBe("parsed");

    // Verify reparse returns 409 when no transcript_s3_key on a session
    // First create a session that ended without a transcript
    const noTranscriptId = `cc-sess-${generateId()}`;
    const noTranscriptDevice = `device-${generateId()}`;
    const noTranscriptStart = makeSessionStartEvent({
      device_id: noTranscriptDevice,
      workspace_id: "github.com/test-user/no-tx-repo",
      cc_session_id: noTranscriptId,
    });
    await postEvents([noTranscriptStart]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${noTranscriptId}`;
      return rows.length > 0 ? rows[0] : null;
    });
    const noTranscriptEnd = makeSessionEndEvent({
      device_id: noTranscriptDevice,
      workspace_id: "github.com/test-user/no-tx-repo",
      cc_session_id: noTranscriptId,
    });
    await postEvents([noTranscriptEnd]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${noTranscriptId}`;
      if (rows.length > 0 && rows[0].lifecycle === "ended") return rows[0];
      return null;
    });

    // Attempt reparse on session with no transcript
    const reparseRes = await fetch(`${baseUrl}/api/sessions/${noTranscriptId}/reparse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(reparseRes.status).toBe(409);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 4: Reparse flow
  // -----------------------------------------------------------------------
  test("Test 4: Reparse resets and re-processes transcript", async () => {
    // Complete full pipeline
    const { ccSessionId } = await runFullPipeline();

    // Record original message IDs for comparison
    const originalMsgs = await sql`
      SELECT id FROM transcript_messages WHERE session_id = ${ccSessionId} ORDER BY ordinal
    `;
    const originalMsgIds = originalMsgs.map((m: any) => m.id);
    expect(originalMsgIds.length).toBeGreaterThan(0);

    // Record original stats for comparison
    const beforeSession = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    const beforeTotalMessages = beforeSession[0].total_messages;

    // POST reparse
    const reparseRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}/reparse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(reparseRes.status).toBe(202);

    // Wait for lifecycle to reach 'parsed' again
    await waitFor(
      async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
        if (
          rows.length > 0 &&
          rows[0].lifecycle === "parsed" &&
          rows[0].parse_status === "completed"
        ) {
          return rows[0];
        }
        return null;
      },
      30_000,
      500,
    );

    // Assert: transcript_messages have new IDs (old deleted, new inserted)
    const newMsgs = await sql`
      SELECT id FROM transcript_messages WHERE session_id = ${ccSessionId} ORDER BY ordinal
    `;
    expect(newMsgs.length).toBeGreaterThan(0);

    // New message IDs should be different from original (re-generated ULIDs)
    const newMsgIds = newMsgs.map((m: any) => m.id);
    const overlap = newMsgIds.filter((id: string) => originalMsgIds.includes(id));
    expect(overlap.length).toBe(0);

    // Assert: stats are repopulated (same as before since same transcript)
    const afterSession = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(afterSession[0].total_messages).toBe(beforeTotalMessages);
    expect(afterSession[0].parse_status).toBe("completed");
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 5: Query API pagination
  // -----------------------------------------------------------------------
  test("Test 5: Cursor-based pagination returns stable pages", async () => {
    // Create 5 sessions via event pipeline with slightly different timestamps
    const sessionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const deviceId = `device-${generateId()}`;
      const ccSessionId = `cc-sess-${generateId()}`;
      sessionIds.push(ccSessionId);

      const startEvent = makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: `github.com/test-user/pagination-repo-${i}`,
        cc_session_id: ccSessionId,
      });
      await postEvents([startEvent]);

      // Wait for each session to appear before creating the next
      await waitFor(async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
        return rows.length > 0 ? rows[0] : null;
      });
    }

    // Page 1: limit=2
    const page1Res = await fetch(`${baseUrl}/api/sessions?limit=2`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.sessions.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    // Page 2: limit=2, cursor from page 1
    const page2Res = await fetch(
      `${baseUrl}/api/sessions?limit=2&cursor=${page1.next_cursor}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    expect(page2.sessions.length).toBe(2);
    expect(page2.has_more).toBe(true);
    expect(page2.next_cursor).toBeTruthy();

    // Page 3: limit=2, cursor from page 2
    const page3Res = await fetch(
      `${baseUrl}/api/sessions?limit=2&cursor=${page2.next_cursor}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(page3Res.status).toBe(200);
    const page3 = await page3Res.json();
    expect(page3.sessions.length).toBe(1);
    expect(page3.has_more).toBe(false);
    expect(page3.next_cursor).toBeNull();

    // Verify total across all pages = 5, no duplicates
    const allIds = [
      ...page1.sessions.map((s: any) => s.id),
      ...page2.sessions.map((s: any) => s.id),
      ...page3.sessions.map((s: any) => s.id),
    ];
    expect(allIds.length).toBe(5);
    expect(new Set(allIds).size).toBe(5);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 6: Query API filtering
  // -----------------------------------------------------------------------
  test("Test 6: Filtering by workspace_id and lifecycle works", async () => {
    // Create sessions with different workspaces
    const wsA = "github.com/test-user/filter-repo-a";
    const wsB = "github.com/test-user/filter-repo-b";

    // Session A: detected (no end event)
    const deviceA = `device-${generateId()}`;
    const ccSessionA = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceA,
        workspace_id: wsA,
        cc_session_id: ccSessionA,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionA}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Session B: full pipeline (parsed)
    const { ccSessionId: ccSessionB } = await runFullPipeline({
      workspace_id: wsB,
    });

    // Resolve workspace ULID for session A
    const wsARows = await sql`
      SELECT w.id FROM workspaces w WHERE w.canonical_id = ${wsA}
    `;
    const wsAId = wsARows[0]?.id;

    // Filter by workspace_id: only session A's workspace
    if (wsAId) {
      const wsFilterRes = await fetch(
        `${baseUrl}/api/sessions?workspace_id=${wsAId}`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      expect(wsFilterRes.status).toBe(200);
      const wsFilterBody = await wsFilterRes.json();
      // Should only contain sessions from workspace A
      for (const s of wsFilterBody.sessions) {
        expect(s.workspace_id).toBe(wsAId);
      }
    }

    // Filter by lifecycle=parsed — should include session B but not session A
    const lifecycleRes = await fetch(
      `${baseUrl}/api/sessions?lifecycle=parsed`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(lifecycleRes.status).toBe(200);
    const lifecycleBody = await lifecycleRes.json();
    const lifecycleIds = lifecycleBody.sessions.map((s: any) => s.id);
    expect(lifecycleIds).toContain(ccSessionB);
    expect(lifecycleIds).not.toContain(ccSessionA);

    // Filter by after timestamp — use a past timestamp to get all sessions
    const pastTimestamp = new Date(Date.now() - 60_000).toISOString();
    const afterRes = await fetch(
      `${baseUrl}/api/sessions?after=${pastTimestamp}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(afterRes.status).toBe(200);
    const afterBody = await afterRes.json();
    expect(afterBody.sessions.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 7: Session detail + transcript endpoints
  // -----------------------------------------------------------------------
  test("Test 7: Session detail and transcript endpoints return correct data", async () => {
    // Complete pipeline for one session
    const { ccSessionId } = await runFullPipeline();

    // GET /api/sessions/:id — full session detail
    const detailRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.session).toBeTruthy();
    expect(detailBody.session.id).toBe(ccSessionId);
    expect(detailBody.session.lifecycle).toBe("parsed");
    expect(detailBody.session.total_messages).toBeGreaterThan(0);
    // Joined workspace and device names should be present
    expect(detailBody.session.workspace_canonical_id).toBeTruthy();
    expect(detailBody.session.device_name).toBeTruthy();

    // GET /api/sessions/:id/transcript — parsed messages with nested content blocks
    const transcriptRes = await fetch(
      `${baseUrl}/api/sessions/${ccSessionId}/transcript`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(transcriptRes.status).toBe(200);
    const transcriptBody = await transcriptRes.json();
    expect(transcriptBody.messages).toBeTruthy();
    expect(transcriptBody.messages.length).toBeGreaterThan(0);

    // Assert: messages are ordered by ordinal
    for (let i = 1; i < transcriptBody.messages.length; i++) {
      expect(transcriptBody.messages[i].ordinal).toBeGreaterThanOrEqual(
        transcriptBody.messages[i - 1].ordinal,
      );
    }

    // Assert: content blocks are nested correctly within messages
    for (const msg of transcriptBody.messages) {
      expect(msg.content_blocks).toBeDefined();
      // content_blocks is a JSON-aggregated array
      if (msg.content_blocks && msg.content_blocks.length > 0) {
        for (const block of msg.content_blocks) {
          expect(block.block_type).toBeTruthy();
        }
      }
    }

    // GET /api/sessions/:id/transcript/raw — presigned URL
    // Use ?redirect=false to get JSON response instead of 302 redirect
    const rawRes = await fetch(
      `${baseUrl}/api/sessions/${ccSessionId}/transcript/raw?redirect=false`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(rawRes.status).toBe(200);
    const rawBody = await rawRes.json();
    expect(rawBody.url).toBeTruthy();
    // Presigned URL should start with "http" (LocalStack URL)
    expect(rawBody.url).toMatch(/^http/);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 8: Tag management
  // -----------------------------------------------------------------------
  test("Test 8: Tag set, add, remove, and query by tag", async () => {
    // Create a session
    const deviceId = `device-${generateId()}`;
    const ccSessionId = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: "github.com/test-user/tag-repo",
        cc_session_id: ccSessionId,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // PATCH: set tags = ["bugfix"]
    const setRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ tags: ["bugfix"] }),
    });
    expect(setRes.status).toBe(200);
    const setBody = await setRes.json();
    expect(setBody.session.tags).toEqual(["bugfix"]);

    // PATCH: add_tags = ["auth"]
    const addRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ add_tags: ["auth"] }),
    });
    expect(addRes.status).toBe(200);
    const addBody = await addRes.json();
    // Should contain both tags, order may vary
    expect(addBody.session.tags).toContain("bugfix");
    expect(addBody.session.tags).toContain("auth");
    expect(addBody.session.tags.length).toBe(2);

    // PATCH: remove_tags = ["bugfix"]
    const removeRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ remove_tags: ["bugfix"] }),
    });
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.session.tags).toEqual(["auth"]);

    // GET: query by tag=auth — should include this session
    const authTagRes = await fetch(`${baseUrl}/api/sessions?tag=auth`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(authTagRes.status).toBe(200);
    const authTagBody = await authTagRes.json();
    const authIds = authTagBody.sessions.map((s: any) => s.id);
    expect(authIds).toContain(ccSessionId);

    // GET: query by tag=bugfix — should NOT include this session
    const bugfixTagRes = await fetch(`${baseUrl}/api/sessions?tag=bugfix`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(bugfixTagRes.status).toBe(200);
    const bugfixTagBody = await bugfixTagRes.json();
    const bugfixIds = bugfixTagBody.sessions.map((s: any) => s.id);
    expect(bugfixIds).not.toContain(ccSessionId);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 9: Duplicate session.end handling
  // -----------------------------------------------------------------------
  test("Test 9: Duplicate session.end does not produce duplicate data", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test-user/dup-end-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // 1. POST session.start
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // 2. Upload transcript
    const uploadRes = await uploadTranscript(ccSessionId);
    expect(uploadRes.status).toBe(202);

    // 3. POST session.end (first)
    const endEvent1 = makeSessionEndEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    await postEvents([endEvent1]);

    // Wait for pipeline to complete
    await waitFor(
      async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
        if (rows.length > 0 && rows[0].lifecycle === "parsed") return rows[0];
        return null;
      },
      30_000,
      500,
    );

    // Record message count before duplicate
    const beforeMsgs = await sql`
      SELECT count(*)::int as cnt FROM transcript_messages WHERE session_id = ${ccSessionId}
    `;
    const beforeCount = beforeMsgs[0].cnt;

    // 4. POST session.end again (duplicate)
    const endEvent2 = makeSessionEndEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    await postEvents([endEvent2]);

    // Brief wait for any processing
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    // Assert: session is still parsed (or summarized), no error
    const afterRows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(afterRows[0].lifecycle).toBe("parsed");

    // Assert: transcript_messages count is the same (not doubled)
    const afterMsgs = await sql`
      SELECT count(*)::int as cnt FROM transcript_messages WHERE session_id = ${ccSessionId}
    `;
    expect(afterMsgs[0].cnt).toBe(beforeCount);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 10: Pipeline failure — missing transcript in S3
  // -----------------------------------------------------------------------
  test("Test 10: Pipeline failure with missing S3 key transitions to failed", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test-user/fail-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // 1. POST session.start
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // 2. POST session.end (no transcript uploaded, but we'll set a fake S3 key)
    const endEvent = makeSessionEndEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    await postEvents([endEvent]);

    // Wait for lifecycle to reach 'ended'
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      if (rows.length > 0 && rows[0].lifecycle === "ended") return rows[0];
      return null;
    });

    // 3. Directly set a fake transcript_s3_key pointing to a non-existent S3 object
    await sql`
      UPDATE sessions
      SET transcript_s3_key = ${"transcripts/nonexistent/fake-session/raw.jsonl"}
      WHERE id = ${ccSessionId}
    `;

    // 4. Trigger reparse — this will try to download a non-existent S3 object
    const reparseRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}/reparse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(reparseRes.status).toBe(202);

    // 5. Wait for session to transition to 'failed'
    const failedSession = await waitFor(
      async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
        if (rows.length > 0 && rows[0].lifecycle === "failed") return rows[0];
        return null;
      },
      15_000,
      500,
    );

    // Assert: parse_error describes S3 download failure
    expect(failedSession.parse_error).toBeTruthy();
    expect(failedSession.parse_error).toMatch(/S3|download|not found/i);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 11: Backfill scanner dry-run
  // -----------------------------------------------------------------------
  test("Test 11: Backfill scanner discovers sessions from directory", async () => {
    // Create a temporary directory structure mimicking ~/.claude/projects/
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), "fuel-code-backfill-test-"));

    try {
      // Create a project directory (hyphen-separated path format)
      const projectDir = join(tmpDir, "-Users-testuser-Desktop-test-project");
      fs.mkdirSync(projectDir, { recursive: true });

      // Copy the test fixture JSONL with a UUID-style filename
      // Using a realistic UUID v4 format as the session ID
      const fakeSessionId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
      const transcriptPath = join(projectDir, `${fakeSessionId}.jsonl`);
      fs.copyFileSync(TEST_TRANSCRIPT_PATH, transcriptPath);

      // Set the mtime to 10 minutes ago so it's not treated as "potentially active"
      const tenMinutesAgo = new Date(Date.now() - 600_000);
      fs.utimesSync(transcriptPath, tenMinutesAgo, tenMinutesAgo);

      // Run the scanner on our temp directory
      const scanResult = await scanForSessions(tmpDir, {
        skipActiveThresholdMs: 300_000, // default 5 min threshold
      });

      // Assert: discovers the session
      expect(scanResult.discovered.length).toBe(1);
      expect(scanResult.discovered[0].sessionId).toBe(fakeSessionId);
      expect(scanResult.discovered[0].transcriptPath).toBe(transcriptPath);

      // Assert: skipped counts are correct for our minimal setup
      // The project dir itself is not skipped; we only have 1 JSONL file, no subagents
      expect(scanResult.skipped.subagents).toBe(0);
    } finally {
      // Clean up temp directory
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
