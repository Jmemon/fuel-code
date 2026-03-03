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
