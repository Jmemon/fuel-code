/**
 * Session type definitions.
 *
 * A Session represents a single Claude Code interaction — from start to end.
 * Sessions are the primary unit of developer activity. They go through a
 * lifecycle from detection through parsing (transcript analysis) to summarization.
 */

/**
 * Session lifecycle states.
 * Progression: detected -> capturing -> ended -> parsed -> summarized -> archived
 * "failed" can occur at any stage.
 */
export type SessionLifecycle =
  | "detected"
  | "capturing"
  | "ended"
  | "parsed"
  | "summarized"
  | "archived"
  | "failed";

/**
 * Status of transcript parsing for this session.
 * Separate from lifecycle because parsing is an async background job.
 */
export type ParseStatus = "pending" | "parsing" | "completed" | "failed";

/**
 * Session interface — maps to the `sessions` Postgres table.
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
  /** Current transcript parse status */
  parse_status: ParseStatus;
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
  /** Arbitrary metadata */
  metadata: Record<string, unknown>;
}
