/**
 * GitActivity type definitions.
 *
 * Represents a processed git event (commit, push, checkout, merge) stored in
 * the `git_activity` table. Each row corresponds to a git operation captured
 * by fuel-code's git hook scripts and processed by git event handlers.
 *
 * The session_id is nullable — git activity outside an active Claude Code
 * session is stored as "orphan" workspace-level activity.
 */

/** The type of git operation */
export type GitActivityType = "commit" | "push" | "checkout" | "merge";

/**
 * GitActivity interface — maps to the `git_activity` Postgres table.
 */
export interface GitActivity {
  /** ULID primary key (same as the originating event ID) */
  id: string;
  /** Workspace this git activity belongs to */
  workspace_id: string;
  /** Device where this git operation occurred */
  device_id: string;
  /** Session this activity is correlated with (null for orphan events) */
  session_id: string | null;
  /** Type of git operation */
  type: GitActivityType;
  /** Branch name (null if not applicable) */
  branch: string | null;
  /** Commit SHA (null for non-commit operations) */
  commit_sha: string | null;
  /** Commit message (null for non-commit operations) */
  message: string | null;
  /** Number of files changed (null if not applicable) */
  files_changed: number | null;
  /** Lines inserted (null if not applicable) */
  insertions: number | null;
  /** Lines deleted (null if not applicable) */
  deletions: number | null;
  /** When the git operation occurred */
  timestamp: string;
  /** Additional structured data (e.g., push refs, checkout from/to) */
  data: Record<string, unknown>;
  /** When this row was created */
  created_at: string;
}
