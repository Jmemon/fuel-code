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

import { seedFixtures, cleanFixtures, IDS } from "./fixtures.js";

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
// Setup: each test file starts its own server instance (each on a different
// random port). Database seeding uses an advisory lock to ensure only one
// file TRUNCATEs and seeds at a time, preventing race conditions when bun
// runs test files in parallel with separate module contexts.
// ---------------------------------------------------------------------------

/**
 * Start a fully-wired test server with real Postgres + Redis + WebSocket.
 * Seeds fixture data into the database using an advisory lock for safety.
 * Returns context for test use.
 */
export async function setupTestServer(): Promise<TestServerContext> {
  return _doSetup();
}

// ---------------------------------------------------------------------------
// Internal setup — runs exactly once
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Debug logging helper — helps diagnose hangs by showing which step is stuck
// ---------------------------------------------------------------------------

function dbg(step: string, extra?: string) {
  const ts = new Date().toISOString();
  const suffix = extra ? ` — ${extra}` : "";
  console.log(`[setup.ts ${ts}] ${step}${suffix}`);
}

async function _doSetup(): Promise<TestServerContext> {
  const setupStart = Date.now();
  dbg("START _doSetup", `PID=${process.pid}`);

  // 1. Connect to Postgres and run migrations
  dbg("step 1/9: connecting to Postgres", DATABASE_URL.replace(/\/\/.*@/, "//***@"));
  const sql = createDb(DATABASE_URL, { max: 5 });
  dbg("step 1/9: running migrations...");
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    dbg("step 1/9: MIGRATION ERROR", migrationResult.errors.map((e) => e.name).join(", "));
    throw new Error(
      `Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`,
    );
  }
  dbg("step 1/9: migrations OK", `applied=${migrationResult.applied}`);

  // 2. Create two Redis clients: app (non-blocking) + consumer (blocking XREADGROUP)
  dbg("step 2/9: connecting to Redis", REDIS_URL);
  const redis = createRedisClient(REDIS_URL);
  const redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);
  dbg("step 2/9: Redis connected");

  // 3. Set up Redis consumer group (flushall is handled under the advisory lock below)
  dbg("step 3/9: ensuring Redis consumer group...");
  await ensureConsumerGroup(redis);
  dbg("step 3/9: consumer group ready");

  // 4. Seed fixture data using a Postgres advisory lock to prevent parallel
  //    test files from racing on TRUNCATE + INSERT. The first file to acquire
  //    the lock does the full seed; subsequent files check for our specific
  //    fixture data and skip if it's already present.
  //    A reference count table (_e2e_refs) tracks how many test files are
  //    active so the last one to finish can clean up all fixture data.
  //    Advisory lock key 99999 is arbitrary but must be consistent.
  dbg("step 4/9: acquiring advisory lock + seeding fixtures...");
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(99999)`;
    dbg("step 4/9: advisory lock acquired");

    // Ensure the ref count table exists (idempotent)
    await tx`
      CREATE TABLE IF NOT EXISTS _e2e_refs (
        id integer PRIMARY KEY DEFAULT 1,
        count integer NOT NULL DEFAULT 0
      )
    `;
    await tx`INSERT INTO _e2e_refs (id, count) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`;

    // Increment ref count for this test file
    await tx`UPDATE _e2e_refs SET count = count + 1 WHERE id = 1`;

    // Check if OUR specific fixture data exists (keyed on a known workspace ID)
    const [{ count }] = await tx`SELECT count(*) as count FROM workspaces WHERE id = ${IDS.ws_fuel_code}`;
    if (Number(count) === 0) {
      // First file (or stale data from a previous run): flush Redis + truncate + seed.
      // TRUNCATE is used here (not targeted deletes) to ensure a clean test state.
      dbg("step 4/9: first file — flushing Redis + truncating tables + seeding fixtures");
      await redis.flushall();
      await ensureConsumerGroup(redis);
      await tx`TRUNCATE events, git_activity, content_blocks, transcript_messages, sessions, workspace_devices, workspaces, devices CASCADE`;
      await seedFixtures(tx as any);
      dbg("step 4/9: seed complete");
    } else {
      dbg("step 4/9: fixture data already present, skipping seed");
    }
  });
  dbg("step 4/9: advisory lock released");

  // 6. Create Express app (no S3 in Phase 4 CLI tests — not testing transcript upload)
  dbg("step 5/9: creating Express app...");
  const app = createApp({
    sql,
    redis,
    apiKey: API_KEY,
  });
  dbg("step 5/9: Express app created");

  // 7. Start HTTP server on random port
  dbg("step 6/9: starting HTTP server on port 0 (random)...");
  const server: Server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;
  dbg("step 6/9: HTTP server listening", `port=${address.port} url=${baseUrl}`);

  // 8. Attach WebSocket server (must be created before consumer so
  //    the consumer can broadcast events to connected WS clients)
  dbg("step 7/9: attaching WebSocket server...");
  const wsHandle: WsServerHandle = createWsServer({
    httpServer: server,
    logger,
    apiKey: API_KEY,
    // Use short ping intervals for tests to avoid timeouts
    pingIntervalMs: 60_000,
    pongTimeoutMs: 10_000,
  });
  dbg("step 7/9: WebSocket server attached");

  // 9. Wire up event handler and start consumer with broadcaster
  //    so that ingested events are broadcast to WS subscribers.
  dbg("step 8/9: wiring event handler + starting Redis consumer...");
  const { registry } = createEventHandler(sql, logger);
  const consumer = startConsumer({
    redis: redisConsumer, sql, registry, logger,
    broadcaster: wsHandle.broadcaster,
  });
  dbg("step 8/9: consumer started");

  const elapsed = Date.now() - setupStart;
  dbg(`step 9/9: setup COMPLETE in ${elapsed}ms`, `baseUrl=${baseUrl}`);

  // 10. Build cleanup function (tears down in reverse order).
  //     Decrements the ref count; the last test file to finish deletes
  //     fixture data by known IDs so nothing leaks into the database.
  const cleanup = async () => {
    const cleanStart = Date.now();
    dbg("cleanup: START");

    // Stop consumer
    dbg("cleanup: stopping Redis consumer...");
    if (consumer) await consumer.stop();
    dbg("cleanup: consumer stopped");

    // Shut down WebSocket server
    dbg("cleanup: shutting down WebSocket server...");
    if (wsHandle) await wsHandle.shutdown();
    dbg("cleanup: WebSocket server shut down");

    // Close HTTP server
    dbg("cleanup: closing HTTP server...");
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    dbg("cleanup: HTTP server closed");

    // Flush Redis so no stale stream data remains
    dbg("cleanup: flushing Redis...");
    try {
      if (redis) await redis.flushall();
    } catch {}
    dbg("cleanup: Redis flushed");

    // Decrement ref count; if last file, truncate all fixture data
    dbg("cleanup: decrementing ref count...");
    try {
      if (sql) {
        await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(99999)`;
          await tx`UPDATE _e2e_refs SET count = count - 1 WHERE id = 1`;
          const [{ count }] = await tx`SELECT count FROM _e2e_refs WHERE id = 1`;
          if (Number(count) <= 0) {
            dbg("cleanup: last file — cleaning fixtures + dropping _e2e_refs");
            await cleanFixtures(tx as any);
            await tx`DROP TABLE IF EXISTS _e2e_refs`;
          } else {
            dbg("cleanup: other files still active, skipping truncate", `remaining=${count}`);
          }
        });
      }
    } catch {}

    // Disconnect Redis clients
    dbg("cleanup: disconnecting Redis clients...");
    if (redisConsumer) await redisConsumer.quit();
    if (redis) await redis.quit();
    dbg("cleanup: Redis clients disconnected");

    // Close Postgres pool
    dbg("cleanup: closing Postgres pool...");
    if (sql) await sql.end();

    dbg(`cleanup: COMPLETE in ${Date.now() - cleanStart}ms`);
  };

  return {
    baseUrl,
    wsUrl,
    apiKey: API_KEY,
    fixtures: IDS,
    sql,
    broadcaster: wsHandle.broadcaster,
    cleanup,
  };
}
