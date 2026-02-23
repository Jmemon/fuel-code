/**
 * Historical session backfill scanner for fuel-code.
 *
 * Discovers all Claude Code sessions stored in ~/.claude/projects/ and provides
 * ingestion into the fuel-code backend. Real-world observations:
 *   - ~1,130 JSONL transcript files totaling ~1.1 GB
 *   - Largest single file: 144 MB
 *   - Directory naming: hyphens replace slashes (e.g., -Users-john-Desktop-repo)
 *   - Files are UUID-named: {uuid}.jsonl
 *   - sessions-index.json provides pre-indexed metadata when available
 *   - Subagent directories ({session_id}/subagents/) should be skipped
 *
 * The scanner has two phases:
 *   1. Discovery: scan directories, collect metadata, resolve workspaces
 *   2. Ingestion: upload transcripts and emit synthetic session events
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  deriveWorkspaceCanonicalId,
  generateId,
  normalizeGitRemote,
  type Event,
  type EventType,
} from "@fuel-code/shared";
import type { BackfillResult } from "./backfill-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A session discovered by the scanner from ~/.claude/projects/ */
export interface DiscoveredSession {
  /** UUID session ID (extracted from filename) */
  sessionId: string;
  /** Absolute path to the JSONL transcript file */
  transcriptPath: string;
  /** Claude projects directory name (e.g., "-Users-john-Desktop-repo") */
  projectDir: string;
  /** Decoded filesystem path from the directory name (null if unresolvable) */
  resolvedCwd: string | null;
  /** Workspace canonical ID — resolved from git or "_unassociated" */
  workspaceCanonicalId: string;
  /** Git branch if known (from sessions-index.json or JSONL header) */
  gitBranch: string | null;
  /** First user prompt if known (from sessions-index.json) */
  firstPrompt: string | null;
  /** ISO-8601 timestamp of the first message */
  firstTimestamp: string | null;
  /** ISO-8601 timestamp of the last message */
  lastTimestamp: string | null;
  /** File size in bytes */
  fileSizeBytes: number;
  /** Message count from sessions-index.json (null if unavailable) */
  messageCount: number | null;
}

/** Result from scanning all Claude project directories */
export interface ScanResult {
  /** Sessions discovered and ready for ingestion */
  discovered: DiscoveredSession[];
  /** Errors encountered during scanning (non-fatal) */
  errors: Array<{ path: string; error: string }>;
  /** Counts of intentionally skipped items */
  skipped: {
    /** Subagent transcript directories */
    subagents: number;
    /** Non-JSONL files (sessions-index.json, .DS_Store, etc.) */
    nonJsonl: number;
    /** Files modified recently (potentially active sessions) */
    potentiallyActive: number;
  };
}

/** Progress callback data during ingestion */
export interface BackfillProgress {
  /** Total number of sessions to process */
  total: number;
  /** Number completed (ingested or skipped) */
  completed: number;
  /** Number skipped (already in backend) */
  skipped: number;
  /** Number that failed */
  failed: number;
  /** Session ID currently being processed (null if between sessions) */
  currentSession: string | null;
}

/** Dependencies injected into the ingestion function */
export interface IngestDeps {
  /** Base URL of the fuel-code backend (e.g., "http://localhost:3000") */
  serverUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Device ID to stamp on synthetic events */
  deviceId: string;
  /** Progress callback fired after each session */
  onProgress?: (progress: BackfillProgress) => void;
  /** AbortSignal for clean cancellation (Ctrl-C) */
  signal?: AbortSignal;
  /** Number of events per ingest POST (default: 50) */
  batchSize?: number;
  /** Milliseconds to wait between batches (default: 100) */
  throttleMs?: number;
  /** Set of session IDs already ingested (for resume) */
  alreadyIngested?: Set<string>;
  /** Number of sessions to process concurrently (default: 10) */
  concurrency?: number;
}

/** Entry from a sessions-index.json file */
interface SessionsIndexEntry {
  sessionId: string;
  projectPath?: string;
  created?: string;
  modified?: string;
  gitBranch?: string;
  firstPrompt?: string;
  messageCount?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path to Claude Code's project transcript directory */
const DEFAULT_CLAUDE_PROJECTS_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
);

