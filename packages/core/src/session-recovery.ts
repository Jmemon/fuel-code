/**
 * Stuck session recovery for fuel-code.
 *
 * On server startup (and optionally on a periodic schedule), this module
 * scans for sessions that are stuck in intermediate pipeline states —
 * lifecycle 'ended' or 'parsed' with parse_status 'pending' or 'parsing'
 * and no recent update. These sessions likely had their pipeline worker
 * crash or time out.
 *
 * Recovery strategy:
 *   - Sessions WITH a transcript_s3_key: re-trigger the pipeline
 *   - Sessions WITHOUT a transcript_s3_key: transition to 'failed'
 *     (no raw data to re-process)
 *
 * The function is safe to call concurrently — the pipeline itself uses
 * optimistic locking to prevent duplicate processing.
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import { findStuckSessions, failSession } from "./session-lifecycle.js";
import { runSessionPipeline, type PipelineDeps } from "./session-pipeline.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a recovery sweep — returned to the caller for logging/monitoring */
export interface RecoveryResult {
  /** Number of stuck sessions found */
  found: number;
  /** Number of sessions where pipeline was re-triggered */
  retried: number;
  /** Per-session errors encountered during recovery attempts */
  errors: Array<{ sessionId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Main recovery function
// ---------------------------------------------------------------------------

/**
 * Find and recover sessions stuck in intermediate pipeline states.
 *
 * Called on server startup (after a short delay) and optionally on a
 * periodic schedule. For each stuck session:
 *   - If it has a transcript_s3_key: reset to 'ended' and re-trigger pipeline
 *   - If it has no transcript_s3_key: transition to 'failed'
 *
 * @param sql          - postgres.js tagged template client
 * @param pipelineDeps - Injected pipeline dependencies (S3, summary config, logger)
 * @param options      - Optional configuration overrides
 * @returns RecoveryResult with counts and any per-session errors
 */
export async function recoverStuckSessions(
  sql: Sql,
  pipelineDeps: PipelineDeps,
  options?: {
    /** How long a session must be stuck before recovery kicks in (ms). Default: 600_000 (10 min) */
    stuckThresholdMs?: number;
    /** Maximum number of sessions to recover in a single sweep. Default: 10 */
    maxRetries?: number;
    /** If true, report what would be recovered without making changes. Default: false */
    dryRun?: boolean;
  },
): Promise<RecoveryResult> {
  const logger = pipelineDeps.logger;
  const stuckThresholdMs = options?.stuckThresholdMs ?? 600_000;
  const maxRetries = options?.maxRetries ?? 10;
  const dryRun = options?.dryRun ?? false;

  // --- Step 1: Find stuck sessions ---
  const stuckSessions = await findStuckSessions(sql, stuckThresholdMs);

  const result: RecoveryResult = {
    found: stuckSessions.length,
    retried: 0,
    errors: [],
  };

  if (stuckSessions.length === 0) {
    return result;
  }

  logger.info(
    { count: stuckSessions.length, dryRun },
    `Found ${stuckSessions.length} sessions needing recovery`,
  );

  // --- Step 2: Process each stuck session (up to maxRetries) ---
  const toProcess = stuckSessions.slice(0, maxRetries);

  for (const session of toProcess) {
    try {
      // Look up the session's transcript_s3_key to decide recovery strategy
      const rows = await sql`
        SELECT transcript_s3_key FROM sessions WHERE id = ${session.id}
      `;

      if (rows.length === 0) {
        // Session was deleted between findStuckSessions and now — skip
        continue;
      }

      const hasTranscript = !!rows[0].transcript_s3_key;

      if (dryRun) {
        // Report what we would do without modifying anything
        logger.info(
          { sessionId: session.id, hasTranscript, lifecycle: session.lifecycle },
          `[dry-run] Would ${hasTranscript ? "re-trigger pipeline" : "fail session"}`,
        );
        result.retried++;
        continue;
      }

      if (hasTranscript) {
        // Session has a transcript — re-trigger the pipeline.
        // First reset parse_status back to 'pending' so the pipeline can claim it.
        await sql`
          UPDATE sessions
          SET parse_status = 'pending', updated_at = now()
          WHERE id = ${session.id}
        `;

        // Fire-and-forget: pipeline runs asynchronously with its own error handling
        runSessionPipeline(pipelineDeps, session.id).catch((err) => {
          logger.error(
            { sessionId: session.id, error: err instanceof Error ? err.message : String(err) },
            "Recovery pipeline trigger failed",
          );
        });

        result.retried++;
        logger.info(
          { sessionId: session.id, lifecycle: session.lifecycle },
          "Re-triggered pipeline for stuck session",
        );
      } else {
        // No transcript available — mark as failed so it doesn't get picked up again
        await failSession(
          sql,
          session.id,
          "Recovery: no transcript_s3_key available for reprocessing",
        );

        result.retried++;
        logger.info(
          { sessionId: session.id },
          "Marked stuck session as failed (no transcript)",
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({ sessionId: session.id, error: errorMsg });
      logger.error(
        { sessionId: session.id, error: errorMsg },
        "Error recovering stuck session",
      );
    }
  }

  return result;
}
