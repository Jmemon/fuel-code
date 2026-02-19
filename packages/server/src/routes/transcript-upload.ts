/**
 * Transcript upload endpoint for fuel-code.
 *
 * POST /api/sessions/:id/transcript/upload — accepts raw JSONL transcript body
 * and stores it in S3. Designed to be called by the CLI's `transcript upload`
 * command after a Claude Code session ends.
 *
 * Key behaviors:
 *   - Idempotent: if transcript_s3_key is already set, returns 200 (no re-upload)
 *   - Accepts uploads for sessions in any lifecycle state (detected, capturing, ended)
 *   - Triggers the post-processing pipeline if the session lifecycle is 'ended'
 *   - Uses express.raw() middleware ONLY on this route (not globally)
 *   - Body limit: 200MB (large transcripts from long CC sessions)
 */

import { Router } from "express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import { buildTranscriptKey } from "@fuel-code/shared";
import type { FuelCodeS3Client } from "../aws/s3.js";
import type { PipelineDeps } from "@fuel-code/core";
import { runSessionPipeline } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the transcript upload router with injected dependencies.
 *
 * @param deps.sql        - postgres.js SQL client for session lookups/updates
 * @param deps.s3         - S3 client for uploading the raw transcript JSONL
 * @param deps.pipelineDeps - Pipeline dependencies for triggering post-processing
 * @param deps.logger     - Pino logger for structured logging
 * @returns Express Router with POST /:id/transcript/upload
 */
export function createTranscriptUploadRouter(deps: {
  sql: Sql;
  s3: FuelCodeS3Client;
  pipelineDeps: PipelineDeps;
  logger: Logger;
}): Router {
  const { sql, s3, pipelineDeps, logger } = deps;
  const router = Router();

  /**
   * POST /:id/transcript/upload
   *
   * Receives raw JSONL transcript body, stores it in S3, and optionally
   * triggers the post-processing pipeline if the session has already ended.
   *
   * The express.raw() middleware is applied inline so it only affects this
   * route — the rest of the app continues to use express.json().
   */
  router.post(
    "/:id/transcript/upload",
    express.raw({ type: "*/*", limit: "200mb" }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const sessionId = req.params.id;

        // --- Step 1: Validate session exists ---
        const sessionRows = await sql`
          SELECT id, lifecycle, workspace_id, transcript_s3_key
          FROM sessions
          WHERE id = ${sessionId}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const session = sessionRows[0];

        // --- Step 2: Idempotency — if transcript already uploaded, return early ---
        if (session.transcript_s3_key) {
          res.status(200).json({
            status: "already_uploaded",
            s3_key: session.transcript_s3_key,
          });
          return;
        }

        // --- Step 3: Get workspace canonical ID for building the S3 key ---
        const workspaceRows = await sql`
          SELECT canonical_id
          FROM workspaces
          WHERE id = ${session.workspace_id}
        `;

        if (workspaceRows.length === 0) {
          res.status(404).json({ error: "Workspace not found for session" });
          return;
        }

        const canonicalId = workspaceRows[0].canonical_id as string;

        // --- Step 4: Build the S3 key ---
        const s3Key = buildTranscriptKey(canonicalId, sessionId);

        // --- Step 5: Collect request body and upload to S3 ---
        // express.raw() provides req.body as a Buffer
        const body = req.body as Buffer;

        if (!body || body.length === 0) {
          res.status(400).json({ error: "Empty request body — no transcript data" });
          return;
        }

        logger.info(
          { sessionId, s3Key, bodySize: body.length },
          `Uploading transcript for session ${sessionId} (${body.length} bytes)`,
        );

        await s3.upload(s3Key, body, "application/x-ndjson");

        // --- Step 6: Update session with the S3 key ---
        await sql`
          UPDATE sessions
          SET transcript_s3_key = ${s3Key}, updated_at = now()
          WHERE id = ${sessionId}
        `;

        // --- Step 7: Trigger pipeline if session has already ended ---
        const lifecycle = session.lifecycle as string;
        const pipelineTriggered = lifecycle === "ended";

        if (pipelineTriggered) {
          // Fire-and-forget: pipeline runs asynchronously, errors are logged internally
          runSessionPipeline(pipelineDeps, sessionId).catch((err) => {
            logger.error(
              { sessionId, error: err instanceof Error ? err.message : String(err) },
              "Pipeline trigger failed after transcript upload",
            );
          });
        }

        // --- Step 8: Return success response ---
        res.status(202).json({
          status: "uploaded",
          s3_key: s3Key,
          pipeline_triggered: pipelineTriggered,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
