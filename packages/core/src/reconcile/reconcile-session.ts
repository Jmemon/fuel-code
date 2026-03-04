/**
 * reconcileSession() — the single idempotent function that processes a session
 * through the full pipeline. Replaces runSessionPipeline() as the primary
 * entry point for session post-processing.
 *
 * Uses computeGap() to determine which steps still need to run, making it
 * safe to call from any context: hook handlers, backfill, recovery sweeps,
 * or manual reparse. Calling it on an already-complete session is a no-op.
 *
 * Pipeline steps (skipped when gap says they're done):
 *   1. Fetch session row, compute gap
 *   2. If needsTranscriptUpload -> return early (caller must upload first)
 *   3. Fix stale timestamps (backfill started_at = ended_at bug)
 *   4. Transition to transcript_ready if not already there or beyond
 *   5. Download and parse main transcript
 *   6. Persist messages + content_blocks (delete-first for idempotency)
 *   7. Persist relationships (subagents, teams, skills, worktrees)
 *   8. Parse subagent transcripts
 *   9. Update stats, advance to parsed
 *  10. Generate session summary -> advance to summarized
 *  11. Generate per-teammate summaries (best-effort, non-fatal)
 *  12. Advance to complete
 *
 * Never throws — all errors are caught and returned in the result object.
 */

import type { Sql } from "postgres";
import type { Logger } from "pino";
import type { TranscriptStats, ParseResult } from "@fuel-code/shared";
import { buildParsedBackupKey, generateId } from "@fuel-code/shared";
import { parseTranscript } from "../transcript-parser.js";
import { generateSummary, extractInitialPrompt, type SummaryConfig } from "../summary-generator.js";
import { transitionSession, failSession, type SessionLifecycle } from "../session-lifecycle.js";
import { computeGap, type SessionForGap } from "./compute-gap.js";
import { generateTeammateSummaries } from "./teammate-summary.js";
import type { SessionSeed } from "../types/reconcile.js";
import { buildSeedFromRecovery } from "./session-seed.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal S3 client interface used by the reconciler.
 * Identical to the one in session-pipeline.ts — kept here so the reconcile
 * module can be used independently.
 */
export interface ReconcileS3Client {
  upload(key: string, body: Buffer | string, contentType?: string): Promise<{ key: string; size: number }>;
  download(key: string): Promise<string>;
}

/** Dependencies injected into reconcileSession — keeps it testable */
export interface ReconcileDeps {
  sql: Sql;
  s3: ReconcileS3Client;
  summaryConfig: SummaryConfig;
  logger: Logger;
}

