/**
 * Handler for "team.create" events.
 *
 * When a multi-agent team is created within a session, this handler:
 *   1. Inserts into teams (or updates on conflict by team_name)
 *   2. Updates the session row to record team_name and team_role='lead'
 *
 * The session that creates the team is always the lead.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a team.create event by inserting the team and marking the session as lead.
 *
 * Extracts from event.data:
 *   - session_id: CC session that created this team
 *   - team_name: name of the team
 *   - description: optional human-readable description
 */
export async function handleTeamCreate(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const teamName = event.data.team_name as string;
  const description = (event.data.description as string | undefined) ?? null;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "team.create: session not found, skipping");
    return;
  }

  const id = generateId();

  logger.info({ id, sessionId: session.id, teamName }, "Creating team");

  // Insert team — upsert on team_name so duplicate events are idempotent
  await sql`
    INSERT INTO teams (id, team_name, description, lead_session_id, created_at, metadata)
    VALUES (
      ${id},
      ${teamName},
      ${description},
      ${session.id},
      ${event.timestamp},
      ${JSON.stringify({})}
    )
    ON CONFLICT (team_name) DO UPDATE SET
      description = COALESCE(EXCLUDED.description, teams.description),
      lead_session_id = COALESCE(EXCLUDED.lead_session_id, teams.lead_session_id)
  `;

  // Mark this session as the team lead
  await sql`
    UPDATE sessions
    SET team_name = ${teamName}, team_role = ${"lead"}
    WHERE id = ${session.id}
  `;
}
