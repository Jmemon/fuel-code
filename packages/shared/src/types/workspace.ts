/**
 * Workspace type definitions.
 *
 * A Workspace maps to a single code repository. It's identified by a
 * canonical_id derived from the git remote URL (or a fallback hash).
 * This is the primary grouping for events, sessions, and analytics.
 */

/**
 * Sentinel value for events that can't be associated with a git repo
 * (e.g., running Claude Code outside a git directory).
 */
export const UNASSOCIATED_WORKSPACE = "_unassociated" as const;

/**
 * Workspace interface — maps to the `workspaces` Postgres table.
 */
export interface Workspace {
  /** ULID primary key */
  id: string;
  /**
   * Normalized identifier derived from the git remote URL.
   * Examples: "github.com/user/repo", "local:<sha256>", "_unassociated"
   */
  canonical_id: string;
  /** Human-readable name, usually the repo name */
  display_name: string;
  /** Default branch for this repo (null if unknown) */
  default_branch: string | null;
  /** Arbitrary metadata (e.g., language, framework detection results) */
  metadata: Record<string, unknown>;
  /** When this workspace was first observed */
  first_seen_at: string;
  /** Last time any data for this workspace was updated */
  updated_at: string;
}
