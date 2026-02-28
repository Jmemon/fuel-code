/**
 * Server entry point for fuel-code.
 *
 * Startup sequence (order matters):
 *   1. Load env vars (dotenv)
 *   2. Validate required env vars
 *   3. Connect to Postgres
 *   4. Run database migrations — abort if they fail
 *   5. Connect to Redis
 *   6. Ensure Redis consumer group exists
 *   7. Create Express app with middleware stack
 *   8. Start HTTP server
 *   9. Start event consumer (Task 11)
 *
 * Graceful shutdown on SIGTERM/SIGINT:
 *   1. Stop accepting new connections
 *   2. Stop consumer (Task 11)
 *   3. Close Redis
 *   4. Close Postgres pool
 *   5. Exit 0 (or force exit after 30s timeout)
 */

import "dotenv/config";
import { join } from "node:path";
import { createServer } from "node:http";
import { createDb } from "./db/postgres.js";
import { runMigrations } from "./db/migrator.js";
import { createRedisClient } from "./redis/client.js";
import { ensureConsumerGroup } from "./redis/stream.js";
import { createApp } from "./app.js";
import { logger, createLogger } from "./logger.js";
import { createEventHandler } from "./pipeline/wire.js";
import { startConsumer } from "./pipeline/consumer.js";
import { createS3Client } from "./aws/s3.js";
import { loadS3Config } from "./aws/s3-config.js";
import { createWsServer } from "./ws/index.js";
import { loadSummaryConfig, createPipelineQueue, type PipelineDeps } from "@fuel-code/core";

/** Graceful shutdown timeout — force exit if cleanup takes longer than this */
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Validate that all required environment variables are set.
 * Logs an error and exits if any are missing.
 */
