/**
 * Session post-processing pipeline orchestrator.
 *
 * Runs after a session ends, executing the following steps:
 *   1. Validate session is in 'ended' state with a transcript_s3_key
 *   2. Download transcript from S3
 *   3. Parse JSONL into structured messages and content blocks
 *   4. Persist parsed data to Postgres (transcript_messages + content_blocks)
 *   5. Advance lifecycle to 'parsed' with computed stats
 *   6. Generate LLM summary (best-effort, non-blocking)
 *   7. Upload parsed backup to S3 (best-effort)
 *
 * Concurrency is managed via a bounded async work queue that limits how many
 * pipelines run in parallel and drops new entries when the queue is full.
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { TranscriptStats, TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";
import { buildParsedBackupKey } from "@fuel-code/shared";
import { parseTranscript } from "./transcript-parser.js";
import { generateSummary, extractInitialPrompt, type SummaryConfig } from "./summary-generator.js";
import { transitionSession, failSession, type SessionLifecycle } from "./session-lifecycle.js";

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
   * Queue-based pipeline trigger. When set, callers should use this instead
   * of calling runSessionPipeline() directly, to respect concurrency limits.
   * Wired up by server startup via createPipelineQueue().
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
// Constants
// ---------------------------------------------------------------------------

/** Batch size for INSERT operations to avoid exceeding Postgres parameter limits */
const BATCH_SIZE = 500;

/** Maximum queue depth before new enqueue requests are dropped */
const MAX_QUEUE_DEPTH = 50;

// ---------------------------------------------------------------------------
// Main pipeline function
// ---------------------------------------------------------------------------

/**
 * Run the full post-processing pipeline for a single session.
 *
 * This is the core orchestration function. It downloads the transcript from S3,
 * parses it, persists the structured data to Postgres, computes stats, and
 * optionally generates an LLM summary.
 *
 * Never throws — all errors are captured in the returned PipelineResult.
 *
 * @param deps      - Injected dependencies (sql, s3, summaryConfig, logger)
 * @param sessionId - The session to process
 * @returns PipelineResult with status flags, errors, and optional stats
 */