/** UUID v4 pattern for validating session IDs extracted from filenames */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Default: skip files modified within last 5 minutes (likely active sessions) */
const DEFAULT_SKIP_ACTIVE_THRESHOLD_MS = 300_000;

/** HTTP timeout for dedup checks and transcript uploads (2 minutes) */
const HTTP_TIMEOUT_MS = 120_000;

/**
 * Combine the user's abort signal with a timeout into a single signal.
 * When either fires, the combined signal aborts — enabling immediate
 * cancellation of in-flight HTTP requests on Ctrl-C.
 */
function combinedSignal(userSignal?: AbortSignal): AbortSignal {
  if (!userSignal) return AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return AbortSignal.any([userSignal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]);
}

/**
 * Abort-aware sleep: resolves after `ms` milliseconds OR rejects immediately
 * if the abort signal fires. This ensures retry backoff loops don't block
 * cancellation.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// projectDirToPath: convert Claude projects directory name to filesystem path
// ---------------------------------------------------------------------------

/**
 * Convert a Claude projects directory name back to a filesystem path.
 *
 * Claude Code names project directories by replacing "/" with "-" in the
 * absolute project path. For example:
 *   "-Users-johnmemon-Desktop-contextual-clarity"
 *   → "/Users/johnmemon/Desktop/contextual-clarity"
 *
 * The challenge: hyphens in the original path components are indistinguishable
 * from the hyphen-separators. We use a greedy approach that tries to find the
 * longest valid path prefix, then appends the remaining segments.
 *
 * @param dirName - The Claude projects directory name (e.g., "-Users-john-Desktop-repo")
 * @returns The resolved filesystem path (e.g., "/Users/john/Desktop/repo")
 */
