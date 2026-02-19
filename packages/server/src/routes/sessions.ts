/**
 * Session API endpoints for fuel-code.
 *
 * Provides REST endpoints for querying and mutating sessions:
 *   - GET  /api/sessions           — List with filtering and cursor-based pagination
 *   - GET  /api/sessions/:id       — Session detail with workspace/device names
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
  // GET /sessions/:id — Session detail with workspace/device names
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

        res.json({ session: rows[0] });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // GET /sessions/:id/transcript — Parsed messages with nested content blocks
  // =========================================================================
  router.get(
    "/sessions/:id/transcript",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

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
  // =========================================================================
  router.get(
    "/sessions/:id/transcript/raw",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;

        // Look up the session's transcript S3 key
        const sessionRows = await sql`
          SELECT id, transcript_s3_key
          FROM sessions
          WHERE id = ${id}
        `;

        if (sessionRows.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const session = sessionRows[0];

        if (!session.transcript_s3_key) {
          res.status(404).json({
            error: "Raw transcript not available",
            details: "No transcript has been uploaded for this session",
          });
          return;
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
        const url = await s3.presignedUrl(session.transcript_s3_key);

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

        // Query git_activity table for all git events correlated to this session
        const gitActivity = await sql`
          SELECT * FROM git_activity
          WHERE session_id = ${id}
          ORDER BY timestamp ASC
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

  return router;
}
