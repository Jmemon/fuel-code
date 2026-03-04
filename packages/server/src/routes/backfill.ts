/**
 * Backfill endpoint for fuel-code.
 *
 * POST /api/backfill/sessions — accepts session metadata from the CLI backfill
 * command and creates the session row server-side. Replaces the CLI's direct
 * ensureSessionRow + endSession DB writes so the CLI only needs backend.url + api_key.
 *
 * Key behaviors:
 *   - Idempotent: ON CONFLICT (id) DO NOTHING returns 200 { status: "exists" }
 *   - Resolves workspace and device via the same core functions as event processing
 *   - For non-live ended sessions, transitions lifecycle to "ended"
 *   - Does NOT handle S3/pipeline — the existing transcript upload endpoint handles those
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import { backfillSessionRequestSchema } from "@fuel-code/shared";
import {
  resolveOrCreateWorkspace,
  resolveOrCreateDevice,
  transitionSession,
} from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the backfill router with injected dependencies.
 *
 * @param deps.sql    - postgres.js SQL client for session writes
 * @param deps.logger - Pino logger for structured logging
 * @returns Express Router with POST /backfill/sessions
 */
export function createBackfillRouter(deps: {
  sql: Sql;
  logger: Logger;
}): Router {
  const { sql, logger } = deps;
  const router = Router();

  /**
   * POST /backfill/sessions
   *
   * Create a session row from backfill scan metadata. Handles workspace/device
   * resolution, session insertion with dedup, and lifecycle transition for
   * ended sessions.
   */
  router.post(
    "/backfill/sessions",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // --- Validate request body ---
        const parseResult = backfillSessionRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid request body",
            details: parseResult.error.issues,
          });
          return;
        }

        const data = parseResult.data;

        // --- Resolve workspace (upsert by canonical ID) ---
        const workspaceId = await resolveOrCreateWorkspace(sql, data.workspace_canonical_id);

        // --- Resolve device (upsert by device ID) ---
        await resolveOrCreateDevice(sql, data.device_id, {
          name: data.device_name,
          type: data.device_type,
        });

        // --- Insert session row with ON CONFLICT dedup ---
        const inserted = await sql`
          INSERT INTO sessions (
            id, workspace_id, device_id, lifecycle, started_at,
            git_branch, source
          ) VALUES (
            ${data.session_id}, ${workspaceId}, ${data.device_id}, 'detected',
            ${data.started_at}, ${data.git_branch ?? null},
            ${data.source}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;

        // If no row returned, ON CONFLICT fired — session already exists
        if (inserted.length === 0) {
          res.status(200).json({ status: "exists", session_id: data.session_id });
          return;
        }

        // --- For non-live ended sessions, transition to "ended" ---
        let lifecycle = "detected";
        if (!data.is_live && data.ended_at) {
          await transitionSession(sql, data.session_id, ["detected"], "ended", {
            ended_at: data.ended_at,
            end_reason: "exit",
            duration_ms: data.duration_ms ?? undefined,
          });
          lifecycle = "ended";
        }

        logger.info(
          { sessionId: data.session_id, lifecycle, workspaceId },
          `Backfill session created: ${data.session_id} (${lifecycle})`,
        );

        res.status(201).json({
          session_id: data.session_id,
          lifecycle,
          workspace_id: workspaceId,
          status: "created",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
