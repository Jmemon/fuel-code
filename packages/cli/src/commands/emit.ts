/**
 * `fuel-code emit` command.
 *
 * The internal command called by git hooks and Claude Code hooks to send
 * events to the backend. This is the most performance-critical CLI path.
 *
 * Design constraints:
 *   - MUST complete within 2 seconds total
 *   - Exit code MUST always be 0 (hooks must not fail)
 *   - No stdout on success (hooks capture stdout)
 *   - Zero data loss: if the backend is unreachable, events go to the local queue
 *
 * Flow:
 *   1. Load config. If missing, try to queue with hardcoded path, exit 0.
 *   2. Parse --data JSON. If invalid, wrap as { _raw: theString }, log warning.
 *   3. Construct Event object with ULID, timestamps, device/workspace/session IDs.
 *   4. Attempt HTTP POST to backend. On success, exit 0.
 *   5. On any failure, fall through to local queue. Exit 0.
 */

import { Command } from "commander";
import pino from "pino";
import { generateId, type Event, type EventType } from "@fuel-code/shared";
import { loadConfig, QUEUE_DIR, type FuelCodeConfig } from "../lib/config.js";
import { createApiClient } from "../lib/api-client.js";
import { enqueueEvent } from "../lib/queue.js";

// ---------------------------------------------------------------------------
// Logger — writes to stderr to keep stdout clean for hooks
// ---------------------------------------------------------------------------

const logger = pino({
  name: "fuel-code:emit",
  level: process.env.LOG_LEVEL ?? "warn",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 2 } }
      : undefined,
});

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * Create the `emit` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createEmitCommand(): Command {
  const cmd = new Command("emit")
    .description("Emit an event to the backend (used by hooks)")
    .argument("<event-type>", "Event type (e.g., git.commit, session.start)")
    .option("--data <json>", "Event payload as JSON string", "{}")
    .option("--data-stdin", "Read event data JSON from stdin instead of --data")
    .option("--session-id <id>", "Session ID this event belongs to")
    .option(
      "--workspace-id <id>",
      "Workspace ID for this event",
      "_unassociated",
    )
    .action(async (eventType: string, opts: EmitOptions) => {
      await runEmit(eventType, opts);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options parsed by Commander for the emit command */
interface EmitOptions {
  data: string;
  dataStdin?: boolean;
  sessionId?: string;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Core emit logic — extracted for testability
// ---------------------------------------------------------------------------

/**
 * Core emit logic. Separated from Commander for unit testing.
 *
 * This function NEVER throws and NEVER sets a non-zero exit code.
 * If anything goes wrong, the event is queued locally and we exit 0.
 */
export async function runEmit(
  eventType: string,
  opts: EmitOptions,
): Promise<void> {
  // 1. Load config. If missing, try to queue with hardcoded path.
  let config: FuelCodeConfig | null = null;
  try {
    config = loadConfig();
  } catch {
    // Config not found or corrupted — still try to queue the event
    logger.warn("Config not found — will attempt to queue event with hardcoded path");
  }

  // 2. Parse event data — from stdin (--data-stdin) or from --data argument.
  let data: Record<string, unknown>;

  if (opts.dataStdin) {
    // Read JSON from stdin (used by git hooks via heredoc piping)
    // Declare stdinText outside try so the catch block can wrap it as _raw
    let stdinText = "";
    try {
      stdinText = await Bun.stdin.text();
      const parsed = JSON.parse(stdinText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      } else {
        // Valid JSON but not an object — wrap it
        data = { _raw: stdinText };
      }
    } catch {
      // Not valid JSON — wrap the raw stdin text (consistent with --data path)
      logger.warn("Failed to parse stdin as JSON — wrapping as { _raw }");
      data = { _raw: stdinText };
    }
  } else {
    // Parse --data argument JSON. If invalid, wrap as { _raw: theString }.
    try {
      const parsed = JSON.parse(opts.data);
      // Ensure it's an object, not a primitive or array
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      } else {
        // Valid JSON but not an object — wrap it
        logger.warn({ rawData: opts.data }, "Event data is valid JSON but not an object — wrapping as { _raw }");
        data = { _raw: opts.data };
      }
    } catch {
      // Not valid JSON — wrap the raw string
      logger.warn({ rawData: opts.data }, "Event data is not valid JSON — wrapping as { _raw }");
      data = { _raw: opts.data };
    }
  }

  // 3. Construct the Event object
  const event: Event = {
    id: generateId(),
    type: eventType as EventType,
    timestamp: new Date().toISOString(),
    device_id: config?.device.id ?? "unknown",
    workspace_id: opts.workspaceId,
    session_id: opts.sessionId ?? null,
    data,
    ingested_at: null,
    blob_refs: [],
  };

  // 4. Attempt HTTP POST to backend (only if we have config)
  if (config) {
    try {
      const client = createApiClient(config);
      await client.ingest([event]);
      // Success — exit silently
      return;
    } catch (err) {
      // Any failure (timeout, network error, HTTP error) — fall through to queue
      logger.warn(
        { err, eventId: event.id },
        "Backend ingest failed — falling through to local queue",
      );
    }
  }

  // 5. Queue fallback: persist to disk
  const queueDir = config?.pipeline.queue_path ?? QUEUE_DIR;
  const queuedPath = enqueueEvent(event, queueDir);

  if (queuedPath) {
    logger.debug({ eventId: event.id, path: queuedPath }, "Event queued locally");
  } else {
    // Even disk write failed — log the event data to stderr as absolute last resort
    logger.error(
      { event },
      "CRITICAL: Failed to queue event to disk — event data logged here as last resort",
    );
  }

  // Always exit 0 — hooks must not fail
}
