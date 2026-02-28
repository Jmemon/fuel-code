/**
 * Session post-processing pipeline orchestrator.
 *
 * Runs after a session ends, executing the following steps:
 *   1. Validate session is in 'ended' state with a transcript_s3_key
 *   2. Download transcript from S3
 *   3. Parse JSONL into structured messages and content blocks
 *   4. Persist parsed data to Postgres (transcript_messages + content_blocks)
 *   5. Persist relationships (subagents, teams, skills, worktrees, session metadata)
 *   6. Advance lifecycle to 'parsed' with computed stats
 *   7. Generate LLM summary (best-effort, non-blocking)
 *   8. Upload parsed backup to S3 (best-effort)
 *
 * Concurrency is managed via an async work queue that limits how many
 * pipelines run in parallel (the pending queue itself is unbounded since
 * it only holds lightweight session ID strings).
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { TranscriptStats, TranscriptMessage, ParsedContentBlock, ParseResult } from "@fuel-code/shared";
import { buildParsedBackupKey, generateId } from "@fuel-code/shared";
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
  // Step 5.5: Persist extracted relationships (subagents, teams, skills, worktrees)
  //
  // Non-fatal: if this fails, the pipeline continues. Relationship data can
  // be re-derived from the transcript on a subsequent reparse.
  // -------------------------------------------------------------------------

  await persistRelationships(sql, sessionId, parseResult, log);

  // -------------------------------------------------------------------------
  // Step 5.6: Parse sub-agent transcripts
  //
  // For each subagent that was persisted and has a transcript_s3_key, download
  // and parse its transcript through the same parser, then insert messages and
  // content blocks with the subagent_id FK set. Non-fatal — failures are
  // logged but don't block the rest of the pipeline.
  // -------------------------------------------------------------------------

  await parseSubagentTranscripts(sql, s3, sessionId, log);

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
    duration_ms: stats.duration_ms,
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
// Relationship persistence
// ---------------------------------------------------------------------------

/**
 * Persist parser-extracted relationship data to the database tables.
 *
 * Writes sub-agents, teams, skills, worktrees, and session metadata that were
 * extracted during transcript parsing. Uses upsert convergence for subagents
 * and teams (real-time hooks may have already created rows), and delete-then-
 * insert for skills and worktrees (idempotent on reparse).
 *
 * Non-fatal: the entire function is wrapped in try/catch so that a failure
 * here does not block the rest of the pipeline.
 */
