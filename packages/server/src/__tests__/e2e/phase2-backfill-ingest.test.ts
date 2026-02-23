/**
 * End-to-end integration tests for the backfill ingestion pipeline.
 *
 * Verifies the complete backfill flow against real Postgres, Redis, and
 * LocalStack S3:
 *   1. scanForSessions() discovers transcript files from a fake projects dir
 *   2. ingestBackfillSessions() pushes them through the real pipeline to "parsed"
 *   3. Deduplication: a second ingest of the same session is skipped
 *
 * These tests require Postgres (5433), Redis (6380), and LocalStack (4566)
 * running via docker-compose.test.yml.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
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
import {
  scanForSessions,
  ingestBackfillSessions,
  type BackfillProgress,
  type PipelineDeps,
  type SummaryConfig,
} from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";

const S3_ENDPOINT = "http://localhost:4566";
const S3_BUCKET = "fuel-code-test-backfill";
const S3_REGION = "us-east-1";

const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");
const TEST_TRANSCRIPT_PATH = join(import.meta.dir, "fixtures/test-transcript.jsonl");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let sql: ReturnType<typeof createDb>;
let redis: ReturnType<typeof createRedisClient>;
let redisConsumer: ReturnType<typeof createRedisClient>;
let consumer: ConsumerHandle;
let server: Server;
let baseUrl: string;
let s3: FuelCodeS3Client;
let pipelineDeps: PipelineDeps;

// Per-test temp directory tracking
let tempProjectsDir: string;

// ---------------------------------------------------------------------------
// waitFor helper — polls Postgres until a condition is met
// ---------------------------------------------------------------------------

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
// Fake projects directory builder
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory mimicking ~/.claude/projects/ with a single
 * UUID-named JSONL transcript file. The file's mtime is set to 10 minutes
 * ago so scanForSessions does not skip it as "potentially active".
 */
function createFakeProjectsDir(): { projectsDir: string; sessionId: string } {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "fuel-backfill-e2e-"));
  const projectDir = join(dir, "-Users-testuser-Desktop-test-project");
  fs.mkdirSync(projectDir, { recursive: true });

  const sessionId = randomUUID();
  const transcriptDest = join(projectDir, `${sessionId}.jsonl`);
  fs.copyFileSync(TEST_TRANSCRIPT_PATH, transcriptDest);

  // Set mtime to 10 minutes ago (past the 5-minute active session threshold)
  const tenMinAgo = new Date(Date.now() - 600_000);
  fs.utimesSync(transcriptDest, tenMinAgo, tenMinAgo);

  return { projectsDir: dir, sessionId };
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Postgres connection pool + migrations
  sql = createDb(DATABASE_URL, { max: 5 });
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(
      `Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`,
    );
  }

  // 2. Two Redis clients: app (non-blocking) + consumer (blocking XREADGROUP)
  redis = createRedisClient(REDIS_URL);
  redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);

  // 3. Flush Redis + set up consumer group
  await redis.flushall();
  await ensureConsumerGroup(redis);

  // 4. Create S3 bucket in LocalStack
  const rawS3 = new AwsS3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  try {
    await rawS3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  } catch (err: any) {
    if (
      err.name !== "BucketAlreadyOwnedByYou" &&
      err.name !== "BucketAlreadyExists"
    ) {
      throw err;
    }
  }
  rawS3.destroy();

  // 5. Create FuelCodeS3Client pointing at LocalStack
  s3 = createS3Client(
    {
      bucket: S3_BUCKET,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
    },
    logger,
  );

  // 6. Build PipelineDeps with summaries DISABLED (no Anthropic API in tests)
  const summaryConfig: SummaryConfig = {
    enabled: false,
    model: "claude-sonnet-4-20250514",
    temperature: 0.3,
    maxOutputTokens: 150,
    apiKey: "",
  };
  pipelineDeps = { sql, s3, summaryConfig, logger };

  // 7. Wire event handler + start consumer
  const { registry } = createEventHandler(sql, logger, pipelineDeps);
  consumer = startConsumer({ redis: redisConsumer, sql, registry, logger, pipelineDeps });

  // 8. Start HTTP server on random port
  const app = createApp({ sql, redis, apiKey: API_KEY, s3, pipelineDeps });
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  tempProjectsDir = "";
}, 30_000);

