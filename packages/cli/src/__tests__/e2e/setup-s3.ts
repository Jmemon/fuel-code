/**
 * S3-enabled test server setup for CLI E2E tests that exercise the full pipeline.
 *
 * Unlike setup.ts (which starts a server WITHOUT S3 for basic event/session tests),
 * this variant connects to LocalStack S3, creates an S3 bucket, and wires up
 * PipelineDeps so the consumer can process transcripts and run the session pipeline.
 *
 * Requires Postgres (5433), Redis (6380), and LocalStack S3 (4566) running via
 * docker-compose.test.yml.
 *
 * Does NOT seed fixture data — tests using this setup create their own data.
 * Does NOT use advisory locks or ref counting — each test file gets its own
 * isolated server instance with a unique random port.
 */

import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { S3Client as AwsS3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

// Relative imports from the server package — bun can't resolve
// @fuel-code/server/src/... subpath imports in workspace mode.
import { createApp } from "../../../../server/src/app.js";
import { createDb } from "../../../../server/src/db/postgres.js";
import { runMigrations } from "../../../../server/src/db/migrator.js";
import { createRedisClient } from "../../../../server/src/redis/client.js";
import { ensureConsumerGroup } from "../../../../server/src/redis/stream.js";
import { startConsumer, type ConsumerHandle } from "../../../../server/src/pipeline/consumer.js";
import { createEventHandler } from "../../../../server/src/pipeline/wire.js";
import { createWsServer, type WsServerHandle } from "../../../../server/src/ws/index.js";
import { createS3Client } from "../../../../server/src/aws/s3.js";
import type { FuelCodeS3Client } from "../../../../server/src/aws/s3.js";
import { logger } from "../../../../server/src/logger.js";
import type { PipelineDeps, SummaryConfig } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";

/** LocalStack S3 configuration */
const S3_ENDPOINT = "http://localhost:4566";
const S3_BUCKET = "fuel-code-test-cli";
const S3_REGION = "us-east-1";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "../../../../server/src/db/migrations",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface S3TestServerContext {
  /** HTTP base URL, e.g. "http://127.0.0.1:12345" */
  baseUrl: string;
  /** WebSocket URL, e.g. "ws://127.0.0.1:12345" */
  wsUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** SQL connection for direct DB queries in tests */
  sql: ReturnType<typeof createDb>;
  /** S3 client for direct S3 assertions in tests */
  s3: FuelCodeS3Client;
  /** Tears down all resources in reverse order */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Start a fully-wired test server with Postgres, Redis, LocalStack S3,
 * and the event pipeline (with summaries disabled).
 *
 * Each call creates an independent server on a random port — no shared
 * singleton or advisory locks needed.
 */
export async function setupS3TestServer(): Promise<S3TestServerContext> {
  // 1. Connect to Postgres and run migrations
  const sql = createDb(DATABASE_URL, { max: 5 });
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(
      `Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`,
    );
  }

  // 2. Create two Redis clients: app (non-blocking) + consumer (blocking XREADGROUP)
  const redis = createRedisClient(REDIS_URL);
  const redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);

  // 3. Flush Redis and set up consumer group for a clean stream state
  await redis.flushall();
  await ensureConsumerGroup(redis);

  // 4. Create the S3 test bucket in LocalStack (idempotent)
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

  // 5. Create the fuel-code S3 client pointing at LocalStack
  const s3 = createS3Client(
    {
      bucket: S3_BUCKET,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: true,
    },
    logger,
  );

  // 6. Build pipeline dependencies with summaries DISABLED (no Anthropic API in tests)
  const summaryConfig: SummaryConfig = {
    enabled: false,
    model: "claude-sonnet-4-20250514",
    temperature: 0.3,
    maxOutputTokens: 150,
    apiKey: "",
  };
  const pipelineDeps: PipelineDeps = { sql, s3, summaryConfig, logger };

  // 7. Wire up event handler with pipeline deps so session.end triggers the pipeline
  const { registry } = createEventHandler(sql, logger, pipelineDeps);

  // 8. Create Express app with S3 and pipeline deps enabled
  const app = createApp({
    sql,
    redis,
    apiKey: API_KEY,
    s3,
    pipelineDeps,
  });

  // 9. Start HTTP server on random port
  const server: Server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;

  // 10. Attach WebSocket server
  const wsHandle: WsServerHandle = createWsServer({
    httpServer: server,
    logger,
    apiKey: API_KEY,
    pingIntervalMs: 60_000,
    pongTimeoutMs: 10_000,
  });

  // 11. Start consumer with broadcaster and pipeline deps
  const consumer: ConsumerHandle = startConsumer({
    redis: redisConsumer,
    sql,
    registry,
    logger,
    pipelineDeps,
    broadcaster: wsHandle.broadcaster,
  });

  // 12. Build cleanup function — tears down in reverse order
  const cleanup = async () => {
    // Stop consumer
    if (consumer) await consumer.stop();

    // Shut down WebSocket server
    if (wsHandle) await wsHandle.shutdown();

    // Close HTTP server
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    // Flush Redis so no stale stream data remains
    try {
      if (redis) await redis.flushall();
    } catch {}

    // Disconnect Redis clients
    try {
      if (redisConsumer) await redisConsumer.quit();
    } catch {}
    try {
      if (redis) await redis.quit();
    } catch {}

    // Close Postgres pool
    if (sql) await sql.end();
  };

  return {
    baseUrl,
    wsUrl,
    apiKey: API_KEY,
    sql,
    s3,
    cleanup,
  };
}
