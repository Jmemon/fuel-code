/**
 * Teams API endpoints for fuel-code.
 *
 * Provides REST endpoints for querying session-scoped agent teams:
 *   - GET /teams       — List all teams with cursor-based pagination and session info
 *   - GET /teams/:name — Team detail with teammate members (by team_name)
 *
 * Teams are session-scoped: each team is tied to a specific session and its
 * members are tracked via the teammates table (not subagents). Auth is enforced
 * by the upstream auth middleware on /api/*.
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
  //
  // Teams are session-scoped: each row in teams is tied to a session_id.
  // The response includes inline session info and a computed member_count
  // from the teammates table.
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

        // Join teams with sessions to include session context and compute
        // member_count from the teammates table via a correlated subquery.
        const rows = await sql`
          SELECT t.id,
                 t.team_name,
                 t.description,
                 t.session_id,
                 t.created_at,
                 t.metadata,
                 s.initial_prompt AS session_initial_prompt,
                 s.started_at AS session_started_at,
                 s.lifecycle AS session_lifecycle,
                 (SELECT COUNT(*)::int FROM teammates tm WHERE tm.team_id = t.id) AS member_count
          FROM teams t
          JOIN sessions s ON t.session_id = s.id
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

        // Shape the response to nest session info as an object
        const shaped = teams.map((row) => ({
          id: row.id,
          team_name: row.team_name,
          description: row.description,
          session_id: row.session_id,
          session: {
            id: row.session_id,
            initial_prompt: row.session_initial_prompt,
            started_at: row.session_started_at,
            lifecycle: row.session_lifecycle,
          },
          created_at: row.created_at,
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
  // GET /teams/:name — Team detail with teammate members
  //
  // Looks up teams by team_name. Since teams are now session-scoped, the same
  // team_name can exist across multiple sessions. This endpoint returns the
  // first match and its teammate members (not subagents).
  // =========================================================================
  router.get(
    "/teams/:name",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { name } = req.params;

        // Fetch team by team_name with session join
        const teamRows = await sql`
          SELECT t.id,
                 t.team_name,
                 t.description,
                 t.session_id,
                 t.created_at,
                 t.metadata,
                 s.initial_prompt AS session_initial_prompt,
                 s.started_at AS session_started_at,
                 s.lifecycle AS session_lifecycle
          FROM teams t
          JOIN sessions s ON t.session_id = s.id
          WHERE t.team_name = ${name}
          ORDER BY t.created_at DESC
          LIMIT 1
        `;

        if (teamRows.length === 0) {
          res.status(404).json({ error: "Team not found" });
          return;
        }

        const row = teamRows[0];

        // Fetch teammate members for this team (not subagents)
        const members = await sql`
          SELECT id,
                 role,
                 entity_type,
                 entity_name,
                 summary,
                 created_at,
                 session_id,
                 metadata
          FROM teammates
          WHERE team_id = ${row.id}
          ORDER BY created_at
        `;

        // Shape response with nested session info and members
        const team = {
          id: row.id,
          team_name: row.team_name,
          description: row.description,
          session_id: row.session_id,
          session: {
            id: row.session_id,
            initial_prompt: row.session_initial_prompt,
            started_at: row.session_started_at,
            lifecycle: row.session_lifecycle,
          },
          created_at: row.created_at,
          member_count: members.length,
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
