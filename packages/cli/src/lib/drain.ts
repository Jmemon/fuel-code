/**
 * Queue drainer for fuel-code.
 *
 * Reads locally queued events from ~/.fuel-code/queue/ and attempts to POST
 * them to the backend in batches. Two modes of operation:
 *   - Foreground: user runs `fuel-code queue drain` — prints progress to stdout
 *   - Background: spawned silently by `fuel-code emit` after queuing an event
 *
 * Key behaviors:
 *   - Batches events according to config.pipeline.batch_size (default 50)
 *   - Uses 10s timeout (drainer is not latency-sensitive)
 *   - On 401: stops immediately (invalid API key)
 *   - On network error / timeout: stops, leaves remaining events in queue
 *   - Tracks per-event delivery attempts via _attempts field in the JSON file
 *   - Events that exceed 100 attempts are moved to dead-letter directory
 *   - Corrupted (unreadable) files are moved to dead-letter immediately
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import pino from "pino";
import { NetworkError, type Event, type IngestResponse } from "@fuel-code/shared";
import type { FuelCodeConfig } from "./config.js";
import type { ApiClient } from "./api-client.js";
import { createApiClient } from "./api-client.js";
import {
  listQueuedEvents,
  readQueuedEvent,
  removeQueuedEvent,
  moveToDeadLetter,
} from "./queue.js";

// ---------------------------------------------------------------------------
// Logger — writes to stderr so it never pollutes stdout
// ---------------------------------------------------------------------------

const logger = pino({
  name: "fuel-code:drain",
  level: process.env.LOG_LEVEL ?? "warn",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 2 } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of delivery attempts before an event is dead-lettered */
const MAX_ATTEMPTS = 100;

/** Timeout (ms) for drain POST requests — drainer is not latency-sensitive */
const DRAIN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result summary returned after a drain attempt */
export interface DrainResult {
  /** Number of events successfully delivered to the backend */
  drained: number;
  /** Number of events the backend reported as duplicates */
  duplicates: number;
  /** Number of events still remaining in the queue */
  remaining: number;
  /** Number of events moved to the dead-letter directory this drain cycle */
  deadLettered: number;
  /** Human-readable error messages encountered during draining */
  errors: string[];
}

/** Options to control drain behavior */
export interface DrainOptions {
  /** If true, print progress to stdout (used by `fuel-code queue drain`) */
  foreground?: boolean;
  /** Limit number of batches to process (useful for testing) */
  maxBatches?: number;
  /** Override the queue directory (for testing) */
  queueDir?: string;
  /** Override the dead-letter directory (for testing) */
  deadLetterDir?: string;
  /** Inject an API client (for testing — avoids real HTTP calls) */
  apiClient?: ApiClient;
}

// ---------------------------------------------------------------------------
// Core drain logic
// ---------------------------------------------------------------------------

/**
 * Drain the local event queue by posting batched events to the backend.
 *
 * Reads all queued event files, groups them into batches, and POSTs each
 * batch to the ingest endpoint. Successfully delivered events are removed
 * from the queue. Failed events have their _attempts counter incremented,
 * and events exceeding MAX_ATTEMPTS are moved to the dead-letter directory.
 *
 * @param config - CLI configuration (backend URL, API key, batch size, etc.)
 * @param options - Optional behavior overrides (foreground mode, test mocks, etc.)
 * @returns Summary of what happened during this drain cycle
 */
