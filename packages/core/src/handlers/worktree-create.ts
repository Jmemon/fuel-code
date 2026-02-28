/**
 * Handler for "worktree.create" events.
 *
 * When a git worktree is created for isolated parallel work within a session,
 * this handler inserts a row into session_worktrees tracking its creation.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a worktree.create event by inserting a session_worktrees row.
 *
 * Extracts from event.data:
 *   - session_id: CC session that created this worktree
 *   - worktree_name: name of the worktree (optional, may be auto-generated)
 *   - branch: branch created for/in the worktree (optional)
 */
export async function handleWorktreeCreate(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const worktreeName = (event.data.worktree_name as string | undefined) ?? null;
  const branch = (event.data.branch as string | undefined) ?? null;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "worktree.create: session not found, skipping");
    return;
  }

  const id = generateId();

  logger.info({ id, sessionId: session.id, worktreeName, branch }, "Recording worktree creation");

  await sql`
    INSERT INTO session_worktrees (id, session_id, worktree_name, branch, created_at, metadata)
    VALUES (
      ${id},
      ${session.id},
      ${worktreeName},
      ${branch},
      ${event.timestamp},
      ${JSON.stringify({})}
    )
  `;
}
