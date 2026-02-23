/**
 * Redis Stream consumer loop for the fuel-code event pipeline.
 *
 * Reads events from the Redis Stream (via the consumer group) and dispatches
 * each one to the event processor. Handles retries, dead-lettering after 3
 * failures, pending entry reclamation on startup, and graceful shutdown.
 *
 * The consumer is started once during server boot and runs until stop() is
 * called (SIGTERM/SIGINT). It never crashes the process — all errors are
 * caught, logged, and retried.
 *
 * Flow: Redis Stream -> readFromStream -> processEvent -> acknowledgeEntry
 */

import type Redis from "ioredis";
import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { EventHandlerRegistry, ProcessResult, PipelineDeps } from "@fuel-code/core";
import type { Event } from "@fuel-code/shared";
import { processEvent as processEventImpl } from "@fuel-code/core";
import type { WsBroadcaster } from "../ws/broadcaster.js";

import {
  ensureConsumerGroup as ensureConsumerGroupImpl,
  readFromStream as readFromStreamImpl,
  acknowledgeEntry as acknowledgeEntryImpl,
  claimPendingEntries as claimPendingEntriesImpl,
  type StreamEntry,
} from "../redis/stream.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies injected into the consumer — keeps it testable without live services */
export interface ConsumerDeps {
  /** ioredis client for stream operations */
  redis: Redis;
  /** postgres.js tagged template client for event persistence */
  sql: Sql;
  /** Handler registry mapping event types to processing functions */
  registry: EventHandlerRegistry;
  /** Pino logger for structured logging */
  logger: Logger;
  /** Pipeline dependencies for post-processing (Phase 2) — passed through to processEvent */
  pipelineDeps?: PipelineDeps;
  /** Optional WebSocket broadcaster — when provided, broadcasts events after successful processing */
  broadcaster?: WsBroadcaster;
}

/**
 * Optional function overrides for testing.
 * When provided, these replace the real stream/processor calls.
 * In production, these are never passed — the defaults from the imports are used.
 */
export interface ConsumerOverrides {
  ensureConsumerGroup?: (redis: Redis) => Promise<void>;
  readFromStream?: (redis: Redis, count: number, blockMs: number) => Promise<StreamEntry[]>;
  acknowledgeEntry?: (redis: Redis, streamId: string) => Promise<void>;
  claimPendingEntries?: (redis: Redis, minIdleMs: number, count: number) => Promise<StreamEntry[]>;
  processEvent?: (sql: Sql, event: Event, registry: EventHandlerRegistry, logger: Logger, pipelineDeps?: PipelineDeps) => Promise<ProcessResult>;
  /** Override the reconnect delay (ms) for faster tests */
  reconnectDelayMs?: number;
  /** Override the stats interval (ms) for faster tests */
  statsIntervalMs?: number;
}

