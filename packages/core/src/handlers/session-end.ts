/**
 * Handler for "session.end" events.
 *
 * When a Claude Code session terminates, this handler updates the existing
 * session row to lifecycle="ended" and fills in ended_at, end_reason, and
 * duration_ms.
 *
 * The WHERE clause restricts updates to sessions in "detected" or "capturing"
 * states — sessions that have already ended or progressed further won't be
 * regressed. If no rows are updated, a warning is logged (likely the session
 * was never started or already ended).
 */

import type { EventHandlerContext } from "../event-processor.js";

/**
 * Handle a session.end event by updating the session row.
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
  const durationMs = event.data.duration_ms as number;

  logger.info({ ccSessionId, endReason, durationMs }, "Ending session");

  // Update the session row — only if it's in a state that can be ended.
  // "detected" and "capturing" are the valid pre-end states.
  const result = await sql`
    UPDATE sessions
    SET lifecycle = 'ended',
        ended_at = ${event.timestamp},
        end_reason = ${endReason},
        duration_ms = ${durationMs},
        updated_at = now()
    WHERE id = ${ccSessionId}
      AND lifecycle IN ('detected', 'capturing')
  `;

  // result.count is the number of rows affected by the UPDATE.
  // If 0, the session either doesn't exist or was already in a terminal state.
  if (result.count === 0) {
    logger.warn(
      { ccSessionId },
      "No session updated — session may not exist or was already ended",
    );
  }
}
