/**
 * Handler for "skill.invoke" events.
 *
 * When a skill (slash command like /commit, /review-pr) is invoked during
 * a session, this handler inserts a row into session_skills. No upsert
 * needed — each invocation is a distinct record.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a skill.invoke event by inserting a session_skills row.
 *
 * Extracts from event.data:
 *   - session_id: CC session the skill was invoked in
 *   - skill_name: name of the invoked skill (e.g., "commit")
 *   - args: raw argument string (optional)
 *   - invoked_by: who triggered the skill (optional)
 */
export async function handleSkillInvoke(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const skillName = event.data.skill_name as string;
  const args = (event.data.args as string | undefined) ?? null;
  const invokedBy = (event.data.invoked_by as string | undefined) ?? null;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "skill.invoke: session not found, skipping");
    return;
  }

  const id = generateId();

  logger.info({ id, sessionId: session.id, skillName, invokedBy }, "Recording skill invocation");

  await sql`
    INSERT INTO session_skills (id, session_id, skill_name, invoked_at, invoked_by, args, metadata)
    VALUES (
      ${id},
      ${session.id},
      ${skillName},
      ${event.timestamp},
      ${invokedBy},
      ${args},
      ${JSON.stringify({})}
    )
  `;
}
