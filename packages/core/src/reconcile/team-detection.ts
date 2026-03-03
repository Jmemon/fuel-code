/**
 * Team detection — Extract team intervals from parsed content blocks.
 *
 * Scans for TeamCreate and TeamDelete tool_use blocks to build time-bounded
 * team intervals. Each interval represents a team's existence within a session,
 * from creation to deletion (or end-of-session if never deleted).
 *
 * The intervals are then persisted to the `teams` table, keyed by
 * (session_id, team_name, created_at) to support idempotent reparse.
 */

import type { Sql } from "postgres";
import type { ParsedContentBlock, TranscriptMessage } from "@fuel-code/shared";
import { generateId } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A time-bounded team interval extracted from transcript content blocks. */
export interface TeamInterval {
  teamName: string;
  description: string | null;
  /** ISO timestamp from the parent message of the TeamCreate block */
  createdAt: string;
  /** ISO timestamp from the paired TeamDelete, or null if still active */
  endedAt: string | null;
}

/** A persisted team row returned from the database after insertion. */
export interface PersistedTeam {
  id: string;
  session_id: string;
  team_name: string;
  description: string | null;
  created_at: string;
}

/**
 * A teammate extracted from Agent tool_use blocks that reference a team_name.
 *
 * Aligns with the `teammates` table schema from migration 006:
 *   - role: 'lead' | 'member'
 *   - entity_type: 'human' | 'agent' | 'subagent'
 *   - entity_name: the agent's display name
 */
export interface ParsedTeammate {
  teamName: string;
  entityName: string;
  entityType: "human" | "agent" | "subagent";
  role: "lead" | "member";
}

