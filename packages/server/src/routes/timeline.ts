/**
 * Timeline API endpoint for fuel-code.
 *
 * GET /api/timeline — Returns a session-grouped activity feed with embedded
 * git activity highlights. This is the unified "what happened" view:
 *   - Sessions with their associated commits, pushes, merges, and checkouts
 *   - Orphan git events (activity outside any CC session)
 *
 * Items are interleaved chronologically (newest first). Pagination is
 * session-based using cursor-encoded keyset pagination.
 *
 * Query strategy (4 steps):
 *   1. Fetch sessions (paginated, filtered by workspace/device/time/cursor)
 *   2. Batch-fetch git activity for those sessions
 *   3. Fetch orphan git activity (session_id IS NULL) in the same time range
 *   4. Merge and interleave sessions + orphan git groups by timestamp
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import { timelineQuerySchema } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the timeline router for testability */
export interface TimelineRouterDeps {
  /** postgres.js SQL tagged template client */
  sql: Sql;
  /** Pino logger instance */
  logger: Logger;
}

/**
 * Decoded cursor for keyset pagination.
 * `s` = started_at ISO timestamp, `i` = session ID.
 * Same format as sessions.ts for consistency.
 */
interface PaginationCursor {
  s: string;
  i: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 pagination cursor into its components.
 * Returns null if the cursor is invalid (malformed base64, bad JSON, or missing fields).
 */
function decodeCursor(cursorStr: string): PaginationCursor | null {
  try {
    const decoded = Buffer.from(cursorStr, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (typeof parsed.s === "string" && typeof parsed.i === "string") {
      return { s: parsed.s, i: parsed.i };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode a pagination cursor from session started_at and id.
 * The cursor is base64-encoded JSON for opaque client consumption.
 */
function encodeCursor(started_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: started_at, i: id })).toString("base64");
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the timeline router with injected dependencies.
 *
 * @param deps - Database and logger dependencies
 * @returns Express Router with the timeline endpoint mounted at /timeline
 */
export function createTimelineRouter(deps: TimelineRouterDeps): Router {
  const { sql, logger } = deps;
  const router = Router();

  // =========================================================================
  // GET /timeline — Session-grouped activity feed with git highlights
  // =========================================================================
  router.get(
    "/timeline",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // --- Validate query parameters with Zod ---
        const parseResult = timelineQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid query parameters",
            details: parseResult.error.issues,
          });
          return;
        }

        const query = parseResult.data;

        // --- Decode cursor if provided ---
        let cursor: PaginationCursor | null = null;
        if (query.cursor) {
          cursor = decodeCursor(query.cursor);
          if (!cursor) {
            res.status(400).json({
              error: "Invalid cursor",
              details: "Cursor must be a valid base64-encoded pagination token",
            });
            return;
          }
        }

        // =================================================================
        // Step 1: Fetch sessions (paginated, filtered)
        // =================================================================

        // Build dynamic WHERE conditions using postgres.js tagged template fragments
        const sessionConditions: ReturnType<typeof sql>[] = [];

        if (query.workspace_id) {
          sessionConditions.push(sql`s.workspace_id = ${query.workspace_id}`);
        }

        if (query.device_id) {
          sessionConditions.push(sql`s.device_id = ${query.device_id}`);
        }

        if (query.after) {
          sessionConditions.push(sql`s.started_at > ${query.after}`);
        }

        if (query.before) {
          sessionConditions.push(sql`s.started_at < ${query.before}`);
        }

        if (cursor) {
          // Keyset pagination: get rows "after" the cursor position.
          // Ordered by (started_at DESC, id DESC) so "after" means earlier
          // timestamps or same timestamp with a smaller id.
          sessionConditions.push(
            sql`(s.started_at, s.id) < (${cursor.s}, ${cursor.i})`,
          );
        }

        // Compose the WHERE clause from all session conditions
        const sessionWhereClause =
          sessionConditions.length > 0
            ? sql`WHERE ${sessionConditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)}`
            : sql``;

        // Fetch limit + 1 rows to detect if there are more pages
        const fetchLimit = query.limit + 1;

        const sessionRows = await sql`
          SELECT s.id, s.workspace_id, s.device_id, s.lifecycle,
                 s.started_at, s.ended_at, s.duration_ms, s.summary,
                 s.cost_estimate_usd, s.total_messages, s.tags,
                 w.display_name AS workspace_name,
                 d.name AS device_name
          FROM sessions s
          JOIN workspaces w ON s.workspace_id = w.id
          JOIN devices d ON s.device_id = d.id
          ${sessionWhereClause}
          ORDER BY s.started_at DESC, s.id DESC
          LIMIT ${fetchLimit}
        `;

        // Determine pagination state from the extra row
        const hasMore = sessionRows.length > query.limit;
        const sessions = hasMore ? sessionRows.slice(0, query.limit) : [...sessionRows];

        // Build the next cursor from the last session in the result set
        const nextCursor =
          hasMore && sessions.length > 0
            ? encodeCursor(
                sessions[sessions.length - 1].started_at,
                sessions[sessions.length - 1].id,
              )
            : null;

        // If no sessions, return early with empty results
        if (sessions.length === 0) {
          res.json({
            items: [],
            next_cursor: null,
            has_more: false,
          });
          return;
        }

        // =================================================================
        // Step 2: Batch-fetch git activity for fetched sessions
        // =================================================================

        const sessionIds = sessions.map((s: any) => s.id);

        // Fetch git activity linked to these sessions, optionally filtered by type
        let sessionGitActivity: any[];
        if (query.types) {
          sessionGitActivity = await sql`
            SELECT ga.id, ga.type, ga.branch, ga.commit_sha, ga.message,
                   ga.files_changed, ga.insertions, ga.deletions,
                   ga.timestamp, ga.data, ga.session_id
            FROM git_activity ga
            WHERE ga.session_id IN ${sql(sessionIds)}
              AND ga.type IN ${sql(query.types)}
            ORDER BY ga.timestamp ASC
          `;
        } else {
          sessionGitActivity = await sql`
            SELECT ga.id, ga.type, ga.branch, ga.commit_sha, ga.message,
                   ga.files_changed, ga.insertions, ga.deletions,
                   ga.timestamp, ga.data, ga.session_id
            FROM git_activity ga
            WHERE ga.session_id IN ${sql(sessionIds)}
            ORDER BY ga.timestamp ASC
          `;
        }

        // Group git activity by session_id for efficient lookup
        const gitBySession = new Map<string, any[]>();
        for (const ga of sessionGitActivity) {
          const list = gitBySession.get(ga.session_id) || [];
          list.push({
            id: ga.id,
            type: ga.type,
            branch: ga.branch,
            commit_sha: ga.commit_sha,
            message: ga.message,
            files_changed: ga.files_changed,
            timestamp: ga.timestamp,
            data: ga.data,
          });
          gitBySession.set(ga.session_id, list);
        }

        // =================================================================
        // Step 3: Fetch orphan git activity (no session) in the same time range
        // =================================================================

        // Determine the time range from the fetched sessions page
        const timestamps = sessions.map((s: any) => new Date(s.started_at).getTime());
        const timeRangeStart = new Date(Math.min(...timestamps)).toISOString();
        const timeRangeEnd = new Date(Math.max(...timestamps)).toISOString();

        // Build orphan query conditions
        const orphanConditions: ReturnType<typeof sql>[] = [
          sql`ga.session_id IS NULL`,
          sql`ga.timestamp >= ${timeRangeStart}`,
          sql`ga.timestamp <= ${timeRangeEnd}`,
        ];

        if (query.workspace_id) {
          orphanConditions.push(sql`ga.workspace_id = ${query.workspace_id}`);
        }

        if (query.device_id) {
          orphanConditions.push(sql`ga.device_id = ${query.device_id}`);
        }

        if (query.types) {
          orphanConditions.push(sql`ga.type IN ${sql(query.types)}`);
        }

        const orphanWhereClause = sql`WHERE ${orphanConditions.reduce(
          (acc, cond) => sql`${acc} AND ${cond}`,
        )}`;

        const orphanRows = await sql`
          SELECT ga.id, ga.type, ga.branch, ga.commit_sha, ga.message,
                 ga.files_changed, ga.insertions, ga.deletions,
                 ga.timestamp, ga.data,
                 ga.workspace_id, ga.device_id,
                 w.display_name AS workspace_name,
                 d.name AS device_name
          FROM git_activity ga
          JOIN workspaces w ON ga.workspace_id = w.id
          JOIN devices d ON ga.device_id = d.id
          ${orphanWhereClause}
          ORDER BY ga.timestamp DESC
        `;

        // =================================================================
        // Step 4: Merge and interleave sessions + orphan git groups
        // =================================================================

        // Build session timeline items with embedded git activity
        const sessionItems = sessions.map((s: any) => ({
          type: "session" as const,
          session: {
            id: s.id,
            workspace_id: s.workspace_id,
            workspace_name: s.workspace_name,
            device_id: s.device_id,
            device_name: s.device_name,
            lifecycle: s.lifecycle,
            started_at: s.started_at,
            ended_at: s.ended_at,
            duration_ms: s.duration_ms,
            summary: s.summary,
            cost_estimate_usd: s.cost_estimate_usd,
            total_messages: s.total_messages,
            tags: s.tags,
          },
          git_activity: gitBySession.get(s.id) || [],
          // Internal field for sorting — not included in response
          _sort_ts: new Date(s.started_at).getTime(),
        }));

        // Group orphan git events by (workspace_id, device_id) to form orphan items.
        // Each group becomes a single timeline item with all its events.
        const orphanGroupKey = (row: any) => `${row.workspace_id}:${row.device_id}`;
        const orphanGroups = new Map<string, any[]>();

        for (const row of orphanRows) {
          const key = orphanGroupKey(row);
          const group = orphanGroups.get(key) || [];
          group.push(row);
          orphanGroups.set(key, group);
        }

        const orphanItems = Array.from(orphanGroups.values()).map((group) => {
          // Find the earliest event timestamp as the anchor for this group
          const earliestTs = group.reduce(
            (min: number, row: any) => Math.min(min, new Date(row.timestamp).getTime()),
            Infinity,
          );

          const representative = group[0];
          return {
            type: "git_activity" as const,
            workspace_id: representative.workspace_id,
            workspace_name: representative.workspace_name,
            device_id: representative.device_id,
            device_name: representative.device_name,
            git_activity: group.map((row: any) => ({
              id: row.id,
              type: row.type,
              branch: row.branch,
              commit_sha: row.commit_sha,
              message: row.message,
              files_changed: row.files_changed,
              timestamp: row.timestamp,
              data: row.data,
            })),
            started_at: new Date(earliestTs).toISOString(),
            // Internal field for sorting
            _sort_ts: earliestTs,
          };
        });

        // Merge and sort all items by timestamp descending (newest first)
        const allItems = [...sessionItems, ...orphanItems].sort(
          (a, b) => b._sort_ts - a._sort_ts,
        );

        // Strip internal _sort_ts field from response
        const items = allItems.map(({ _sort_ts, ...item }) => item);

        res.json({
          items,
          next_cursor: nextCursor,
          has_more: hasMore,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