export async function drainQueue(
  config: FuelCodeConfig,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const result: DrainResult = {
    drained: 0,
    duplicates: 0,
    remaining: 0,
    deadLettered: 0,
    errors: [],
  };

  // 1. List all queued event files
  const filePaths = listQueuedEvents(options.queueDir);
  if (filePaths.length === 0) {
    return result;
  }

  // 2. Create API client (use injected mock if provided, for tests)
  const client = options.apiClient ?? createApiClient({
    ...config,
    pipeline: {
      ...config.pipeline,
      // Override timeout — drainer uses a longer 10s timeout
      post_timeout_ms: DRAIN_TIMEOUT_MS,
    },
  });

  // 3. Batch into groups of config.pipeline.batch_size
  const batchSize = config.pipeline.batch_size;
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += batchSize) {
    batches.push(filePaths.slice(i, i + batchSize));
  }

  // Limit batches if maxBatches option is set
  const batchLimit = options.maxBatches ?? batches.length;

  // 4. Process each batch
  for (let batchIdx = 0; batchIdx < Math.min(batches.length, batchLimit); batchIdx++) {
    const batch = batches[batchIdx];

    // 4a. Read each event file. Corrupted files go directly to dead-letter.
    const events: Event[] = [];
    const eventFileMap: Map<string, string> = new Map(); // event.id → filePath

    for (const filePath of batch) {
      const event = readQueuedEvent(filePath);
      if (event === null) {
        // Corrupted / unreadable file — dead-letter it immediately
        logger.warn({ filePath }, "Corrupted queue file — moving to dead-letter");
        moveToDeadLetter(filePath, options.deadLetterDir);
        result.deadLettered++;
        continue;
      }

      // Check if this event has exceeded max attempts
      const rawJson = readRawJson(filePath);
      if (rawJson && (rawJson._attempts as number) >= MAX_ATTEMPTS) {
        logger.warn(
          { filePath, attempts: rawJson._attempts },
          "Event exceeded max attempts — moving to dead-letter",
        );
        moveToDeadLetter(filePath, options.deadLetterDir);
        result.deadLettered++;
        continue;
      }

      events.push(event);
      eventFileMap.set(event.id, filePath);
    }

    // Skip batch if all files were corrupted or dead-lettered
    if (events.length === 0) {
      continue;
    }

    // 4b. POST the batch to the ingest endpoint
    if (options.foreground) {
      const totalQueued = filePaths.length;
      const processed = batchIdx * batchSize + events.length;
      process.stdout.write(`Draining: ${Math.min(processed, totalQueued)}/${totalQueued} events...\r`);
    }

    let response: IngestResponse;
    try {
      response = await client.ingest(events);
    } catch (err) {
      // Classify the error to decide behavior
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (err instanceof NetworkError) {
        // Check for 401 (invalid API key)
        if (err.context?.status === 401) {
          result.errors.push("Invalid API key.");
          // Increment attempts for all events in this failed batch
          for (const [, filePath] of eventFileMap) {
            await incrementAttemptAndMaybeDL(filePath, result, options.deadLetterDir);
          }
          break;
        }

        // Check for 503 or timeout
        if (
          err.context?.status === 503 ||
          errorMsg.includes("timeout") ||
          errorMsg.includes("abort")
        ) {
          result.errors.push(`Backend unavailable: ${errorMsg}`);
          for (const [, filePath] of eventFileMap) {
            await incrementAttemptAndMaybeDL(filePath, result, options.deadLetterDir);
          }
          break;
        }
      }

      // Generic network error — stop processing
      result.errors.push(`Network error: ${errorMsg}`);
      for (const [, filePath] of eventFileMap) {
        await incrementAttemptAndMaybeDL(filePath, result, options.deadLetterDir);
      }
      break;
    }

    // 4c. On success: process the response
    // The IngestResponse has { ingested: number, duplicates: number }
    // All events in the batch were accepted (ingested or deduplicated), so remove them all
    result.drained += response.ingested;
    result.duplicates += response.duplicates;

    // Remove all event files that were in this successful batch
    for (const [, filePath] of eventFileMap) {
      removeQueuedEvent(filePath);
    }
  }

  // Count remaining events in the queue
  result.remaining = listQueuedEvents(options.queueDir).length;

  if (options.foreground) {
    // Clear the progress line
    process.stdout.write("\n");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Attempt tracking
// ---------------------------------------------------------------------------

/**
 * Increment the _attempts counter in a queued event file.
 *
 * Reads the raw JSON from the file, increments the _attempts field
 * (defaults to 0 if absent), and atomically rewrites the file.
 *
 * @param filePath - Absolute path to the event JSON file
 * @returns The new attempt count after incrementing
 */
export function addAttempt(filePath: string): number {
  // Read the raw JSON (preserving _attempts and any other metadata)
  const raw = readRawJson(filePath);
  if (!raw) {
    // File is unreadable — return 1 as a best effort
    return 1;
  }

  const currentAttempts = typeof raw._attempts === "number" ? raw._attempts : 0;
  const newAttempts = currentAttempts + 1;
  raw._attempts = newAttempts;

  // Atomic rewrite: write to temp file, then rename
  const tmpPath = `${filePath}.tmp.${crypto.randomBytes(4).toString("hex")}`;

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    logger.warn({ err, filePath }, "Failed to update attempt count");
  }

  return newAttempts;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a queue file as raw JSON (preserves _attempts and other metadata).
 * Returns null if the file cannot be read or parsed.
 */
function readRawJson(filePath: string): Record<string, unknown> | null {
  try {
    const contents = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Increment the attempt counter for a failed event file.
 * If the attempt count reaches MAX_ATTEMPTS, move it to dead-letter.
 */
async function incrementAttemptAndMaybeDL(
  filePath: string,
  result: DrainResult,
  deadLetterDir?: string,
): Promise<void> {
  const newCount = addAttempt(filePath);
  if (newCount >= MAX_ATTEMPTS) {
    moveToDeadLetter(filePath, deadLetterDir);
    result.deadLettered++;
  }
}
