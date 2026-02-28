/**
 * Handler for "worktree.remove" events.
 *
 * When a git worktree is removed after use, this handler updates the
 * matching session_worktrees row with removed_at and had_changes. If no
 * matching create row exists (remove arrived before create, or create was
 * missed), inserts a complete row with both created_at and removed_at so
 * no data is lost.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a worktree.remove event by updating or inserting a session_worktrees row.
 *
 * Extracts from event.data:
 *   - session_id: CC session that removed this worktree
 *   - worktree_name: name of the worktree being removed (optional)
 *   - had_changes: whether the worktree had uncommitted changes (optional)
 */
export async function handleWorktreeRemove(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const worktreeName = (event.data.worktree_name as string | undefined) ?? null;
  const hadChanges = (event.data.had_changes as boolean | undefined) ?? null;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "worktree.remove: session not found, skipping");
    return;
  }

  logger.info({ sessionId: session.id, worktreeName, hadChanges }, "Recording worktree removal");

  // Try to update the existing worktree row by (session_id, worktree_name)
  const updated = await sql`
    UPDATE session_worktrees
    SET removed_at = ${event.timestamp},
        had_changes = ${hadChanges}
    WHERE session_id = ${session.id}
      AND worktree_name = ${worktreeName}
      AND removed_at IS NULL
    RETURNING id
  `;

  // If no matching create row found, insert a complete row with both timestamps
  if (updated.length === 0) {
    const id = generateId();
    logger.info({ id, sessionId: session.id, worktreeName }, "worktree.remove: no create row found, inserting complete worktree record");

    await sql`
      INSERT INTO session_worktrees (id, session_id, worktree_name, created_at, removed_at, had_changes, metadata)
      VALUES (
        ${id},
        ${session.id},
        ${worktreeName},
        ${event.timestamp},
        ${event.timestamp},
        ${hadChanges},
        ${JSON.stringify({})}
      )
    `;
  }
}