async function persistRelationships(
  sql: Sql,
  sessionId: string,
  parseResult: ParseResult,
  logger: Logger,
): Promise<void> {
  try {
    // 1. Upsert subagents — hooks may have inserted rows in real-time,
    //    parser upserts retroactively with COALESCE to fill gaps.
    for (const sa of parseResult.subagents) {
      const id = generateId();
      await sql`
        INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model,
          spawning_tool_use_id, team_name, isolation, run_in_background, status, started_at)
        VALUES (${id}, ${sessionId}, ${sa.agent_id}, ${sa.agent_type}, ${sa.agent_name ?? null},
          ${sa.model ?? null}, ${sa.spawning_tool_use_id}, ${sa.team_name ?? null},
          ${sa.isolation ?? null}, ${sa.run_in_background}, ${"completed"}, ${sa.started_at || null})
        ON CONFLICT (session_id, agent_id) DO UPDATE SET
          agent_type = COALESCE(EXCLUDED.agent_type, subagents.agent_type),
          agent_name = COALESCE(EXCLUDED.agent_name, subagents.agent_name),
          model = COALESCE(EXCLUDED.model, subagents.model),
          spawning_tool_use_id = COALESCE(EXCLUDED.spawning_tool_use_id, subagents.spawning_tool_use_id),
          team_name = COALESCE(EXCLUDED.team_name, subagents.team_name),
          isolation = COALESCE(EXCLUDED.isolation, subagents.isolation)
      `;
    }

    // 2. Upsert teams — unique on team_name; merge member_count and metadata
    for (const team of parseResult.teams) {
      const id = generateId();
      const memberCount = parseResult.subagents.filter(s => s.team_name === team.team_name).length;
      await sql`
        INSERT INTO teams (id, team_name, description, lead_session_id, created_at, member_count, metadata)
        VALUES (${id}, ${team.team_name}, ${team.description ?? null}, ${sessionId}, now(),
          ${memberCount}, ${JSON.stringify({ message_count: team.message_count })})
        ON CONFLICT (team_name) DO UPDATE SET
          description = COALESCE(EXCLUDED.description, teams.description),
          member_count = GREATEST(teams.member_count, EXCLUDED.member_count),
          metadata = jsonb_set(COALESCE(teams.metadata, '{}'), '{message_count}', ${String(team.message_count)}::jsonb)
      `;
    }

    // 3. Insert skills (delete-first for idempotent reparse)
    await sql`DELETE FROM session_skills WHERE session_id = ${sessionId}`;
    for (const skill of parseResult.skills) {
      await sql`
        INSERT INTO session_skills (id, session_id, skill_name, invoked_at, invoked_by, args)
        VALUES (${generateId()}, ${sessionId}, ${skill.skill_name},
          ${skill.invoked_at || new Date().toISOString()},
          ${skill.invoked_by}, ${skill.args ?? null})
      `;
    }

    // 4. Insert worktrees (delete-first for idempotent reparse)
    await sql`DELETE FROM session_worktrees WHERE session_id = ${sessionId}`;
    for (const wt of parseResult.worktrees) {
      await sql`
        INSERT INTO session_worktrees (id, session_id, worktree_name, created_at)
        VALUES (${generateId()}, ${sessionId}, ${wt.worktree_name ?? null},
          ${wt.created_at || new Date().toISOString()})
      `;
    }

    // 5. Update session metadata (permission_mode, team info, resume chain)
    if (parseResult.permission_mode || parseResult.teams.length > 0 || parseResult.resumed_from_session_id) {
      await sql`
        UPDATE sessions SET
          permission_mode = COALESCE(${parseResult.permission_mode ?? null}, permission_mode),
          team_name = COALESCE(${parseResult.teams[0]?.team_name ?? null}, team_name),
          team_role = COALESCE(${parseResult.teams.length > 0 ? "lead" : null}, team_role),
          resumed_from_session_id = COALESCE(${parseResult.resumed_from_session_id ?? null}, resumed_from_session_id)
        WHERE id = ${sessionId}
      `;
    }

    // 6. Update subagent_count on session from actual DB rows
    if (parseResult.subagents.length > 0) {
      await sql`
        UPDATE sessions SET subagent_count = (
          SELECT COUNT(*) FROM subagents WHERE session_id = ${sessionId}
        ) WHERE id = ${sessionId}
      `;
    }

  } catch (err) {
    // NON-FATAL: log warning but don't block pipeline
    logger.warn({ err, sessionId }, "Failed to persist relationships — continuing pipeline");
  }
}

// ---------------------------------------------------------------------------
// Sub-agent transcript parsing
// ---------------------------------------------------------------------------

/**
 * Download, parse, and persist transcripts for all sub-agents in a session
 * that have a transcript_s3_key set. Each sub-agent's messages and content
 * blocks are inserted with the subagent_id FK pointing to the subagent ULID.
 *
 * Non-fatal: individual sub-agent failures are logged but don't block the
 * pipeline or other sub-agents from being processed.
 */
