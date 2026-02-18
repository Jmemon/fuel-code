/**
 * Express application factory for fuel-code.
 *
 * Separated from index.ts so integration tests can create an app instance
 * via createApp() and use supertest without starting a real HTTP listener.
 *
 * Middleware stack (order matters):
 *   1. express.json()    — parse JSON bodies (1MB limit to prevent OOM)
 *   2. helmet()          — security headers (HSTS, X-Frame-Options, etc.)
 *   3. cors()            — disabled in Phase 1 (no web client)
 *   4. pino-http         — request/response logging
 *   5. Auth middleware    — Bearer token validation on /api/* (except /api/health)
 *   6. Routes            — /api/health, /api/events (Task 8)
 *   7. Error handler     — must be last (catches thrown errors and next(err))
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import type postgres from "postgres";
import type Redis from "ioredis";

import { logger } from "./logger.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createEventsRouter } from "./routes/events.js";

/** Dependencies injected into createApp for testability */
export interface AppDeps {
  /** postgres.js SQL client */
  sql: postgres.Sql;
  /** ioredis client */
  redis: Redis;
  /** API key for Bearer token auth */
  apiKey: string;
}

/**
 * Create and configure the Express app with the full middleware stack.
 *
 * @param deps - Injected dependencies (DB, Redis, API key)
 * @returns Fully configured Express app ready to listen or test with supertest
 */
export function createApp(deps: AppDeps): express.Express {
  const app = express();

  // --- 1. Body parsing with size limit to prevent OOM from oversized payloads ---
  app.use(express.json({ limit: "1mb" }));

  // --- 2. Security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.) ---
  app.use(helmet());

  // --- 3. CORS — disabled in Phase 1 (no web client yet) ---
  app.use(cors({ origin: false }));

  // --- 4. Request/response logging via pino-http ---
  // Logs method, url, status code, and response time for every request.
  // Does NOT log request/response bodies (may contain sensitive data).
  app.use(
    pinoHttp({
      logger,
      // Don't log health check requests to reduce noise
      autoLogging: {
        ignore: (req) => req.url === "/api/health",
      },
    }),
  );

  // --- 5. Auth middleware on /api/* EXCEPT /api/health ---
  // Health endpoint must be unauthenticated for Railway health probes.
  // Mount health BEFORE the auth middleware so it bypasses auth.
  app.use("/api/health", createHealthRouter(deps.sql, deps.redis));

  // Auth middleware applies to all remaining /api/* routes
  app.use("/api", createAuthMiddleware(deps.apiKey));

  // --- 6. Routes ---
  app.use("/api", createEventsRouter({ redis: deps.redis }));

  // --- 7. Error handler — MUST be registered last ---
  app.use(errorHandler);

  return app;
}
