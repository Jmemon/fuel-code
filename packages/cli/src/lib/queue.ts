/**
 * Local event queue for fuel-code.
 *
 * When the backend is unreachable or slow, events are persisted to disk as
 * individual JSON files in ~/.fuel-code/queue/. A separate drain process
 * (Task 12) reads from this queue and retries delivery.
 *
 * Key design decisions:
 *   - Atomic writes: write to .tmp file then rename, so readers never see
 *     partial files.
 *   - ULID filenames: events sort chronologically by filename since ULIDs
 *     are lexicographically time-ordered.
 *   - NEVER throw from enqueueEvent: this is the last-resort fallback path.
 *     If even disk writes fail, we log the error and return an empty string.
 *   - Dead-letter directory: events that repeatedly fail delivery are moved
 *     here for manual inspection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import pino from "pino";
import type { Event } from "@fuel-code/shared";
import { QUEUE_DIR, DEAD_LETTER_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// Logger — writes to stderr so it never pollutes stdout
// ---------------------------------------------------------------------------

const logger = pino({
  name: "fuel-code:queue",
  level: process.env.LOG_LEVEL ?? "warn",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 2 } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist an event to the local queue directory via atomic write.
 *
 * The file is named `{event.id}.json` so it sorts by ULID (chronological).
 * Write strategy: write to a .tmp file first, then rename for atomicity.
 *
 * @returns The path to the written file, or empty string if the write failed.
 *          NEVER throws — this is the last-resort fallback.
 */
export function enqueueEvent(event: Event, queueDir?: string): string {
  const dir = queueDir ?? QUEUE_DIR;

  try {
    // Ensure the queue directory exists
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${event.id}.json`;
    const filePath = path.join(dir, filename);

    // Atomic write: write to temp file in the same directory, then rename.
    // Same-directory rename is atomic on POSIX filesystems.
    const tmpPath = path.join(
      dir,
      `.${filename}.tmp.${crypto.randomBytes(4).toString("hex")}`,
    );

    fs.writeFileSync(tmpPath, JSON.stringify(event, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);

    return filePath;
  } catch (err) {
    // Last-resort: log but never throw. The event is lost, but the CLI
    // process must not fail with a non-zero exit code.
    logger.error(
      { err, eventId: event.id },
      "Failed to enqueue event to disk — event will be lost",
    );
    return "";
  }
}

/**
 * List all queued event files, sorted by filename (ULID chronological order).
 *
 * @returns Array of absolute file paths for .json files in the queue directory.
 */
export function listQueuedEvents(queueDir?: string): string[] {
  const dir = queueDir ?? QUEUE_DIR;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir);
  return files
    .filter((f) => f.endsWith(".json"))
    .sort() // ULID filenames are lexicographically time-ordered
    .map((f) => path.join(dir, f));
}

/**
 * Read and parse a queued event file.
 *
 * @returns The parsed Event object, or null if the file is missing or corrupted.
 */
export function readQueuedEvent(filePath: string): Event | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Event;
  } catch (err) {
    logger.warn(
      { err, filePath },
      "Failed to read queued event file — returning null",
    );
    return null;
  }
}

/**
 * Remove a queued event file after successful delivery.
 * Logs a warning on failure but does not throw.
 */
export function removeQueuedEvent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn(
      { err, filePath },
      "Failed to remove queued event file",
    );
  }
}

/**
 * Move a failed event file to the dead-letter directory.
 * Used when an event has exhausted delivery retries and needs manual review.
 */
export function moveToDeadLetter(
  filePath: string,
  deadLetterDir?: string,
): void {
  const dlDir = deadLetterDir ?? DEAD_LETTER_DIR;

  try {
    fs.mkdirSync(dlDir, { recursive: true });

    const filename = path.basename(filePath);
    const destPath = path.join(dlDir, filename);

    fs.renameSync(filePath, destPath);
  } catch (err) {
    logger.warn(
      { err, filePath, deadLetterDir: dlDir },
      "Failed to move event to dead-letter directory",
    );
  }
}

/**
 * Count the number of pending events in the queue.
 *
 * @returns Number of .json files in the queue directory.
 */
export function getQueueDepth(queueDir?: string): number {
  const dir = queueDir ?? QUEUE_DIR;

  if (!fs.existsSync(dir)) {
    return 0;
  }

  const files = fs.readdirSync(dir);
  return files.filter((f) => f.endsWith(".json")).length;
}

/**
 * Count the number of events in the dead-letter directory.
 *
 * @returns Number of files in the dead-letter directory.
 */
export function getDeadLetterDepth(deadLetterDir?: string): number {
  const dir = deadLetterDir ?? DEAD_LETTER_DIR;

  if (!fs.existsSync(dir)) {
    return 0;
  }

  return fs.readdirSync(dir).length;
}
