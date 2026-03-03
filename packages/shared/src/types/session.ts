/**
 * Session type definitions.
 *
 * A Session represents a single Claude Code interaction — from start to end.
 * Sessions are the primary unit of developer activity. They go through a
 * lifecycle from detection through parsing (transcript analysis) to summarization.
 */

import type { Subagent } from './subagent.js';
import type { SessionSkill } from './skill.js';
import type { SessionWorktree } from './worktree.js';
import type { Team } from './team.js';
import type { Teammate } from './teammate.js';

/**
 * Session lifecycle states — unified progression through the pipeline.
 *
 * Progression: detected -> ended -> transcript_ready -> parsed -> summarized -> complete
 * "failed" can occur at any stage.
 *
 * Key changes from prior design:
 *   - Removed "capturing" (no longer needed; detection is instantaneous)
 *   - Removed "archived" (replaced by "complete" as the terminal success state)
 *   - Added "transcript_ready" between "ended" and "parsed" to represent
 *     the moment the transcript is uploaded to S3 and ready for parsing
 */
export type SessionLifecycle =
  | "detected"
  | "ended"
  | "transcript_ready"
  | "parsed"
  | "summarized"
  | "complete"
  | "failed";

/**
 * Session interface — maps to the `sessions` Postgres table.
 *
 * Changes from prior version:
 *   - Dropped `parse_status` and `parse_error` — lifecycle now subsumes parse tracking.
 *   - Dropped `team_name` and `team_role` — replaced by the `teammates` join from
 *     the new teammates table (session-scoped team membership).
 *   - Added `last_error` — stores the most recent error message when lifecycle is "failed".
 *   - Added `teammates` — optional joined data from the teammates table.
 */
export interface Session {
  /** ULID primary key */
  id: string;
  /** Workspace this session belongs to */
  workspace_id: string;
  /** Device that ran this session */
  device_id: string;
  /** Claude Code's own session identifier (from CC internals) */
  cc_session_id: string;
  /** Current lifecycle state */
  lifecycle: SessionLifecycle;
  /** Working directory where the session ran */
  cwd: string;
  /** Git branch at session start (null if not in a git repo) */
  git_branch: string | null;
  /** Normalized git remote URL (null if not in a git repo) */
  git_remote: string | null;
  /** Claude model used in this session (null if unknown) */
  model: string | null;
  /** Duration of the session in milliseconds (null if still active) */
  duration_ms: number | null;
  /** S3 key for the raw transcript blob (null if not yet uploaded) */
  transcript_path: string | null;
  /** When the session started */
  started_at: string;
  /** When the session ended (null if still active) */
  ended_at: string | null;
  /** Most recent error message (populated when lifecycle is "failed") */
  last_error: string | null;
  /** Arbitrary metadata */
  metadata: Record<string, unknown>;

  // -- Phase 4-2: session chain, permission mode --

  /** ID of the session this one was resumed from (session chaining) */
  resumed_from_session_id?: string;
  /** Permission mode the session ran under (e.g. "plan", "auto-edit") */
  permission_mode?: string;

  // -- Joined data (populated by detail queries, not stored inline) --

  /** Subagents spawned during this session */
  subagents?: Subagent[];
  /** Skills invoked during this session */
  skills?: SessionSkill[];
  /** Worktrees created during this session */
  worktrees?: SessionWorktree[];
  /** Team this session is a member of */
  team?: Team;
  /** Teammates in this session's team (session-scoped membership) */
  teammates?: Teammate[];
  /** The session this one was resumed from */
  resumed_from?: { id: string; started_at: string; initial_prompt?: string };
  /** Sessions that resumed from this one */
  resumed_by?: { id: string; started_at: string; initial_prompt?: string }[];
}
