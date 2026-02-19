/**
 * Backfill state persistence for the fuel-code historical session scanner.
 *
 * Stores state at ~/.fuel-code/backfill-state.json so that:
 *   - Users can check status of the last backfill run
 *   - Interrupted backfills can resume without re-ingesting completed sessions
 *   - Concurrent runs are detected (isRunning flag)
 *
 * The state file is a simple JSON document read/written atomically.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result summary from a completed backfill run */
export interface BackfillResult {
  /** Number of sessions successfully ingested */
  ingested: number;
  /** Number of sessions skipped (already in backend) */
  skipped: number;
  /** Number of sessions that failed to ingest */
  failed: number;
  /** Per-session error details */
  errors: Array<{ sessionId: string; error: string }>;
  /** Total bytes of transcript data processed */
  totalSizeBytes: number;
  /** Wall-clock duration of the backfill run */
  durationMs: number;
}

/** Persisted backfill state for resume and status reporting */
export interface BackfillState {
  /** ISO-8601 timestamp of the last completed run (null if never run) */
  lastRunAt: string | null;
  /** Result summary from the last completed run */
  lastRunResult: BackfillResult | null;
  /** Whether a backfill is currently in progress */
  isRunning: boolean;
  /** ISO-8601 timestamp of when the current run started */
  startedAt: string | null;
  /** Session IDs already ingested — for resume after interruption */
  ingestedSessionIds: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default directory for backfill state (same as fuel-code config dir) */
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".fuel-code");

/** Filename for the backfill state JSON */
const STATE_FILENAME = "backfill-state.json";

// ---------------------------------------------------------------------------
// Default state factory
// ---------------------------------------------------------------------------

/** Create a fresh BackfillState with all fields at their zero values */
function createDefaultState(): BackfillState {
  return {
    lastRunAt: null,
    lastRunResult: null,
    isRunning: false,
    startedAt: null,
    ingestedSessionIds: [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the backfill state from disk.
 *
 * Returns a default (empty) state if the file doesn't exist or is unreadable.
 * Never throws — missing/corrupt files are treated as "no prior state".
 *
 * @param stateDir - Directory containing backfill-state.json (default: ~/.fuel-code/)
 */
export function loadBackfillState(stateDir?: string): BackfillState {
  const dir = stateDir ?? DEFAULT_STATE_DIR;
  const filePath = path.join(dir, STATE_FILENAME);

  if (!fs.existsSync(filePath)) {
    return createDefaultState();
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BackfillState>;

    // Merge with defaults to handle missing fields from older state files
    return {
      lastRunAt: parsed.lastRunAt ?? null,
      lastRunResult: parsed.lastRunResult ?? null,
      isRunning: parsed.isRunning ?? false,
      startedAt: parsed.startedAt ?? null,
      ingestedSessionIds: Array.isArray(parsed.ingestedSessionIds)
        ? parsed.ingestedSessionIds
        : [],
    };
  } catch {
    // Corrupted file — return default state
    return createDefaultState();
  }
}

/**
 * Persist backfill state to disk atomically.
 *
 * Uses a temp file + rename strategy to avoid partial writes.
 * Creates the state directory if it doesn't exist.
 *
 * @param state - The backfill state to persist
 * @param stateDir - Directory to write backfill-state.json (default: ~/.fuel-code/)
 */
export function saveBackfillState(
  state: BackfillState,
  stateDir?: string,
): void {
  const dir = stateDir ?? DEFAULT_STATE_DIR;
  const filePath = path.join(dir, STATE_FILENAME);

  // Ensure the directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: write to temp file then rename
  const tmpPath = path.join(
    dir,
    `.${STATE_FILENAME}.tmp.${crypto.randomBytes(4).toString("hex")}`,
  );

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
