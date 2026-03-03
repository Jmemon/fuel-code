/**
 * Handler for "session.end" events.
 *
 * Simplified lifecycle handler (Phase C):
 *   1. transitionSession(detected -> ended) with ended_at, end_reason, duration_ms
 *   2. On success: if transcript_s3_key already present, advance to transcript_ready
 *      and enqueue reconcile so the full pipeline runs automatically
 *   3. On "Session not found": create synthetic session at 'ended' (out-of-order arrival)
 *   4. On other failures: log and return
 *
 * No parse_status, no capturing state. The lifecycle itself encodes all
 * pipeline progress.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { transitionSession } from "../session-lifecycle.js";

/**
 * Handle a session.end event by transitioning the session lifecycle and
 * conditionally enqueuing reconcile if transcript is already present.
 *
 * Extracts from event.data:
 *   - cc_session_id: identifies which session to update
 *   - end_reason: why the session ended (exit/clear/logout/crash)
 *   - duration_ms: total session duration in milliseconds
 */
export async function handleSessionEnd(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

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

  // Transition detected -> ended with optimistic locking.
  // Only "detected" is a valid source state.
  const result = await transitionSession(
    sql,
    ccSessionId,
    ["detected"],
    "ended",
    {
      ended_at: event.timestamp,
      end_reason: endReason,
      duration_ms: durationMs,
    },
  );

  if (!result.success) {
    if (result.reason === "Session not found") {
      // Out-of-order: session.end arrived before session.start.
      // Create a synthetic session directly at 'ended' so that transcript
      // upload and reconcile can proceed once the transcript arrives.
      logger.warn({ ccSessionId }, "session.end: session not found, creating synthetic row at ended");

      const gitBranch = (event.data.git_branch as string | null) ?? null;
      const model = (event.data.model as string | null) ?? null;

      await sql`
        INSERT INTO sessions (
          id, workspace_id, device_id, lifecycle, started_at, ended_at,
          end_reason, duration_ms, git_branch, model, source, metadata
        ) VALUES (
          ${ccSessionId},
          ${workspaceId},
          ${event.device_id},
          ${"ended"},
          ${event.timestamp},
          ${event.timestamp},
          ${endReason},
          ${0},
          ${gitBranch},
          ${model},
          ${"backfill"},
          ${JSON.stringify({})}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    } else {
      // Any other failure (already ended, already further along, etc.) — log and bail.
      logger.warn(
        { ccSessionId, reason: result.reason },
        "session.end: lifecycle transition failed",
      );
      return;
    }
  }

  // Backfill events.session_id so this event appears in "events for session X"
  // queries. The event was inserted with session_id=null to avoid FK races.
  await sql`
    UPDATE events SET session_id = ${ccSessionId} WHERE id = ${event.id}
  `;

  // If transcript_s3_key is already present (e.g. backfill uploaded the
  // transcript before the session ended), advance to transcript_ready and
  // enqueue reconcile so the full pipeline kicks off automatically.
  if (ctx.pipelineDeps) {
    const session = await sql`
      SELECT transcript_s3_key FROM sessions WHERE id = ${ccSessionId}
    `;

    if (session[0]?.transcript_s3_key) {
      // Advance ended -> transcript_ready before enqueuing reconcile.
      // This lets reconcileSession skip the transcript_ready transition
      // and proceed directly to parsing.
      const trResult = await transitionSession(sql, ccSessionId, "ended", "transcript_ready");
      if (trResult.success) {
        logger.info({ ccSessionId }, "session.end: transcript already present, advanced to transcript_ready");
      } else {
        // Non-fatal: reconcileSession will handle the transition itself
        logger.debug(
          { ccSessionId, reason: trResult.reason },
          "session.end: transcript_ready transition skipped (reconcile will handle)",
        );
      }

      // Enqueue reconcile via the bounded queue (or direct fallback for tests)
      if (ctx.pipelineDeps.enqueueSession) {
        ctx.pipelineDeps.enqueueSession(ccSessionId);
      } else {
        const { reconcileSession } = await import("../reconcile/reconcile-session.js");
        reconcileSession(ctx.pipelineDeps, ccSessionId).catch((err) => {
          logger.error(
            { sessionId: ccSessionId, error: err instanceof Error ? err.message : String(err) },
            "session.end: reconcile trigger failed",
          );
        });
      }
    }
  }
}
