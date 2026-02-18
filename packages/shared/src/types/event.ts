/**
 * Event type definitions for the fuel-code event system.
 *
 * Events are the core data primitive — every user action, system signal,
 * and lifecycle transition is captured as an Event and ingested to the backend.
 *
 * There are 14 event types across 4 categories:
 *   - session.*    — Claude Code session lifecycle
 *   - git.*        — git operations detected by hooks
 *   - remote.*     — remote dev environment provisioning
 *   - system.*     — device registration, hook installation, heartbeats
 */

/** All 14 event types in the fuel-code system */
export type EventType =
  | "session.start"
  | "session.end"
  | "session.compact"
  | "git.commit"
  | "git.push"
  | "git.checkout"
  | "git.merge"
  | "remote.provision.start"
  | "remote.provision.ready"
  | "remote.provision.error"
  | "remote.terminate"
  | "system.device.register"
  | "system.hooks.installed"
  | "system.heartbeat";

/**
 * Runtime array of all EventType values.
 * Used by Zod schemas for enum validation and by any code
 * that needs to iterate over known event types.
 */
export const EVENT_TYPES = [
  "session.start",
  "session.end",
  "session.compact",
  "git.commit",
  "git.push",
  "git.checkout",
  "git.merge",
  "remote.provision.start",
  "remote.provision.ready",
  "remote.provision.error",
  "remote.terminate",
  "system.device.register",
  "system.hooks.installed",
  "system.heartbeat",
] as const satisfies readonly EventType[];

/**
 * Reference to a blob stored in S3 (e.g., transcript file).
 * Stored alongside the event so consumers can fetch the blob by key.
 */
export interface BlobRef {
  /** S3 object key */
  key: string;
  /** MIME type of the blob (e.g., "application/json") */
  content_type: string;
  /** Size in bytes, for quota tracking and display */
  size_bytes: number;
}

/**
 * The core Event interface — every activity signal in fuel-code.
 * Maps directly to the `events` Postgres table.
 */
export interface Event {
  /** ULID — globally unique, time-sortable identifier */
  id: string;
  /** One of the 14 EventType values */
  type: EventType;
  /** ISO-8601 timestamp of when the event occurred on the client */
  timestamp: string;
  /** Device that generated this event */
  device_id: string;
  /** Workspace (repo) this event belongs to */
  workspace_id: string;
  /** Session this event is part of (null for non-session events like git hooks) */
  session_id: string | null;
  /** Type-specific payload — validated per-type by payload registry */
  data: Record<string, unknown>;
  /** Server-side timestamp of when this event was ingested (null before ingestion) */
  ingested_at: string | null;
  /** References to blobs in S3 associated with this event */
  blob_refs: BlobRef[];
}

/**
 * Request body for the POST /ingest endpoint.
 * Clients batch events and send them in a single request.
 */
export interface IngestRequest {
  events: Event[];
}

/**
 * Response from the POST /ingest endpoint.
 * Reports how many events were accepted, deduplicated, or rejected.
 */
export interface IngestResponse {
  /** Number of events successfully ingested */
  ingested: number;
  /** Number of events skipped due to duplicate IDs */
  duplicates: number;
  /** Number of events rejected due to validation errors (optional) */
  rejected?: number;
  /** Per-event errors, indexed by position in the request array (optional) */
  errors?: Array<{ index: number; error: string }>;
}
