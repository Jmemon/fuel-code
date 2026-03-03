/**
 * Reconciler types for the session pipeline.
 *
 * SessionSeed is the normalized input that any session origin (hook, backfill,
 * recovery) produces. It contains everything the reconciler needs to decide
 * whether a session already exists and what processing is still pending.
 *
 * SessionGap is the reconciler's output: a bitmask-style struct that tells the
 * pipeline exactly which steps still need to run for a given session. The
 * pipeline iterates the true flags and dispatches accordingly.
 */

/**
 * SessionSeed — normalized input for the reconciler.
 *
 * Every session origin (hook event, backfill scan, recovery sweep) must
 * produce a SessionSeed. The reconciler compares it against the existing
 * DB row (if any) to compute a SessionGap.
 */
export interface SessionSeed {
  /** Claude Code's own session identifier */
  ccSessionId: string;
  /** How this session was discovered */
  origin: 'hook' | 'backfill' | 'recovery';
  /** Canonical workspace identifier (e.g. github.com/org/repo) */
  workspaceCanonicalId: string;
  /** Device ID that ran this session */
  deviceId: string;
  /** Working directory where the session ran */
  cwd: string;
  /** Git branch at session start (null if not in a git repo) */
  gitBranch: string | null;
  /** Normalized git remote URL (null if not in a git repo) */
  gitRemote: string | null;
  /** Claude model used (null if unknown) */
  model: string | null;
  /** Claude Code CLI version (null if unknown) */
  ccVersion: string | null;
  /** Human-readable description of the source (e.g. "hook:session.end", "backfill:scan") */
  source: string;
  /** When the session started (ISO 8601) */
  startedAt: string;
  /** When the session ended (null if still active) */
  endedAt: string | null;
  /** Duration in milliseconds (null if still active or unknown) */
  durationMs: number | null;
  /** Why the session ended (e.g. "user_exit", "crash") */
  endReason: string | null;
  /** Where the raw transcript lives */
  transcriptRef: { type: 'disk'; path: string } | { type: 's3'; key: string } | null;
  /** Whether this session is currently running (lsof / process check) */
  isLive: boolean;
}

/**
 * SessionGap — what the reconciler determined still needs to happen.
 *
 * Each boolean flag corresponds to a pipeline step. The reconciler sets
 * flags to true when the step hasn't been completed yet (or needs to be
 * re-run due to stale data). The pipeline reads this struct and dispatches
 * only the needed steps.
 */
export interface SessionGap {
  /** Transcript needs to be uploaded from disk to S3 */
  needsTranscriptUpload: boolean;
  /** Transcript needs to be parsed into messages + content blocks */
  needsParsing: boolean;
  /** Subagent transcripts need to be parsed */
  needsSubagentParsing: boolean;
  /** Multi-agent team membership needs to be detected from transcript */
  needsTeamDetection: boolean;
  /** Aggregate stats (tokens, cost, message counts) need to be computed */
  needsStats: boolean;
  /** Session needs an LLM-generated summary */
  needsSummary: boolean;
  /** Individual teammate summaries need to be generated */
  needsTeammateSummaries: boolean;
  /** Lifecycle state needs to advance to the next stage */
  needsLifecycleAdvance: boolean;
  /** started_at in DB is stale relative to the seed's value */
  staleStartedAt: boolean;
  /** duration_ms in DB is stale relative to the seed's value */
  staleDurationMs: boolean;
  /** subagent_count in DB is stale relative to current transcript data */
  staleSubagentCount: boolean;
}
