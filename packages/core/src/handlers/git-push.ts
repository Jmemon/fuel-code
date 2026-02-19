/**
 * Handler for "git.push" events.
 *
 * When a git push is performed (detected by the pre-push hook), this handler:
 *   1. Correlates the event to an active CC session (if any)
 *   2. Inserts a row into git_activity with type='push'
 *   3. If correlation found, updates events.session_id for the event row
 *
 * ON CONFLICT (id) DO NOTHING ensures idempotency — replayed events are skipped.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { correlateGitEventToSession } from "../git-correlator.js";

/**
 * Handle a git.push event by inserting git activity and correlating with a session.
 *
 * Extracts from event.data:
 *   - branch: branch being pushed
 *   - remote: remote name (e.g., "origin")
 *   - commit_count: number of commits being pushed
 *   - commits: optional list of commit hashes
 */
export async function handleGitPush(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Extract fields from the git.push payload
  const branch = event.data.branch as string;
  const remote = event.data.remote as string;
  const commitCount = event.data.commit_count as number;
  const commits = event.data.commits ?? null;

  // Correlate this git event to an active CC session
  const correlation = await correlateGitEventToSession(
    sql,
    workspaceId,
    event.device_id,
    new Date(event.timestamp),
  );

  logger.info(
    { branch, remote, commitCount, sessionId: correlation.sessionId },
    "Processing git.push event",
  );

  // Wrap INSERT + UPDATE in a transaction so both succeed or both roll back.
  // Prevents inconsistent state where git_activity has session_id but events doesn't.
  await sql.begin(async (tx) => {
    // Insert into git_activity — push events store remote/commit info in data JSONB
    await tx`
      INSERT INTO git_activity (id, workspace_id, device_id, session_id, type, branch, timestamp, data)
      VALUES (
        ${event.id},
        ${workspaceId},
        ${event.device_id},
        ${correlation.sessionId},
        ${"push"},
        ${branch},
        ${event.timestamp},
        ${JSON.stringify({ remote, commit_count: commitCount, commits })}
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
