/**
 * Handler for "session.start" events.
 *
 * When a Claude Code session begins, this handler inserts a new row into
 * the sessions table with lifecycle="detected". The session ID comes from
 * the event's data.cc_session_id (Claude Code's own session identifier).
 *
 * ON CONFLICT (id) DO NOTHING ensures idempotency — if the session row
 * already exists (e.g., event replayed), we silently skip.
 */

import type { EventHandlerContext } from "../event-processor.js";

/**
 * Handle a session.start event by inserting a session row.
 *
 * Extracts from event.data:
 *   - cc_session_id: used as the session primary key
 *   - git_branch: branch at session start
 *   - model: Claude model being used
 *   - source: how the session was initiated (startup/resume/clear/compact)
 *   - transcript_path: S3 key for the transcript blob
 */
export async function handleSessionStart(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Extract fields from the session.start payload
  const ccSessionId = event.data.cc_session_id as string;
  const gitBranch = (event.data.git_branch as string | null) ?? null;
  const model = (event.data.model as string | null) ?? null;
  const source = (event.data.source as string) ?? "startup";

  logger.info({ ccSessionId, gitBranch, model, source }, "Creating session row");

  // Insert session with lifecycle="detected" — the initial state.
  // Uses the CC session ID as the primary key so it can be looked up
  // by session.end events using the same ID.
  await sql`
    INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, git_branch, model, source, metadata)
    VALUES (
      ${ccSessionId},
      ${workspaceId},
      ${event.device_id},
      ${"detected"},
      ${event.timestamp},
      ${gitBranch},
      ${model},
      ${source},
      ${JSON.stringify({})}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}
