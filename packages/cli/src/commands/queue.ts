/**
 * `fuel-code queue` command group.
 *
 * Subcommands for managing the local event queue:
 *   - status      — Show queue depth, dead-letter depth, and oldest event age
 *   - drain       — Flush queued events to the backend (foreground mode)
 *   - dead-letter — List events in the dead-letter directory
 *
 * The local queue acts as a durable buffer when the backend is unreachable.
 * Events are persisted as JSON files in ~/.fuel-code/queue/ and delivered
 * by the drainer (either background after emit, or manually via this command).
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigError, extractTimestamp } from "@fuel-code/shared";
import { configExists, loadConfig, getQueueDir, getDeadLetterDir } from "../lib/config.js";
import {
  getQueueDepth,
  getDeadLetterDepth,
  listQueuedEvents,
  readQueuedEvent,
} from "../lib/queue.js";
import { drainQueue } from "../lib/drain.js";

// ---------------------------------------------------------------------------
// Command group factory
// ---------------------------------------------------------------------------

/**
 * Create the `queue` command group with status, drain, and dead-letter subcommands.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createQueueCommand(): Command {
  const cmd = new Command("queue")
    .description("Manage the local event queue");

  // --- queue status ---
  cmd
    .command("status")
    .description("Show queue depth, dead-letter count, and oldest event age")
    .action(async () => {
      await runQueueStatus();
    });

  // --- queue drain ---
  cmd
    .command("drain")
    .description("Flush queued events to the backend")
    .action(async () => {
      await runQueueDrain();
    });

  // --- queue dead-letter ---
  cmd
    .command("dead-letter")
    .description("List events in the dead-letter directory")
    .action(async () => {
      await runDeadLetter();
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/**
 * `fuel-code queue status` — display current queue health.
 *
 * Shows:
 *   - Number of pending events in the queue
 *   - Number of dead-lettered events
 *   - Age of the oldest queued event (derived from the ULID filename)
 */
export async function runQueueStatus(): Promise<void> {
  const queueDepth = getQueueDepth();
  const dlDepth = getDeadLetterDepth();

  // Determine the age of the oldest event by reading the first queued file's ULID
  let oldestAge = "n/a";
  const queuedFiles = listQueuedEvents();
  if (queuedFiles.length > 0) {
    oldestAge = getEventAge(queuedFiles[0]);
  }

  console.log(`Queue:       ${queueDepth} event${queueDepth === 1 ? "" : "s"} pending`);
  console.log(`Dead letter: ${dlDepth} event${dlDepth === 1 ? "" : "s"}`);
  console.log(`Oldest:      ${oldestAge}`);
}

/**
 * `fuel-code queue drain` — flush the local queue to the backend.
 *
 * Runs drainQueue in foreground mode (prints progress to stdout).
 * Requires a valid config (backend URL and API key).
 */
export async function runQueueDrain(): Promise<void> {
  // Ensure fuel-code is initialized
  if (!configExists()) {
    console.log("fuel-code is not initialized. Run 'fuel-code init' first.");
    process.exitCode = 1;
    return;
  }

  // Load config
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error (${err.code}): ${err.message}`);
    } else {
      console.error("Failed to load config:", err);
    }
    process.exitCode = 1;
    return;
  }

  // Run the drain in foreground mode (prints progress)
  const result = await drainQueue(config, { foreground: true });

  // Print results summary
  console.log("");
  console.log(`Drained:      ${result.drained} event${result.drained === 1 ? "" : "s"}`);
  console.log(`Duplicates:   ${result.duplicates}`);
  console.log(`Dead-lettered: ${result.deadLettered}`);
  console.log(`Remaining:    ${result.remaining}`);

  if (result.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }
}

/**
 * `fuel-code queue dead-letter` — list dead-lettered events.
 *
 * For each file in the dead-letter directory, prints the event ID,
 * type, timestamp, and attempt count.
 */
export async function runDeadLetter(): Promise<void> {
  const dlDir = getDeadLetterDir();

  if (!fs.existsSync(dlDir)) {
    console.log("No dead-lettered events.");
    return;
  }

  const files = fs.readdirSync(dlDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dlDir, f));

  if (files.length === 0) {
    console.log("No dead-lettered events.");
    return;
  }

  console.log(`Dead-lettered events (${files.length}):\n`);

  for (const filePath of files) {
    const raw = readRawDeadLetter(filePath);
    if (!raw) {
      console.log(`  ${path.basename(filePath)} — unreadable`);
      continue;
    }

    const id = (raw.id as string) ?? "unknown";
    const type = (raw.type as string) ?? "unknown";
    const timestamp = (raw.timestamp as string) ?? "unknown";
    const attempts = typeof raw._attempts === "number" ? raw._attempts : "?";

    console.log(`  ID:        ${id}`);
    console.log(`  Type:      ${type}`);
    console.log(`  Timestamp: ${timestamp}`);
    console.log(`  Attempts:  ${attempts}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute a human-readable relative time string for a queued event file.
 * Extracts the timestamp from the ULID in the filename.
 */
function getEventAge(filePath: string): string {
  try {
    // Extract the ULID from the filename (e.g., "01HZTEST...AAAA.json" → "01HZTEST...AAAA")
    const basename = path.basename(filePath, ".json");
    const eventTime = extractTimestamp(basename);
    const diffMs = Date.now() - eventTime.getTime();

    if (diffMs < 1000) return "just now";
    if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)} seconds ago`;
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} minutes ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} hours ago`;
    return `${Math.floor(diffMs / 86_400_000)} days ago`;
  } catch {
    return "unknown";
  }
}

/**
 * Read a dead-letter file as raw JSON (preserves _attempts metadata).
 * Returns null if the file cannot be read or parsed.
 */
function readRawDeadLetter(filePath: string): Record<string, unknown> | null {
  try {
    const contents = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(contents) as Record<string, unknown>;
  } catch {
    return null;
  }
}
