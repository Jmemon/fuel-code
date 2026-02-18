/**
 * Base Zod schemas for event validation.
 *
 * These schemas validate the event envelope — the structure common to all events.
 * Type-specific payload validation is handled by the payload registry.
 *
 * Used by:
 *   - Server ingest endpoint to validate incoming event batches
 *   - CLI to validate events before queuing
 */

import { z } from "zod";
import { EVENT_TYPES } from "../types/event.js";

/** ULID format: 26 uppercase Crockford Base32 characters */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Schema for a blob reference — a pointer to an S3 object.
 * Validated when events include file attachments (e.g., transcripts).
 */
export const blobRefSchema = z.object({
  /** S3 object key */
  key: z.string().min(1),
  /** MIME type (e.g., "application/json") */
  content_type: z.string().min(1),
  /** File size in bytes */
  size_bytes: z.number().int().nonnegative(),
});

/**
 * Schema for a single event envelope.
 * Validates structure and format but NOT the type-specific payload in `data`.
 * Payload validation is deferred to the payload registry for flexibility.
 */
export const eventSchema = z.object({
  /** ULID — must match Crockford Base32 format */
  id: z.string().regex(ULID_REGEX, "id must be a valid ULID"),
  /** Must be one of the 14 known event types */
  type: z.enum(EVENT_TYPES),
  /** ISO-8601 datetime string */
  timestamp: z.string().datetime(),
  /** Device that generated this event */
  device_id: z.string().min(1),
  /** Workspace this event belongs to */
  workspace_id: z.string().min(1),
  /** Session ID (null for non-session events like git hooks) */
  session_id: z.string().nullable(),
  /** Type-specific payload — permissive at envelope level */
  data: z.record(z.unknown()),
  /** Blob references for associated S3 objects */
  blob_refs: z.array(blobRefSchema).default([]),
});

/**
 * Schema for the ingest request body (POST /ingest).
 * Enforces batch size limits: min 1, max 100 events per request.
 */
export const ingestRequestSchema = z.object({
  events: z.array(eventSchema).min(1).max(100),
});