/** A persisted teammate row returned from the database after insertion. */
export interface PersistedTeammate {
  id: string;
  team_id: string;
  session_id: string;
  role: string;
  entity_type: string;
  entity_name: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Pure extraction
// ---------------------------------------------------------------------------

/**
 * Extract team intervals from content blocks and their parent messages.
 *
 * Pairs TeamCreate blocks with TeamDelete blocks by team name in ordinal order.
 * Multiple create/delete cycles for the same team name produce separate intervals.
 *
 * Timestamps are resolved from the parent TranscriptMessage (via message_id),
 * since content blocks don't carry their own timestamps. If a message timestamp
 * can't be resolved, the block is skipped.
 *
 * @param contentBlocks - All parsed content blocks for the session
 * @param messages      - All parsed transcript messages (for timestamp resolution)
 * @returns Array of team intervals, ordered by creation time
 */
export function extractTeamIntervals(
  contentBlocks: ParsedContentBlock[],
  messages: TranscriptMessage[],
): TeamInterval[] {
  // Build a lookup from message_id -> timestamp for resolving block timestamps
  const messageTimestamps = new Map<string, string>();
  for (const msg of messages) {
    if (msg.timestamp) {
      messageTimestamps.set(msg.id, msg.timestamp);
    }
  }

  // Collect TeamCreate and TeamDelete events in block_order
  // (block_order is globally unique within a session and preserves chronological order)
  const creates: Array<{ teamName: string; description: string | null; timestamp: string; blockOrder: number }> = [];
  const deletes: Array<{ teamName: string; timestamp: string; blockOrder: number }> = [];

  for (const block of contentBlocks) {
    if (block.block_type !== "tool_use") continue;

    const timestamp = messageTimestamps.get(block.message_id);
    if (!timestamp) continue;

    if (block.tool_name === "TeamCreate") {
      const input = block.tool_input as Record<string, unknown> | null;
      const name = (input?.team_name as string) ?? (input?.name as string);
      if (!name) continue;

      creates.push({
        teamName: name,
        description: (input?.description as string) ?? null,
        timestamp,
        blockOrder: block.block_order,
      });
    }

    if (block.tool_name === "TeamDelete") {
      const input = block.tool_input as Record<string, unknown> | null;
      const name = (input?.team_name as string) ?? (input?.name as string);
      if (!name) continue;

      deletes.push({
        teamName: name,
        timestamp,
        blockOrder: block.block_order,
      });
    }
  }

  // Sort both by block_order to ensure chronological pairing
  creates.sort((a, b) => a.blockOrder - b.blockOrder);
  deletes.sort((a, b) => a.blockOrder - b.blockOrder);

  // Pair each create with the next unmatched delete of the same team name.
  // Track which delete indices have been consumed so each delete pairs with
  // exactly one create.
  const usedDeletes = new Set<number>();
  const intervals: TeamInterval[] = [];

  for (const create of creates) {
    // Find the earliest delete for this team name that comes after this create
    let matchedDelete: (typeof deletes)[number] | null = null;

    for (let i = 0; i < deletes.length; i++) {
      if (usedDeletes.has(i)) continue;
      if (deletes[i].teamName !== create.teamName) continue;
      if (deletes[i].blockOrder <= create.blockOrder) continue;

      matchedDelete = deletes[i];
      usedDeletes.add(i);
      break;
    }

    intervals.push({
      teamName: create.teamName,
      description: create.description,
      createdAt: create.timestamp,
      endedAt: matchedDelete?.timestamp ?? null,
    });
  }

  // Sort intervals by createdAt for deterministic output
  intervals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return intervals;
}

// ---------------------------------------------------------------------------
// Teammate extraction
// ---------------------------------------------------------------------------

/**
 * Extract teammates from Agent tool_use blocks that specify a `team_name`.
 *
 * When the lead session spawns subagents via the `Agent` tool with a `team_name`
 * parameter, each spawn represents a teammate joining a team. This function
 * scans content blocks for such Agent calls and builds a deduplicated list of
 * teammates, keyed by (entityName, teamName).
 *
 * Additionally, for each team that has teammates, an implicit "lead" teammate
 * is added representing the session owner (the orchestrating agent).
 *
 * @param contentBlocks - All parsed content blocks for the session
 * @param teams         - Persisted team rows (needed to map teamName -> team_id)
 * @returns Deduplicated list of parsed teammates
 */
export function extractTeammates(
  contentBlocks: ParsedContentBlock[],
  teams: PersistedTeam[],
): ParsedTeammate[] {
  // Build a set of known team names so we only extract teammates for teams
  // that were actually persisted (avoids orphan references).
  const knownTeamNames = new Set(teams.map(t => t.team_name));

  // Scan Agent tool_use blocks for team-affiliated spawns
  const teammates: ParsedTeammate[] = [];
  const seen = new Set<string>(); // dedup key: "teamName::entityName"

  for (const block of contentBlocks) {
    if (block.block_type !== "tool_use" || block.tool_name !== "Agent") continue;

    const input = block.tool_input as Record<string, unknown> | null;
    if (!input?.team_name) continue;

    const teamName = input.team_name as string;
    if (!knownTeamNames.has(teamName)) continue;

    const entityName = (input.name as string) ?? (input.description as string) ?? "unnamed";
    const dedupKey = `${teamName}::${entityName}`;

    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    teammates.push({
      teamName,
      entityName,
      entityType: "agent",
      role: "member",
    });
  }

  // For each team that has at least one extracted teammate, add an implicit
  // "lead" entry representing the session owner (the orchestrating agent).
  const teamsWithMembers = new Set(teammates.map(t => t.teamName));
  for (const teamName of teamsWithMembers) {
    const leadKey = `${teamName}::lead`;
    if (!seen.has(leadKey)) {
      seen.add(leadKey);
      teammates.push({
        teamName,
        entityName: "lead",
        entityType: "human",
        role: "lead",
      });
    }
  }

  return teammates;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist team intervals to the `teams` table.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING on the compound unique constraint
 * (session_id, team_name, created_at) to make this idempotent across reparses.
 *
 * @param sql       - Postgres connection
 * @param sessionId - The session these teams belong to
 * @param intervals - Team intervals from extractTeamIntervals()
 * @returns The persisted (or pre-existing) team rows
 */
export async function persistTeams(
  sql: Sql,
  sessionId: string,
  intervals: TeamInterval[],
): Promise<PersistedTeam[]> {
  if (intervals.length === 0) return [];

  const results: PersistedTeam[] = [];

  for (const interval of intervals) {
    const id = generateId();

    // INSERT with ON CONFLICT DO NOTHING — if this exact (session_id, team_name, created_at)
    // already exists from a previous parse, skip silently.
    const rows = await sql`
      INSERT INTO teams (id, session_id, team_name, description, created_at, metadata)
      VALUES (
        ${id},
        ${sessionId},
        ${interval.teamName},
        ${interval.description},
        ${interval.createdAt},
        ${JSON.stringify({ ended_at: interval.endedAt })}
      )
      ON CONFLICT (session_id, team_name, created_at) DO NOTHING
      RETURNING id, session_id, team_name, description, created_at
    `;

    if (rows.length > 0) {
      // Freshly inserted
      results.push({
        id: rows[0].id as string,
        session_id: rows[0].session_id as string,
        team_name: rows[0].team_name as string,
        description: rows[0].description as string | null,
        created_at: String(rows[0].created_at),
      });
    } else {
      // Already existed — fetch the existing row
      const existing = await sql`
        SELECT id, session_id, team_name, description, created_at
        FROM teams
        WHERE session_id = ${sessionId}
          AND team_name = ${interval.teamName}
          AND created_at = ${interval.createdAt}
      `;
      if (existing.length > 0) {
        results.push({
          id: existing[0].id as string,
          session_id: existing[0].session_id as string,
          team_name: existing[0].team_name as string,
          description: existing[0].description as string | null,
          created_at: String(existing[0].created_at),
        });
      }
    }
  }

  return results;
}

/**
 * Persist extracted teammates to the `teammates` table.
 *
 * Uses delete-then-insert within a transaction for idempotent reparse: all
 * teammates for this session are wiped and re-created from the current parse.
 * This avoids complex upsert logic for teammates whose names or roles may
 * change across reparses.
 *
 * @param sql       - Postgres connection
 * @param sessionId - The session these teammates belong to
 * @param teammates - Parsed teammates from extractTeammates()
 * @param teams     - Persisted teams (for resolving teamName -> team_id)
 * @returns The persisted teammate rows
 */
export async function persistTeammates(
  sql: Sql,
  sessionId: string,
  teammates: ParsedTeammate[],
  teams: PersistedTeam[],
): Promise<PersistedTeammate[]> {
  if (teammates.length === 0) return [];

  // Build teamName -> team_id lookup. If multiple team rows share the same
  // team_name (create/delete/re-create cycles), pick the first one — teammates
  // are associated with the team as a named concept, not a specific interval.
  const teamIdByName = new Map<string, string>();
  for (const team of teams) {
    if (!teamIdByName.has(team.team_name)) {
      teamIdByName.set(team.team_name, team.id);
    }
  }

  // Delete existing teammates for this session (idempotent reparse)
  await sql`DELETE FROM teammates WHERE session_id = ${sessionId}`;

  const results: PersistedTeammate[] = [];

  for (const mate of teammates) {
    const teamId = teamIdByName.get(mate.teamName);
    if (!teamId) continue; // No matching team — skip

    const id = generateId();

    const rows = await sql`
      INSERT INTO teammates (id, team_id, session_id, role, entity_type, entity_name, created_at, metadata)
      VALUES (
        ${id},
        ${teamId},
        ${sessionId},
        ${mate.role},
        ${mate.entityType},
        ${mate.entityName},
        now(),
        '{}'
      )
      RETURNING id, team_id, session_id, role, entity_type, entity_name, created_at
    `;

    if (rows.length > 0) {
      results.push({
        id: rows[0].id as string,
        team_id: rows[0].team_id as string,
        session_id: rows[0].session_id as string,
        role: rows[0].role as string,
        entity_type: rows[0].entity_type as string,
        entity_name: rows[0].entity_name as string | null,
        created_at: String(rows[0].created_at),
      });
    }
  }

  return results;
}
