/**
 * Workspace API endpoints for fuel-code.
 *
 * Provides REST endpoints for querying workspaces:
 *   - GET /workspaces       — List all workspaces with aggregate session stats and cursor pagination
 *   - GET /workspaces/:id   — Workspace detail with recent sessions, devices, git summary, and stats
 *
 * All endpoints are read-only aggregation queries over existing tables.
 * Workspaces are populated by the event processor when events are ingested.
 * Auth is enforced by the upstream auth middleware on /api/*.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the workspaces router for testability */
export interface WorkspacesRouterDeps {
  /** postgres.js SQL tagged template client */
  sql: Sql;
  /** Pino logger instance */
  logger: Logger;
}

/**
 * Decoded cursor for keyset pagination.
 * `u` = last_session_at ISO timestamp, `i` = workspace ID.
 */
interface WorkspacePaginationCursor {
  u: string;
  i: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Query parameter schema for GET /workspaces list endpoint */
const workspaceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 pagination cursor into its components.
 * Returns null if the cursor is invalid (malformed base64, bad JSON, or missing fields).
 */
function decodeCursor(cursorStr: string): WorkspacePaginationCursor | null {
  try {
    const decoded = Buffer.from(cursorStr, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed.u === "string" && typeof parsed.i === "string") {
      return { u: parsed.u, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode a pagination cursor from workspace last_session_at and id.
 * The cursor is base64-encoded JSON for opaque client consumption.
 */
function encodeCursor(lastSessionAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: lastSessionAt, i: id })).toString(
    "base64",
  );
}

/**
 * Determine whether a string looks like a ULID (26 alphanumeric chars).
 * Used to disambiguate workspace lookup by ULID vs display_name/canonical_id.
 */
function isUlid(value: string): boolean {
  return /^[0-9A-Za-z]{26}$/.test(value);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the workspaces router with injected dependencies.
 *
 * @param deps - Database and logger dependencies
 * @returns Express Router with workspace endpoints mounted at /workspaces/*
 */
export function createWorkspacesRouter(deps: WorkspacesRouterDeps): Router {
  const { sql, logger } = deps;
  const router = Router();

  // =========================================================================
  // GET /workspaces — List all workspaces with aggregate session stats
  // =========================================================================
  router.get(
    "/workspaces",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // --- Validate query parameters with Zod ---
        const parseResult = workspaceListQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid query parameters",
            details: parseResult.error.issues,
          });
          return;
        }

        const query = parseResult.data;

        // --- Decode cursor if provided ---
        let cursor: WorkspacePaginationCursor | null = null;
        if (query.cursor) {
          cursor = decodeCursor(query.cursor);
          if (!cursor) {
            res.status(400).json({
              error: "Invalid cursor",
              details:
                "Cursor must be a valid base64-encoded pagination token",
            });
            return;
          }
        }

        // Fetch limit + 1 rows to determine if there are more pages
        const fetchLimit = query.limit + 1;

        // CTE aggregates session stats per workspace, then applies keyset pagination.
        // cursor fields: u = last_session_at, i = workspace id
        const cursorTs = cursor ? cursor.u : null;
        const cursorId = cursor ? cursor.i : null;

        const rows = await sql`
          WITH workspace_agg AS (
            SELECT w.*,
              COUNT(s.id) AS session_count,
              COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) AS active_session_count,
              MAX(s.started_at) AS last_session_at,
              COUNT(DISTINCT s.device_id) AS device_count,
              COALESCE(SUM(s.cost_estimate_usd), 0) AS total_cost_usd,
              COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms,
              COALESCE(SUM(s.tokens_in), 0) AS total_tokens_in,
              COALESCE(SUM(s.tokens_out), 0) AS total_tokens_out
            FROM workspaces w
            LEFT JOIN sessions s ON s.workspace_id = w.id
            GROUP BY w.id
          )
          SELECT * FROM workspace_agg
          WHERE (${cursorTs}::timestamptz IS NULL OR (last_session_at, id) < (${cursorTs}, ${cursorId}))
          ORDER BY last_session_at DESC NULLS LAST, id DESC
          LIMIT ${fetchLimit}
        `;

        // Determine pagination state from the extra row
        const hasMore = rows.length > query.limit;
        const workspaces = hasMore ? rows.slice(0, query.limit) : rows;

        // Build the next cursor from the last row in the result set
        const nextCursor =
          hasMore && workspaces.length > 0
            ? encodeCursor(
                workspaces[workspaces.length - 1].last_session_at,
                workspaces[workspaces.length - 1].id,
              )
            : null;

        res.json({
          workspaces,
          next_cursor: nextCursor,
          has_more: hasMore,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /workspaces/:id — Workspace detail with sessions, devices, git, stats
  // =========================================================================
  router.get(
    "/workspaces/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id as string;

        // --- Resolve workspace by ULID, canonical_id, or display_name ---
        let workspaceRows: any[];

        if (isUlid(id)) {
          // ULID lookup: exact match on primary key
          workspaceRows = await sql`
            SELECT * FROM workspaces WHERE id = ${id}
          `;
        } else {
          // Name/canonical lookup: case-insensitive display_name or exact canonical_id
          workspaceRows = await sql`
            SELECT * FROM workspaces
            WHERE LOWER(display_name) = LOWER(${id}) OR canonical_id = ${id}
          `;
        }

        if (workspaceRows.length === 0) {
          res.status(404).json({ error: "Workspace not found" });
          return;
        }

        // If multiple matches on display_name, return 400 ambiguous
        if (workspaceRows.length > 1) {
          res.status(400).json({
            error: "Ambiguous workspace name",
            matches: workspaceRows.map((w: any) => ({
              id: w.id,
              canonical_id: w.canonical_id,
              display_name: w.display_name,
            })),
          });
          return;
        }

        const workspace = workspaceRows[0];

        // --- Parallel queries for detail data ---
        const [recentSessions, devices, gitSummary, stats] =
          await Promise.all([
            // Recent sessions (last 10) with device names
            sql`
              SELECT s.id, s.lifecycle, s.started_at, s.ended_at, s.duration_ms,
                     s.summary, s.cost_estimate_usd, s.total_messages, s.tags,
                     s.model, s.git_branch,
                     d.name AS device_name, d.id AS device_id, d.type AS device_type
              FROM sessions s
              JOIN devices d ON s.device_id = d.id
              WHERE s.workspace_id = ${workspace.id}
              ORDER BY s.started_at DESC
              LIMIT 10
            `,

            // Devices tracking this workspace (via workspace_devices junction)
            sql`
              SELECT d.*, wd.local_path, wd.hooks_installed, wd.git_hooks_installed, wd.last_active_at
              FROM devices d
              JOIN workspace_devices wd ON wd.device_id = d.id
              WHERE wd.workspace_id = ${workspace.id}
              ORDER BY wd.last_active_at DESC
            `,

            // Git activity summary: flat object with commit/push counts, active branches, and last commit time
            sql`
              SELECT
                COUNT(*) FILTER (WHERE type = 'commit') AS total_commits,
                COUNT(*) FILTER (WHERE type = 'push') AS total_pushes,
                array_agg(DISTINCT branch) FILTER (WHERE branch IS NOT NULL) AS active_branches,
                MAX(timestamp) AS last_commit_at
              FROM git_activity
              WHERE workspace_id = ${workspace.id}
            `,

            // Aggregate stats across all sessions for this workspace
            sql`
              SELECT
                COUNT(*)::int AS total_sessions,
                COUNT(CASE WHEN lifecycle = 'capturing' THEN 1 END)::int AS active_sessions,
                COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
                COALESCE(SUM(cost_estimate_usd), 0) AS total_cost_usd,
                COALESCE(SUM(total_messages), 0) AS total_messages,
                COALESCE(SUM(tokens_in), 0) AS total_tokens_in,
                COALESCE(SUM(tokens_out), 0) AS total_tokens_out,
                MIN(started_at) AS first_session_at,
                MAX(started_at) AS last_session_at
              FROM sessions
              WHERE workspace_id = ${workspace.id}
            `,
          ]);

        // git_summary is a single-row aggregate; extract as flat object
        const gitRow = gitSummary[0] || {};
        res.json({
          workspace,
          recent_sessions: recentSessions,
          devices,
          git_summary: {
            total_commits: gitRow.total_commits ?? 0,
            total_pushes: gitRow.total_pushes ?? 0,
            active_branches: gitRow.active_branches ?? [],
            last_commit_at: gitRow.last_commit_at ?? null,
          },
          stats: stats[0] || null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
