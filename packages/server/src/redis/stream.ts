/**
 * Redis Streams abstraction for the fuel-code event pipeline.
 *
 * Events flow through Redis Streams as the primary transport:
 *   HTTP POST /ingest → publishToStream → Redis Stream → readFromStream → Processor → Postgres
 *
 * This module provides:
 *   - Consumer group setup (XGROUP CREATE with MKSTREAM)
 *   - Single and batch publish (XADD / pipeline)
 *   - Consumer group reads (XREADGROUP with blocking)
 *   - Acknowledgement (XACK)
 *   - Pending entry reclamation (XAUTOCLAIM with XPENDING+XCLAIM fallback)
 *
 * All functions take a Redis instance as the first argument so they're
 * testable with mocks and don't hold module-level state.
 */

import type Redis from "ioredis";
import { hostname } from "os";
import type { Event } from "@fuel-code/shared";
import { StorageError } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The Redis Stream key where incoming events are published */
export const EVENTS_STREAM = "events:incoming";

/** Consumer group name — all event processor workers join this group */
export const CONSUMER_GROUP = "event-processors";

/**
 * Unique consumer name for this process.
 * Combines the OS hostname with the PID so each worker in a fleet
 * gets a distinct name (important for XREADGROUP and XCLAIM).
 */
export const CONSUMER_NAME = `${hostname()}-${process.pid}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry read from the Redis Stream */
export interface StreamEntry {
  /** The Redis Stream entry ID (e.g. "1234567890-0") */
  streamId: string;
  /** The deserialized Event object stored in this entry */
  event: Event;
}

/** Result of a batch publish operation — reports per-event success/failure */
export interface BatchPublishResult {
  /** Events that were successfully added to the stream */
  succeeded: Array<{ eventId: string; streamId: string }>;
  /** Events that failed to be added (e.g. pipeline error) */
  failed: Array<{ eventId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Consumer Group Setup
// ---------------------------------------------------------------------------

/**
 * Ensure the consumer group exists on the events stream.
 *
 * Uses XGROUP CREATE with MKSTREAM so the stream is created automatically
 * if it doesn't exist yet. The group starts reading from ID "0" (beginning).
 *
 * If the group already exists, Redis returns a BUSYGROUP error which we
 * silently ignore — this is expected on repeated startups.
 *
 * @param redis - An ioredis client instance
 */
export async function ensureConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup("CREATE", EVENTS_STREAM, CONSUMER_GROUP, "0", "MKSTREAM");
  } catch (err: unknown) {
    // BUSYGROUP means the group already exists — that's fine
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("BUSYGROUP")) {
      throw new StorageError(
        "Failed to create consumer group",
        "STORAGE_REDIS_XGROUP",
        { stream: EVENTS_STREAM, group: CONSUMER_GROUP, error: message },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Serialize an Event into flat key-value pairs for XADD.
 *
 * Redis Stream entries are flat string maps, so we JSON-encode
 * nested fields (data, blob_refs) and store scalar fields directly.
 */
function serializeEvent(event: Event): string[] {
  return [
    "id", event.id,
    "type", event.type,
    "timestamp", event.timestamp,
    "device_id", event.device_id,
    "workspace_id", event.workspace_id,
    "session_id", event.session_id ?? "",
    "data", JSON.stringify(event.data),
    "ingested_at", event.ingested_at ?? "",
    "blob_refs", JSON.stringify(event.blob_refs),
  ];
}

/**
 * Deserialize a Redis Stream entry back into an Event.
 *
 * Reverses the serializeEvent encoding: parses JSON fields
 * and converts empty strings back to null.
 */
function deserializeEvent(fields: Record<string, string>): Event {
  return {
    id: fields.id,
    type: fields.type as Event["type"],
    timestamp: fields.timestamp,
    device_id: fields.device_id,
    workspace_id: fields.workspace_id,
    session_id: fields.session_id || null,
    data: JSON.parse(fields.data || "{}"),
    ingested_at: fields.ingested_at || null,
    blob_refs: JSON.parse(fields.blob_refs || "[]"),
  };
}

/**
 * Publish a single event to the Redis events stream.
 *
 * Uses XADD with auto-generated stream entry ID ("*").
 * The event is serialized into flat key-value pairs for storage.
 *
 * @param redis - An ioredis client instance
 * @param event - The Event to publish
 * @returns The Redis Stream entry ID assigned to this event
 * @throws StorageError if the XADD command fails
 */
export async function publishToStream(
  redis: Redis,
  event: Event,
): Promise<string> {
  try {
    const streamId = await redis.xadd(
      EVENTS_STREAM,
      "*",
      ...serializeEvent(event),
    );
    return streamId!;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StorageError(
      `Failed to publish event ${event.id} to stream`,
      "STORAGE_REDIS_XADD",
      { eventId: event.id, stream: EVENTS_STREAM, error: message },
    );
  }
}

/**
 * Publish multiple events to the stream in a single round-trip using a pipeline.
 *
 * Pipelines batch multiple XADD commands into one network request,
 * significantly reducing latency for bulk ingestion.
 *
 * Each event is processed independently — failures on one event
 * don't prevent others from succeeding.
 *
 * @param redis - An ioredis client instance
 * @param events - Array of Events to publish
 * @returns BatchPublishResult with per-event success/failure details
 */
export async function publishBatchToStream(
  redis: Redis,
  events: Event[],
): Promise<BatchPublishResult> {
  const result: BatchPublishResult = { succeeded: [], failed: [] };

  if (events.length === 0) {
    return result;
  }

  // Build a pipeline with one XADD per event
  const pipeline = redis.pipeline();
  for (const event of events) {
    pipeline.xadd(EVENTS_STREAM, "*", ...serializeEvent(event));
  }

  // Execute all commands in a single round-trip
  const responses = await pipeline.exec();

  // Process results — responses is Array<[error | null, result]>
  if (!responses) {
    // Pipeline returned null — treat all as failed
    for (const event of events) {
      result.failed.push({ eventId: event.id, error: "Pipeline returned null" });
    }
    return result;
  }

  for (let i = 0; i < events.length; i++) {
    const [err, streamId] = responses[i];
    if (err) {
      result.failed.push({
        eventId: events[i].id,
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      result.succeeded.push({
        eventId: events[i].id,
        streamId: streamId as string,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Consuming
// ---------------------------------------------------------------------------

/**
 * Convert raw Redis XREADGROUP/XCLAIM response into StreamEntry[].
 *
 * Redis returns entries as [streamId, [field1, value1, field2, value2, ...]].
 * We convert the flat array into a Record and then deserialize into an Event.
 */
function parseStreamEntries(
  entries: Array<[string, string[]]>,
): StreamEntry[] {
  return entries.map(([streamId, flatFields]) => {
    // Convert flat [k1, v1, k2, v2, ...] into { k1: v1, k2: v2, ... }
    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length; i += 2) {
      fields[flatFields[i]] = flatFields[i + 1];
    }
    return { streamId, event: deserializeEvent(fields) };
  });
}

/**
 * Read new entries from the stream as part of the consumer group.
 *
 * Uses XREADGROUP to receive entries that haven't been delivered to
 * this consumer yet. The ">" special ID means "give me new messages".
 *
 * Supports blocking reads — the call will wait up to `blockMs` milliseconds
 * for new entries before returning an empty array.
 *
 * @param redis - An ioredis client instance
 * @param count - Maximum number of entries to read per call
 * @param blockMs - How long to block waiting for new entries (0 = don't block)
 * @returns Array of StreamEntry objects (empty if nothing available)
 */
export async function readFromStream(
  redis: Redis,
  count: number,
  blockMs: number,
): Promise<StreamEntry[]> {
  try {
    const response = await redis.xreadgroup(
      "GROUP", CONSUMER_GROUP, CONSUMER_NAME,
      "COUNT", count,
      "BLOCK", blockMs,
      "STREAMS", EVENTS_STREAM,
      ">",
    );

    // xreadgroup returns null when the block timeout expires with no data
    if (!response) {
      return [];
    }

    // Response shape: [[streamKey, [[entryId, [field, value, ...]], ...]]]
    // We only read from one stream, so take the first (and only) element
    const [, entries] = response[0] as [string, Array<[string, string[]]>];
    return parseStreamEntries(entries);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StorageError(
      "Failed to read from event stream",
      "STORAGE_REDIS_XREADGROUP",
      { stream: EVENTS_STREAM, group: CONSUMER_GROUP, consumer: CONSUMER_NAME, error: message },
    );
  }
}

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

/**
 * Acknowledge a stream entry as processed.
 *
 * After successfully processing an event, call XACK so Redis knows
 * this entry doesn't need to be re-delivered. Un-acked entries will
 * show up in the Pending Entries List (PEL) and can be reclaimed.
 *
 * @param redis - An ioredis client instance
 * @param streamId - The Redis Stream entry ID to acknowledge
 */
export async function acknowledgeEntry(
  redis: Redis,
  streamId: string,
): Promise<void> {
  try {
    await redis.xack(EVENTS_STREAM, CONSUMER_GROUP, streamId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StorageError(
      `Failed to acknowledge stream entry ${streamId}`,
      "STORAGE_REDIS_XACK",
      { stream: EVENTS_STREAM, group: CONSUMER_GROUP, streamId, error: message },
    );
  }
}

// ---------------------------------------------------------------------------
// Pending Entry Reclamation
// ---------------------------------------------------------------------------

/**
 * Reclaim entries that have been pending (un-acked) for too long.
 *
 * When a consumer crashes or gets stuck, its claimed entries sit in the
 * Pending Entries List (PEL). This function transfers ownership of those
 * stale entries to the current consumer so they can be re-processed.
 *
 * First tries XAUTOCLAIM (Redis 6.2+). If the server doesn't support it
 * (older Redis), falls back to the manual XPENDING + XCLAIM approach.
 *
 * @param redis - An ioredis client instance
 * @param minIdleMs - Only claim entries idle for at least this many ms
 * @param count - Maximum number of entries to claim
 * @returns Array of reclaimed StreamEntry objects
 */
export async function claimPendingEntries(
  redis: Redis,
  minIdleMs: number,
  count: number,
): Promise<StreamEntry[]> {
  try {
    return await claimWithXautoclaim(redis, minIdleMs, count);
  } catch (err: unknown) {
    // If XAUTOCLAIM is not supported (ERR unknown command), fall back
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("unknown command") || message.includes("ERR")) {
      return await claimWithXpendingXclaim(redis, minIdleMs, count);
    }
    throw new StorageError(
      "Failed to claim pending stream entries",
      "STORAGE_REDIS_XCLAIM",
      { stream: EVENTS_STREAM, group: CONSUMER_GROUP, error: message },
    );
  }
}

/**
 * Claim pending entries using XAUTOCLAIM (Redis 6.2+).
 *
 * XAUTOCLAIM atomically scans the PEL for idle entries and transfers them
 * to the specified consumer in a single command.
 *
 * Response shape: [nextCursorId, [[entryId, [fields...]], ...], deletedIds]
 */
async function claimWithXautoclaim(
  redis: Redis,
  minIdleMs: number,
  count: number,
): Promise<StreamEntry[]> {
  const response = await redis.xautoclaim(
    EVENTS_STREAM,
    CONSUMER_GROUP,
    CONSUMER_NAME,
    minIdleMs,
    "0-0",
    "COUNT",
    count,
  );

  // XAUTOCLAIM returns: [nextStartId, entries, deletedIds]
  // entries is the array of [entryId, [field, value, ...]]
  if (!response || !response[1] || (response[1] as unknown[]).length === 0) {
    return [];
  }

  const entries = response[1] as Array<[string, string[]]>;
  return parseStreamEntries(entries);
}

/**
 * Fallback: claim pending entries using XPENDING + XCLAIM (Redis < 6.2).
 *
 * 1. XPENDING scans the PEL for entries idle longer than minIdleMs
 * 2. XCLAIM transfers ownership of those entries to the current consumer
 */
async function claimWithXpendingXclaim(
  redis: Redis,
  minIdleMs: number,
  count: number,
): Promise<StreamEntry[]> {
  // Get pending entries from the PEL
  const pending = await redis.xpending(
    EVENTS_STREAM,
    CONSUMER_GROUP,
    "IDLE",
    minIdleMs,
    "-",
    "+",
    count,
  );

  // xpending returns [] when nothing is pending
  if (!pending || pending.length === 0) {
    return [];
  }

  // Extract the stream IDs from pending entries
  // Each pending entry is [entryId, consumerName, idleTime, deliveryCount]
  const entryIds = (pending as Array<[string, string, number, number]>).map(
    (entry) => entry[0],
  );

  if (entryIds.length === 0) {
    return [];
  }

  // Claim those specific entries for the current consumer
  const claimed = await redis.xclaim(
    EVENTS_STREAM,
    CONSUMER_GROUP,
    CONSUMER_NAME,
    minIdleMs,
    ...entryIds,
  );

  if (!claimed || claimed.length === 0) {
    return [];
  }

  // XCLAIM returns entries in the same format as XRANGE
  return parseStreamEntries(claimed as Array<[string, string[]]>);
}
