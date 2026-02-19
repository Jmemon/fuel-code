/**
 * Session action endpoints for fuel-code.
 *
 * POST /api/sessions/:id/reparse — resets a session's parsed data and
 * re-triggers the post-processing pipeline. Useful when the parser is
 * updated or when a previous parse attempt failed.
 *
 * Precondition checks:
 *   - Session must exist (404 otherwise)
 *   - Session must have a transcript_s3_key (409 if missing)
 *   - Session must not be currently parsing (409 if parse_status = 'parsing')
 *   - Session must have ended (409 if lifecycle is 'detected' or 'capturing')
 *   - resetSessionForReparse must succeed (409 if session can't be reset)
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import {
  resetSessionForReparse,
  runSessionPipeline,
  type PipelineDeps,
} from "@fuel-code/core";

/**
 * Trigger the pipeline for a session, preferring the bounded queue when
 * available and falling back to a direct fire-and-forget call (tests).
 */
function triggerPipeline(pipelineDeps: PipelineDeps, sessionId: string, logger: Logger): void {
  if (pipelineDeps.enqueueSession) {
    pipelineDeps.enqueueSession(sessionId);
  } else {
    runSessionPipeline(pipelineDeps, sessionId).catch((err: unknown) => {
      logger.error(
        { sessionId, error: err instanceof Error ? err.message : String(err) },
        "Pipeline trigger failed (direct)",
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the session actions router with injected dependencies.
 *
 * @param deps.sql          - postgres.js SQL client for session lookups/updates
 * @param deps.pipelineDeps - Pipeline dependencies for triggering post-processing
 * @param deps.logger       - Pino logger for structured logging
 * @returns Express Router with POST /sessions/:id/reparse
 */
export function createSessionActionsRouter(deps: {
  sql: Sql;
  pipelineDeps: PipelineDeps;
  logger: Logger;
}): Router {
  const { sql, pipelineDeps, logger } = deps;
  const router = Router();

  /**
   * POST /sessions/:id/reparse
   *
   * Resets a session's parsed data (transcript_messages, content_blocks, stats)
   * and re-triggers the post-processing pipeline from the raw transcript in S3.
   * Returns 202 immediately — the pipeline runs asynchronously.
   */
  router.post(
    "/sessions/:id/reparse",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const sessionId = req.params.id as string;

        // --- Step 1: Fetch session details for validation ---
        const sessionRows = await sql`
          SELECT id, lifecycle, parse_status, transcript_s3_key
          FROM sessions
          WHERE id = ${sessionId}
        `;

        // --- Step 2: Session not found ---
        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const session = sessionRows[0];

        // --- Step 3: No transcript available in S3 ---
        if (!session.transcript_s3_key) {
          res.status(409).json({ error: "No transcript available. Cannot reparse." });
          return;
        }

        // --- Step 4: Currently being processed ---
        if (session.parse_status === "parsing") {
          res.status(409).json({ error: "Session is currently being processed. Try again later." });
          return;
        }

        // --- Step 5: Session hasn't ended yet ---
        const lifecycle = session.lifecycle as string;
        if (lifecycle === "detected" || lifecycle === "capturing") {
          res.status(409).json({ error: "Session has not ended yet." });
          return;
        }

        // --- Step 6: Reset session for reparse ---
        // Deletes transcript_messages + content_blocks, clears derived stats,
        // and sets lifecycle back to 'ended' with parse_status = 'pending'.
        const resetResult = await resetSessionForReparse(sql, sessionId);

        // --- Step 7: Reset failed (session in unexpected state) ---
        if (!resetResult.reset) {
          res.status(409).json({ error: "Session cannot be reparsed from current state" });
          return;
        }

        // --- Step 8: Trigger pipeline asynchronously via bounded queue ---
        triggerPipeline(pipelineDeps, sessionId, logger);

        // --- Step 9: Return 202 — reparse initiated ---
        res.status(202).json({
          message: "Reparse initiated",
          session_id: sessionId,
          lifecycle: "ended",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