/** Result of a reconcileSession call — always returned, never throws */
export interface ReconcileResult {
  sessionId: string;
  /** Which steps were actually executed (for observability) */
  stepsExecuted: string[];
  /** Whether parsing completed successfully (or was already done) */
  parseSuccess: boolean;
  /** Whether summary completed successfully (or was already done) */
  summarySuccess: boolean;
  /** Accumulated non-fatal errors from individual steps */
  errors: string[];
  /** Computed transcript stats (if parsing was performed) */
  stats?: TranscriptStats;
  /** Final lifecycle state after reconciliation */
  finalLifecycle?: SessionLifecycle;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Batch size for INSERT operations to avoid exceeding Postgres parameter limits */
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Main reconcile function
// ---------------------------------------------------------------------------

/**
 * Reconcile a single session through the full pipeline, skipping any steps
 * that are already complete based on the session's current lifecycle state.
 *
 * This is idempotent: calling it on a complete session returns immediately.
 * Calling it on a parsed session skips to summary. Calling it on a
 * summarized session skips to complete.
 *
 * @param deps      - Injected dependencies (sql, s3, summaryConfig, logger)
 * @param sessionId - The session to process
 * @returns ReconcileResult with status flags, errors, and optional stats
 */
export async function reconcileSession(
  deps: ReconcileDeps,
  sessionId: string,
): Promise<ReconcileResult> {
  const { sql, s3, summaryConfig, logger } = deps;
  const log = logger.child({ sessionId, component: "reconcile" });
  const errors: string[] = [];
  const stepsExecuted: string[] = [];

  try {
    // -----------------------------------------------------------------------
    // Step 1: Fetch session row, build a recovery seed, and compute the gap
    // -----------------------------------------------------------------------

    const sessionRows = await sql`
      SELECT id, workspace_id, device_id, lifecycle, transcript_s3_key,
             started_at, ended_at, duration_ms, summary, subagent_count,
             cwd, git_branch, git_remote, model, end_reason
      FROM sessions
      WHERE id = ${sessionId}
    `;

    if (sessionRows.length === 0) {
      return makeResult(sessionId, stepsExecuted, {
        parseSuccess: false,
        summarySuccess: false,
        errors: ["Session not found"],
      });
    }

    const session = sessionRows[0];
    const lifecycle = session.lifecycle as SessionLifecycle;

    // Terminal states: nothing to do
    if (lifecycle === "complete") {
      log.debug("Session already complete — no-op");
      return makeResult(sessionId, stepsExecuted, {
        parseSuccess: true,
        summarySuccess: true,
        finalLifecycle: "complete",
      });
    }

    if (lifecycle === "failed") {
      log.debug("Session in failed state — no-op (use resetSessionForReparse to retry)");
      return makeResult(sessionId, stepsExecuted, {
        parseSuccess: false,
        summarySuccess: false,
        finalLifecycle: "failed",
        errors: ["Session is in failed state"],
      });
    }

    // Build a recovery seed from the current DB row and compute the gap
    const workspaceCanonicalId = await resolveCanonicalId(sql, session.workspace_id as string);
    const seed = buildSeedFromRecovery(
      {
        id: session.id as string,
        workspace_id: session.workspace_id as string,
        device_id: session.device_id as string,
        cwd: session.cwd as string | undefined,
        git_branch: session.git_branch as string | null,
        git_remote: session.git_remote as string | null,
        model: session.model as string | null,
        lifecycle: session.lifecycle as string,
        started_at: (session.started_at as Date).toISOString(),
        ended_at: session.ended_at ? (session.ended_at as Date).toISOString() : null,
        duration_ms: session.duration_ms as number | null,
        end_reason: session.end_reason as string | null,
        transcript_s3_key: session.transcript_s3_key as string | null,
      },
      workspaceCanonicalId,
    );

    const sessionForGap: SessionForGap = {
      lifecycle,
      transcript_s3_key: session.transcript_s3_key as string | null,
      started_at: (session.started_at as Date).toISOString(),
      ended_at: session.ended_at ? (session.ended_at as Date).toISOString() : null,
      duration_ms: session.duration_ms as number | null,
      summary: session.summary as string | null,
      subagent_count: session.subagent_count as number | null,
    };

    const gap = computeGap(sessionForGap, seed);
    stepsExecuted.push("computeGap");

    log.info({ lifecycle, gap }, "Computed session gap");

    // -----------------------------------------------------------------------
    // Step 2: If transcript upload is still needed, return early
    // The caller (backfill/hook handler) must upload the transcript first.
    // -----------------------------------------------------------------------

    if (gap.needsTranscriptUpload) {
      log.info("Session needs transcript upload — cannot proceed with reconcile");
      return makeResult(sessionId, stepsExecuted, {
        parseSuccess: false,
        summarySuccess: false,
        errors: ["Transcript not yet uploaded to S3"],
      });
    }

    // -----------------------------------------------------------------------
    // Step 3: Fix stale timestamps (backfill started_at = ended_at bug)
    // -----------------------------------------------------------------------

    if (gap.staleStartedAt && seed.startedAt) {
      try {
        await sql`
          UPDATE sessions
          SET started_at = ${seed.startedAt}, updated_at = now()
          WHERE id = ${sessionId}
        `;
        stepsExecuted.push("fixStaleStartedAt");
        log.info({ newStartedAt: seed.startedAt }, "Fixed stale started_at");
      } catch (err) {
        const errMsg = `Fix stale started_at failed: ${err instanceof Error ? err.message : String(err)}`;
        log.warn({ error: errMsg }, errMsg);
        errors.push(errMsg);
      }
    }

    if (gap.staleDurationMs && seed.durationMs != null) {
      try {
        await sql`
          UPDATE sessions
          SET duration_ms = ${seed.durationMs}, updated_at = now()
          WHERE id = ${sessionId}
        `;
        stepsExecuted.push("fixStaleDurationMs");
        log.info({ newDurationMs: seed.durationMs }, "Fixed stale duration_ms");
      } catch (err) {
        const errMsg = `Fix stale duration_ms failed: ${err instanceof Error ? err.message : String(err)}`;
        log.warn({ error: errMsg }, errMsg);
        errors.push(errMsg);
      }
    }

    // -----------------------------------------------------------------------
    // Step 4: Transition to transcript_ready if needed
    // If the session is in detected or ended state and has a transcript key,
    // advance it to transcript_ready so parsing can proceed.
    // -----------------------------------------------------------------------

    if (lifecycle === "detected" || lifecycle === "ended") {
      if (!session.transcript_s3_key) {
        return makeResult(sessionId, stepsExecuted, {
          parseSuccess: false,
          summarySuccess: false,
          errors: ["No transcript S3 key — cannot advance to transcript_ready"],
          finalLifecycle: lifecycle,
        });
      }

      const trResult = await transitionSession(sql, sessionId, lifecycle, "transcript_ready");
      if (!trResult.success) {
        log.warn({ reason: trResult.reason }, "Transition to transcript_ready failed");
        return makeResult(sessionId, stepsExecuted, {
          parseSuccess: false,
          summarySuccess: false,
          errors: [`Transition to transcript_ready failed: ${trResult.reason}`],
          finalLifecycle: lifecycle,
        });
      }
      stepsExecuted.push("transitionToTranscriptReady");
      log.info("Session advanced to transcript_ready");
    }

    // -----------------------------------------------------------------------
    // Steps 5-9: Parsing phase (skipped if session is already parsed or beyond)
    // -----------------------------------------------------------------------

    let parseResult: ParseResult | null = null;

    if (gap.needsParsing) {
      // Step 5: Download and parse main transcript
      const s3Key = session.transcript_s3_key as string;

      let transcriptContent: string;
      try {
        transcriptContent = await s3.download(s3Key);
        stepsExecuted.push("downloadTranscript");
      } catch (err) {
        const errMsg = `S3 download failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ error: errMsg }, "Reconcile S3 download failed");
        await failSession(sql, sessionId, errMsg);
        return makeResult(sessionId, stepsExecuted, {
          parseSuccess: false,
          summarySuccess: false,
          errors: [errMsg],
          finalLifecycle: "failed",
        });
      }

      // Parse JSONL into structured data
      parseResult = await parseTranscript(sessionId, transcriptContent);
      stepsExecuted.push("parseTranscript");

      // Log line-level parse warnings but continue — partial results are fine
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
        { messages: parseResult.messages.length, contentBlocks: parseResult.contentBlocks.length },
        "Transcript parsed successfully",
      );

      // Step 6: Persist messages + content_blocks (delete-first for idempotency)
      try {
        await sql.begin(async (tx: any) => {
          await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId}`;
          await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId}`;

          await batchInsertMessages(tx, parseResult!.messages);
          await batchInsertContentBlocks(tx, parseResult!.contentBlocks);
        });
        stepsExecuted.push("persistMessages");
      } catch (err) {
        const errMsg = `Persist failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ error: errMsg }, "Reconcile persist failed");
        await failSession(sql, sessionId, errMsg);
        return makeResult(sessionId, stepsExecuted, {
          parseSuccess: false,
          summarySuccess: false,
          errors: [errMsg],
          finalLifecycle: "failed",
        });
      }

