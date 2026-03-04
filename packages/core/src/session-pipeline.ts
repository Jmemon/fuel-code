/**
 * Session pipeline types and bounded work queue.
 *
 * The actual pipeline logic lives in `reconcile/reconcile-session.ts`.
 * This module provides:
 *   - Type exports (PipelineDeps, PipelineResult, S3Client)
 *   - createPipelineQueue: a bounded async work queue that calls reconcileSession
 *
 * Concurrency is managed via an async work queue that limits how many
 * pipelines run in parallel (the pending queue itself is unbounded since
 * it only holds lightweight session ID strings).
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { TranscriptStats } from "@fuel-code/shared";
import type { SummaryConfig } from "./summary-generator.js";
import { reconcileSession } from "./reconcile/reconcile-session.js";

// ---------------------------------------------------------------------------
// S3 client interface (minimal subset of FuelCodeS3Client from server)
// ---------------------------------------------------------------------------

/**
 * Minimal S3 client interface used by the pipeline.
 * Keeps core/ decoupled from server/ — the server passes in the concrete
 * FuelCodeS3Client which satisfies this interface.
 */
export interface S3Client {
  upload(key: string, body: Buffer | string, contentType?: string): Promise<{ key: string; size: number }>;
  download(key: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Pipeline dependencies and result types
// ---------------------------------------------------------------------------

/** Dependencies injected into the pipeline — keeps it testable */
export interface PipelineDeps {
  sql: Sql;
  s3: S3Client;
  summaryConfig: SummaryConfig;
  logger: Logger;
  /**
   * Queue-based pipeline trigger. When set, callers should use this
   * to respect concurrency limits. Wired up by server startup via
   * createPipelineQueue().
   */
  enqueueSession?: (sessionId: string) => void;
}

/** Result of a pipeline run — always returned, never throws */
export interface PipelineResult {
  sessionId: string;
  parseSuccess: boolean;
  summarySuccess: boolean;
  errors: string[];
  stats?: TranscriptStats;
}

// ---------------------------------------------------------------------------
// Pipeline queue — bounded async work queue for concurrent pipeline runs
// ---------------------------------------------------------------------------

/**
 * Create a bounded async work queue for session pipelines.
 *
 * The queue limits concurrent pipeline executions to `maxConcurrent`.
 * The pending queue is unbounded (session IDs are lightweight strings).
 *
 * Usage:
 *   const queue = createPipelineQueue(3);
 *   queue.start(deps);
 *   queue.enqueue("session-123"); // fire-and-forget
 *   await queue.stop();           // waits for in-flight to finish
 *
 * @param maxConcurrent - Maximum number of pipelines running simultaneously
 */
export function createPipelineQueue(maxConcurrent: number): {
  enqueue(sessionId: string): void;
  start(deps: PipelineDeps): void;
  stop(): Promise<void>;
  depth(): number;
} {
  /** Pending session IDs waiting to be processed */
  const pending: string[] = [];

  /** Number of currently running pipeline tasks */
  let active = 0;

  /** Injected dependencies — set when start() is called */
  let pipelineDeps: PipelineDeps | null = null;

  /** Whether the queue has been stopped */
  let stopped = false;

  /** Resolvers for stop() to wait on in-flight work */
  let drainResolve: (() => void) | null = null;

  /**
   * Try to dequeue and process the next session from the pending list.
   * Respects the concurrency limit and stopped flag.
   */
  function tryProcess(): void {
    // Don't start new work if stopped or at capacity or nothing pending
    while (!stopped && active < maxConcurrent && pending.length > 0) {
      const sessionId = pending.shift()!;
      active++;

      // Fire-and-forget: run reconcile pipeline and handle completion
      reconcileSession(pipelineDeps!, sessionId)
        .catch((err) => {
          pipelineDeps!.logger.error(
            { sessionId, error: err instanceof Error ? err.message : String(err) },
            "Pipeline queue: unhandled error",
          );
        })
        .finally(() => {
          active--;

          // If stopped and no more active work, resolve the drain promise
          if (stopped && active === 0 && drainResolve) {
            drainResolve();
          }

          // Process next item in queue
          tryProcess();
        });
    }
  }

  return {
    /**
     * Add a session ID to the processing queue.
     * Session IDs are lightweight strings — the queue is unbounded since
     * concurrency is already gated by maxConcurrent.
     */
    enqueue(sessionId: string): void {
      if (stopped) return;

      if (!pipelineDeps) {
        // Queue not started yet — silently drop
        return;
      }

      pending.push(sessionId);
      tryProcess();
    },

    /**
     * Start the queue with the given pipeline dependencies.
     * Must be called before enqueue() will have any effect.
     */
    start(deps: PipelineDeps): void {
      pipelineDeps = deps;
      stopped = false;
    },

    /**
     * Stop accepting new work and wait for all in-flight pipelines to finish.
     * Returns a promise that resolves when all active work is complete.
     */
    async stop(): Promise<void> {
      stopped = true;
      pending.length = 0; // Clear pending items

      if (active === 0) return;

      // Wait for in-flight work to drain
      return new Promise<void>((resolve) => {
        drainResolve = resolve;
      });
    },

    /** Return the number of pending (not yet started) items in the queue */
    depth(): number {
      return pending.length;
    },
  };
}