/** Handle returned by startConsumer — call stop() for graceful shutdown */
export interface ConsumerHandle {
  /** Signal the consumer loop to stop and wait for the current iteration to finish */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entries to read per loop iteration */
const READ_COUNT = 10;

/** How long to block waiting for new entries (ms) — keeps CPU idle when quiet */
const BLOCK_MS = 5_000;

/** Minimum idle time before reclaiming a pending entry from a crashed consumer (ms) */
const CLAIM_IDLE_MS = 60_000;

/** Maximum number of pending entries to reclaim on startup */
const CLAIM_COUNT = 100;

/** Maximum number of times to retry a failing event before dead-lettering it */
const MAX_RETRIES = 3;

/** How long to wait before retrying after a Redis connection error (ms) */
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

/** Interval between periodic stats log messages (ms) */
const DEFAULT_STATS_INTERVAL_MS = 60_000;

/** Maximum time to wait for the loop to exit after stop() is called (ms) */
const STOP_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Consumer implementation
// ---------------------------------------------------------------------------

/**
 * Start the Redis Stream consumer loop.
 *
 * On startup:
 *   1. Ensures the consumer group exists (idempotent)
 *   2. Reclaims pending entries from crashed consumers
 *   3. Processes reclaimed entries before reading new ones
 *
 * Main loop:
 *   - Reads up to 10 new entries, blocking 5s if none available
 *   - Processes each entry via processEvent
 *   - Acknowledges on success or duplicate
 *   - Retries failures up to 3 times, then dead-letters (ack + error log)
 *   - Logs stats every 60 seconds
 *
 * @param deps - Injected dependencies (redis, sql, registry, logger)
 * @param overrides - Optional function overrides for testing (never used in production)
 * @returns A ConsumerHandle with stop() for graceful shutdown
 */
export function startConsumer(
  deps: ConsumerDeps,
  overrides?: ConsumerOverrides,
): ConsumerHandle {
  const { redis, sql, registry, logger, pipelineDeps, broadcaster } = deps;

  // Resolve function implementations — use overrides for testing, defaults for production
  const ensureGroup = overrides?.ensureConsumerGroup ?? ensureConsumerGroupImpl;
  const readStream = overrides?.readFromStream ?? readFromStreamImpl;
  const ackEntry = overrides?.acknowledgeEntry ?? acknowledgeEntryImpl;
  const claimPending = overrides?.claimPendingEntries ?? claimPendingEntriesImpl;
  const processEvt = overrides?.processEvent ?? processEventImpl;
  const reconnectDelayMs = overrides?.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const statsIntervalMs = overrides?.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;

  /** Flag to signal the loop to exit */
  let shouldStop = false;

  /** Resolves when the loop has fully exited */
  let loopDone: Promise<void>;

  /** In-memory retry counter: streamId -> failure count */
  const failureCounts = new Map<string, number>();

  /** Cumulative stats for periodic logging */
  let statsProcessed = 0;
  let statsDuplicates = 0;
  let statsErrors = 0;
  let lastStatsTime = Date.now();

  /**
   * Process a single stream entry: call processEvent, handle ack/retry/dead-letter.
   *
   * @param entry - The stream entry containing a deserialized Event
   */
  async function handleEntry(entry: StreamEntry): Promise<void> {
    try {
      const result = await processEvt(sql, entry.event, registry, logger, pipelineDeps);

      if (result.status === "duplicate") {
        statsDuplicates++;
      } else {
        statsProcessed++;

        // Broadcast newly processed events to subscribed WebSocket clients.
        // Non-blocking — broadcastEvent is fire-and-forget with internal error handling.
        if (broadcaster) {
          broadcaster.broadcastEvent(entry.event);

          // Broadcast session lifecycle transitions for event types that cause them.
          // session.start -> lifecycle "capturing", session.end -> lifecycle "ended".
          const { session_id, workspace_id, type: eventType } = entry.event;
          if (session_id && workspace_id) {
            if (eventType === "session.start") {
              broadcaster.broadcastSessionUpdate(session_id, workspace_id, "detected");
            } else if (eventType === "session.end") {
              broadcaster.broadcastSessionUpdate(session_id, workspace_id, "ended");
            }
          }
        }
      }

      // Success or duplicate — acknowledge so Redis removes it from PEL
      await ackEntry(redis, entry.streamId);

      // Clear failure counter on success
      failureCounts.delete(entry.streamId);
    } catch (err) {
      statsErrors++;

      const currentFailures = (failureCounts.get(entry.streamId) ?? 0) + 1;
      failureCounts.set(entry.streamId, currentFailures);

      const errorMsg = err instanceof Error ? err.message : String(err);

      if (currentFailures >= MAX_RETRIES) {
        // Dead-letter: ack to prevent infinite retry, log permanent failure
        logger.error(
          {
            eventId: entry.event.id,
            eventType: entry.event.type,
            streamId: entry.streamId,
            attempts: currentFailures,
            error: errorMsg,
          },
          `Event ${entry.event.id} permanently failed after ${MAX_RETRIES} attempts: ${errorMsg}`,
        );
        await ackEntry(redis, entry.streamId);
        failureCounts.delete(entry.streamId);
      } else {
        // Transient failure — log and leave un-acked for retry
        logger.warn(
          {
            eventId: entry.event.id,
            eventType: entry.event.type,
            streamId: entry.streamId,
            attempt: currentFailures,
            error: errorMsg,
          },
          `Event ${entry.event.id} failed (attempt ${currentFailures}/${MAX_RETRIES}): ${errorMsg}`,
        );
      }
    }
  }

  /**
   * Log cumulative consumer stats every statsIntervalMs.
   * Called at the end of each loop iteration.
   */
  function maybeLogStats(): void {
    const now = Date.now();
    if (now - lastStatsTime >= statsIntervalMs) {
      logger.info(
        {
          processed: statsProcessed,
          duplicates: statsDuplicates,
          errors: statsErrors,
          pending: failureCounts.size,
        },
        `Consumer stats: ${statsProcessed} processed, ${statsDuplicates} duplicates, ${statsErrors} errors, ${failureCounts.size} pending`,
      );
      lastStatsTime = now;
    }
  }

  /**
   * The main consumer loop. Runs until shouldStop is set to true.
   * Never throws — all errors are caught and retried.
   */
  async function loop(): Promise<void> {
    // --- Startup: ensure consumer group exists (retry until success) ---
    while (!shouldStop) {
      try {
        await ensureGroup(redis);
        break; // Success — proceed to main loop
      } catch (err) {
        logger.error(
          { err },
          `Failed to ensure consumer group — retrying in ${reconnectDelayMs}ms`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, reconnectDelayMs);
          if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
          }
        });
      }
    }

    if (shouldStop) return; // Shutdown requested during startup retry loop

    try {
      const pendingEntries = await claimPending(redis, CLAIM_IDLE_MS, CLAIM_COUNT);
      if (pendingEntries.length > 0) {
        logger.info(
          { count: pendingEntries.length },
          `Reclaimed ${pendingEntries.length} pending entries from crashed consumers`,
        );
        for (const entry of pendingEntries) {
          if (shouldStop) break;
          await handleEntry(entry);
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to reclaim pending entries on startup");
      // Non-fatal — continue to main loop
    }

    // --- Main loop: read and process new entries ---
    while (!shouldStop) {
      try {
        const entries = await readStream(redis, READ_COUNT, BLOCK_MS);

        for (const entry of entries) {
          if (shouldStop) break;
          await handleEntry(entry);
        }

        maybeLogStats();
      } catch (err) {
        // Detect NOGROUP errors (Redis restarted, stream/group lost) and
        // re-create the consumer group before retrying. Without this, the
        // consumer spins forever on NOGROUP after a Redis restart.
        const errMsg = err instanceof Error ? err.message : String(err);
        const isNoGroup = errMsg.includes("NOGROUP");

        if (isNoGroup) {
          logger.warn("Consumer group lost (Redis restart?) — re-creating");
          try {
            await ensureGroup(redis);
            logger.info("Consumer group re-created successfully");
            continue; // Skip the delay — group is back, retry immediately
          } catch (groupErr) {
            logger.error({ err: groupErr }, "Failed to re-create consumer group");
          }
        }

        // Redis connection lost or other transient error — wait and retry
        logger.error(
          { err },
          `Consumer loop error — retrying in ${reconnectDelayMs}ms`,
        );

        // Sleep before retrying, but check shouldStop to avoid delaying shutdown
        if (!shouldStop) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, reconnectDelayMs);
            // Allow the timer to be cleaned up if the process exits
            if (typeof timer === "object" && "unref" in timer) {
              timer.unref();
            }
          });
        }
      }
    }
  }

  // Start the loop in the background (fire-and-forget, errors are caught internally)
  loopDone = loop();

  return {
    /**
     * Signal the consumer to stop and wait for the current iteration to finish.
     * Returns once the loop has exited, or after STOP_TIMEOUT_MS if it hangs.
     */
    async stop(): Promise<void> {
      shouldStop = true;

      // Race: either the loop finishes or we time out
      await Promise.race([
        loopDone,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn("Consumer stop timed out — forcing exit");
            resolve();
          }, STOP_TIMEOUT_MS);
          if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
          }
        }),
      ]);
    },
  };
}