afterAll(async () => {
  // Stop the consumer and clean up all resources.
  // consumer.stop() sets shouldStop=true synchronously; the flushall breaks
  // the consumer's blocked XREADGROUP so it can exit promptly.
  if (consumer) {
    const stopPromise = consumer.stop();
    // Flush Redis to break the consumer's blocked XREADGROUP
    if (redis) {
      try { await redis.flushall(); } catch {}
    }
    await stopPromise;
  }
  if (server) {
    // closeAllConnections() terminates keep-alive connections from the backfill
    // client that would otherwise keep server.close() hanging indefinitely
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  if (redisConsumer) redisConsumer.disconnect();
  if (redis) {
    try { await redis.quit(); } catch {}
  }
  if (sql) await sql.end();
}, 15_000);

afterEach(async () => {
  // Clean up temp directory between tests
  if (tempProjectsDir) {
    fs.rmSync(tempProjectsDir, { recursive: true, force: true });
    tempProjectsDir = "";
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 2 E2E: Backfill Ingestion", () => {
  // -----------------------------------------------------------------------
  // Test 1: scanForSessions discovers transcript files
  // -----------------------------------------------------------------------
  test("scanForSessions discovers transcript files", async () => {
    const { projectsDir, sessionId } = createFakeProjectsDir();
    tempProjectsDir = projectsDir;

    const scanResult = await scanForSessions(projectsDir, {
      skipActiveThresholdMs: 300_000,
    });

    // Assert: discovers exactly 1 session with the correct ID
    expect(scanResult.discovered.length).toBe(1);
    expect(scanResult.discovered[0].sessionId).toBe(sessionId);

    // Assert: file size is non-zero (the fixture has real content)
    expect(scanResult.discovered[0].fileSizeBytes).toBeGreaterThan(0);

    // Assert: transcript path points to the expected location
    expect(scanResult.discovered[0].transcriptPath).toContain(sessionId);
    expect(scanResult.discovered[0].transcriptPath).toEndWith(".jsonl");

    // Assert: no errors during scan
    expect(scanResult.errors.length).toBe(0);

    // Assert: skipped counts are sane
    expect(scanResult.skipped.subagents).toBe(0);
  }, 10_000);

  // -----------------------------------------------------------------------
  // Test 2: full backfill — scan, ingest, session reaches "parsed"
  // -----------------------------------------------------------------------
  test("full backfill: scan -> ingest -> session reaches parsed", async () => {
    const { projectsDir, sessionId } = createFakeProjectsDir();
    tempProjectsDir = projectsDir;

    // 1. Scan to discover sessions
    const scanResult = await scanForSessions(projectsDir, {
      skipActiveThresholdMs: 300_000,
    });
    expect(scanResult.discovered.length).toBe(1);

    // 2. Ingest against the real test server
    const progressUpdates: BackfillProgress[] = [];
    const deviceId = `backfill-device-${generateId().slice(0, 8)}`;

    const result = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: baseUrl,
      apiKey: API_KEY,
      deviceId,
      onProgress: (p) => progressUpdates.push({ ...p }),
      concurrency: 1,
      batchSize: 10,
      throttleMs: 50,
    });

    // Assert: ingestion result shows 1 ingested, 0 skipped
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors.length).toBe(0);

    // 3. Wait for session lifecycle to reach "parsed"
    const parsedSession = await waitFor(
      async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
        if (rows.length > 0 && rows[0].lifecycle === "parsed") return rows[0];
        return null;
      },
      45_000,
      500,
    );


    // Assert: session has expected pipeline results
    expect(parsedSession.lifecycle).toBe("parsed");
    expect(parsedSession.parse_status).toBe("completed");
    expect(parsedSession.transcript_s3_key).toBeTruthy();

    // Assert: transcript_messages rows exist
    const msgRows = await sql`
      SELECT count(*)::int as cnt FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    expect(msgRows[0].cnt).toBeGreaterThan(0);

    // Assert: content_blocks rows exist
    const blockRows = await sql`
      SELECT count(*)::int as cnt FROM content_blocks WHERE session_id = ${sessionId}
    `;
    expect(blockRows[0].cnt).toBeGreaterThan(0);

    // Assert: progress callback fired at least once
    expect(progressUpdates.length).toBeGreaterThan(0);

    // Assert: final progress report shows correct totals
    const lastProgress = progressUpdates[progressUpdates.length - 1];
    expect(lastProgress.total).toBe(1);
    expect(lastProgress.completed).toBe(1);
  }, 60_000);

  // -----------------------------------------------------------------------
  // Test 3: dedup — second ingest of same session is skipped
  // -----------------------------------------------------------------------
  test("dedup: second ingest of same session is skipped", async () => {
    const { projectsDir, sessionId } = createFakeProjectsDir();
    tempProjectsDir = projectsDir;

    // 1. First ingest: scan + ingest
    const scanResult = await scanForSessions(projectsDir, {
      skipActiveThresholdMs: 300_000,
    });
    expect(scanResult.discovered.length).toBe(1);

    const deviceId = `backfill-device-${generateId().slice(0, 8)}`;
    const firstResult = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: baseUrl,
      apiKey: API_KEY,
      deviceId,
      concurrency: 1,
      batchSize: 10,
      throttleMs: 50,
    });
    expect(firstResult.ingested).toBe(1);

    // Wait for session to be fully processed (parsed)
    await waitFor(
      async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${sessionId}`;
        if (rows.length > 0 && rows[0].lifecycle === "parsed") return rows[0];
        return null;
      },
      45_000,
      500,
    );


    // Record row counts before the second ingest
    const beforeMsgs = await sql`
      SELECT count(*)::int as cnt FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    const beforeBlocks = await sql`
      SELECT count(*)::int as cnt FROM content_blocks WHERE session_id = ${sessionId}
    `;

    // 2. Second ingest of the same discovered sessions
    const secondResult = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: baseUrl,
      apiKey: API_KEY,
      deviceId,
      concurrency: 1,
      batchSize: 10,
      throttleMs: 50,
    });

    // Assert: second ingest skips the session (already exists)
    expect(secondResult.skipped).toBe(1);
    expect(secondResult.ingested).toBe(0);
    expect(secondResult.failed).toBe(0);

    // Assert: no duplicate rows were created
    const afterMsgs = await sql`
      SELECT count(*)::int as cnt FROM transcript_messages WHERE session_id = ${sessionId}
    `;
    const afterBlocks = await sql`
      SELECT count(*)::int as cnt FROM content_blocks WHERE session_id = ${sessionId}
    `;
    expect(afterMsgs[0].cnt).toBe(beforeMsgs[0].cnt);
    expect(afterBlocks[0].cnt).toBe(beforeBlocks[0].cnt);
  }, 60_000);
});
