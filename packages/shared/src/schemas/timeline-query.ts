/**
 * Zod validation schema for the GET /api/timeline query parameters.
 *
 * The timeline endpoint returns a session-grouped activity feed with embedded
 * git activity highlights. Query parameters allow filtering by workspace,
 * device, time range, git activity types, and cursor-based pagination.
 *
 * All fields are optional. `limit` is coerced from string to number since
 * Express query params are always strings. `types` is a comma-separated list
 * of git activity types (commit, push, checkout, merge) that gets transformed
 * into an array.
 */

import { z } from "zod";

/**
 * Schema for GET /api/timeline query parameters.
 *
 * Filters:
 *   - workspace_id: Show only sessions/activity for this workspace
 *   - device_id: Show only sessions/activity for this device
 *   - after: Only sessions started after this ISO-8601 timestamp
 *   - before: Only sessions started before this ISO-8601 timestamp
 *   - types: Comma-separated git activity types to include (commit,push,checkout,merge)
 *   - limit: Number of session-level items per page (default 20, max 100)
 *   - cursor: Opaque pagination token (base64 JSON with { s, i } fields)
 */
export const timelineQuerySchema = z.object({
  /** Filter to a specific workspace (ULID) */
  workspace_id: z.string().optional(),
  /** Filter to a specific device (ULID) */
  device_id: z.string().optional(),
  /** Only include sessions started after this ISO-8601 datetime */
  after: z.string().datetime({ offset: true }).optional(),
  /** Only include sessions started before this ISO-8601 datetime */
  before: z.string().datetime({ offset: true }).optional(),
  /** Comma-separated git activity types to filter (e.g., "commit,push") — transformed to array */
  types: z.string().optional().transform(val => val ? val.split(',') : null),
  /** Number of session-level items per page (default 20, max 100) */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque pagination cursor — base64-encoded JSON { s: started_at, i: session_id } */
  cursor: z.string().optional(),
});

/** Inferred type for parsed timeline query parameters */
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
