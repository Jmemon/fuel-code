/**
 * Teammate type definitions.
 *
 * A Teammate represents a participant in a multi-agent team session.
 * Unlike the old team_name/team_role columns on sessions, teammates are
 * stored in their own table and linked to both a team and a session.
 * This allows richer per-participant metadata (color, summary, CC teammate ID).
 */

import type { TranscriptMessage } from './transcript.js';

/**
 * Teammate interface — maps to the `teammates` Postgres table.
 * Represents a single participant in a multi-agent team.
 */
export interface Teammate {
  /** ULID primary key */
  id: string;
  /** Team this teammate belongs to */
  team_id: string;
  /** Session this teammate participated in */
  session_id: string;
  /** Display name for this teammate (e.g. "researcher", "coder") */
  name: string;
  /** Claude Code's internal teammate identifier (null if unknown) */
  cc_teammate_id: string | null;
  /** Display color for UI rendering (hex string, null if unset) */
  color: string | null;
  /** LLM-generated summary of this teammate's contribution (null if not yet summarized) */
  summary: string | null;
  /** When this teammate record was created */
  created_at: string;
  /** Arbitrary metadata */
  metadata: Record<string, unknown>;
}

/**
 * TeammateDetail extends Teammate with the parent team's name and
 * optionally the transcript messages attributed to this teammate.
 * Used for detail views that need the full teammate context.
 */
export interface TeammateDetail extends Teammate {
  /** Name of the team this teammate belongs to (denormalized for display) */
  team_name: string;
  /** Transcript messages attributed to this teammate (populated on detail queries) */
  messages?: TranscriptMessage[];
}

/**
 * TeammateSummary is a lightweight projection of a teammate for list views.
 * Contains only the fields needed for rendering a teammate in a summary context.
 */
export interface TeammateSummary {
  /** Teammate primary key */
  id: string;
  /** Display name */
  name: string;
  /** Display color (hex string, null if unset) */
  color: string | null;
  /** LLM-generated summary of contribution (null if not yet summarized) */
  summary: string | null;
}
