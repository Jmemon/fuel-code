/**
 * Session API endpoints for fuel-code.
 *
 * Provides REST endpoints for querying and mutating sessions:
 *   - GET  /api/sessions           — List with filtering and cursor-based pagination
 *   - GET  /api/sessions/:id       — Session detail with relationship data
 *   - GET  /api/sessions/:id/subagents      — Sub-agents spawned in this session
 *   - GET  /api/sessions/:id/skills         — Skills invoked in this session
 *   - GET  /api/sessions/:id/worktrees      — Worktrees used in this session
 *   - GET  /api/sessions/:id/transcript     — Parsed messages with nested content blocks
 *   - GET  /api/sessions/:id/transcript/raw — Presigned S3 URL for raw transcript
 *   - GET  /api/sessions/:id/events         — Events belonging to this session
 *   - GET  /api/sessions/:id/git            — Git activity (stub, populated in Phase 3)
 *   - PATCH /api/sessions/:id               — Update tags or summary
 *
 * All endpoints require Bearer token auth (enforced by upstream auth middleware).
 * Cursor-based pagination uses base64-encoded { s: started_at, i: id } cursors
 * for stable, keyset-based page traversal.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Sql } from "postgres";
import type { Logger } from "pino";

import {
  sessionListQuerySchema,
  sessionPatchSchema,
  parseLifecycleParam,
  batchStatusRequestSchema,
} from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * S3 client subset needed by sessions router — only presigned URL generation.
 * Matches the presignedUrl method from FuelCodeS3Client in aws/s3.ts.
 */
interface S3PresignClient {
  presignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

/** Dependencies injected into the sessions router for testability */
export interface SessionsRouterDeps {
  /** postgres.js SQL tagged template client */
  sql: Sql;
  /** Optional S3 client for raw transcript presigned URLs */
  s3?: S3PresignClient;
  /** Pino logger instance */
  logger: Logger;
}

/**
 * Decoded cursor for keyset pagination.
 * `s` = started_at ISO timestamp, `i` = session ID.
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
  return Buffer.from(JSON.stringify({ s: started_at, i: id })).toString(
    "base64",
  );
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the sessions router with injected dependencies.
 *
 * @param deps - Database, optional S3, and logger dependencies
 * @returns Express Router with all session endpoints mounted at /sessions/*
 */
export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const { sql, s3, logger } = deps;
  const router = Router();

