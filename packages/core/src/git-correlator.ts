/**
 * Git-session correlator — finds the active Claude Code session for a git event.
 *
 * When a git hook fires (commit, push, checkout, merge), we want to link that
 * git activity to the CC session that was active at the time. This enables
 * "what did I commit during this session?" views.
 *
 * Correlation heuristic: find the most recently started session for the same
 * workspace + device that is currently active (lifecycle = 'detected' or 'capturing').
 * The event timestamp must be >= session started_at to avoid false matches.
 *
 * If no active session is found, the git event is recorded as "orphan" workspace-level
 * activity (session_id = NULL in git_activity).
 */

import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of attempting to correlate a git event with a CC session */
export interface CorrelationResult {
  /** Session ID if a match was found, null otherwise */
  sessionId: string | null;
  /** Confidence level: 'active' if matched to a live session, 'none' if orphan */
  confidence: "active" | "none";
}

// ---------------------------------------------------------------------------
// Correlator
// ---------------------------------------------------------------------------

/**
 * Find the active Claude Code session for a git event.
 *
 * Queries sessions that are currently active (detected or capturing) for the
 * same workspace and device, and started before the git event occurred.
 * Returns the most recently started session if multiple are active.
 *
 * @param sql - postgres.js tagged template client
 * @param workspaceId - Resolved workspace ULID
 * @param deviceId - Device ID that produced the git event
 * @param eventTimestamp - When the git event occurred
 * @returns CorrelationResult with sessionId and confidence level
 */
export async function correlateGitEventToSession(
  sql: Sql,
  workspaceId: string,
  deviceId: string,
  eventTimestamp: Date,
): Promise<CorrelationResult> {
  const rows = await sql`
    SELECT id FROM sessions
    WHERE workspace_id = ${workspaceId}
      AND device_id = ${deviceId}
      AND lifecycle IN ('detected', 'capturing')
      AND started_at <= ${eventTimestamp.toISOString()}
    ORDER BY started_at DESC
    LIMIT 1
  `;

  if (rows.length > 0) {
    return { sessionId: rows[0].id as string, confidence: "active" };
  }

  return { sessionId: null, confidence: "none" };
}
