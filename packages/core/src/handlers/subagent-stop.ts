/**
 * Handler for "subagent.stop" events.
 *
 * When a sub-agent finishes execution, this handler updates the subagent row
 * to status='completed' and sets ended_at. If the stop event arrives before
 * the start event (out-of-order delivery), inserts a complete row with
 * status='completed' so no data is lost.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a subagent.stop event by completing the subagent row.
 *
 * Extracts from event.data:
 *   - session_id: CC session that owns this agent
 *   - agent_id: unique ID for the sub-agent instance
 *   - agent_type: type of agent
 *   - agent_transcript_path: S3 path to the sub-agent's transcript (optional)
 */
export async function handleSubagentStop(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const agentId = event.data.agent_id as string;
  const agentType = event.data.agent_type as string;
  const transcriptPath = (event.data.agent_transcript_path as string | undefined) ?? null;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "subagent.stop: session not found, skipping");
    return;
  }

  logger.info({ sessionId: session.id, agentId, agentType }, "Completing subagent");

  // Try to update the existing subagent row first
  const updated = await sql`
    UPDATE subagents
    SET status = ${"completed"},
        ended_at = ${event.timestamp},
        transcript_s3_key = COALESCE(${transcriptPath}, transcript_s3_key)
    WHERE session_id = ${session.id} AND agent_id = ${agentId}
    RETURNING id
  `;

  // If no row was found (stop arrived before start), insert a complete row
  if (updated.length === 0) {
    const id = generateId();
    logger.info({ id, sessionId: session.id, agentId }, "subagent.stop: no start row found, inserting completed subagent");

    await sql`
      INSERT INTO subagents (id, session_id, agent_id, agent_type, status, started_at, ended_at, transcript_s3_key, metadata)
      VALUES (
        ${id},
        ${session.id},
        ${agentId},
        ${agentType},
        ${"completed"},
        ${event.timestamp},
        ${event.timestamp},
        ${transcriptPath},
        ${JSON.stringify({})}
      )
      ON CONFLICT (session_id, agent_id) DO UPDATE SET
        status = ${"completed"},
        ended_at = EXCLUDED.ended_at,
        transcript_s3_key = COALESCE(EXCLUDED.transcript_s3_key, subagents.transcript_s3_key)
    `;
  }
}
