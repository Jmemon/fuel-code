/**
 * Team type definitions.
 *
 * A Team represents a multi-agent coordination group within a session.
 * Teams are now session-scoped: each team record is tied to a specific session,
 * and participants are tracked via the `teammates` table rather than as
 * subagent references.
 *
 * Changes from prior version:
 *   - Added `session_id` — teams are session-scoped, not global
 *   - Removed `lead_session_id` — leadership is implicit in the session graph
 *   - Removed `members?: Subagent[]` — replaced by `teammates?: Teammate[]`
 *   - Added `teammates?` — optional joined data from the teammates table
 */

import type { Teammate } from './teammate.js';

export interface Team {
  /** ULID primary key */
  id: string;
  /** Session this team belongs to */
  session_id: string;
  /** Display name for the team (e.g. "research-team") */
  team_name: string;
  /** Optional description of the team's purpose */
  description?: string;
  /** When the team record was created */
  created_at: string;
  /** When the team ended (null if still active) */
  ended_at?: string;
  /** Number of teammates in this team */
  member_count: number;
  /** Teammates in this team (populated by detail queries) */
  teammates?: Teammate[];
  /** Arbitrary metadata */
  metadata: Record<string, unknown>;
}
