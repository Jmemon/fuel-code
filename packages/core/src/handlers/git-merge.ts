/**
 * Handler for "git.merge" events.
 *
 * When a git merge completes (detected by the post-merge hook), this handler:
 *   1. Correlates the event to an active CC session (if any)
 *   2. Inserts a row into git_activity with type='merge'
 *   3. If correlation found, updates events.session_id for the event row
 *
 * ON CONFLICT (id) DO NOTHING ensures idempotency — replayed events are skipped.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { correlateGitEventToSession } from "../git-correlator.js";

/**
 * Handle a git.merge event by inserting git activity and correlating with a session.
 *
 * Extracts from event.data:
 *   - merge_commit: merge commit hash
 *   - message: merge commit message
 *   - merged_branch: branch that was merged in
 *   - into_branch: branch that received the merge
 *   - files_changed: number of files changed by the merge
 *   - had_conflicts: whether the merge had conflicts
 */
export async function handleGitMerge(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Extract fields from the git.merge payload
  const mergeCommit = event.data.merge_commit as string;
  const message = event.data.message as string;
  const mergedBranch = event.data.merged_branch as string;
  const intoBranch = event.data.into_branch as string;
  const filesChanged = event.data.files_changed as number;
  const hadConflicts = event.data.had_conflicts as boolean;

  // Correlate this git event to an active CC session
  const correlation = await correlateGitEventToSession(
    sql,
    workspaceId,
    event.device_id,
    new Date(event.timestamp),
  );

  logger.info(
    { mergedBranch, intoBranch, mergeCommit, sessionId: correlation.sessionId },
    "Processing git.merge event",
  );

  // Wrap INSERT + UPDATE in a transaction so both succeed or both roll back.
  // Prevents inconsistent state where git_activity has session_id but events doesn't.
  // tx typed as any: postgres.js TransactionSql loses call signature via Omit (TS 5.9)
  await sql.begin(async (tx: any) => {
    // Insert into git_activity — merge events store branch/conflict info in data JSONB
    await tx`
      INSERT INTO git_activity (id, workspace_id, device_id, session_id, type, branch, commit_sha, message, files_changed, timestamp, data)
      VALUES (
        ${event.id},
        ${workspaceId},
        ${event.device_id},
        ${correlation.sessionId},
        ${"merge"},
        ${intoBranch},
        ${mergeCommit},
        ${message},
        ${filesChanged},
        ${event.timestamp},
        ${JSON.stringify({ merged_branch: mergedBranch, had_conflicts: hadConflicts })}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // If we found an active session, update the event row's session_id
    if (correlation.sessionId) {
      await tx`
        UPDATE events SET session_id = ${correlation.sessionId}
        WHERE id = ${event.id} AND session_id IS NULL
      `;
    }
  });
}
