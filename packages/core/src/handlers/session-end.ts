/**
 * Handler for "session.end" events.
 *
 * When a Claude Code session terminates, this handler:
 *   1. Uses transitionSession (with optimistic locking) to move the session
 *      from detected/capturing -> ended, setting ended_at, end_reason, duration_ms.
 *   2. If pipelineDeps are available AND the session already has a transcript_s3_key
 *      (backfill path), triggers the post-processing pipeline asynchronously.
 *
 * The WHERE clause (via transitionSession) restricts updates to sessions in
 * "detected" or "capturing" states -- sessions that have already ended or
 * progressed further won't be regressed.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { transitionSession } from "../session-lifecycle.js";

/**
 * Handle a session.end event by transitioning the session lifecycle and
 * optionally triggering the post-processing pipeline.
 *
 * Extracts from event.data:
 *   - cc_session_id: identifies which session to update
 *   - end_reason: why the session ended (exit/clear/logout/crash)
 *   - duration_ms: total session duration in milliseconds
 */
export async function handleSessionEnd(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  // Extract fields from the session.end payload
  const ccSessionId = event.data.cc_session_id as string;
  const endReason = event.data.end_reason as string;
  let durationMs = event.data.duration_ms as number;

  // When duration_ms is 0 or missing (e.g. hooks send 0 because they don't
  // know the real duration), compute it from the session's started_at and
  // the event timestamp (which represents ended_at).
  if (!durationMs || durationMs <= 0) {
    const sessionRow = await sql`
      SELECT started_at FROM sessions WHERE id = ${ccSessionId}
    `;
    if (sessionRow.length > 0 && sessionRow[0].started_at) {
      const startedAt = new Date(sessionRow[0].started_at).getTime();
      const endedAt = new Date(event.timestamp).getTime();
      if (!isNaN(startedAt) && !isNaN(endedAt)) {
        durationMs = Math.max(0, endedAt - startedAt);
      }
    }
  }

  logger.info({ ccSessionId, endReason, durationMs }, "Ending session");

  // Use transitionSession with optimistic locking instead of raw SQL.
  // Accepts both "detected" and "capturing" as valid source states.
  const result = await transitionSession(
    sql,
    ccSessionId,
    ["detected", "capturing"],
    "ended",
    {
      ended_at: event.timestamp,
      end_reason: endReason,
      duration_ms: durationMs,
    },
  );

  if (!result.success) {
    logger.warn(
      { ccSessionId, reason: result.reason },
      "session.end: lifecycle transition failed",
    );
    return;
  }

  // Phase 2: If pipeline deps are available, check if transcript_s3_key is
  // already set (backfill path — transcript was uploaded before session ended).
  // If so, trigger the pipeline via the bounded queue (or direct fallback).
  if (ctx.pipelineDeps) {
    const session = await sql`
      SELECT transcript_s3_key FROM sessions WHERE id = ${ccSessionId}
    `;

    if (session[0]?.transcript_s3_key) {
      if (ctx.pipelineDeps.enqueueSession) {
        ctx.pipelineDeps.enqueueSession(ccSessionId);
      } else {
        // Fallback for tests without queue: dynamic import to avoid circular dep
        const { runSessionPipeline } = await import("../session-pipeline.js");
        runSessionPipeline(ctx.pipelineDeps, ccSessionId).catch((err) => {
          logger.error(
            { sessionId: ccSessionId, error: err instanceof Error ? err.message : String(err) },
            "session.end: pipeline trigger failed",
          );
        });
      }
    }
  }
}