async function parseSubagentTranscripts(
  sql: Sql,
  s3: S3Client,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    // Find all subagents for this session that have an uploaded transcript
    const subagentRows = await sql`
      SELECT id, agent_id, transcript_s3_key
      FROM subagents
      WHERE session_id = ${sessionId}
        AND transcript_s3_key IS NOT NULL
    `;

    if (subagentRows.length === 0) return;

    logger.info(
      { count: subagentRows.length },
      `Processing ${subagentRows.length} sub-agent transcript(s)`,
    );

    for (const row of subagentRows) {
      const subagentUlid = row.id as string;
      const agentId = row.agent_id as string;
      const s3Key = row.transcript_s3_key as string;

      try {
        // Download sub-agent transcript from S3
        const content = await s3.download(s3Key);

        // Parse through the same transcript parser
        const subParseResult = await parseTranscript(sessionId, content);

        if (subParseResult.messages.length === 0) {
          logger.info({ agentId }, "Sub-agent transcript has no messages — skipping");
          continue;
        }

        // Persist parsed messages and content blocks with subagent_id FK set
        // TransactionSql type is missing template literal call signatures in postgres.js types
        await sql.begin(async (tx: any) => {
          // Clear any previously parsed sub-agent data (idempotent re-run)
          await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId} AND subagent_id = ${subagentUlid}`;
          await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId} AND subagent_id = ${subagentUlid}`;

          await batchInsertMessages(tx, subParseResult.messages, subagentUlid);
          await batchInsertContentBlocks(tx, subParseResult.contentBlocks, subagentUlid);
        });

        logger.info(
          { agentId, messages: subParseResult.messages.length, blocks: subParseResult.contentBlocks.length },
          `Parsed sub-agent transcript for ${agentId}`,
        );
      } catch (err) {
        // Non-fatal per sub-agent — log and continue with remaining sub-agents
        logger.warn(
          { agentId, error: err instanceof Error ? err.message : String(err) },
          `Failed to parse sub-agent transcript for ${agentId} — continuing`,
        );
      }
    }
  } catch (err) {
    // Non-fatal: log warning but don't block pipeline
    logger.warn(
      { err, sessionId },
      "Failed to process sub-agent transcripts — continuing pipeline",
    );
  }
}

// ---------------------------------------------------------------------------
// Batch insert helpers
// ---------------------------------------------------------------------------

/**
 * Insert transcript messages in batches of BATCH_SIZE.
 * Uses sql.unsafe with parameterized values to avoid exceeding Postgres limits.
 *
 * @param subagentId - When set, all messages are attributed to this sub-agent
 *                     via the subagent_id FK column. Pass null for main session messages.
 */
async function batchInsertMessages(
  tx: Sql,
  messages: TranscriptMessage[],
  subagentId: string | null = null,
): Promise<void> {
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE);

    if (chunk.length === 0) continue;

    // Build parameterized INSERT with numbered placeholders
    // Each message has 22 columns (transcript_messages columns + subagent_id)
    const colCount = 22;
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
        `$${offset + 21}, $${offset + 22})`,
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
        subagentId,                              // 22
      );
    }

    await tx.unsafe(
      `INSERT INTO transcript_messages (
        id, session_id, line_number, ordinal, message_type, role, model,
        tokens_in, tokens_out, cache_read, cache_write, cost_usd,
        compact_sequence, is_compacted, timestamp, raw_message, metadata,
        has_text, has_thinking, has_tool_use, has_tool_result, subagent_id
      ) VALUES ${placeholders.join(", ")}`,
      values as any[],
    );
  }
}

/**
 * Insert content blocks in batches of BATCH_SIZE.
 * Uses sql.unsafe with parameterized values to avoid exceeding Postgres limits.
 *
 * @param subagentId - When set, all blocks are attributed to this sub-agent
 *                     via the subagent_id FK column. Pass null for main session blocks.
 */
async function batchInsertContentBlocks(
  tx: Sql,
  blocks: ParsedContentBlock[],
  subagentId: string | null = null,
): Promise<void> {
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const chunk = blocks.slice(i, i + BATCH_SIZE);

    if (chunk.length === 0) continue;

    // Each content block has 15 columns (content_blocks columns + subagent_id)
    const colCount = 15;
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j];
      const offset = j * colCount;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
        `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, ` +
        `$${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15})`,
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
        subagentId,                              // 15
      );
    }

    await tx.unsafe(
      `INSERT INTO content_blocks (
        id, message_id, session_id, block_order, block_type,
        content_text, thinking_text, tool_name, tool_use_id, tool_input,
        tool_result_id, is_error, result_text, metadata, subagent_id
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
