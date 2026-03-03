/**
 * computeGap() — compares current DB state against a SessionSeed to determine
 * what pipeline work remains.
 *
 * The reconciler calls this after matching a seed to a DB row. The returned
 * SessionGap is a flat struct of boolean flags — one per pipeline step. The
 * pipeline reads the gap and dispatches only the steps that are flagged true.
 *
 * Lifecycle progression:
 *   detected -> ended -> transcript_ready -> parsed -> summarized -> complete
 *
 * Each step's flag is set based on the session's current lifecycle state:
 *   - transcript_ready: needs parsing, stats, subagent parsing, team detection
 *   - parsed: needs summary, teammate summaries
 *   - summarized: needs teammate summaries (if not yet done), lifecycle advance
 *   - complete: all-false (terminal)
 *   - failed: all-false except needsLifecycleAdvance=false
 */

import type { SessionSeed, SessionGap } from "../types/reconcile.js";
import type { SessionLifecycle } from "../session-lifecycle.js";

// ---------------------------------------------------------------------------
// Minimal session row shape accepted by computeGap
// ---------------------------------------------------------------------------

/**
 * The subset of session DB columns that computeGap needs.
 * Callers SELECT these columns and pass the row directly.
 */
export interface SessionForGap {
  lifecycle: SessionLifecycle;
  transcript_s3_key?: string | null;
  started_at: string;
  ended_at?: string | null;
  duration_ms?: number | null;
  summary?: string | null;
  subagent_count?: number | null;
}

// ---------------------------------------------------------------------------
// computeGap
// ---------------------------------------------------------------------------

/**
 * Compare a session's current DB state against the desired state (seed) and
 * return a SessionGap indicating what pipeline steps still need to run.
 *
 * @param session - Current session row from the DB (partial, only needs fields above)
 * @param seed    - The normalized SessionSeed from any origin
 * @returns SessionGap with boolean flags for each pending pipeline step
 */
export function computeGap(session: SessionForGap, seed: SessionSeed): SessionGap {
  const lifecycle = session.lifecycle;

  // Terminal states: nothing to do
  const isTerminal = lifecycle === "complete" || lifecycle === "failed";

  // Transcript upload is needed when we have a disk-based transcript ref
  // but the session row has no S3 key yet
  const needsTranscriptUpload =
    !isTerminal &&
    !session.transcript_s3_key &&
    seed.transcriptRef?.type === "disk";

  // Parsing, stats, subagent parsing, and team detection all happen when
  // the session is in transcript_ready (transcript uploaded, not yet parsed)
  const isReadyForParsing = lifecycle === "transcript_ready";
  const needsParsing = isReadyForParsing;
  const needsSubagentParsing = isReadyForParsing;
  const needsTeamDetection = isReadyForParsing;
  const needsStats = isReadyForParsing;

  // Summary generation happens after parsing completes
  const needsSummary = lifecycle === "parsed";

  // Teammate summaries can be generated after the main summary or alongside
  // it — flag it for both parsed and summarized states
  const needsTeammateSummaries =
    lifecycle === "parsed" || lifecycle === "summarized";

  // Lifecycle should advance for any non-terminal state
  const needsLifecycleAdvance = !isTerminal;

  // Stale field detection: the DB row has placeholder values that the seed
  // can correct (common in backfill where session.start arrives before
  // session.end, or where hooks sent 0 for duration).

  // started_at is stale when DB has started_at === ended_at but the seed
  // has distinct values (backfill discovered the real start time).
  // Terminal sessions are never stale — their data is final.
  const staleStartedAt =
    !isTerminal &&
    !!session.ended_at &&
    session.started_at === session.ended_at &&
    !!seed.startedAt &&
    !!seed.endedAt &&
    seed.startedAt !== seed.endedAt;

  // duration_ms is stale when DB has 0 but the seed computed a real duration.
  // Terminal sessions are never stale.
  const staleDurationMs =
    !isTerminal &&
    (session.duration_ms === 0 || session.duration_ms == null) &&
    !!seed.durationMs &&
    seed.durationMs > 0;

  // subagent_count is always flagged for recomputation from DB — the
  // actual count comes from the subagents table, not the seed
  const staleSubagentCount = !isTerminal;

  return {
    needsTranscriptUpload,
    needsParsing,
    needsSubagentParsing,
    needsTeamDetection,
    needsStats,
    needsSummary,
    needsTeammateSummaries,
    needsLifecycleAdvance,
    staleStartedAt,
    staleDurationMs,
    staleSubagentCount,
  };
}
