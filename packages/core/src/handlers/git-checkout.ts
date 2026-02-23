/**
 * Handler for "git.checkout" events.
 *
 * When a git checkout/switch occurs (detected by the post-checkout hook), this handler:
 *   1. Correlates the event to an active CC session (if any)
 *   2. Inserts a row into git_activity with type='checkout'
 *   3. If correlation found, updates events.session_id for the event row
 *
 * For the branch field, we prefer to_branch (the destination branch name).
 * If to_branch is null (detached HEAD), we fall back to to_ref (the commit SHA).
 *
 * ON CONFLICT (id) DO NOTHING ensures idempotency — replayed events are skipped.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { correlateGitEventToSession } from "../git-correlator.js";

/**
 * Handle a git.checkout event by inserting git activity and correlating with a session.
 *
 * Extracts from event.data:
 *   - from_ref: source commit SHA
 *   - to_ref: destination commit SHA
 *   - from_branch: source branch name (null if detached)
 *   - to_branch: destination branch name (null if detached HEAD)
 */
export async function handleGitCheckout(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Extract fields from the git.checkout payload
  const fromRef = event.data.from_ref as string;
  const toRef = event.data.to_ref as string;
  const fromBranch = (event.data.from_branch as string | null) ?? null;
  const toBranch = (event.data.to_branch as string | null) ?? null;

  // Use to_branch as the branch field; fall back to to_ref for detached HEAD
  const branch = toBranch ?? toRef;

  // Correlate this git event to an active CC session
  const correlation = await correlateGitEventToSession(
    sql,
    workspaceId,
    event.device_id,
    new Date(event.timestamp),
  );

  logger.info(
    { fromBranch, toBranch, branch, sessionId: correlation.sessionId },
    "Processing git.checkout event",
  );

  // Wrap INSERT + UPDATE in a transaction so both succeed or both roll back.
  // Prevents inconsistent state where git_activity has session_id but events doesn't.
  // tx typed as any: postgres.js TransactionSql loses call signature via Omit (TS 5.9)
  await sql.begin(async (tx: any) => {
    // Insert into git_activity — checkout events store ref details in data JSONB
    await tx`
      INSERT INTO git_activity (id, workspace_id, device_id, session_id, type, branch, timestamp, data)
      VALUES (
        ${event.id},
        ${workspaceId},
        ${event.device_id},
        ${correlation.sessionId},
        ${"checkout"},
        ${branch},
        ${event.timestamp},
        ${JSON.stringify({ from_ref: fromRef, to_ref: toRef, from_branch: fromBranch, to_branch: toBranch })}
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
