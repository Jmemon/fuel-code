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

import type { FuelCodeS3Client } from "./aws/s3.js";
import type { PipelineDeps } from "@fuel-code/core";
import { logger } from "./logger.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createHealthRouter } from "./routes/health.js";
import { createEventsRouter } from "./routes/events.js";
import { createTranscriptUploadRouter } from "./routes/transcript-upload.js";
import { createSessionActionsRouter } from "./routes/session-actions.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createTimelineRouter } from "./routes/timeline.js";
import { createPromptsRouter } from "./routes/prompts.js";
import { createWorkspacesRouter } from "./routes/workspaces.js";
import { createDevicesRouter } from "./routes/devices.js";

/** Dependencies injected into createApp for testability */
export interface AppDeps {
  /** postgres.js SQL client */
  sql: postgres.Sql;
  /** ioredis client */
  redis: Redis;
  /** API key for Bearer token auth */
  apiKey: string;
  /** S3 client for transcript uploads (Phase 2 — optional for backwards compat) */
  s3?: FuelCodeS3Client;
  /** Pipeline dependencies for post-processing (Phase 2 — optional for backwards compat) */
  pipelineDeps?: PipelineDeps;
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

  // --- 6b. Transcript upload route (Phase 2) ---
  // Only mounted when S3 and pipeline deps are available. The route uses
  // express.raw() inline (not globally) to handle large binary uploads.
  if (deps.s3 && deps.pipelineDeps) {
    const uploadRouter = createTranscriptUploadRouter({
      sql: deps.sql,
      s3: deps.s3,
      pipelineDeps: deps.pipelineDeps,
      logger,
    });
    app.use("/api/sessions", uploadRouter);
  }

  // --- 6c. Session actions route (reparse) ---
  // Only mounted when pipeline deps are available (Phase 2+).
  if (deps.pipelineDeps) {
    app.use("/api", createSessionActionsRouter({
      sql: deps.sql,
      pipelineDeps: deps.pipelineDeps,
      logger,
    }));
  }

  // --- 6d. Session query/mutation routes (Task 9) ---
  // List, detail, transcript, events, git activity, and tag/summary updates.
  app.use("/api", createSessionsRouter({ sql: deps.sql, s3: deps.s3, logger }));

  // --- 6e. Timeline endpoint (Task 5) ---
  // Unified activity feed: sessions with embedded git highlights + orphan git events.
  app.use("/api", createTimelineRouter({ sql: deps.sql, logger }));

  // --- 6f. Prompts endpoint (Task 4) ---
  // Auto-prompt for git hook installation: pending prompts + dismiss actions.
  app.use("/api", createPromptsRouter({ sql: deps.sql, logger }));

  // --- 6g. Workspace and device query routes (Phase 4) ---
  // Read-only aggregation endpoints for workspaces and devices.
  app.use("/api", createWorkspacesRouter({ sql: deps.sql, logger }));
  app.use("/api", createDevicesRouter({ sql: deps.sql, logger }));

  // --- 7. Error handler — MUST be registered last ---
  app.use(errorHandler);

  return app;
}
