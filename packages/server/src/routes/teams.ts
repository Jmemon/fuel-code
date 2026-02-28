/**
 * Teams API endpoints for fuel-code.
 *
 * Provides REST endpoints for querying agent teams:
 *   - GET /teams       — List all teams with cursor-based pagination and lead session info
 *   - GET /teams/:name — Team detail with sub-agent members
 *
 * All endpoints are read-only queries over the teams and subagents tables
 * (created by migration 005_session_relationships). Auth is enforced by the
 * upstream auth middleware on /api/*.
 *
 * Cursor-based pagination uses base64-encoded { c: created_at, i: id } cursors
 * for stable, keyset-based page traversal ordered by created_at DESC.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the teams router for testability */
export interface TeamsRouterDeps {
  /** postgres.js SQL tagged template client */
  sql: Sql;
  /** Pino logger instance */
  logger: Logger;
}

/**
 * Decoded cursor for keyset pagination.
 * `c` = created_at ISO timestamp, `i` = team ID.
 */
interface TeamPaginationCursor {
  c: string;
  i: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 pagination cursor into its components.
 * Returns null if the cursor is invalid (malformed base64, bad JSON, or missing fields).
 */
function decodeCursor(cursorStr: string): TeamPaginationCursor | null {
  try {
    const decoded = Buffer.from(cursorStr, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed.c === "string" && typeof parsed.i === "string") {
      return { c: parsed.c, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode a pagination cursor from team created_at and id.
 * The cursor is base64-encoded JSON for opaque client consumption.
 */
function encodeCursor(created_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: created_at, i: id })).toString(
    "base64",
  );
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the teams router with injected dependencies.
 *
 * @param deps - Database and logger dependencies
 * @returns Express Router with team endpoints mounted at /teams/*
 */
export function createTeamsRouter(deps: TeamsRouterDeps): Router {
  const { sql } = deps;
  const router = Router();

  // =========================================================================
  // GET /teams — List all teams with cursor-based pagination
  // =========================================================================
  router.get(
    "/teams",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // --- Parse and validate query parameters ---
        const rawLimit = Number(req.query.limit) || 50;
        const limit = Math.min(Math.max(rawLimit, 1), 250);

        // --- Decode cursor if provided ---
        let cursor: TeamPaginationCursor | null = null;
        if (req.query.cursor && typeof req.query.cursor === "string") {
          cursor = decodeCursor(req.query.cursor);
          if (!cursor) {
            res.status(400).json({
              error: "Invalid cursor",
              details:
                "Cursor must be a valid base64-encoded pagination token",
            });
            return;
          }
        }

        // --- Build WHERE conditions ---
        const conditions: ReturnType<typeof sql>[] = [];

        if (cursor) {
          conditions.push(
            sql`(t.created_at, t.id) < (${cursor.c}, ${cursor.i})`,
          );
        }

        const whereClause =
          conditions.length > 0
            ? sql`WHERE ${conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)}`
            : sql``;

        // Fetch limit + 1 to determine if there are more pages
        const fetchLimit = limit + 1;

        // Join teams with sessions on lead_session_id to include lead session info.
        // LEFT JOIN because lead_session_id can be NULL if the team hasn't
        // been fully initialized yet.
        const rows = await sql`
          SELECT t.id,
                 t.team_name,
                 t.description,
                 t.lead_session_id,
                 t.created_at,
                 t.ended_at,
                 t.member_count,
                 t.metadata,
                 ls.id AS lead_session_db_id,
                 ls.initial_prompt AS lead_session_initial_prompt,
                 ls.started_at AS lead_session_started_at,
                 ls.lifecycle AS lead_session_lifecycle
          FROM teams t
          LEFT JOIN sessions ls ON t.lead_session_id = ls.id
          ${whereClause}
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT ${fetchLimit}
        `;

        // Determine pagination state
        const hasMore = rows.length > limit;
        const teams = hasMore ? rows.slice(0, limit) : rows;

        // Build next cursor from last row
        const nextCursor =
          hasMore && teams.length > 0
            ? encodeCursor(
                teams[teams.length - 1].created_at,
                teams[teams.length - 1].id,
              )
            : null;

        // Shape the response to nest lead_session as an object
        const shaped = teams.map((row) => ({
          id: row.id,
          team_name: row.team_name,
          description: row.description,
          lead_session_id: row.lead_session_id,
          lead_session: row.lead_session_db_id
            ? {
                id: row.lead_session_db_id,
                initial_prompt: row.lead_session_initial_prompt,
                started_at: row.lead_session_started_at,
                lifecycle: row.lead_session_lifecycle,
              }
            : null,
          created_at: row.created_at,
          ended_at: row.ended_at,
          member_count: row.member_count,
          metadata: row.metadata,
        }));

        res.json({
          teams: shaped,
          next_cursor: nextCursor,
          has_more: hasMore,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /teams/:name — Team detail with sub-agent members
  // =========================================================================
  router.get(
    "/teams/:name",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { name } = req.params;

        // --- Fetch team by team_name with lead session join ---
        const teamRows = await sql`
          SELECT t.id,
                 t.team_name,
                 t.description,
                 t.lead_session_id,
                 t.created_at,
                 t.ended_at,
                 t.member_count,
                 t.metadata,
                 ls.id AS lead_session_db_id,
                 ls.initial_prompt AS lead_session_initial_prompt,
                 ls.started_at AS lead_session_started_at,
                 ls.lifecycle AS lead_session_lifecycle
          FROM teams t
          LEFT JOIN sessions ls ON t.lead_session_id = ls.id
          WHERE t.team_name = ${name}
        `;

        if (teamRows.length === 0) {
          res.status(404).json({ error: "Team not found" });
          return;
        }

        const row = teamRows[0];

        // --- Fetch sub-agent members for this team ---
        const members = await sql`
          SELECT id,
                 agent_id,
                 agent_type,
                 agent_name,
                 model,
                 status,
                 started_at,
                 ended_at,
                 session_id
          FROM subagents
          WHERE team_name = ${name}
          ORDER BY started_at
        `;

        // Shape response with nested lead_session
        const team = {
          id: row.id,
          team_name: row.team_name,
          description: row.description,
          lead_session_id: row.lead_session_id,
          lead_session: row.lead_session_db_id
            ? {
                id: row.lead_session_db_id,
                initial_prompt: row.lead_session_initial_prompt,
                started_at: row.lead_session_started_at,
                lifecycle: row.lead_session_lifecycle,
              }
            : null,
          created_at: row.created_at,
          ended_at: row.ended_at,
          member_count: row.member_count,
          metadata: row.metadata,
          members,
        };

        res.json({ team });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