export async function runSessionPipeline(
  deps: PipelineDeps,
  sessionId: string,
): Promise<PipelineResult> {
  const { sql, s3, summaryConfig, logger } = deps;
  const log = logger.child({ sessionId, component: "pipeline" });
  const errors: string[] = [];

  // -------------------------------------------------------------------------
  // Step 1: Fetch and validate session state
  // -------------------------------------------------------------------------

  const sessionRows = await sql`
    SELECT id, lifecycle, transcript_s3_key, workspace_id
    FROM sessions
    WHERE id = ${sessionId}
  `;

  if (sessionRows.length === 0) {
    return { sessionId, parseSuccess: false, summarySuccess: false, errors: ["Session not found"] };
  }

  const session = sessionRows[0];

  if (!session.transcript_s3_key) {
    return { sessionId, parseSuccess: false, summarySuccess: false, errors: ["No transcript in S3"] };
  }

  if (session.lifecycle !== "ended") {
    return {
      sessionId,
      parseSuccess: false,
      summarySuccess: false,
      errors: [`Session not in 'ended' state (currently '${session.lifecycle}')`],
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Mark parse_status as 'parsing' so other workers know we claimed it
  // -------------------------------------------------------------------------

  await sql`
    UPDATE sessions
    SET parse_status = 'parsing', updated_at = now()
    WHERE id = ${sessionId}
  `;

  // -------------------------------------------------------------------------
  // Step 3: Download transcript from S3
  // -------------------------------------------------------------------------

  let transcriptContent: string;
  try {
    transcriptContent = await s3.download(session.transcript_s3_key as string);
  } catch (err) {
    const errMsg = `S3 download failed: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ error: errMsg }, "Pipeline S3 download failed");
    await failSession(sql, sessionId, errMsg);
    return { sessionId, parseSuccess: false, summarySuccess: false, errors: [errMsg] };
  }

  // -------------------------------------------------------------------------
  // Step 4: Parse transcript JSONL into structured data
  // -------------------------------------------------------------------------

  const parseResult = await parseTranscript(sessionId, transcriptContent);

  // Log any line-level parse warnings but continue — partial results are fine
  if (parseResult.errors.length > 0) {
    log.warn(
      { parseErrors: parseResult.errors.length },
      `Transcript parsed with ${parseResult.errors.length} line-level errors`,
    );
    for (const e of parseResult.errors) {
      errors.push(`Line ${e.lineNumber}: ${e.error}`);
    }
  }

  log.info(
    {
      messages: parseResult.messages.length,
      contentBlocks: parseResult.contentBlocks.length,
    },
    "Transcript parsed successfully",
  );

  // -------------------------------------------------------------------------
  // Step 5: Persist parsed data to Postgres in a transaction
  // -------------------------------------------------------------------------

  try {
    // TransactionSql type is missing template literal call signatures in postgres.js types
    await sql.begin(async (tx: any) => {
      // Clear any previously parsed data for this session (idempotent re-run)
      await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId}`;
      await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId}`;

      // Batch insert transcript messages in chunks of BATCH_SIZE
      await batchInsertMessages(tx, parseResult.messages);

      // Batch insert content blocks in chunks of BATCH_SIZE
      await batchInsertContentBlocks(tx, parseResult.contentBlocks);
    });
  } catch (err) {
    const errMsg = `Persist failed: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ error: errMsg }, "Pipeline persist failed");
    await failSession(sql, sessionId, errMsg);
    return { sessionId, parseSuccess: false, summarySuccess: false, errors: [errMsg] };
  }

  // -------------------------------------------------------------------------
  // Step 6: Advance lifecycle to 'parsed' with computed stats
  // -------------------------------------------------------------------------

  const stats = parseResult.stats;

  // Extract initial prompt from the parsed messages for the session row
  const initialPrompt = extractInitialPrompt(parseResult.messages, parseResult.contentBlocks);

  const transitionResult = await transitionSession(sql, sessionId, "ended", "parsed", {
    parse_status: "completed",
    parse_error: null,
    initial_prompt: initialPrompt ?? undefined,
    total_messages: stats.total_messages,
    user_messages: stats.user_messages,
    assistant_messages: stats.assistant_messages,
    tool_use_count: stats.tool_use_count,
    thinking_blocks: stats.thinking_blocks,
    subagent_count: stats.subagent_count,
    tokens_in: stats.tokens_in,
    tokens_out: stats.tokens_out,
    cache_read_tokens: stats.cache_read_tokens,
    cache_write_tokens: stats.cache_write_tokens,
    cost_estimate_usd: stats.cost_estimate_usd,
  });

  if (!transitionResult.success) {
    // Another process won the race — log and return. Not an error per se.
    log.warn(
      { reason: transitionResult.reason },
      "Lifecycle transition to 'parsed' failed — another process may have won the race",
    );
    return {
      sessionId,
      parseSuccess: false,
      summarySuccess: false,
      errors: [`Transition to parsed failed: ${transitionResult.reason}`],
      stats,
    };
  }

  log.info("Session advanced to 'parsed'");

  // -------------------------------------------------------------------------
  // Step 7: Generate summary (best-effort — failure does NOT regress lifecycle)
  // -------------------------------------------------------------------------

  let summarySuccess = false;

  try {
    const summaryResult = await generateSummary(
      parseResult.messages,
      parseResult.contentBlocks,
      summaryConfig,
    );

    if (summaryResult.success && summaryResult.summary) {
      // Advance lifecycle to 'summarized'
      const summaryTransition = await transitionSession(sql, sessionId, "parsed", "summarized", {
        summary: summaryResult.summary,
      });

      if (summaryTransition.success) {
        summarySuccess = true;
        log.info("Session advanced to 'summarized'");
      } else {
        log.warn(
          { reason: summaryTransition.reason },
          "Lifecycle transition to 'summarized' failed",
        );
      }
    } else if (summaryResult.success) {
      // Summary generation was disabled or returned empty — session stays at 'parsed'
      log.info("Summary generation skipped (disabled or empty)");
      summarySuccess = true; // Not a failure, just skipped
    } else {
      // Summary generation returned an error — session stays at 'parsed'
      log.error({ error: summaryResult.error }, "Summary generation failed — session stays at 'parsed'");
      errors.push(`Summary failed: ${summaryResult.error}`);
    }
  } catch (err) {
    const errMsg = `Summary error: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ error: errMsg }, "Summary generation threw — session stays at 'parsed'");
    errors.push(errMsg);
  }

  // -------------------------------------------------------------------------
  // Step 8: Upload parsed backup to S3 (best-effort, fire-and-forget)
  // -------------------------------------------------------------------------

  try {
    // Derive backup key using the shared utility instead of fragile regex replacement.
    // The transcript key format is: transcripts/{canonicalId}/{sessionId}/raw.jsonl
    const transcriptKey = session.transcript_s3_key as string;
    const keyParts = transcriptKey.split("/");
    const backupKey = buildParsedBackupKey(keyParts[1], sessionId);

    await s3.upload(
      backupKey,
      JSON.stringify(parseResult),
      "application/json",
    );

    log.info({ backupKey }, "Parsed backup uploaded to S3");
  } catch (err) {
    // Best-effort: log and ignore errors
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to upload parsed backup to S3 — ignoring",
    );
  }

  return {
    sessionId,
    parseSuccess: true,
    summarySuccess,
    errors: errors.length > 0 ? errors : [],
    stats,
  };
}

// ---------------------------------------------------------------------------
// Batch insert helpers
// ---------------------------------------------------------------------------

/**
 * Insert transcript messages in batches of BATCH_SIZE.
 * Uses sql.unsafe with parameterized values to avoid exceeding Postgres limits.
 */
async function batchInsertMessages(
  tx: Sql,
  messages: TranscriptMessage[],
): Promise<void> {
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE);

    if (chunk.length === 0) continue;

    // Build parameterized INSERT with numbered placeholders
    // Each message has 21 columns (matches all transcript_messages columns)
    const colCount = 21;
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (let j = 0; j < chunk.length; j++) {
      const m = chunk[j];
      const offset = j * colCount;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
        `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, ` +
        `$${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, ` +
        `$${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20}, ` +
        `$${offset + 21})`,
      );
      values.push(
        m.id,                                    // 1
        m.session_id,                            // 2
        m.line_number,                           // 3
        m.ordinal,                               // 4
        m.message_type,                          // 5
        m.role,                                  // 6
        m.model,                                 // 7
        m.tokens_in,                             // 8
        m.tokens_out,                            // 9
        m.cache_read,                            // 10
        m.cache_write,                           // 11
        m.cost_usd,                              // 12
        m.compact_sequence,                      // 13
        m.is_compacted,                          // 14
        m.timestamp,                             // 15
        JSON.stringify(m.raw_message),           // 16
        JSON.stringify(m.metadata),              // 17
        m.has_text,                              // 18
        m.has_thinking,                          // 19
        m.has_tool_use,                          // 20
        m.has_tool_result,                       // 21
      );
    }

    await tx.unsafe(
      `INSERT INTO transcript_messages (
        id, session_id, line_number, ordinal, message_type, role, model,
        tokens_in, tokens_out, cache_read, cache_write, cost_usd,
        compact_sequence, is_compacted, timestamp, raw_message, metadata,
        has_text, has_thinking, has_tool_use, has_tool_result
      ) VALUES ${placeholders.join(", ")}`,
      values as any[],
    );
  }
}

/**
 * Insert content blocks in batches of BATCH_SIZE.
 * Uses sql.unsafe with parameterized values to avoid exceeding Postgres limits.
 */
async function batchInsertContentBlocks(
  tx: Sql,
  blocks: ParsedContentBlock[],
): Promise<void> {
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const chunk = blocks.slice(i, i + BATCH_SIZE);

    if (chunk.length === 0) continue;

    // Each content block has 14 columns
    const colCount = 14;
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j];
      const offset = j * colCount;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
        `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, ` +
        `$${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14})`,
      );
      values.push(
        b.id,                                    // 1
        b.message_id,                            // 2
        b.session_id,                            // 3
        b.block_order,                           // 4
        b.block_type,                            // 5
        b.content_text,                          // 6
        b.thinking_text,                         // 7
        b.tool_name,                             // 8
        b.tool_use_id,                           // 9
        JSON.stringify(b.tool_input),            // 10
        b.tool_result_id,                        // 11
        b.is_error,                              // 12
        b.result_text,                           // 13
        JSON.stringify(b.metadata),              // 14
      );
    }

    await tx.unsafe(
      `INSERT INTO content_blocks (
        id, message_id, session_id, block_order, block_type,
        content_text, thinking_text, tool_name, tool_use_id, tool_input,
        tool_result_id, is_error, result_text, metadata
      ) VALUES ${placeholders.join(", ")}`,
      values as any[],
    );
  }
}

// ---------------------------------------------------------------------------
// Pipeline queue — bounded async work queue for concurrent pipeline runs
// ---------------------------------------------------------------------------

/**
 * Create a bounded async work queue for session pipelines.
 *
 * The queue limits concurrent pipeline executions to `maxConcurrent` and drops
 * new entries when the queue depth exceeds MAX_QUEUE_DEPTH (50). This prevents
 * unbounded memory growth if sessions end faster than they can be processed.
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

      // Fire-and-forget: run pipeline and handle completion
      runSessionPipeline(pipelineDeps!, sessionId)
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
     * Drops the entry with a warning if the queue is full (>50 pending).
     */
    enqueue(sessionId: string): void {
      if (stopped) return;

      if (!pipelineDeps) {
        // Queue not started yet — silently drop
        return;
      }

      if (pending.length >= MAX_QUEUE_DEPTH) {
        pipelineDeps.logger.warn(
          { sessionId, queueDepth: pending.length },
          "Pipeline queue overflow — dropping session",
        );
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