  // =========================================================================
  // GET /sessions — List sessions with filtering and cursor pagination
  // =========================================================================
  router.get(
    "/sessions",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // --- Validate query parameters with Zod ---
        const parseResult = sessionListQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid query parameters",
            details: parseResult.error.issues,
          });
          return;
        }

        const query = parseResult.data;

        // --- Validate lifecycle values if provided ---
        let lifecycleValues: string[] | null = null;
        if (query.lifecycle) {
          lifecycleValues = parseLifecycleParam(query.lifecycle);
          if (!lifecycleValues) {
            res.status(400).json({
              error: "Invalid lifecycle value",
              details: `Valid values: detected, capturing, ended, parsed, summarized, archived, failed`,
            });
            return;
          }
        }

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

        // --- Build dynamic WHERE conditions ---
        // Uses postgres.js tagged template fragments for safe parameterized queries.
        // Each condition is a fragment that gets composed into the final query.
        const conditions: ReturnType<typeof sql>[] = [];

        if (query.workspace_id) {
          conditions.push(sql`s.workspace_id = ${query.workspace_id}`);
        }

        if (query.device_id) {
          conditions.push(sql`s.device_id = ${query.device_id}`);
        }

        if (lifecycleValues && lifecycleValues.length > 0) {
          conditions.push(sql`s.lifecycle IN ${sql(lifecycleValues)}`);
        }

        if (query.after) {
          conditions.push(sql`s.started_at > ${query.after}`);
        }

        if (query.before) {
          conditions.push(sql`s.started_at < ${query.before}`);
        }

        if (query.ended_after) {
          conditions.push(sql`s.ended_at > ${query.ended_after}`);
        }

        if (query.ended_before) {
          conditions.push(sql`s.ended_at < ${query.ended_before}`);
        }

        if (query.tag) {
          // Use Postgres array containment operator (@>) for GIN index usage
          conditions.push(sql`s.tags @> ARRAY[${query.tag}]::text[]`);
        }

        // Phase 4-2 filters: team name, has_subagents, has_team
        if (query.team) {
          conditions.push(sql`s.team_name = ${query.team}`);
        }

        if (query.has_subagents === "true") {
          conditions.push(sql`s.subagent_count > 0`);
        }

        if (query.has_team === "true") {
          conditions.push(sql`s.team_name IS NOT NULL`);
        }

        if (cursor) {
          // Keyset pagination: get rows after the cursor position.
          // Orders by (started_at DESC, id DESC) so "after" means earlier timestamps
          // or same timestamp with a smaller id.
          conditions.push(
            sql`(s.started_at, s.id) < (${cursor.s}, ${cursor.i})`,
          );
        }

        // Compose the WHERE clause from all conditions
        const whereClause =
          conditions.length > 0
            ? sql`WHERE ${conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`)}`
            : sql``;

        // Fetch limit + 1 rows to determine if there are more pages
        const fetchLimit = query.limit + 1;

        const rows = await sql`
          SELECT s.*,
                 w.canonical_id AS workspace_canonical_id,
                 w.display_name AS workspace_name,
                 d.name AS device_name
          FROM sessions s
          JOIN workspaces w ON s.workspace_id = w.id
          JOIN devices d ON s.device_id = d.id
          ${whereClause}
          ORDER BY s.started_at DESC, s.id DESC
          LIMIT ${fetchLimit}
        `;

        // Determine pagination state from the extra row
        const hasMore = rows.length > query.limit;
        const sessions = hasMore ? rows.slice(0, query.limit) : rows;

        // Build the next cursor from the last row in the result set
        const nextCursor =
          hasMore && sessions.length > 0
            ? encodeCursor(
                sessions[sessions.length - 1].started_at,
                sessions[sessions.length - 1].id,
              )
            : null;

        res.json({
          sessions,
          next_cursor: nextCursor,
          has_more: hasMore,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id — Session detail with workspace/device names and
  // inline relationship data (subagents, skills, worktrees, team, resume chain)
  // =========================================================================
  router.get(
    "/sessions/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        const rows = await sql`
          SELECT s.*,
                 w.canonical_id AS workspace_canonical_id,
                 w.display_name AS workspace_name,
                 d.name AS device_name
          FROM sessions s
          JOIN workspaces w ON s.workspace_id = w.id
          JOIN devices d ON s.device_id = d.id
          WHERE s.id = ${id}
        `;

        if (rows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const session = rows[0];

        // Fetch all relationship data in parallel for performance
        const [subagents, skills, worktrees, teamRows, resumedFromRows, resumedByRows] =
          await Promise.all([
            sql`SELECT * FROM subagents WHERE session_id = ${id} ORDER BY started_at`,
            sql`SELECT * FROM session_skills WHERE session_id = ${id} ORDER BY invoked_at`,
            sql`SELECT * FROM session_worktrees WHERE session_id = ${id} ORDER BY created_at`,
            // Only query teams table if session has a team_name
            session.team_name
              ? sql`SELECT * FROM teams WHERE team_name = ${session.team_name}`
              : Promise.resolve([]),
            // Only query resumed_from if session has a resumed_from_session_id
            session.resumed_from_session_id
              ? sql`SELECT id, started_at, initial_prompt FROM sessions WHERE id = ${session.resumed_from_session_id}`
              : Promise.resolve([]),
            // Find sessions that resumed from this one
            sql`SELECT id, started_at, initial_prompt FROM sessions WHERE resumed_from_session_id = ${id}`,
          ]);

        session.subagents = subagents;
        session.skills = skills;
        session.worktrees = worktrees;
        session.team = teamRows.length > 0 ? teamRows[0] : null;
        session.resumed_from = resumedFromRows.length > 0 ? resumedFromRows[0] : null;
        session.resumed_by = resumedByRows;

        res.json({ session });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/subagents — List sub-agents spawned in this session
  // =========================================================================
  router.get(
    "/sessions/:id/subagents",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // Verify the session exists
        const sessionRows = await sql`
          SELECT id FROM sessions WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const subagents = await sql`
          SELECT * FROM subagents
          WHERE session_id = ${id}
          ORDER BY started_at
        `;

        res.json({ subagents });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/skills — List skills invoked in this session
  // =========================================================================
  router.get(
    "/sessions/:id/skills",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // Verify the session exists
        const sessionRows = await sql`
          SELECT id FROM sessions WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const skills = await sql`
          SELECT * FROM session_skills
          WHERE session_id = ${id}
          ORDER BY invoked_at
        `;

        res.json({ skills });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/worktrees — List worktrees used in this session
  // =========================================================================
  router.get(
    "/sessions/:id/worktrees",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // Verify the session exists
        const sessionRows = await sql`
          SELECT id FROM sessions WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const worktrees = await sql`
          SELECT * FROM session_worktrees
          WHERE session_id = ${id}
          ORDER BY created_at
        `;

        res.json({ worktrees });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/transcript — Parsed messages with nested content blocks
  //
  // Supports sub-agent filtering via ?subagent_id query parameter:
  //   - No param (default): main session messages only (subagent_id IS NULL)
  //   - ?subagent_id=all: all messages (main + all sub-agents) by timestamp
  //   - ?subagent_id=<ulid>: messages for a specific sub-agent (404 if not found)
  // =========================================================================
  router.get(
    "/sessions/:id/transcript",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const subagentId = (req.query.subagent_id as string | undefined)?.trim() || undefined;

        // First verify the session exists and check its parse status
        const sessionRows = await sql`
          SELECT id, parse_status, parse_error, lifecycle
          FROM sessions
          WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const session = sessionRows[0];

        // Transcript is only available when parse_status is 'completed'
        if (session.parse_status !== "completed") {
          res.status(404).json({
            error: "Transcript not yet available",
            parse_status: session.parse_status,
            parse_error: session.parse_error || null,
            lifecycle: session.lifecycle,
          });
          return;
        }

        // Build the subagent WHERE filter based on the query parameter.
        // Default (no param): only main session messages where subagent_id is null.
        // "all": no subagent filter, returns everything ordered by timestamp.
        // Specific ULID: validate the sub-agent exists for this session, then filter.
        let subagentFilter: ReturnType<typeof sql>;
        if (!subagentId) {
          subagentFilter = sql`AND tm.subagent_id IS NULL`;
        } else if (subagentId === "all") {
          subagentFilter = sql``;
        } else {
          // Validate the sub-agent exists for this session before querying messages
          const subagentRows = await sql`
            SELECT id FROM subagents
            WHERE id = ${subagentId} AND session_id = ${id}
          `;
          if (subagentRows.length === 0) {
            res.status(404).json({
              error: "Sub-agent not found",
              details: `No sub-agent with id '${subagentId}' found for session ${id}`,
            });
            return;
          }
          subagentFilter = sql`AND tm.subagent_id = ${subagentId}`;
        }

        // Fetch messages with nested content blocks aggregated as JSON array.
        // LEFT JOIN ensures messages with no content blocks still appear.
        // FILTER (WHERE cb.id IS NOT NULL) prevents null rows from appearing
        // in the json_agg when there are no matching content blocks.
        const messages = await sql`
          SELECT tm.*,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', cb.id,
                  'block_order', cb.block_order,
                  'block_type', cb.block_type,
                  'content_text', cb.content_text,
                  'thinking_text', cb.thinking_text,
                  'tool_name', cb.tool_name,
                  'tool_use_id', cb.tool_use_id,
                  'tool_input', cb.tool_input,
                  'tool_result_id', cb.tool_result_id,
                  'is_error', cb.is_error,
                  'result_text', cb.result_text,
                  'result_s3_key', cb.result_s3_key,
                  'metadata', cb.metadata
                )
              ) FILTER (WHERE cb.id IS NOT NULL),
              '[]'
            ) AS content_blocks
          FROM transcript_messages tm
          LEFT JOIN content_blocks cb ON cb.message_id = tm.id
          WHERE tm.session_id = ${id}
          ${subagentFilter}
          GROUP BY tm.id
          ORDER BY tm.ordinal
        `;

        res.json({ messages });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/transcript/raw — Presigned S3 URL for raw transcript
  //
  // Supports sub-agent raw transcripts via ?subagent_id=<ulid> query param.
  // When provided, looks up the sub-agent's transcript_s3_key instead of the
  // session's. No param returns the main session transcript (existing behavior).
  // =========================================================================
  router.get(
    "/sessions/:id/transcript/raw",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const subagentId = (req.query.subagent_id as string | undefined)?.trim() || undefined;

        // Determine the S3 key source: sub-agent row or session row
        let s3Key: string | null = null;

        if (subagentId) {
          // Sub-agent raw transcript: look up the subagent's transcript_s3_key
          const subagentRows = await sql`
            SELECT id, transcript_s3_key
            FROM subagents
            WHERE id = ${subagentId} AND session_id = ${id}
          `;

          if (subagentRows.length === 0) {
            res.status(404).json({
              error: "Sub-agent not found",
              details: `No sub-agent with id '${subagentId}' found for session ${id}`,
            });
            return;
          }

          s3Key = subagentRows[0].transcript_s3_key as string | null;

          if (!s3Key) {
            res.status(404).json({
              error: "Raw transcript not available",
              details: "No transcript has been uploaded for this sub-agent",
            });
            return;
          }
        } else {
          // Main session transcript: existing behavior
          const sessionRows = await sql`
            SELECT id, transcript_s3_key
            FROM sessions
            WHERE id = ${id}
          `;

          if (sessionRows.length === 0) {
            res.status(404).json({ error: "Session not found" });
            return;
          }

          s3Key = sessionRows[0].transcript_s3_key as string | null;

          if (!s3Key) {
            res.status(404).json({
              error: "Raw transcript not available",
              details: "No transcript has been uploaded for this session",
            });
            return;
          }
        }

        // S3 client is optional — if not configured, we can't generate presigned URLs
        if (!s3) {
          res.status(503).json({
            error: "S3 not configured",
            details: "Raw transcript downloads require S3 to be configured",
          });
          return;
        }

        // Generate a presigned URL (default 1 hour expiry)
        const url = await s3.presignedUrl(s3Key);

        // If the client explicitly requests no redirect, return the URL as JSON
        if (req.query.redirect === "false") {
          res.json({ url });
          return;
        }

        // Default behavior: redirect to the presigned URL
        res.redirect(302, url);
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/events — Events belonging to this session
  // =========================================================================
  router.get(
    "/sessions/:id/events",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // Verify the session exists first
        const sessionRows = await sql`
          SELECT id FROM sessions WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // Fetch all events for this session in chronological order
        const events = await sql`
          SELECT *
          FROM events
          WHERE session_id = ${id}
          ORDER BY timestamp ASC
        `;

        res.json({ events });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/git — Git activity (stub for Phase 3)
  // =========================================================================
  router.get(
    "/sessions/:id/git",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // Verify the session exists first
        const sessionRows = await sql`
          SELECT id FROM sessions WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // Query git_activity table for all git events correlated to this session.
        // LIMIT 500 as a defensive upper bound to prevent unbounded result sets.
        const gitActivity = await sql`
          SELECT * FROM git_activity
          WHERE session_id = ${id}
          ORDER BY timestamp ASC
          LIMIT 500
        `;
        res.json({ git_activity: gitActivity });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // PATCH /sessions/:id — Update tags or summary
  // =========================================================================
  router.patch(
    "/sessions/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // --- Validate request body ---
        const parseResult = sessionPatchSchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid request body",
            details: parseResult.error.issues,
          });
          return;
        }

        const body = parseResult.data;

        // --- Enforce mutual exclusivity of tag mutation modes ---
        // At most one of tags/add_tags/remove_tags can be provided.
        const tagModes = [body.tags, body.add_tags, body.remove_tags].filter(
          (v) => v !== undefined,
        );
        if (tagModes.length > 1) {
          res.status(400).json({
            error: "Invalid tag operation",
            details:
              "Provide at most one of: tags (replace), add_tags (append), remove_tags (remove)",
          });
          return;
        }

        // --- Check that the session exists ---
        const existingRows = await sql`
          SELECT id, tags FROM sessions WHERE id = ${id}
        `;

        if (existingRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const existing = existingRows[0];

        // --- Build the SET clauses for the UPDATE ---
        // We always update updated_at to track when the session was last modified.
        const updates: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        };

        // Handle summary update
        if (body.summary !== undefined) {
          updates.summary = body.summary;
        }

        // Handle tag mutations (exactly one mode or none)
        if (body.tags !== undefined) {
          // Replace mode: set tags to the exact array provided
          updates.tags = body.tags;
        } else if (body.add_tags !== undefined) {
          // Append mode: merge with existing tags, deduplicate
          const currentTags: string[] = existing.tags || [];
          const merged = [...new Set([...currentTags, ...body.add_tags])];
          updates.tags = merged;
        } else if (body.remove_tags !== undefined) {
          // Remove mode: filter out matching tags
          const currentTags: string[] = existing.tags || [];
          const removeSet = new Set(body.remove_tags);
          updates.tags = currentTags.filter((t) => !removeSet.has(t));
        }

        // --- Execute the UPDATE ---
        // Use postgres.js set helper for clean dynamic column updates
        const updatedRows = await sql`
          UPDATE sessions
          SET ${sql(updates)}
          WHERE id = ${id}
          RETURNING *
        `;

        // Fetch the session with joined workspace/device names for the response
        const resultRows = await sql`
          SELECT s.*,
                 w.canonical_id AS workspace_canonical_id,
                 w.display_name AS workspace_name,
                 d.name AS device_name
          FROM sessions s
          JOIN workspaces w ON s.workspace_id = w.id
          JOIN devices d ON s.device_id = d.id
          WHERE s.id = ${id}
        `;

        res.json({ session: resultRows[0] });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // POST /sessions/batch-status — Batch lifecycle status for multiple sessions
  // =========================================================================
  router.post(
    "/sessions/batch-status",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parseResult = batchStatusRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
          res.status(400).json({
            error: "Invalid request body",
            details: parseResult.error.issues,
          });
          return;
        }

        const { session_ids } = parseResult.data;

        const rows = await sql`
          SELECT id, lifecycle, parse_status
          FROM sessions
          WHERE id IN ${sql(session_ids)}
        `;

        // Build statuses map and detect not_found IDs
        const statuses: Record<string, { lifecycle: string; parse_status: string }> = {};
        const foundIds = new Set<string>();

        for (const row of rows) {
          statuses[row.id as string] = {
            lifecycle: row.lifecycle as string,
            parse_status: row.parse_status as string,
          };
          foundIds.add(row.id as string);
        }

        const not_found = session_ids.filter((id) => !foundIds.has(id));

        res.json({ statuses, not_found });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