export function projectDirToPath(dirName: string): string {
  // Leading "-" maps to leading "/"
  if (!dirName.startsWith("-")) {
    return dirName;
  }

  // Strip leading dash and split on remaining dashes
  const rest = dirName.slice(1);
  const parts = rest.split("-");

  // Greedy approach: try to build the longest valid path by checking each
  // prefix. When a prefix exists on disk, commit to it and start a new segment.
  // This correctly handles directory names with hyphens (e.g., "my-project").
  let resolved = "/";
  let currentSegment = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Try extending the current segment with this part (hyphen-joined)
    const candidateWithExtend = currentSegment
      ? `${currentSegment}-${part}`
      : part;

    if (currentSegment === "") {
      // No current segment — this part starts a new one
      currentSegment = part;
    } else {
      // Check if committing the current segment as a directory is valid,
      // and starting fresh with this part
      const committedPath = path.join(resolved, currentSegment);

      try {
        const stat = fs.statSync(committedPath);
        if (stat.isDirectory()) {
          // The current segment is a valid directory — commit it
          resolved = committedPath;
          currentSegment = part;
          continue;
        }
      } catch {
        // Not a valid directory — keep extending
      }

      // Current segment path doesn't exist as directory — extend it
      currentSegment = candidateWithExtend;
    }
  }

  // Append whatever remains as the final segment
  if (currentSegment) {
    resolved = path.join(resolved, currentSegment);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// scanForSessions: discover all historical sessions
// ---------------------------------------------------------------------------

/**
 * Discover all historical Claude Code sessions from the projects directory.
 *
 * Scans each project subdirectory for JSONL transcript files, using
 * sessions-index.json for metadata when available. Skips subagent
 * directories, non-JSONL files, and recently modified files.
 *
 * @param claudeProjectsDir - Path to ~/.claude/projects/ (overridable for tests)
 * @param options.skipActiveThresholdMs - Skip files modified within this many ms (default: 5 min)
 * @param options.onProgress - Called with directory name as each project dir is scanned
 */
export async function scanForSessions(
  claudeProjectsDir?: string,
  options?: {
    skipActiveThresholdMs?: number;
    onProgress?: (dirScanned: string) => void;
  },
): Promise<ScanResult> {
  const projectsDir = claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
  const skipThreshold =
    options?.skipActiveThresholdMs ?? DEFAULT_SKIP_ACTIVE_THRESHOLD_MS;
  const now = Date.now();

  const result: ScanResult = {
    discovered: [],
    errors: [],
    skipped: { subagents: 0, nonJsonl: 0, potentiallyActive: 0 },
  };

  // Check if the projects directory exists
  if (!fs.existsSync(projectsDir)) {
    return result;
  }

  // List all project directories
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsDir);
  } catch (err) {
    result.errors.push({
      path: projectsDir,
      error: `Failed to read projects directory: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }

  // Cache workspace resolution per CWD to avoid repeated git invocations
  // (most sessions in the same project dir share one CWD)
  const workspaceCache = new Map<string, string>();

  for (const projectDir of projectDirs) {
    const projectDirPath = path.join(projectsDir, projectDir);

    // Skip non-directories at the top level
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(projectDirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) {
      result.skipped.nonJsonl++;
      continue;
    }

    // Report progress
    options?.onProgress?.(projectDir);

    // Try to load sessions-index.json for this project
    const sessionsIndex = loadSessionsIndex(projectDirPath);

    // List entries in the project directory
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectDirPath, { withFileTypes: true });
    } catch (err) {
      result.errors.push({
        path: projectDirPath,
        error: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(projectDirPath, entry.name);

      // Skip subdirectories (subagent transcripts live in {sessionId}/subagents/)
      if (entry.isDirectory()) {
        result.skipped.subagents++;
        continue;
      }

      // Skip non-JSONL files (sessions-index.json, .DS_Store, etc.)
      if (!entry.name.endsWith(".jsonl")) {
        result.skipped.nonJsonl++;
        continue;
      }

      // Extract session ID from filename (strip .jsonl extension)
      const sessionId = entry.name.replace(/\.jsonl$/, "");

      // Validate session ID is a UUID
      if (!UUID_REGEX.test(sessionId)) {
        result.skipped.nonJsonl++;
        continue;
      }

      // Check file stats for recency and size
      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(entryPath);
      } catch (err) {
        result.errors.push({
          path: entryPath,
          error: `Failed to stat file: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // Skip files modified within the threshold (potentially active sessions)
      if (now - fileStat.mtimeMs < skipThreshold) {
        result.skipped.potentiallyActive++;
        continue;
      }

      // Build the discovered session object
      const discovered: DiscoveredSession = {
        sessionId,
        transcriptPath: entryPath,
        projectDir,
        resolvedCwd: null,
        workspaceCanonicalId: "_unassociated",
        gitBranch: null,
        firstPrompt: null,
        firstTimestamp: null,
        lastTimestamp: null,
        fileSizeBytes: fileStat.size,
        messageCount: null,
      };

      // Try to enrich from sessions-index.json
      const indexEntry = sessionsIndex?.get(sessionId);
      if (indexEntry) {
        discovered.gitBranch = indexEntry.gitBranch || null;
        discovered.firstPrompt = indexEntry.firstPrompt ?? null;
        discovered.firstTimestamp = indexEntry.created ?? null;
        discovered.lastTimestamp = indexEntry.modified ?? null;
        discovered.messageCount = indexEntry.messageCount ?? null;
      }

      // Always read JSONL metadata (need cwd + fallback timestamps/branch)
      let jsonlMetadata: { firstTimestamp: string | null; lastTimestamp: string | null; gitBranch: string | null; cwd: string | null } | null = null;
      try {
        jsonlMetadata = await readJsonlMetadata(entryPath);
        discovered.firstTimestamp =
          discovered.firstTimestamp ?? jsonlMetadata.firstTimestamp;
        discovered.lastTimestamp =
          discovered.lastTimestamp ?? jsonlMetadata.lastTimestamp;
        discovered.gitBranch =
          discovered.gitBranch ?? jsonlMetadata.gitBranch;
      } catch (err) {
        result.errors.push({
          path: entryPath,
          error: `Failed to read JSONL metadata: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // CWD waterfall: authoritative sources first, projectDirToPath fallback last
      const resolvedCwd =
        indexEntry?.projectPath ||
        jsonlMetadata?.cwd ||
        projectDirToPath(projectDir);
      discovered.resolvedCwd = resolvedCwd;

      // Resolve workspace (cached per CWD)
      if (!workspaceCache.has(resolvedCwd)) {
        workspaceCache.set(resolvedCwd, resolveWorkspaceFromPath(resolvedCwd));
      }
      discovered.workspaceCanonicalId = workspaceCache.get(resolvedCwd)!;

      result.discovered.push(discovered);
    }
  }

  // Sort by firstTimestamp ascending (oldest first), nulls last
  result.discovered.sort((a, b) => {
    if (!a.firstTimestamp && !b.firstTimestamp) return 0;
    if (!a.firstTimestamp) return 1;
    if (!b.firstTimestamp) return -1;
    return a.firstTimestamp.localeCompare(b.firstTimestamp);
  });

  return result;
}

// ---------------------------------------------------------------------------
// ingestBackfillSessions: push discovered sessions through the pipeline
// ---------------------------------------------------------------------------

/**
 * Ingest discovered sessions into the fuel-code backend.
 *
 * Processes sessions concurrently (configurable via deps.concurrency, default 10).
 * For each session:
 *   1. Check if already ingested (dedup via GET /api/sessions/:id)
 *   2. Emit synthetic session.start event and wait for the row to exist
 *   3. Upload transcript file (POST /api/sessions/:id/transcript/upload)
 *   4. Emit synthetic session.end event
 *   5. Report progress
 *
 * Handles rate limiting (429) with shared backoff across all workers.
 * Session.end events are batched and flushed periodically.
 *
 * @param sessions - Array of discovered sessions to ingest
 * @param deps - Injected dependencies (API client, config, callbacks)
 */
export async function ingestBackfillSessions(
  sessions: DiscoveredSession[],
  deps: IngestDeps,
): Promise<BackfillResult> {
  const startTime = Date.now();
  const batchSize = deps.batchSize ?? 50;
  const throttleMs = deps.throttleMs ?? 100;
  const alreadyIngested = deps.alreadyIngested ?? new Set<string>();
  const baseUrl = deps.serverUrl.replace(/\/+$/, "");
  const concurrency = deps.concurrency ?? 10;

  const result: BackfillResult = {
    ingested: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    totalSizeBytes: 0,
    durationMs: 0,
  };

  // Shared rate limit state: when any worker hits 429, all workers pause.
  // rateLimitUntil is a timestamp (ms) until which workers should wait.
  let rateLimitUntil = 0;

  // Collect session.end events for batched ingestion. JS is single-threaded
  // so concurrent pushes are safe; flushing is coordinated below.
  let eventBatch: Event[] = [];
  let flushInProgress = false;

  /**
   * Flush the accumulated session.end event batch to the backend.
   * Prevents concurrent flushes via a simple flag (JS is single-threaded).
   */
  async function tryFlushBatch(force = false): Promise<void> {
    if (flushInProgress) return;
    if (!force && eventBatch.length < batchSize) return;
    if (eventBatch.length === 0) return;

    flushInProgress = true;
    const batch = eventBatch;
    eventBatch = [];

    try {
      await flushEventBatch(baseUrl, deps.apiKey, batch);
      if (throttleMs > 0) await sleep(throttleMs);
    } catch {
      // If batch flush fails, the transcripts are already uploaded.
      // Session.end events will be re-emitted on next backfill run.
    } finally {
      flushInProgress = false;
    }
  }

  /**
   * Wait if a rate limit is active. Returns false if the signal was aborted
   * during the wait.
   */
  async function waitForRateLimit(): Promise<boolean> {
    const now = Date.now();
    if (rateLimitUntil > now) {
      const waitMs = rateLimitUntil - now;
      try {
        await abortableSleep(waitMs, deps.signal);
      } catch {
        return false;
      }
    }
    return !deps.signal?.aborted;
  }

  /**
   * Process a single session: emit events, upload transcript, handle errors.
   * Called concurrently by the worker pool.
   */
  async function processSession(session: DiscoveredSession): Promise<void> {
    // Check for cancellation
    if (deps.signal?.aborted) return;

    // Skip if already ingested in a previous (interrupted) run
    if (alreadyIngested.has(session.sessionId)) {
      result.skipped++;
      return;
    }

    try {
      // Wait if rate-limited
      if (!(await waitForRateLimit())) return;

      // Step 1: Dedup check — does this session already exist in the backend?
      const exists = await checkSessionExists(
        baseUrl,
        deps.apiKey,
        session.sessionId,
        deps.signal,
      );
      if (exists) {
        result.skipped++;
        return;
      }

      // Step 2: Emit synthetic session.start event so the session row is created.
      const now = new Date().toISOString();

      // session_id must be null on session.start — the session row doesn't exist
      // yet (the handler creates it). The events table has a FK constraint
      // on session_id, so setting it here would violate the FK.
      const startEvent: Event = {
        id: generateId(),
        type: "session.start" as EventType,
        timestamp: session.firstTimestamp ?? now,
        device_id: deps.deviceId,
        workspace_id: session.workspaceCanonicalId,
        session_id: null,
        data: {
          cc_session_id: session.sessionId,
          cwd: session.resolvedCwd,
          git_branch: session.gitBranch,
          git_remote: null,
          cc_version: null,
          model: null,
          source: "backfill",
          transcript_path: session.transcriptPath,
        },
        ingested_at: null,
        blob_refs: [],
      };

      await flushEventBatchWithRateLimit(baseUrl, deps.apiKey, [startEvent], (until) => {
        rateLimitUntil = Math.max(rateLimitUntil, until);
      }, deps.signal);

      // Step 3: Emit session.end immediately (not batched) so the session
      // reaches "ended" state before we attempt the transcript upload.
      // If the upload fails, the session is cleanly "ended" and retryable,
      // rather than stuck at "detected" as a zombie row.
      let durationMs = 0;
      if (session.firstTimestamp && session.lastTimestamp) {
        durationMs = Math.max(
          0,
          new Date(session.lastTimestamp).getTime() -
            new Date(session.firstTimestamp).getTime(),
        );
      }

      const endEvent: Event = {
        id: generateId(),
        type: "session.end" as EventType,
        timestamp: session.lastTimestamp ?? now,
        device_id: deps.deviceId,
        workspace_id: session.workspaceCanonicalId,
        session_id: session.sessionId,
        data: {
          cc_session_id: session.sessionId,
          duration_ms: durationMs,
          end_reason: "exit",
          transcript_path: session.transcriptPath,
        },
        ingested_at: null,
        blob_refs: [],
      };

      if (!(await waitForRateLimit())) return;
      await flushEventBatchWithRateLimit(baseUrl, deps.apiKey, [endEvent], (until) => {
        rateLimitUntil = Math.max(rateLimitUntil, until);
      }, deps.signal);

      // Step 4: Upload the transcript. The session is already "ended", so
      // the upload route will trigger the pipeline. If this fails, the
      // session is still cleanly ended and can be retried later.
      if (!(await waitForRateLimit())) return;

      await uploadTranscriptWithRetry(
        baseUrl,
        deps.apiKey,
        session.sessionId,
        session.transcriptPath,
        15,   // maxRetries — generous to handle consumer backlog
        (until) => { rateLimitUntil = Math.max(rateLimitUntil, until); },
        deps.signal,
      );

      result.ingested++;
      result.totalSizeBytes += session.fileSizeBytes;
    } catch (err) {
      result.failed++;
      result.errors.push({
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Concurrent worker pool ---
  // Process sessions with bounded concurrency. A simple approach: maintain
  // an array of in-flight promises, starting new work as slots open up.
  // The abort signal is raced so Ctrl-C breaks out immediately.
  const inFlight = new Set<Promise<void>>();
  let sessionIndex = 0;
  let lastReportedSession: string | null = null;

  // A promise that rejects when the abort signal fires, used to race against
  // in-flight work so the pool loop exits immediately on Ctrl-C.
  const abortPromise = deps.signal
    ? new Promise<void>((_, reject) => {
        if (deps.signal!.aborted) { reject(new Error("Aborted")); return; }
        deps.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      })
    : null;

  function reportProgress(currentSession: string | null): void {
    deps.onProgress?.({
      total: sessions.length,
      completed: result.ingested + result.skipped + result.failed,
      skipped: result.skipped,
      failed: result.failed,
      currentSession: currentSession ?? lastReportedSession,
    });
  }

  try {
    while (sessionIndex < sessions.length) {
      if (deps.signal?.aborted) break;

      // Fill up to concurrency limit
      while (inFlight.size < concurrency && sessionIndex < sessions.length) {
        if (deps.signal?.aborted) break;

        const session = sessions[sessionIndex++];

        // Report progress as each session is launched
        lastReportedSession = session.sessionId;
        reportProgress(session.sessionId);

        const p = processSession(session).then(() => {
          inFlight.delete(p);
          reportProgress(session.sessionId);
        });
        inFlight.add(p);
      }

      // Wait for at least one to complete, or abort signal
      if (inFlight.size >= concurrency) {
        const raceTargets: Promise<void>[] = [...inFlight];
        if (abortPromise) raceTargets.push(abortPromise);
        await Promise.race(raceTargets);
      }
    }

    // Wait for remaining in-flight sessions (they'll exit fast if aborted
    // since all their fetches use the combined signal)
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  } catch {
    // AbortError from the race — wait for in-flight to drain
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  }

  // Flush any remaining session.end events
  await tryFlushBatch(true);

  // Final progress report
  reportProgress(null);

  result.durationMs = Date.now() - startTime;
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load and parse sessions-index.json from a project directory.
 * Returns a Map of sessionId → index entry, or null if unavailable.
 */
function loadSessionsIndex(
  projectDirPath: string,
): Map<string, SessionsIndexEntry> | null {
  const indexPath = path.join(projectDirPath, "sessions-index.json");

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);

    // sessions-index.json may be a plain array OR a versioned object {version, entries: [...]}
    let entries: unknown[];
    if (Array.isArray(parsed)) {
      entries = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).entries)) {
      entries = (parsed as Record<string, unknown>).entries as unknown[];
    } else {
      return null;
    }

    const map = new Map<string, SessionsIndexEntry>();
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      if (e && typeof e === "object" && e.sessionId) {
        map.set(e.sessionId as string, e as unknown as SessionsIndexEntry);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/**
 * Read metadata from the first and last few lines of a JSONL transcript file.
 *
 * Extracts timestamps and git branch from the file header without loading
 * the entire file into memory (important for 100MB+ transcripts).
 */
async function readJsonlMetadata(filePath: string): Promise<{
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  gitBranch: string | null;
  cwd: string | null;
}> {
  const result = {
    firstTimestamp: null as string | null,
    lastTimestamp: null as string | null,
    gitBranch: null as string | null,
    cwd: null as string | null,
  };

  // Check for empty file
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return result;
  }

  // Read first 5 lines for metadata (sessionId, timestamp, gitBranch)
  try {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream });

    let lineCount = 0;
    for await (const line of rl) {
      if (lineCount >= 5) {
        rl.close();
        stream.destroy();
        break;
      }

      try {
        const parsed = JSON.parse(line);
        if (parsed.timestamp && !result.firstTimestamp) {
          result.firstTimestamp = parsed.timestamp;
        }
        if (parsed.gitBranch && !result.gitBranch) {
          result.gitBranch = parsed.gitBranch;
        }
        if (parsed.cwd && !result.cwd) {
          result.cwd = parsed.cwd;
        }
      } catch {
        // Skip malformed lines
      }
      lineCount++;
    }
  } catch {
    // Best effort — return what we have
  }

  // Read last 5 lines for lastTimestamp by reading the tail of the file
  try {
    // Read the last 64KB of the file (enough for ~5 lines in most transcripts)
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const tail = buffer.toString("utf-8");
    const lines = tail.split("\n").filter((l) => l.trim().length > 0);

    // Check last 5 lines in reverse for a timestamp
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.timestamp) {
          result.lastTimestamp = parsed.timestamp;
          break;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Best effort — return what we have
  }

  return result;
}

/**
 * Run a shell command silently, returning trimmed stdout or null on failure.
 * Mirrors the pattern from cc-hook.ts for git command execution.
 */
function execSilent(cmd: string, cwd: string): string | null {
  try {
    const result = execSync(cmd, { cwd, stdio: "pipe", timeout: 5000 });
    const output = result.toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Resolve workspace using git commands — mirrors the live resolveWorkspace()
 * from cc-hook.ts. Handles subdirectories (git rev-parse walks up), remotes,
 * and local repos (no remote → local:<sha256>).
 *
 * Returns null if the path is not inside a git repo.
 */
function resolveWorkspaceWithGit(cwd: string): string | null {
  const isGitRepo = execSilent("git rev-parse --is-inside-work-tree", cwd);
  if (isGitRepo !== "true") {
    return null;
  }

  // Check for remotes (prefer origin, fall back to first alphabetically)
  let gitRemote: string | null = null;
  const remoteList = execSilent("git remote", cwd);
  if (remoteList) {
    const remotes = remoteList.split("\n").map((r) => r.trim()).filter(Boolean);
    const targetRemote = remotes.includes("origin") ? "origin" : remotes.sort()[0];
    if (targetRemote) {
      gitRemote = execSilent(`git remote get-url ${targetRemote}`, cwd);
    }
  }

  // For local repos with no remote, get the first commit hash
  let firstCommitHash: string | null = null;
  if (!gitRemote) {
    firstCommitHash = execSilent("git rev-list --max-parents=0 HEAD", cwd);
    if (firstCommitHash) {
      firstCommitHash = firstCommitHash.split("\n")[0].trim();
    }
  }

  return deriveWorkspaceCanonicalId(gitRemote, firstCommitHash);
}

/**
 * Parse a git remote URL from a .git/config file on disk.
 * Used as a filesystem fallback when git commands can't run (e.g., CWD deleted
 * but parent .git still exists).
 */
function parseGitConfigRemote(gitDir: string): string | null {
  const gitConfigPath = path.join(gitDir, "config");
  if (!fs.existsSync(gitConfigPath)) return null;

  try {
    const configContent = fs.readFileSync(gitConfigPath, "utf-8");
    const remoteMatch = configContent.match(
      /\[remote "origin"\][^[]*url\s*=\s*(.+)/,
    );
    if (remoteMatch) {
      return remoteMatch[1].trim();
    }
  } catch {
    // Best effort
  }
  return null;
}

/**
 * Resolve a workspace canonical ID from a filesystem path.
 *
 * Multi-strategy resolver:
 *   1. If path exists on disk → use git commands (handles subdirectories)
 *   2. Walk up parent directories looking for .git → parse config + deriveWorkspaceCanonicalId
 *   3. Nothing found → "_unassociated"
 */
function resolveWorkspaceFromPath(resolvedPath: string): string {
  try {
    // Strategy 1: Path exists on disk → use git commands (handles subdirs automatically)
    if (fs.existsSync(resolvedPath)) {
      const gitResult = resolveWorkspaceWithGit(resolvedPath);
      if (gitResult) return gitResult;
    }

    // Strategy 2: Walk up parent directories looking for .git/
    let current = resolvedPath;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) break; // reached filesystem root
      current = parent;

      if (!fs.existsSync(current)) continue;

      const gitDir = path.join(current, ".git");
      if (!fs.existsSync(gitDir)) continue;

      // Found a .git — try git commands first (handles local repos too)
      const gitResult = resolveWorkspaceWithGit(current);
      if (gitResult) return gitResult;

      // Fallback: parse .git/config directly + use deriveWorkspaceCanonicalId
      const remoteUrl = parseGitConfigRemote(gitDir);
      return deriveWorkspaceCanonicalId(remoteUrl, null);
    }

    // Strategy 3: Nothing found
    return "_unassociated";
  } catch {
    return "_unassociated";
  }
}

/**
 * Check if a session already exists in the backend.
 * Returns true if GET /api/sessions/:id returns 200, false on 404 or error.
 */
async function checkSessionExists(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${baseUrl}/api/sessions/${sessionId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: combinedSignal(signal),
      },
    );
    return response.ok;
  } catch (err) {
    // If aborted by user, rethrow so processSession exits immediately
    if (signal?.aborted) throw err;
    // Network error or timeout — treat as "not exists" to allow ingestion
    return false;
  }
}

/**
 * Upload a transcript with retry logic to handle:
 * 1. Race condition: session.start event hasn't been processed yet (404)
 * 2. Rate limiting: server returns 429 with Retry-After
 * 3. Transient errors: EAGAIN, connection resets, timeouts
 *
 * Uses exponential backoff with jitter, capped at 10s per retry.
 * With 15 retries the total max wait is ~90s, enough for any consumer backlog.
 */
async function uploadTranscriptWithRetry(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  transcriptPath: string,
  maxRetries = 15,
  onRateLimit?: (until: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      await uploadTranscript(baseUrl, apiKey, sessionId, transcriptPath, signal);
      return;
    } catch (err) {
      // If user cancelled, bail immediately — no retries
      if (signal?.aborted) throw err;

      const msg = err instanceof Error ? err.message : String(err);
      const is404 = msg.includes("404");
      const is429 = msg.includes("429");
      // S3/storage failures surface as 503 via the server error handler
      const is503 = msg.includes("503");
      const isTransient = msg.includes("EAGAIN") || msg.includes("ECONNRESET")
        || msg.includes("ETIMEDOUT") || msg.includes("UND_ERR_CONNECT_TIMEOUT");

      if ((is404 || is429 || is503 || isTransient) && attempt < maxRetries) {
        let waitMs: number;

        if (is429) {
          const retryMatch = msg.match(/Retry-After:\s*(\d+)/i);
          waitMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : 10_000;
          if (onRateLimit) onRateLimit(Date.now() + waitMs);
        } else {
          const base = Math.min(500 * Math.pow(2, attempt), 10_000);
          waitMs = base + Math.random() * 500;
        }

        await abortableSleep(waitMs, signal);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Upload a transcript JSONL file to the backend for a specific session.
 *
 * Uses streaming for large files to avoid loading entire transcripts into memory.
 * Throws on failure so the caller can record the error. Includes rate limit
 * headers in error messages so the retry logic can parse them.
 */
async function uploadTranscript(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  transcriptPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${baseUrl}/api/sessions/${sessionId}/transcript/upload`;

  // Use Bun.file() for efficient streaming if available, fall back to readFileSync
  let body: BodyInit;
  try {
    // Bun.file returns a lazy reference that streams on read
    body = Bun.file(transcriptPath);
  } catch {
    body = fs.readFileSync(transcriptPath);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    signal: combinedSignal(signal),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "<unreadable>");
    // Include Retry-After header in error message so retry logic can parse it
    const retryAfter = response.headers.get("Retry-After");
    const retryInfo = retryAfter ? ` Retry-After: ${retryAfter}` : "";
    throw new Error(
      `Transcript upload failed (HTTP ${response.status}): ${responseBody}${retryInfo}`,
    );
  }
}

/**
 * Flush a batch of events to the backend ingest endpoint.
 */
async function flushEventBatch(
  baseUrl: string,
  apiKey: string,
  events: Event[],
  signal?: AbortSignal,
): Promise<void> {
  const url = `${baseUrl}/api/events/ingest`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ events }),
    signal: combinedSignal(signal),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    const retryAfter = response.headers.get("Retry-After");
    const retryInfo = retryAfter ? ` Retry-After: ${retryAfter}` : "";
    throw new Error(`Event ingest failed (HTTP ${response.status}): ${body}${retryInfo}`);
  }
}

/**
 * Flush events with rate limit detection and retry.
 * On 429, waits and retries once. Calls onRateLimit so other workers can pause.
 */
async function flushEventBatchWithRateLimit(
  baseUrl: string,
  apiKey: string,
  events: Event[],
  onRateLimit: (until: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    try {
      await flushEventBatch(baseUrl, apiKey, events, signal);
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("429") && attempt < 2) {
        const retryMatch = msg.match(/Retry-After:\s*(\d+)/i);
        const waitMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : 10_000;
        onRateLimit(Date.now() + waitMs);
        await abortableSleep(waitMs, signal);
        continue;
      }
      throw err;
    }
  }
}

/** Simple sleep utility for throttling between batches */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
