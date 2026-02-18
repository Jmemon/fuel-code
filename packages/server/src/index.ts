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
import { createDb } from "./db/postgres.js";
import { runMigrations } from "./db/migrator.js";
import { createRedisClient } from "./redis/client.js";
import { ensureConsumerGroup } from "./redis/stream.js";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { createEventHandler } from "./pipeline/wire.js";
import { startConsumer } from "./pipeline/consumer.js";

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

  // --- Step 5: Create and connect Redis client ---
  const redis = createRedisClient(env.REDIS_URL);
  try {
    await redis.connect();
  } catch (err) {
    logger.error({ err }, "Failed to connect to Redis — aborting startup");
    process.exit(1);
  }

  // --- Step 6: Ensure consumer group exists on the events stream ---
  await ensureConsumerGroup(redis);

  // --- Step 7-8: Create Express app and start HTTP server ---
  const app = createApp({ sql, redis, apiKey: env.API_KEY });

  const server = app.listen(env.PORT, () => {
    const elapsedMs = Math.round(performance.now() - startMs);
    logger.info(
      { elapsed_ms: elapsedMs, port: env.PORT },
      `Server started in ${elapsedMs}ms. DB: ok. Redis: ok. Port: ${env.PORT}.`,
    );
  });

  // --- Step 9: Start event consumer ---
  // Create the handler registry and start the consumer loop that reads from
  // the Redis Stream and dispatches events to the event processor.
  const { registry } = createEventHandler(sql, logger);
  const consumer = startConsumer({ redis, sql, registry, logger });
  logger.info(
    { registeredHandlers: registry.listRegisteredTypes() },
    "Event consumer started",
  );

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
        server.close((err) => (err ? reject(err) : resolve()));
      });

      // 2. Stop the Redis Stream consumer loop (waits for current iteration to finish)
      await consumer.stop();

      // 3. Close Redis connection
      redis.disconnect();

      // 4. Close Postgres pool
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
