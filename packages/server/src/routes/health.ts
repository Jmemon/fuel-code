/**
 * Health check endpoint for fuel-code server.
 *
 * GET /api/health — unauthenticated (Railway health probes must work without auth).
 *
 * Reports overall server health based on DB and Redis connectivity:
 *   - "ok"        → both DB and Redis are healthy (HTTP 200)
 *   - "degraded"  → DB healthy, Redis unhealthy (HTTP 200) — events accepted but not processing
 *   - "unhealthy" → DB unhealthy (HTTP 503) — server cannot function
 */

import { Router } from "express";
import type postgres from "postgres";
import type Redis from "ioredis";
import { checkDbHealth } from "../db/postgres.js";
import { checkRedisHealth } from "../redis/client.js";

/** The server version reported in health check responses */
const VERSION = "0.1.0";

/** Timestamp when the server process started (for uptime calculation) */
const startTime = Date.now();

/**
 * Create the health check router.
 *
 * @param sql   - postgres.js client for DB health checks
 * @param redis - ioredis client for Redis health checks
 * @param opts  - Optional extra dependencies (e.g., WS client count)
 * @returns Express Router with the GET /api/health endpoint
 */
export function createHealthRouter(
  sql: postgres.Sql,
  redis: Redis,
  opts?: { getWsClientCount?: () => number },
): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    // Run DB and Redis health checks in parallel for minimal latency
    const [dbHealth, redisHealth] = await Promise.all([
      checkDbHealth(sql),
      checkRedisHealth(redis),
    ]);

    // Determine overall status based on check results:
    //   - DB down     → unhealthy (server can't store events)
    //   - Redis down  → degraded (can accept events but can't process them via stream)
    //   - Both up     → ok
    let status: "ok" | "degraded" | "unhealthy";
    if (!dbHealth.ok) {
      status = "unhealthy";
    } else if (!redisHealth.ok) {
      status = "degraded";
    } else {
      status = "ok";
    }

    // HTTP 503 only when unhealthy (DB is down) — Railway will stop routing traffic
    const httpStatus = status === "unhealthy" ? 503 : 200;

    res.status(httpStatus).json({
      status,
      checks: {
        db: {
          ok: dbHealth.ok,
          latency_ms: dbHealth.latency_ms,
          ...(dbHealth.error ? { error: dbHealth.error } : {}),
        },
        redis: {
          ok: redisHealth.ok,
          latency_ms: redisHealth.latency_ms,
          ...(redisHealth.error ? { error: redisHealth.error } : {}),
        },
      },
      ws_clients: opts?.getWsClientCount?.() ?? 0,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      version: VERSION,
    });
  });

  return router;
}
