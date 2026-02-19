/**
 * Handler for "git.commit" events.
 *
 * When a git commit is made (detected by the post-commit hook), this handler:
 *   1. Correlates the event to an active CC session (if any)
 *   2. Inserts a row into git_activity with type='commit'
 *   3. If correlation found, updates events.session_id for the event row
 *
 * ON CONFLICT (id) DO NOTHING ensures idempotency — replayed events are skipped.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { correlateGitEventToSession } from "../git-correlator.js";

/**
 * Handle a git.commit event by inserting git activity and correlating with a session.
 *
 * Extracts from event.data:
 *   - hash: commit SHA
 *   - message: commit message
 *   - author_name, author_email: commit author info
 *   - branch: branch the commit was made on
 *   - files_changed, insertions, deletions: diff stats
 *   - file_list: optional list of changed files
 */
export async function handleGitCommit(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Extract fields from the git.commit payload
  const hash = event.data.hash as string;
  const message = event.data.message as string;
  const authorName = event.data.author_name as string;
  const authorEmail = (event.data.author_email as string | undefined) ?? null;
  const branch = event.data.branch as string;
  const filesChanged = event.data.files_changed as number;
  const insertions = event.data.insertions as number;
  const deletions = event.data.deletions as number;
  const fileList = event.data.file_list ?? null;

  // Correlate this git event to an active CC session
  const correlation = await correlateGitEventToSession(
    sql,
    workspaceId,
    event.device_id,
    new Date(event.timestamp),
  );

  logger.info(
    { hash, branch, sessionId: correlation.sessionId, confidence: correlation.confidence },
    "Processing git.commit event",
  );

  // Wrap INSERT + UPDATE in a transaction so both succeed or both roll back.
  // Prevents inconsistent state where git_activity has session_id but events doesn't.
  await sql.begin(async (tx) => {
    // Insert into git_activity — stores the structured git data
    // data JSONB holds author info and file list for detailed queries
    await tx`
      INSERT INTO git_activity (id, workspace_id, device_id, session_id, type, branch, commit_sha, message, files_changed, insertions, deletions, timestamp, data)
      VALUES (
        ${event.id},
        ${workspaceId},
        ${event.device_id},
        ${correlation.sessionId},
        ${"commit"},
        ${branch},
        ${hash},
        ${message},
        ${filesChanged},
        ${insertions},
        ${deletions},
        ${event.timestamp},
        ${JSON.stringify({ author_name: authorName, author_email: authorEmail, file_list: fileList })}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // If we found an active session, update the event row's session_id
    // so it appears in the session's event timeline
    if (correlation.sessionId) {
      await tx`
        UPDATE events SET session_id = ${correlation.sessionId}
        WHERE id = ${event.id} AND session_id IS NULL
      `;
    }
  });
}
