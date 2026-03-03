/**
 * Transcript upload endpoint for fuel-code.
 *
 * POST /api/sessions/:id/transcript/upload — accepts raw JSONL transcript body
 * and streams it directly to S3 without buffering the full body in memory.
 * Designed to be called by the CLI's `transcript upload` command after a
 * Claude Code session ends.
 *
 * Key behaviors:
 *   - Idempotent: if transcript_s3_key is already set, returns 200 (no re-upload)
 *   - Accepts uploads for sessions in any lifecycle state (detected, ended)
 *   - After upload, transitions session to 'transcript_ready' and triggers pipeline
 *   - Buffers req body then uploads to S3
 *   - Body limit: 200MB enforced via Content-Length check
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import { buildTranscriptKey, buildSubagentTranscriptKey } from "@fuel-code/shared";
import type { FuelCodeS3Client } from "../aws/s3.js";
import type { PipelineDeps } from "@fuel-code/core";
import { runSessionPipeline, transitionSession } from "@fuel-code/core";

/** Maximum upload size: 200MB (large transcripts from long CC sessions) */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

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
   * Uploads a raw JSONL transcript to S3 and optionally triggers the
   * post-processing pipeline if the session has already ended.
   *
   * When ?subagent_id=<id> is present, the transcript is stored under
   * the subagent S3 key path and linked to the subagent row instead of
   * the session. No pipeline trigger for subagent uploads — the pipeline
   * handles sub-agent transcript parsing after the main transcript is parsed.
   */
  router.post(
    "/:id/transcript/upload",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const sessionId = req.params.id as string;
        const subagentId = (req.query.subagent_id as string | undefined)?.trim() || null;

        // --- Step 1: Validate Content-Length is present and within limits ---
        const contentLength = parseInt(req.headers["content-length"] || "0", 10);
        if (!contentLength || contentLength === 0) {
          res.status(400).json({ error: "Content-Length header required" });
          return;
        }
        if (contentLength > MAX_UPLOAD_BYTES) {
          res.status(413).json({
            error: `Upload too large: ${contentLength} bytes exceeds ${MAX_UPLOAD_BYTES} byte limit`,
          });
          return;
        }

        // --- Step 2: Validate session exists ---
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

        // --- Step 3: Idempotency (main transcript only) ---
        // Sub-agent uploads skip this check — each sub-agent has its own key.
        if (!subagentId && session.transcript_s3_key) {
          res.status(200).json({
            status: "already_uploaded",
            s3_key: session.transcript_s3_key,
          });
          return;
        }

        // --- Step 4: Get workspace canonical ID for building the S3 key ---
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

        // --- Step 5: Build the S3 key ---
        const s3Key = subagentId
          ? buildSubagentTranscriptKey(canonicalId, sessionId, subagentId)
          : buildTranscriptKey(canonicalId, sessionId);

        logger.info(
          { sessionId, subagentId, s3Key, contentLength },
          `Uploading ${subagentId ? "sub-agent" : "main"} transcript for session ${sessionId} (${contentLength} bytes)`,
        );

        // --- Step 6: Buffer request body then upload to S3 ---
        // Buffering decouples the client->server and server->S3 connections so a
        // client disconnect mid-stream can't corrupt the S3 upload. Memory is
        // bounded by MAX_UPLOAD_BYTES (200MB) checked in step 1.
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);

        await s3.upload(s3Key, body, "application/x-ndjson");

        // --- Step 7: Update DB with the S3 key ---
        if (subagentId) {
          // Sub-agent upload: update the subagent row's transcript_s3_key.
          // Uses (session_id, agent_id) unique index to find the right row.
          await sql`
            UPDATE subagents
            SET transcript_s3_key = ${s3Key}
            WHERE session_id = ${sessionId} AND agent_id = ${subagentId}
          `;

          res.status(202).json({
            status: "uploaded",
            s3_key: s3Key,
            subagent_id: subagentId,
            pipeline_triggered: false,
          });
        } else {
          // Main transcript: update session with S3 key, then attempt lifecycle
          // transition to 'transcript_ready'. If the session is in 'ended' or
          // 'detected' state, the transition fires and the pipeline is triggered.
          await sql`
            UPDATE sessions
            SET transcript_s3_key = ${s3Key}, updated_at = now()
            WHERE id = ${sessionId}
          `;

          // Attempt to advance to transcript_ready — succeeds if session is
          // in 'ended' or 'detected' (transcript arrived before session.end).
          const transitionResult = await transitionSession(
            sql,
            sessionId,
            ["ended", "detected"],
            "transcript_ready" as any,
          );

          const pipelineTriggered = transitionResult.success;

          if (pipelineTriggered) {
            triggerPipeline(pipelineDeps, sessionId, logger);
          }

          res.status(202).json({
            status: "uploaded",
            s3_key: s3Key,
            pipeline_triggered: pipelineTriggered,
          });
        }
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
