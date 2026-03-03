/**
 * SessionSeed builder functions.
 *
 * A SessionSeed is the universal normalized input for the reconciler. Every
 * session origin (hook event, backfill filesystem scan, recovery from DB row)
 * must produce one. The reconciler then compares it against the current DB
 * state to determine what work remains via computeGap().
 *
 * Three builders:
 *   - buildSeedFromHook: richest data — model, gitRemote, ccVersion all present
 *   - buildSeedFromFilesystem: from backfill scanner's DiscoveredSession
 *   - buildSeedFromRecovery: from an existing DB row being re-processed
 */

import type { SessionSeed } from "../types/reconcile.js";
import type { DiscoveredSession } from "../session-backfill.js";
import type { Event } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Hook event -> SessionSeed
// ---------------------------------------------------------------------------

/**
 * Build a SessionSeed from a hook-emitted event (session.start or session.end).
 *
 * Hook events carry the richest metadata because the CLI helpers resolve
 * workspace identity, git remote, Claude version, etc. at emission time.
 *
 * @param event - The ingested Event from Redis/Postgres. Expects event.data to
 *   contain: cc_session_id, cwd, git_branch, git_remote, cc_version, model,
 *   source, transcript_path.
 * @param workspaceCanonicalId - Resolved canonical workspace ID (e.g. "github.com/org/repo")
 */
export function buildSeedFromHook(
  event: Event,
  workspaceCanonicalId: string,
): SessionSeed {
  const data = event.data;

  return {
    ccSessionId: data.cc_session_id as string,
    origin: "hook",
    workspaceCanonicalId,
    deviceId: event.device_id,
    cwd: (data.cwd as string) ?? "",
    gitBranch: (data.git_branch as string | null) ?? null,
    gitRemote: (data.git_remote as string | null) ?? null,
    model: (data.model as string | null) ?? null,
    ccVersion: (data.cc_version as string | null) ?? null,
    source: `hook:${event.type}`,
    startedAt: event.timestamp,
    endedAt: event.type === "session.end" ? event.timestamp : null,
    durationMs: event.type === "session.end"
      ? ((data.duration_ms as number) ?? null)
      : null,
    endReason: (data.end_reason as string | null) ?? null,
    transcriptRef: data.transcript_path
      ? { type: "disk", path: data.transcript_path as string }
      : null,
    isLive: event.type === "session.start",
  };
}

// ---------------------------------------------------------------------------
// Backfill filesystem scan -> SessionSeed
// ---------------------------------------------------------------------------

/**
 * Build a SessionSeed from a DiscoveredSession found by the backfill scanner.
 *
 * Filesystem discovery is less rich than hooks: model and ccVersion are
 * typically unavailable unless the JSONL header contains them. Timestamps
 * come from the first/last message timestamps in the transcript.
 *
 * @param discovered - A DiscoveredSession from scanForSessions()
 * @param deviceId   - The current device ID (backfill always runs locally)
 */
export function buildSeedFromFilesystem(
  discovered: DiscoveredSession,
  deviceId: string,
): SessionSeed {
  return {
    ccSessionId: discovered.sessionId,
    origin: "backfill",
    workspaceCanonicalId: discovered.workspaceCanonicalId,
    deviceId,
    cwd: discovered.resolvedCwd ?? "",
    gitBranch: discovered.gitBranch,
    gitRemote: null, // not available from filesystem scan
    model: null,     // not reliably available from JSONL
    ccVersion: null, // not available from filesystem scan
    source: "backfill:scan",
    startedAt: discovered.firstTimestamp ?? new Date().toISOString(),
    endedAt: discovered.lastTimestamp ?? null,
    durationMs: computeDurationFromTimestamps(
      discovered.firstTimestamp,
      discovered.lastTimestamp,
    ),
    endReason: null, // unknown from filesystem scan
    transcriptRef: { type: "disk", path: discovered.transcriptPath },
    isLive: discovered.isLive ?? false,
  };
}

// ---------------------------------------------------------------------------
// Recovery from existing DB row -> SessionSeed
// ---------------------------------------------------------------------------

/**
 * Minimal session row shape needed by buildSeedFromRecovery.
 * Avoids importing the full Session type so this stays decoupled.
 */
interface SessionRow {
  id: string;
  workspace_id: string;
  device_id: string;
  cwd?: string;
  git_branch?: string | null;
  git_remote?: string | null;
  model?: string | null;
  lifecycle: string;
  started_at: string;
  ended_at?: string | null;
  duration_ms?: number | null;
  end_reason?: string | null;
  transcript_s3_key?: string | null;
}

/**
 * Build a SessionSeed from an existing session DB row for re-processing.
 *
 * Used by the recovery sweep when a session is stuck in a non-terminal state
 * and needs to be reprocessed. The transcript reference points to the existing
 * S3 key (if present) since the transcript was already uploaded.
 *
 * @param session              - A session row from Postgres
 * @param workspaceCanonicalId - Resolved canonical workspace ID
 */
export function buildSeedFromRecovery(
  session: SessionRow,
  workspaceCanonicalId: string,
): SessionSeed {
  return {
    ccSessionId: session.id,
    origin: "recovery",
    workspaceCanonicalId,
    deviceId: session.device_id,
    cwd: session.cwd ?? "",
    gitBranch: session.git_branch ?? null,
    gitRemote: session.git_remote ?? null,
    model: session.model ?? null,
    ccVersion: null, // not stored in session row
    source: "recovery:sweep",
    startedAt: session.started_at,
    endedAt: session.ended_at ?? null,
    durationMs: session.duration_ms ?? null,
    endReason: session.end_reason ?? null,
    transcriptRef: session.transcript_s3_key
      ? { type: "s3", key: session.transcript_s3_key }
      : null,
    isLive: false, // recovery targets completed/stuck sessions, never live
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute duration in milliseconds from two ISO-8601 timestamps.
 * Returns null if either timestamp is missing or unparseable.
 */
function computeDurationFromTimestamps(
  start: string | null,
  end: string | null,
): number | null {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (isNaN(startMs) || isNaN(endMs)) return null;
  return Math.max(0, endMs - startMs);
}
