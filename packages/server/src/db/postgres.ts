/**
 * PostgreSQL connection pool management for fuel-code.
 *
 * Uses the `postgres` (postgres.js) driver — a zero-dependency, pipeline-ready
 * Postgres client. This module handles:
 *   - Creating a connection pool with sensible defaults
 *   - Health checking the database connection (for readiness probes)
 *
 * SECURITY: Connection strings are never logged (they contain credentials).
 * Only host and port are extracted for diagnostic logging.
 */

import postgres from "postgres";
import { StorageError } from "@fuel-code/shared";

/** Default connection pool settings */
const POOL_DEFAULTS = {
  /** Maximum number of connections in the pool */
  max: 10,
  /** Close idle connections after this many seconds */
  idle_timeout: 20,
  /** Abort connection attempts after this many seconds */
  connect_timeout: 10,
} as const;

/** Health check timeout in milliseconds */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/** Result of a database health check */
export interface DbHealthResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

/**
 * Create a postgres.js client with connection pooling.
 *
 * @param connectionString - Full Postgres connection URI (e.g., postgres://user:pass@host:5432/db)
 * @param options          - Override default pool settings
 * @returns A postgres.js Sql instance (acts as a tagged template + connection pool)
 *
 * @throws {StorageError} If connectionString is empty or undefined (code: STORAGE_DB_URL_MISSING)
 */
export function createDb(
  connectionString: string | undefined,
  options?: { max?: number },
): postgres.Sql {
  // Guard: connection string is required
  if (!connectionString || connectionString.trim() === "") {
    throw new StorageError(
      "DATABASE_URL environment variable is required.",
      "STORAGE_DB_URL_MISSING",
    );
  }

  // Extract host and port for safe diagnostic logging (never log the full URL)
  let safeLogInfo = "unknown";
  try {
    const url = new URL(connectionString);
    safeLogInfo = `${url.hostname}:${url.port || 5432}`;
  } catch {
    // If URL parsing fails, we still proceed — postgres.js will handle the error
    safeLogInfo = "invalid-url";
  }

  const sql = postgres(connectionString, {
    max: options?.max ?? POOL_DEFAULTS.max,
    idle_timeout: POOL_DEFAULTS.idle_timeout,
    connect_timeout: POOL_DEFAULTS.connect_timeout,
  });

  // Log connection target without credentials
  console.log(`[db] Pool created → ${safeLogInfo} (max: ${options?.max ?? POOL_DEFAULTS.max})`);

  return sql;
}

/**
 * Check database health by running a trivial query (`SELECT 1`).
 *
 * Used by readiness/liveness probes. Returns structured result so callers
 * can decide how to respond (HTTP 200 vs 503, etc.).
 *
 * @param sql - A postgres.js client instance
 * @returns Health check result with latency and optional error message
 */
export async function checkDbHealth(
  sql: postgres.Sql,
): Promise<DbHealthResult> {
  const start = performance.now();

  try {
    // Run a trivial query with a timeout to detect hung connections.
    // postgres.js doesn't have a per-query .timeout() method, so we race
    // the query against a manual timeout promise.
    await Promise.race([
      sql`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("DB health check timed out")),
          HEALTH_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);

    const latency_ms = Math.round(performance.now() - start);
    return { ok: true, latency_ms };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - start);
    const error =
      err instanceof Error ? err.message : "Unknown health check failure";
    return { ok: false, latency_ms, error };
  }
}
