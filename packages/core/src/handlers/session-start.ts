/**
 * Handler for "session.start" events.
 *
 * When a Claude Code session begins, this handler inserts a new row into
 * the sessions table with lifecycle="detected". The session ID comes from
 * the event's data.cc_session_id (Claude Code's own session identifier).
 *
 * After creating the session row, checks whether git hooks should be
 * prompted for this workspace+device pair (Task 4: auto-prompt).
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

  // After session creation, check if we should flag this workspace+device
  // for a git hooks installation prompt (Task 4).
  await checkGitHooksPrompt(ctx);
}

/**
 * Check whether we should flag this workspace+device pair for a git hooks
 * installation prompt.
 *
 * Conditions for setting the flag:
 *   1. Workspace is NOT _unassociated (it looks like a git repo)
 *   2. Git hooks are NOT already installed for this workspace+device
 *   3. User has NOT already been prompted (declined or accepted previously)
 *
 * If all conditions are met, sets pending_git_hooks_prompt=true so the CLI
 * can pick it up on the next interactive command.
 */
async function checkGitHooksPrompt(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, workspaceId, logger } = ctx;

  // Only prompt for workspaces that look like git repos.
  // canonical_id="_unassociated" means no git remote was detected,
  // so there's no point prompting for git hooks.
  const workspace = await sql`
    SELECT canonical_id FROM workspaces WHERE id = ${workspaceId}
  `;
  if (!workspace[0]) return;
  const canonicalId = workspace[0].canonical_id as string;
  if (canonicalId === "_unassociated") return;

  // Check whether git hooks are already installed or user was already prompted
  // for this specific workspace+device combination.
  const wd = await sql`
    SELECT git_hooks_installed, git_hooks_prompted
    FROM workspace_devices
    WHERE workspace_id = ${workspaceId} AND device_id = ${event.device_id}
  `;

  if (!wd[0]) return;
  if (wd[0].git_hooks_installed) return;
  if (wd[0].git_hooks_prompted) return;

  // All conditions met — flag for prompting on the next interactive CLI session
  await sql`
    UPDATE workspace_devices
    SET pending_git_hooks_prompt = true, last_active_at = now()
    WHERE workspace_id = ${workspaceId} AND device_id = ${event.device_id}
  `;

  logger.debug({ workspaceId, deviceId: event.device_id }, "Flagged workspace for git hooks prompt");
}