      // Step 7: Persist relationships (subagents, teams, skills, worktrees)
      // Reuses the existing persistRelationships logic from session-pipeline.
      await persistRelationships(sql, sessionId, parseResult, log);
      stepsExecuted.push("persistRelationships");

      // Step 8: Parse subagent transcripts and set teammate_id on their messages
      await parseSubagentTranscripts(sql, s3, sessionId, log);
      stepsExecuted.push("parseSubagentTranscripts");

      // Step 9: Update stats, advance to parsed
      const stats = parseResult.stats;
      const initialPrompt = extractInitialPrompt(parseResult.messages, parseResult.contentBlocks);

      const parsedTransition = await transitionSession(
        sql, sessionId, "transcript_ready", "parsed", {
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
        },
      );

      if (!parsedTransition.success) {
        log.warn(
          { reason: parsedTransition.reason },
          "Lifecycle transition to 'parsed' failed — another process may have won the race",
        );
        return makeResult(sessionId, stepsExecuted, {
          parseSuccess: false,
          summarySuccess: false,
          errors: [`Transition to parsed failed: ${parsedTransition.reason}`],
          stats,
        });
      }

      stepsExecuted.push("transitionToParsed");
      log.info("Session advanced to 'parsed'");

      // Upload parsed backup to S3 (best-effort, fire-and-forget)
      try {
        const keyParts = s3Key.split("/");
        const backupKey = buildParsedBackupKey(keyParts[1], sessionId);
        await s3.upload(backupKey, JSON.stringify(parseResult), "application/json");
        log.info({ backupKey }, "Parsed backup uploaded to S3");
      } catch (err) {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "Failed to upload parsed backup to S3 — ignoring",
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 10: Generate session summary -> advance to summarized
    // (skipped if session is already summarized or beyond)
    // -----------------------------------------------------------------------

    let summarySuccess = false;

    if (gap.needsSummary) {
      try {
        // If we didn't parse in this run, we need to load messages for summary
        let messages = parseResult?.messages;
        let contentBlocks = parseResult?.contentBlocks;

        if (!messages || !contentBlocks) {
          // Load from DB — session was already parsed in a prior run
          const dbMessages = await sql`
            SELECT * FROM transcript_messages
            WHERE session_id = ${sessionId} AND subagent_id IS NULL
            ORDER BY ordinal
          `;
          const dbBlocks = await sql`
            SELECT * FROM content_blocks
            WHERE session_id = ${sessionId} AND subagent_id IS NULL
            ORDER BY block_order
          `;
          messages = dbMessages as any;
          contentBlocks = dbBlocks as any;
        }

        // Query existing teammate rows so the summary model has multi-agent context
        const teammateSummaries = await sql`
          SELECT id, entity_name as name, NULL as color, summary
          FROM teammates WHERE session_id = ${sessionId}
        `;

        const summaryResult = await generateSummary(messages!, contentBlocks!, summaryConfig, teammateSummaries as any);

        if (summaryResult.success && summaryResult.summary) {
          const summaryTransition = await transitionSession(
            sql, sessionId, "parsed", "summarized", { summary: summaryResult.summary },
          );

          if (summaryTransition.success) {
            summarySuccess = true;
            stepsExecuted.push("transitionToSummarized");
            log.info("Session advanced to 'summarized'");
          } else {
            log.warn({ reason: summaryTransition.reason }, "Lifecycle transition to 'summarized' failed");
            errors.push(`Transition to summarized failed: ${summaryTransition.reason}`);
          }
        } else if (summaryResult.success) {
          // Summary generation was disabled or returned empty — advance through
          // summarized (with null summary) to complete
          log.info("Summary generation skipped (disabled or empty)");
          const skipTransition = await transitionSession(
            sql, sessionId, "parsed", "summarized", { summary: undefined },
          );
          if (skipTransition.success) {
            stepsExecuted.push("transitionToSummarized");
          }
          summarySuccess = true;
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
    } else if (!gap.needsSummary) {
      // Summary was already done in a prior run (session is summarized or beyond)
      summarySuccess = true;
    }

    // -----------------------------------------------------------------------
    // Step 11: Per-teammate summaries (non-fatal, best-effort)
    // Iterates over teammates detected in step 7 and generates individual
    // summaries for each one. Failures never block the pipeline.
    // -----------------------------------------------------------------------

    if (gap.needsTeammateSummaries) {
      try {
        await generateTeammateSummaries(
          { sql: deps.sql, summaryConfig: deps.summaryConfig, logger: log },
          sessionId,
        );
        stepsExecuted.push("generateTeammateSummaries");
      } catch (err) {
        logger.warn(
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          "Teammate summary generation failed (non-fatal)",
        );
        // Do NOT fail the session — teammate summaries are best-effort
      }
    }

    // -----------------------------------------------------------------------
    // Step 12: Advance to complete
    // -----------------------------------------------------------------------

    if (gap.needsLifecycleAdvance) {
      // Check current state to determine the right transition
      const currentState = await sql`SELECT lifecycle FROM sessions WHERE id = ${sessionId}`;
      const currentLifecycle = currentState[0]?.lifecycle as SessionLifecycle | undefined;

      if (currentLifecycle === "summarized") {
        const completeTransition = await transitionSession(sql, sessionId, "summarized", "complete");
        if (completeTransition.success) {
          stepsExecuted.push("transitionToComplete");
          log.info("Session advanced to 'complete'");
        } else {
          log.warn(
            { reason: completeTransition.reason },
            "Lifecycle transition to 'complete' failed",
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Determine final lifecycle state
    // -----------------------------------------------------------------------

    const finalRow = await sql`SELECT lifecycle FROM sessions WHERE id = ${sessionId}`;
    const finalLifecycle = (finalRow[0]?.lifecycle as SessionLifecycle) ?? lifecycle;

    return makeResult(sessionId, stepsExecuted, {
      parseSuccess: gap.needsParsing ? stepsExecuted.includes("transitionToParsed") : true,
      summarySuccess,
      errors,
      stats: parseResult?.stats,
      finalLifecycle,
    });

  } catch (err) {
    // Top-level catch: reconcileSession never throws
    const errMsg = `Reconcile error: ${err instanceof Error ? err.message : String(err)}`;
    log.error({ error: errMsg }, "Unhandled error in reconcileSession");

    // Try to fail the session if possible
    try {
      await failSession(sql, sessionId, errMsg);
    } catch {
      // Can't even fail — just log
      log.error("Could not transition session to failed");
    }

    return makeResult(sessionId, stepsExecuted, {
      parseSuccess: false,
      summarySuccess: false,
      errors: [errMsg],
      finalLifecycle: "failed",
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a ReconcileResult with defaults for missing fields.
 */
function makeResult(
  sessionId: string,
  stepsExecuted: string[],
  overrides: Partial<ReconcileResult>,
): ReconcileResult {
  return {
    sessionId,
    stepsExecuted: [...stepsExecuted],
    parseSuccess: false,
    summarySuccess: false,
    errors: [],
    ...overrides,
  };
}

/**
 * Look up the canonical_id for a workspace, falling back to the workspace_id
 * itself if the lookup fails.
 */
async function resolveCanonicalId(sql: Sql, workspaceId: string): Promise<string> {
  try {
    const rows = await sql`
      SELECT canonical_id FROM workspaces WHERE id = ${workspaceId}
    `;
    if (rows.length > 0 && rows[0].canonical_id) {
      return rows[0].canonical_id as string;
    }
  } catch {
    // Fall through to default
  }
  return workspaceId;
}

// ---------------------------------------------------------------------------
// Relationship persistence (reused from session-pipeline.ts logic)
// ---------------------------------------------------------------------------

/**
 * Persist parser-extracted relationship data to the database tables.
 *
 * Writes sub-agents, teams, skills, worktrees, and session metadata that were
 * extracted during transcript parsing. Uses upsert convergence for subagents
 * and teams, and delete-then-insert for skills and worktrees (idempotent on
 * reparse). Non-fatal: the entire function is wrapped in try/catch.
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
    logger.warn({ err, sessionId }, "Failed to persist relationships — continuing reconcile");
  }
}

// ---------------------------------------------------------------------------
// Sub-agent transcript parsing
// ---------------------------------------------------------------------------

/**
 * Download, parse, and persist transcripts for all sub-agents in a session
 * that have a transcript_s3_key set. Each sub-agent's messages and content
 * blocks are inserted with the subagent_id FK pointing to the subagent ULID.
 * Non-fatal: individual sub-agent failures don't block the pipeline.
 */
async function parseSubagentTranscripts(
  sql: Sql,
  s3: ReconcileS3Client,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    const subagentRows = await sql`
      SELECT id, agent_id, transcript_s3_key, team_name
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
      const subagentTeamName = row.team_name as string | null;

      try {
        const content = await s3.download(s3Key);
        const subParseResult = await parseTranscript(sessionId, content);

        if (subParseResult.messages.length === 0) {
          logger.info({ agentId }, "Sub-agent transcript has no messages — skipping");
          continue;
        }

        // Resolve teammate_id for team-affiliated subagents.
        // Uses the subagent's parsed transcript to extract the teammate name,
        // then looks up the teammates table for the matching row.
        // Returns null for non-team subagents (teammate_id stays NULL).
        let teammateId: string | null = null;
        try {
          teammateId = await resolveTeammateFromParseResult(
            sql, sessionId, subParseResult, subagentTeamName,
          );
          if (teammateId) {
            logger.info({ agentId, teammateId }, `Resolved teammate_id for sub-agent ${agentId}`);
          }
        } catch (err) {
          // Non-fatal: if teammate resolution fails, messages are still inserted
          // without teammate_id. The field can be backfilled later.
          logger.warn(
            { agentId, error: err instanceof Error ? err.message : String(err) },
            `Failed to resolve teammate_id for sub-agent ${agentId} — continuing without it`,
          );
        }

        // Persist with subagent_id and teammate_id FKs set
        await sql.begin(async (tx: any) => {
          await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId} AND subagent_id = ${subagentUlid}`;
          await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId} AND subagent_id = ${subagentUlid}`;

          await batchInsertMessages(tx, subParseResult.messages, subagentUlid, teammateId);
          await batchInsertContentBlocks(tx, subParseResult.contentBlocks, subagentUlid, teammateId);
        });

        logger.info(
          { agentId, teammateId, messages: subParseResult.messages.length, blocks: subParseResult.contentBlocks.length },
          `Parsed sub-agent transcript for ${agentId}`,
        );
      } catch (err) {
        logger.warn(
          { agentId, error: err instanceof Error ? err.message : String(err) },
          `Failed to parse sub-agent transcript for ${agentId} — continuing`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "Failed to process sub-agent transcripts — continuing reconcile",
    );
  }
}

// ---------------------------------------------------------------------------
// Batch insert helpers (identical to session-pipeline.ts)
// ---------------------------------------------------------------------------

import type { TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";
import { resolveTeammateFromParseResult } from "./teammate-mapping.js";

/**
 * Insert transcript messages in batches of BATCH_SIZE.
 * Uses sql.unsafe with parameterized values to avoid exceeding Postgres limits.
 *
 * @param subagentId  - FK to subagents table; null for main session messages
 * @param teammateId  - FK to teammates table; set for team-affiliated subagent messages
 */
async function batchInsertMessages(
  tx: Sql,
  messages: TranscriptMessage[],
  subagentId: string | null = null,
  teammateId: string | null = null,
): Promise<void> {
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE);
    if (chunk.length === 0) continue;

    const colCount = 23;
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
        `$${offset + 21}, $${offset + 22}, $${offset + 23})`,
      );
      values.push(
        m.id,
        m.session_id,
        m.line_number,
        m.ordinal,
        m.message_type,
        m.role,
        m.model,
        m.tokens_in,
        m.tokens_out,
        m.cache_read,
        m.cache_write,
        m.cost_usd,
        m.compact_sequence,
        m.is_compacted,
        m.timestamp,
        JSON.stringify(m.raw_message),
        JSON.stringify(m.metadata),
        m.has_text,
        m.has_thinking,
        m.has_tool_use,
        m.has_tool_result,
        subagentId,
        teammateId,
      );
    }

    await tx.unsafe(
      `INSERT INTO transcript_messages (
        id, session_id, line_number, ordinal, message_type, role, model,
        tokens_in, tokens_out, cache_read, cache_write, cost_usd,
        compact_sequence, is_compacted, timestamp, raw_message, metadata,
        has_text, has_thinking, has_tool_use, has_tool_result, subagent_id, teammate_id
      ) VALUES ${placeholders.join(", ")}`,
      values as any[],
    );
  }
}

/**
 * Insert content blocks in batches of BATCH_SIZE.
 * Uses sql.unsafe with parameterized values to avoid exceeding Postgres limits.
 *
 * @param subagentId  - FK to subagents table; null for main session blocks
 * @param teammateId  - FK to teammates table; set for team-affiliated subagent blocks
 */
async function batchInsertContentBlocks(
  tx: Sql,
  blocks: ParsedContentBlock[],
  subagentId: string | null = null,
  teammateId: string | null = null,
): Promise<void> {
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const chunk = blocks.slice(i, i + BATCH_SIZE);
    if (chunk.length === 0) continue;

    const colCount = 16;
    const placeholders: string[] = [];
    const values: unknown[] = [];

    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j];
      const offset = j * colCount;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, ` +
        `$${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, ` +
        `$${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, ` +
        `$${offset + 16})`,
      );
      values.push(
        b.id,
        b.message_id,
        b.session_id,
        b.block_order,
        b.block_type,
        b.content_text,
        b.thinking_text,
        b.tool_name,
        b.tool_use_id,
        JSON.stringify(b.tool_input),
        b.tool_result_id,
        b.is_error,
        b.result_text,
        JSON.stringify(b.metadata),
        subagentId,
        teammateId,
      );
    }

    await tx.unsafe(
      `INSERT INTO content_blocks (
        id, message_id, session_id, block_order, block_type,
        content_text, thinking_text, tool_name, tool_use_id, tool_input,
        tool_result_id, is_error, result_text, metadata, subagent_id, teammate_id
      ) VALUES ${placeholders.join(", ")}`,
      values as any[],
    );
  }
}
