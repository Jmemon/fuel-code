/**
 * Redis connection management for fuel-code.
 *
 * Wraps ioredis with:
 *   - Exponential backoff retry strategy (capped at 3s, max 20 retries)
 *   - Lifecycle event logging (connect, error, close, reconnecting)
 *   - Health check via PING with timeout
 *   - Lazy connection (connect on first command, not on instantiation)
 *
 * Usage:
 *   const redis = createRedisClient(process.env.REDIS_URL!);
 *   await redis.connect();            // explicit connect (lazyConnect is on)
 *   const health = await checkRedisHealth(redis);
 */

import Redis from "ioredis";
import { StorageError } from "@fuel-code/shared";

/** Maximum number of reconnection attempts before giving up */
const MAX_RETRIES = 20;

/** Maximum delay between reconnection attempts (ms) */
const MAX_RETRY_DELAY_MS = 3_000;

/** Timeout for the initial TCP connection (ms) */
const CONNECT_TIMEOUT_MS = 5_000;

/** Maximum retries per individual Redis command */
const MAX_RETRIES_PER_REQUEST = 3;

/**
 * Create a configured ioredis client.
 *
 * The client uses lazyConnect — it won't open a TCP socket until
 * you call `redis.connect()` or issue the first command.
 *
 * @param url - Redis connection URL (e.g. "redis://localhost:6379")
 * @returns A configured Redis instance (not yet connected)
 * @throws StorageError if the URL is empty or undefined
 */
export function createRedisClient(url: string): Redis {
  // Guard: URL must be provided
  if (!url || url.trim() === "") {
    throw new StorageError(
      "Redis URL is required but was empty or undefined",
      "STORAGE_REDIS_URL_MISSING",
      { url },
    );
  }

  const redis = new Redis(url, {
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    connectTimeout: CONNECT_TIMEOUT_MS,
    lazyConnect: true,

    /**
     * Exponential backoff: delay = min(attempt * 100ms, 3000ms).
     * Returns null after 20 attempts to stop reconnecting entirely.
     */
    retryStrategy(times: number): number | null {
      if (times > MAX_RETRIES) {
        console.error(
          `[redis] Exceeded ${MAX_RETRIES} reconnection attempts — giving up`,
        );
        return null;
      }
      const delay = Math.min(times * 100, MAX_RETRY_DELAY_MS);
      return delay;
    },
  });

  // --- Lifecycle event listeners ---

  redis.on("connect", () => {
    console.info("[redis] Connected to Redis");
  });

  redis.on("error", (err: Error) => {
    console.error(`[redis] Error: ${err.message}`);
  });

  redis.on("close", () => {
    console.warn("[redis] Connection closed");
  });

  redis.on("reconnecting", () => {
    console.warn("[redis] Reconnecting...");
  });

  return redis;
}

/** Health check result returned by `checkRedisHealth` */
export interface RedisHealthResult {
  /** Whether the PING succeeded */
  ok: boolean;
  /** Round-trip latency in milliseconds */
  latency_ms: number;
  /** Error message if the check failed */
  error?: string;
}

/** Timeout for the PING health check (ms) */
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/**
 * Check Redis connectivity by issuing a PING command.
 *
 * Returns latency on success, or an error description on failure.
 * The check has a 3-second timeout so it won't block indefinitely.
 *
 * @param redis - An ioredis client instance
 * @returns Health check result with ok status and latency or error
 */
export async function checkRedisHealth(
  redis: Redis,
): Promise<RedisHealthResult> {
  const start = performance.now();

  try {
    // Race the PING against a timeout to avoid hanging on broken connections
    const result = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Redis health check timed out")),
          HEALTH_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);

    const latency_ms = Math.round(performance.now() - start);

    if (result === "PONG") {
      return { ok: true, latency_ms };
    }

    // Unexpected response from PING (should never happen, but be safe)
    return {
      ok: false,
      latency_ms,
      error: `Unexpected PING response: ${result}`,
    };
  } catch (err) {
    const latency_ms = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, latency_ms, error: message };
  }
}
