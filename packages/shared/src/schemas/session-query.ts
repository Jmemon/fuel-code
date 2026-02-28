/**
 * Zod validation schemas for session query endpoints.
 *
 * Used by:
 *   - GET /api/sessions — list with filtering and cursor-based pagination
 *   - PATCH /api/sessions/:id — update tags or summary
 *   - POST /api/sessions/batch-status — bulk lifecycle status lookup
 *
 * The sessionListQuerySchema validates query string parameters (all optional),
 * with coerce on `limit` since query strings are always strings.
 *
 * The sessionPatchSchema validates the request body for tag/summary mutations,
 * enforcing that at most one of tags/add_tags/remove_tags is provided.
 */

import { z } from "zod";

/**
 * Valid session lifecycle states — used to validate the comma-separated
 * `lifecycle` query parameter after splitting.
 */
const VALID_LIFECYCLES = [
  "detected",
  "capturing",
  "ended",
  "parsed",
  "summarized",
  "archived",
  "failed",
] as const;

/**
 * Schema for GET /api/sessions query parameters.
 *
 * All fields are optional. `limit` is coerced from string to number since
 * Express query params are always strings. Datetime fields use ISO-8601
 * format validation.
 */
export const sessionListQuerySchema = z.object({
  /** Filter sessions belonging to this workspace (ULID) */
  workspace_id: z.string().optional(),
  /** Filter sessions belonging to this device (ULID) */
  device_id: z.string().optional(),
  /** Comma-separated lifecycle values (e.g., "parsed,summarized") — validated after split */
  lifecycle: z.string().optional(),
  /** Sessions started after this ISO-8601 timestamp */
  after: z.string().datetime().optional(),
  /** Sessions started before this ISO-8601 timestamp */
  before: z.string().datetime().optional(),
  /** Sessions ended after this ISO-8601 timestamp */
  ended_after: z.string().datetime().optional(),
  /** Sessions ended before this ISO-8601 timestamp */
  ended_before: z.string().datetime().optional(),
  /** Filter sessions containing this tag */
  tag: z.string().optional(),
  /** Number of results per page (default 50, max 250) */
  limit: z.coerce.number().int().min(1).max(250).default(50),
  /** Cursor for pagination — base64 encoded { s: started_at, i: id } */
  cursor: z.string().optional(),
});

/** Inferred type for parsed session list query parameters */
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;

/**
 * Schema for PATCH /api/sessions/:id request body.
 *
 * Supports three tag mutation modes (mutually exclusive):
 *   - `tags`: Replace entire tag array
 *   - `add_tags`: Append unique tags to existing array
 *   - `remove_tags`: Remove matching tags from existing array
 *
 * The mutual exclusivity constraint (at most one of tags/add_tags/remove_tags)
 * is enforced at the route handler level with a clear 400 error message,
 * rather than in the schema, for better error reporting.
 */
export const sessionPatchSchema = z.object({
  /** Replace the entire tags array */
  tags: z.array(z.string()).optional(),
  /** Append these tags (duplicates are deduplicated) */
  add_tags: z.array(z.string()).optional(),
  /** Remove these tags from the existing array */
  remove_tags: z.array(z.string()).optional(),
  /** Update the session summary text */
  summary: z.string().optional(),
});

/** Inferred type for parsed session patch body */
export type SessionPatch = z.infer<typeof sessionPatchSchema>;

/**
 * Validate that comma-separated lifecycle values are all valid.
 * Returns the array of valid lifecycle strings, or null if any are invalid.
 *
 * @param lifecycleParam - Raw comma-separated string from query parameter
 * @returns Array of validated lifecycle strings, or null if validation fails
 */
export function parseLifecycleParam(
  lifecycleParam: string,
): typeof VALID_LIFECYCLES[number][] | null {
  const values = lifecycleParam.split(",").map((v) => v.trim()).filter(Boolean);
  for (const v of values) {
    if (!VALID_LIFECYCLES.includes(v as typeof VALID_LIFECYCLES[number])) {
      return null;
    }
  }
  return values as typeof VALID_LIFECYCLES[number][];
}

/**
 * Schema for POST /api/sessions/batch-status request body.
 * Accepts an array of session IDs and returns their lifecycle/parse_status.
 * Capped at 500 to prevent oversized queries.
 */
export const batchStatusRequestSchema = z.object({
  session_ids: z.array(z.string()).min(1).max(500),
});

/** Inferred type for batch status request */
export type BatchStatusRequest = z.infer<typeof batchStatusRequestSchema>;
