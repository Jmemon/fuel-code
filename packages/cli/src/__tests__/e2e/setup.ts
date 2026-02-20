/**
 * Test server setup, fixture seeding, and teardown for Phase 4 E2E tests.
 *
 * Starts a real Express server with Postgres, Redis, and WebSocket support.
 * The server runs on a random port (port 0) to avoid conflicts. Returns
 * the base URL, WS URL, API key, fixture IDs, and a cleanup function.
 *
 * Uses a singleton pattern: bun runs test files in parallel, so all files
 * share one server instance. The first caller triggers setup; subsequent
 * callers await the same promise. Reference counting ensures cleanup runs
 * only after the last test file's afterAll calls release().
 *
 * Uses the same infrastructure as the server E2E tests in
 * packages/server/src/__tests__/e2e/ — real Postgres (port 5433),
 * real Redis (port 6380) from docker-compose.test.yml.
 */

import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

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
import { logger } from "../../../../server/src/logger.js";

import { seedFixtures, IDS } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";
const MIGRATIONS_DIR = join(
  import.meta.dir,
  "../../../../server/src/db/migrations",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestServerContext {
  /** HTTP base URL, e.g. "http://127.0.0.1:12345" */
  baseUrl: string;
  /** WebSocket URL, e.g. "ws://127.0.0.1:12345" */
  wsUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Fixture IDs for cross-referencing in assertions */
  fixtures: typeof IDS;
  /** SQL connection for direct DB queries in tests */
  sql: ReturnType<typeof createDb>;
  /** WS broadcaster for direct broadcast testing (bypasses consumer pipeline) */
  broadcaster: WsServerHandle["broadcaster"];
  /**
   * Release this test file's hold on the shared server.
   * Actual teardown only happens when the last holder releases.
   */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Singleton state: one server shared across all parallel test files
// ---------------------------------------------------------------------------

let _setupPromise: Promise<TestServerContext> | null = null;
let _refCount = 0;
let _realCleanup: (() => Promise<void>) | null = null;

/**
 * Acquire a shared test server. First caller triggers real setup;
 * subsequent callers get the same promise. Each caller increments a
 * reference count. The returned cleanup() decrements it and only
 * tears down when the last reference is released.
 */
export async function setupTestServer(): Promise<TestServerContext> {
  _refCount++;

  if (!_setupPromise) {
    _setupPromise = _doSetup();
  }

  const shared = await _setupPromise;

  // Each test file gets its own cleanup that decrements the ref count.
  // Real teardown only fires when the last file finishes.
  return {
    ...shared,
    cleanup: async () => {
      _refCount--;
      if (_refCount <= 0 && _realCleanup) {
        await _realCleanup();
        _realCleanup = null;
        _setupPromise = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal setup — runs exactly once
// ---------------------------------------------------------------------------

async function _doSetup(): Promise<TestServerContext> {
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

  // 3. Flush Redis for clean state, set up consumer group
  await redis.flushall();
  await ensureConsumerGroup(redis);

  // 4. Truncate all data tables to ensure clean state from previous test runs.
  //    CASCADE handles FK constraints. Tables are preserved from migrations.
  await sql`TRUNCATE events, git_activity, content_blocks, transcript_messages, sessions, workspace_devices, workspaces, devices CASCADE`;

  // 5. Seed fixture data
  await seedFixtures(sql);

  // 6. Create Express app (no S3 in Phase 4 CLI tests — not testing transcript upload)
  const app = createApp({
    sql,
    redis,
    apiKey: API_KEY,
  });

  // 7. Start HTTP server on random port
  const server: Server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;

  // 8. Attach WebSocket server (must be created before consumer so
  //    the consumer can broadcast events to connected WS clients)
  const wsHandle: WsServerHandle = createWsServer({
    httpServer: server,
    logger,
    apiKey: API_KEY,
    // Use short ping intervals for tests to avoid timeouts
    pingIntervalMs: 60_000,
    pongTimeoutMs: 10_000,
  });

  // 9. Wire up event handler and start consumer with broadcaster
  //    so that ingested events are broadcast to WS subscribers.
  const { registry } = createEventHandler(sql, logger);
  const consumer = startConsumer({
    redis: redisConsumer, sql, registry, logger,
    broadcaster: wsHandle.broadcaster,
  });

  // 10. Store real cleanup function for ref-counted teardown
  _realCleanup = async () => {
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

    // Disconnect Redis clients
    if (redisConsumer) await redisConsumer.quit();
    if (redis) await redis.quit();

    // Close Postgres pool
    if (sql) await sql.end();
  };

  return {
    baseUrl,
    wsUrl,
    apiKey: API_KEY,
    fixtures: IDS,
    sql,
    broadcaster: wsHandle.broadcaster,
    cleanup: async () => {}, // placeholder — overridden per-caller in setupTestServer()
  };
}