function validateEnv(): {
  DATABASE_URL: string;
  REDIS_URL: string;
  API_KEY: string;
  PORT: number;
} {
  const missing: string[] = [];

  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!process.env.REDIS_URL) missing.push("REDIS_URL");
  if (!process.env.API_KEY) missing.push("API_KEY");

  if (missing.length > 0) {
    logger.error(
      { missing },
      `Missing required environment variables: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  return {
    DATABASE_URL: process.env.DATABASE_URL!,
    REDIS_URL: process.env.REDIS_URL!,
    API_KEY: process.env.API_KEY!,
    PORT: parseInt(process.env.PORT || "3000", 10),
  };
}

/**
 * Main server startup function.
 * Runs through the full initialization sequence and starts listening for HTTP requests.
 */
async function main(): Promise<void> {
  const startMs = performance.now();

  // --- Step 1-2: Load and validate env vars ---
  const env = validateEnv();

  // --- Step 3: Create Postgres connection pool ---
  const sql = createDb(env.DATABASE_URL);

  // --- Step 4: Run migrations — abort startup if DB is broken ---
  const migrationsDir = join(import.meta.dir, "db", "migrations");
  try {
    const migrationResult = await runMigrations(sql, migrationsDir);
    logger.info(
      {
        applied: migrationResult.applied.length,
        skipped: migrationResult.skipped.length,
        errors: migrationResult.errors.length,
      },
      "Migrations complete",
    );

    // If any migrations failed, the DB is in an inconsistent state — abort
    if (migrationResult.errors.length > 0) {
      logger.error(
        { errors: migrationResult.errors },
        "Migration errors detected — aborting startup",
      );
      process.exit(1);
    }
  } catch (err) {
    logger.error({ err }, "Migration failed — aborting startup");
    process.exit(1);
  }

  // --- Step 5: Create and connect Redis clients ---
  // Two separate clients are needed because the consumer uses XREADGROUP BLOCK
  // which holds the connection. Health checks (PING) and event writes (XADD)
  // need their own connection to avoid queuing behind the blocked command.
  const redis = createRedisClient(env.REDIS_URL);
  const redisConsumer = createRedisClient(env.REDIS_URL);
  try {
    await Promise.all([redis.connect(), redisConsumer.connect()]);
  } catch (err) {
    logger.error({ err }, "Failed to connect to Redis — aborting startup");
    process.exit(1);
  }

  // --- Step 6: Ensure consumer group exists on the events stream ---
  await ensureConsumerGroup(redis);

  // --- Step 7: Build pipeline dependencies for Phase 2 post-processing ---
  // S3 client for transcript download/upload, summary config for LLM generation.
  // Built before createApp so they can be passed as optional deps for the
  // transcript upload route (Phase 2 Task 8).
  const s3Config = loadS3Config();
  const s3 = createS3Client(s3Config, logger);
  await s3.ensureBucket();
  const summaryConfig = loadSummaryConfig();
  const pipelineDeps: PipelineDeps = { sql, s3, summaryConfig, logger };

  // --- Step 7b: Create bounded pipeline queue (max 6 concurrent, 50 pending) ---
  // The queue prevents unbounded concurrent pipeline runs during backfill or
  // high-throughput periods. Wire enqueueSession into pipelineDeps so all callers
  // (transcript upload, session.end handler, reparse, recovery) route through it.
  const pipelineQueue = createPipelineQueue(6);
  pipelineQueue.start(pipelineDeps);
  pipelineDeps.enqueueSession = (sessionId: string) => pipelineQueue.enqueue(sessionId);

  logger.info(
    { s3Bucket: s3Config.bucket, summaryEnabled: summaryConfig.enabled },
    "Pipeline dependencies initialized",
  );

  // --- Step 8: Create Express app and start HTTP server ---
  // App gets the non-blocking client (for health checks + XADD writes).
  // s3 and pipelineDeps are passed through for the transcript upload route.
  // Use createServer(app) instead of app.listen() so the WS server can share
  // the same HTTP server for WebSocket upgrades on /api/ws.
  // The getWsClientCount callback is a lazy wrapper — the WS server is created
  // right after the app, and the wrapper captures the reference once available.
  let wsClientCountFn: (() => number) | undefined;
  const app = createApp({
    sql, redis, apiKey: env.API_KEY, s3, pipelineDeps,
    getWsClientCount: () => wsClientCountFn?.() ?? 0,
  });
  const httpServer = createServer(app);

  // --- Step 8b: Attach WebSocket server to the HTTP server ---
  // The WS server handles real-time subscriptions for CLI clients.
  // It authenticates via the same API key and broadcasts events/session updates.
  const wsServer = createWsServer({ httpServer, logger, apiKey: env.API_KEY });
  wsClientCountFn = () => wsServer.getClientCount();

  httpServer.listen(env.PORT, () => {
    const elapsedMs = Math.round(performance.now() - startMs);
    logger.info(
      { elapsed_ms: elapsedMs, port: env.PORT },
      `Server started in ${elapsedMs}ms. DB: ok. Redis: ok. WS: ok. Port: ${env.PORT}.`,
    );
  });

  // --- Step 9: Start event consumer ---
  // Create the handler registry and start the consumer loop that reads from
  // the Redis Stream and dispatches events to the event processor.
  // Consumer gets its own Redis client (blocking XREADGROUP commands).
  // Pipeline deps are passed through so session.end can trigger post-processing.
  // The broadcaster is passed so processed events are broadcast to WS clients.
  // Consumer gets its own logger writing to logs/consumer.log for isolated inspection
  const consumerLogger = createLogger("consumer", "consumer.log");
  const { registry } = createEventHandler(sql, logger, pipelineDeps);
  const consumer = startConsumer(
    { redis: redisConsumer, sql, registry, logger: consumerLogger, pipelineDeps, broadcaster: wsServer.broadcaster },
  );
  logger.info(
    { registeredHandlers: registry.listRegisteredTypes() },
    "Event consumer started",
  );

  // --- Step 11: Delayed recovery for stuck sessions ---
  // Wait 5 seconds after startup before scanning for stuck sessions to avoid
  // competing with sessions that were legitimately in-flight during a restart.
  setTimeout(async () => {
    try {
      const { recoverStuckSessions, recoverUnsummarizedSessions } = await import("@fuel-code/core");

      // Recover sessions stuck in intermediate parsing states
      const stuckResult = await recoverStuckSessions(sql, pipelineDeps);
      if (stuckResult.found > 0) {
        logger.info(stuckResult, "Stuck session recovery completed on startup");
      }

      // Recover sessions that completed parsing but failed summary generation
      const summaryResult = await recoverUnsummarizedSessions(sql, pipelineDeps);
      if (summaryResult.found > 0) {
        logger.info(summaryResult, "Summary retry recovery completed on startup");
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? (err as Error).message : String(err) },
        "Session recovery failed on startup",
      );
    }
  }, 5000);

  // --- Graceful shutdown ---
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // Prevent double-shutdown from multiple signals
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, "Shutting down...");

    // Force exit if cleanup takes too long
    const forceExitTimer = setTimeout(() => {
      logger.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Prevent the timer from keeping the process alive if cleanup finishes first
    forceExitTimer.unref();

    try {
      // 1. Stop accepting new HTTP connections
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });

      // 2. Shut down WebSocket server (close all WS connections, clear ping interval)
      await wsServer.shutdown();

      // 3. Drain the pipeline queue (stop accepting new work, wait for in-flight)
      await pipelineQueue.stop();

      // 4. Stop the Redis Stream consumer loop (waits for current iteration to finish)
      await consumer.stop();

      // 5. Close Redis connections (both app + consumer clients)
      redis.disconnect();
      redisConsumer.disconnect();

      // 6. Close Postgres pool
      await sql.end();

      logger.info("Shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Run the server
main().catch((err) => {
  logger.fatal({ err }, "Unhandled startup error");
  process.exit(1);
});

// Export createApp for integration tests (avoids needing to start the HTTP listener)
export { createApp } from "./app.js";
