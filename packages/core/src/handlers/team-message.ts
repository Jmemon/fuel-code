/**
 * Handler for "team.message" events.
 *
 * When agents within a team exchange messages, this handler increments
 * the message count in the team's metadata JSONB column. If the team
 * row doesn't exist yet (message arrived before team.create), logs a
 * warning and skips — we don't create teams implicitly.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a team.message event by incrementing the team's message counter.
 *
 * Extracts from event.data:
 *   - session_id: CC session the message was sent within
 *   - team_name: team the message belongs to
 *   - message_type: type of message (task, result, status, etc.)
 *   - from: sender agent ID or name (optional)
 *   - to: recipient agent ID or name (optional)
 */
export async function handleTeamMessage(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const teamName = event.data.team_name as string;
  const messageType = event.data.message_type as string;
  const from = (event.data.from as string | undefined) ?? null;
  const to = (event.data.to as string | undefined) ?? null;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "team.message: session not found, skipping");
    return;
  }

  logger.info({ sessionId: session.id, teamName, messageType, from, to }, "Processing team message");

  // Find the team and increment the message_count in metadata JSONB.
  // Uses jsonb_set to atomically increment without a read-modify-write cycle.
  // The COALESCE handles the case where message_count doesn't exist yet in metadata.
  const updated = await sql`
    UPDATE teams
    SET metadata = jsonb_set(
      metadata,
      '{message_count}',
      to_jsonb(COALESCE((metadata->>'message_count')::int, 0) + 1)
    )
    WHERE team_name = ${teamName}
    RETURNING id
  `;

  if (updated.length === 0) {
    logger.warn({ teamName }, "team.message: team not found, skipping");
  }
}
