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
 *   - Subagent directories ({session_id}/subagents/) contain agent-*.jsonl files
 *
 * The scanner has two phases:
 *   1. Discovery: scan directories, collect metadata, resolve workspaces
 *   2. Ingestion: write sessions directly to DB and upload transcripts to S3
 */

import { exec, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  buildTranscriptKey,
  buildSubagentTranscriptKey,
  deriveWorkspaceCanonicalId,
} from "@fuel-code/shared";
import type { Sql } from "postgres";
import type { BackfillResult } from "./backfill-state.js";
import { buildSeedFromFilesystem } from "./reconcile/session-seed.js";
import type { SessionSeed } from "./types/reconcile.js";
import { resolveOrCreateWorkspace } from "./workspace-resolver.js";
import { resolveOrCreateDevice } from "./device-resolver.js";
import { transitionSession } from "./session-lifecycle.js";

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
  /** True if the session is currently active — backfill emits session.start only, no session.end */
  isLive?: boolean;
}

/** A sub-agent transcript discovered inside a session's subagents/ directory */
export interface DiscoveredSubagentTranscript {
  /** UUID of the parent session (the directory name containing subagents/) */
  parentSessionId: string;
  /** Agent ID extracted from the filename (agent-<id>.jsonl → <id>) */
  agentId: string;
  /** Absolute path to the sub-agent JSONL transcript file */
  transcriptPath: string;
  /** File size in bytes */
  fileSizeBytes: number;
}

/** Result from scanning all Claude project directories */
export interface ScanResult {
  /** Sessions discovered and ready for ingestion */
  discovered: DiscoveredSession[];
  /** Sub-agent transcripts discovered inside session directories */
  subagentTranscripts: DiscoveredSubagentTranscript[];
  /** Errors encountered during scanning (non-fatal) */
  errors: Array<{ path: string; error: string }>;
  /** Counts of intentionally skipped items */
  skipped: {
    /** Non-session subdirectories (tool-results/, etc.) */
    subagents: number;
    /** Non-JSONL files (sessions-index.json, .DS_Store, etc.) */
    nonJsonl: number;
    /** Files modified recently (potentially active sessions) */
    potentiallyActive: number;
    /** Sub-agent transcripts skipped because they are still active */
    activeSubagents: number;
  };
}

/** Progress callback data during scanning phase */
export interface ScanProgress {
  current: number;
  total: number;
  currentDir: string;
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

/** Minimal S3 client interface used by backfill ingestion */
export interface BackfillS3Client {
  upload(key: string, body: Buffer | string, contentType?: string): Promise<{ key: string; size: number }>;
}

/** Dependencies injected into the ingestion function — writes directly to DB+S3 */
export interface IngestDeps {
  /** Postgres client for direct DB writes */
  sql: Sql;
  /** S3 client for transcript uploads */
  s3: BackfillS3Client;
  /** Device ID to stamp on session rows */
  deviceId: string;
  /** Progress callback fired after each session */
  onProgress?: (progress: BackfillProgress) => void;
  /** AbortSignal for clean cancellation (Ctrl-C) */
  signal?: AbortSignal;
  /** Set of session IDs already ingested (for resume) */
  alreadyIngested?: Set<string>;
  /** Number of sessions to process concurrently (default: 10) */
  concurrency?: number;
  /** Device name hint for resolveOrCreateDevice */
  deviceName?: string;
  /** Device type hint ("local", "remote", etc.) — defaults to "local" */
  deviceType?: string;
  /** Callback fired when a session is successfully ingested (DB row + transcript uploaded) */
  onSessionIngested?: (sessionId: string) => void;
  /** Optional callback to enqueue a session for reconcile (parsing/summary) */
  enqueueReconcile?: (sessionId: string) => void;
  /** Sub-agent transcripts discovered during scan, indexed by parentSessionId at runtime */
  subagentTranscripts?: DiscoveredSubagentTranscript[];
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
// Active session detection: check JSONL content (exit-tag) + process set lookup
// ---------------------------------------------------------------------------

/**
 * Read the last N lines of a file by reading backward from the end.
 * Returns the lines as a single string. Reads in 8KB chunks to avoid
 * loading the whole file for large transcripts.
 */
function readTailLines(filePath: string, lineCount: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return "";

    const chunkSize = 8192;
    let position = stat.size;
    let collected = "";
    let linesFound = 0;

    while (position > 0 && linesFound <= lineCount) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, position);
      collected = buf.toString("utf-8") + collected;
      // Count newlines — we need lineCount+1 to get lineCount full lines
      linesFound = 0;
      for (let i = collected.length - 1; i >= 0; i--) {
        if (collected[i] === "\n") linesFound++;
        if (linesFound > lineCount) {
          collected = collected.slice(i + 1);
          break;
        }
      }
    }

    return collected;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Returns true if the session at filePath appears to be active.
 *
 * Stage 1: if the transcript tail contains /exit, the session closed
 *   gracefully — return false immediately.
 * Stage 2: if activeSet is provided, return whether the session ID
 *   (derived from the filename) is in it. Without activeSet, returns false
 *   (activity state is unknown without process detection).
 *
 * The former lsof Stage 2 has been removed: Claude closes the transcript
 * after every event write, so lsof never reports the file as open mid-session.
 * Callers that need accurate live detection should use buildActiveSessions.
 */
export function isSessionActive(
  filePath: string,
  activeSet?: Set<string>,
): boolean {
  try {
    const tail = readTailLines(filePath, 4);
    if (tail.includes("<command-name>/exit</command-name>")) return false;
  } catch {
    return false;
  }
  if (!activeSet) return false;
  const sessionId = path.basename(filePath, ".jsonl");
  return activeSet.has(sessionId);
}

/**
 * Async version of isSessionActive. See isSessionActive for full docs.
 */
export async function isSessionActiveAsync(
  filePath: string,
  activeSet?: Set<string>,
): Promise<boolean> {
  try {
    const tail = readTailLines(filePath, 4);
    if (tail.includes("<command-name>/exit</command-name>")) return false;
  } catch {
    return false;
  }
  if (!activeSet) return false;
  const sessionId = path.basename(filePath, ".jsonl");
  return activeSet.has(sessionId);
}

// ---------------------------------------------------------------------------
// selectBestSession: pure timestamp-matching helper
// ---------------------------------------------------------------------------

/**
 * Given candidate JSONLs (with their first-event timestamps and mtimes) and
 * the process start epoch, return the session ID whose first-event timestamp
 * is closest to procStart within thresholdSeconds.
 *
 * Falls back to the most-recently-modified candidate when procStart is null
 * (ps failed to provide a start time).
 *
 * Exported for unit testing.
 */
export function selectBestSession(
  candidates: Array<{ sessionId: string; firstTimestamp: number | null; mtime: number }>,
  procStart: number | null,
  thresholdSeconds = 300,
): string | null {
  if (candidates.length === 0) return null;

  if (procStart !== null) {
    // Timestamp-proximity match: find the candidate closest to procStart within threshold.
    // Returns null if nothing falls within the window — no mtime fallback in this branch.
    let best: { sessionId: string; diff: number } | null = null;
    for (const c of candidates) {
      if (c.firstTimestamp === null) continue;
      const diff = Math.abs(c.firstTimestamp - procStart);
      if (diff <= thresholdSeconds && (best === null || diff < best.diff)) {
        best = { sessionId: c.sessionId, diff };
      }
    }
    return best ? best.sessionId : null;
  }

  // Fallback: procStart is null (ps gave no start time) — use most-recently-modified candidate.
  let bestMtime = -Infinity;
  let bestId: string | null = null;
  for (const c of candidates) {
    if (c.mtime > bestMtime) {
      bestMtime = c.mtime;
      bestId = c.sessionId;
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// Live session detection helpers
// ---------------------------------------------------------------------------

/**
 * Return PIDs of running `claude` processes.
 * Uses `pgrep -x claude` (exact name match). Returns [] on any failure.
 */
async function getClaudePids(): Promise<number[]> {
  return new Promise((resolve) => {
    exec("pgrep -x claude", (err, stdout) => {
      if (err || !stdout.trim()) { resolve([]); return; }
      const pids = stdout
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n));
      resolve(pids);
    });
  });
}

/**
 * Return the current working directory of a process via lsof.
 * Parses the `cwd` file descriptor entry; the path is the last whitespace-
 * delimited token on that line. Returns null on any failure.
 */
async function getProcessCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`lsof -p ${pid} -a -d cwd`, { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      for (const line of stdout.split("\n")) {
        if (line.includes(" cwd ")) {
          const parts = line.trim().split(/\s+/);
          resolve(parts[parts.length - 1] || null);
          return;
        }
      }
      resolve(null);
    });
  });
}

/**
 * Return the process start time as a Unix epoch (seconds) via `ps -o lstart=`.
 * macOS lstart format: "Mon Jan 19 10:30:00 2026". Returns null on any failure.
 */
async function getProcessStartEpoch(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    exec(`ps -p ${pid} -o lstart=`, { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return; }
      const epoch = new Date(stdout.trim()).getTime();
      resolve(isNaN(epoch) ? null : epoch / 1000);
    });
  });
}

/**
 * Read the first line of a JSONL file and parse the `timestamp` field to a
 * Unix epoch (seconds). Returns null on any parse failure or I/O error.
 */
function getJsonlFirstTimestamp(jsonlPath: string): number | null {
  try {
    const fd = fs.openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
      if (!firstLine) return null;
      const parsed = JSON.parse(firstLine) as { timestamp?: string };
      if (!parsed.timestamp) return null;
      const epoch = new Date(parsed.timestamp).getTime();
      return isNaN(epoch) ? null : epoch / 1000;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Build the set of session IDs that belong to currently-running Claude
 * processes. Called once before Phase B of scanForSessions.
 *
 * Strategy: pgrep → per-PID CWD via lsof → encode CWD to project dir name →
 * read first-event timestamps of candidate JSONLs → timestamp-correlate to
 * the running process via selectBestSession.
 *
 * On any failure at any stage (pgrep unavailable, lsof error, no timestamp
 * match) the function returns an empty Set so the scan proceeds normally
 * without skipping anything (Option A fallback — non-destructive).
 *
 * CWD encoding: Claude replaces path separators and dots with hyphens when
 * naming project directories (e.g. /Users/john.doe/repo → -Users-john-doe-repo).
 * Additional character substitutions may exist; if the encoded path doesn't
 * match an existing directory the PID is silently skipped.
 */
export async function buildActiveSessions(projectsDir: string): Promise<Set<string>> {
  const active = new Set<string>();

  const pids = await getClaudePids();
  if (pids.length === 0) return active;

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const cwd = await getProcessCwd(pid);
        if (!cwd) return;

        // Encode the CWD to match Claude's project directory naming scheme.
        // Known substitutions: / → - and . → -
        const encodedCwd = cwd.replace(/[/.]/g, "-");
        const projectDir = path.join(projectsDir, encodedCwd);
        if (!fs.existsSync(projectDir)) return;

        const procStart = await getProcessStartEpoch(pid);

        // Collect top-level JSONL files with valid UUID names
        const candidates = fs
          .readdirSync(projectDir)
          .filter(
            (f) =>
              f.endsWith(".jsonl") &&
              UUID_REGEX.test(f.replace(/\.jsonl$/, "")),
          )
          .map((f) => {
            const fullPath = path.join(projectDir, f);
            return {
              sessionId: f.replace(/\.jsonl$/, ""),
              firstTimestamp: getJsonlFirstTimestamp(fullPath),
              mtime: fs.statSync(fullPath).mtimeMs / 1000,
            };
          });

        // When process start time is unavailable (ps failed), skip rather than
        // guessing via mtime — consistent with Option A: ingest rather than skip
        // when we cannot confirm the session is live.
        if (procStart === null) return;
        const sessionId = selectBestSession(candidates, procStart);
        if (sessionId) active.add(sessionId);
      } catch {
        // Per Option A: silently ignore per-PID failures — the session
        // will be ingested rather than incorrectly skipped.
      }
    }),
  );

  return active;
}

// ---------------------------------------------------------------------------
// scanForSessions: discover all historical sessions
// ---------------------------------------------------------------------------

/**
 * Discover all historical Claude Code sessions from the projects directory.
 *
 * Scans each project subdirectory for JSONL transcript files, using
 * sessions-index.json for metadata when available. Skips subagent
 * directories, non-JSONL files, and active sessions (detected via exit-tag check + process set).
 *
 * @param claudeProjectsDir - Path to ~/.claude/projects/ (overridable for tests)
 * @param options.onProgress - Called with directory name as each project dir is scanned
 */
export async function scanForSessions(
  claudeProjectsDir?: string,
  options?: {
    onProgress?: (progress: ScanProgress) => void;
    signal?: AbortSignal;
    concurrency?: number;
    /** Override active-session detection for testing — skips buildActiveSessions() call */
    _activeSessions?: Set<string>;
  },
): Promise<ScanResult> {
  const projectsDir = claudeProjectsDir ?? DEFAULT_CLAUDE_PROJECTS_DIR;
  const concurrency = options?.concurrency ?? 20;

  const result: ScanResult = {
    discovered: [],
    subagentTranscripts: [],
    errors: [],
    skipped: { subagents: 0, nonJsonl: 0, potentiallyActive: 0, activeSubagents: 0 },
  };

  // Check if the projects directory exists
  if (!fs.existsSync(projectsDir)) {
    return result;
  }

  // List all project directories
  let projectDirNames: string[];
  try {
    projectDirNames = fs.readdirSync(projectsDir);
  } catch (err) {
    result.errors.push({
      path: projectsDir,
      error: `Failed to read projects directory: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }

  // ---------- Phase A: Serial collect (cheap fs reads only, no lsof) ----------
  // Collects pending session items and handles directories/non-JSONL inline.

  interface PendingSession {
    sessionId: string;
    entryPath: string;
    projectDir: string;
    sessionsIndex: Map<string, SessionsIndexEntry> | null;
    fileStat: fs.Stats;
  }

  interface PendingSubagent {
    parentSessionId: string;
    agentId: string;
    saPath: string;
  }

  const pendingSessions: PendingSession[] = [];
  const pendingSubagents: PendingSubagent[] = [];

  for (const projectDir of projectDirNames) {
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
      // Discover sub-agent transcripts inside UUID-named session directories.
      // Other subdirectories (tool-results/, etc.) are still skipped.
      if (entry.isDirectory()) {
        if (UUID_REGEX.test(entry.name)) {
          const subagentsDir = path.join(projectDirPath, entry.name, "subagents");
          if (fs.existsSync(subagentsDir)) {
            try {
              const saFiles = fs.readdirSync(subagentsDir);
              for (const saFile of saFiles) {
                if (saFile.startsWith("agent-") && saFile.endsWith(".jsonl")) {
                  const saPath = path.join(subagentsDir, saFile);
                  const agentId = saFile.replace("agent-", "").replace(".jsonl", "");
                  pendingSubagents.push({ parentSessionId: entry.name, agentId, saPath });
                }
              }
            } catch (err) {
              result.errors.push({
                path: subagentsDir,
                error: `Failed to read subagents directory: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
        } else {
          result.skipped.subagents++;
        }
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

      const entryPath = path.join(projectDirPath, entry.name);

      // Stat the file (cheap, no subprocess)
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

      pendingSessions.push({ sessionId, entryPath, projectDir, sessionsIndex, fileStat });
    }
  }

  const totalSessionFiles = pendingSessions.length;

  // Build active session set once before Phase B — O(live_processes), not O(sessions).
  // _activeSessions option is used in tests to inject a known set without spawning processes.
  const activeSessions = options?._activeSessions ?? await buildActiveSessions(projectsDir);

  // ---------- Phase B: Concurrent process (worker pool) ----------
  // Each worker: exit-tag + active-set check → readJsonlMetadata → resolveWorkspaceFromPath

  const workspaceCache = new Map<string, string>();
  let sessionFilesProcessed = 0;

  // Process subagents concurrently (exit-tag + active-set check before ingest)
  const subagentWorkers: Promise<void>[] = [];
  let saIdx = 0;
  for (let w = 0; w < concurrency; w++) {
    subagentWorkers.push((async () => {
      while (saIdx < pendingSubagents.length) {
        if (options?.signal?.aborted) return;
        const item = pendingSubagents[saIdx++];
        if (!item) break;

        // Stage 1: /exit tag → definitely closed
        // Stage 2: parent session in active set → live, skip
        try {
          const saTail = readTailLines(item.saPath, 4);
          if (!saTail.includes("<command-name>/exit</command-name>") &&
              activeSessions.has(item.parentSessionId)) {
            result.skipped.activeSubagents++;
            continue;
          }
        } catch {
          // Can't read tail — proceed with ingest (non-destructive)
        }

        let saFileStat: fs.Stats;
        try {
          saFileStat = fs.statSync(item.saPath);
        } catch {
          result.errors.push({ path: item.saPath, error: "Failed to stat sub-agent transcript file" });
          continue;
        }

        result.subagentTranscripts.push({
          parentSessionId: item.parentSessionId,
          agentId: item.agentId,
          transcriptPath: item.saPath,
          fileSizeBytes: saFileStat.size,
        });
      }
    })());
  }

  // Process sessions concurrently
  const sessionWorkers: Promise<void>[] = [];
  let sessIdx = 0;
  for (let w = 0; w < concurrency; w++) {
    sessionWorkers.push((async () => {
      while (sessIdx < pendingSessions.length) {
        if (options?.signal?.aborted) break;
        const item = pendingSessions[sessIdx++];
        if (!item) break;

        // Stage 1: /exit tag → definitely closed, proceed with full ingest.
        // Stage 2: session in active set → currently live; still included in
        //   discovered[] but marked isLive=true so the ingest phase emits only
        //   session.start (no session.end, no transcript upload).
        let sessionIsLive = false;
        try {
          const tail = readTailLines(item.entryPath, 4);
          if (!tail.includes("<command-name>/exit</command-name>") &&
              activeSessions.has(item.sessionId)) {
            sessionIsLive = true;
          }
        } catch {
          // Can't read tail — proceed with ingest (non-destructive)
        }

        // Build the discovered session object
        const discovered: DiscoveredSession = {
          sessionId: item.sessionId,
          transcriptPath: item.entryPath,
          projectDir: item.projectDir,
          resolvedCwd: null,
          workspaceCanonicalId: "_unassociated",
          gitBranch: null,
          firstPrompt: null,
          firstTimestamp: null,
          lastTimestamp: null,
          fileSizeBytes: item.fileStat.size,
          messageCount: null,
        };

        // Try to enrich from sessions-index.json
        const indexEntry = item.sessionsIndex?.get(item.sessionId);
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
          jsonlMetadata = await readJsonlMetadata(item.entryPath);
          discovered.firstTimestamp =
            discovered.firstTimestamp ?? jsonlMetadata.firstTimestamp;
          discovered.lastTimestamp =
            discovered.lastTimestamp ?? jsonlMetadata.lastTimestamp;
          discovered.gitBranch =
            discovered.gitBranch ?? jsonlMetadata.gitBranch;
        } catch (err) {
          result.errors.push({
            path: item.entryPath,
            error: `Failed to read JSONL metadata: ${err instanceof Error ? err.message : String(err)}`,
          });
        }

        // CWD waterfall: authoritative sources first, projectDirToPath fallback last
        const resolvedCwd =
          indexEntry?.projectPath ||
          jsonlMetadata?.cwd ||
          projectDirToPath(item.projectDir);
        discovered.resolvedCwd = resolvedCwd;

        // Resolve workspace (cached per CWD)
        if (!workspaceCache.has(resolvedCwd)) {
          workspaceCache.set(resolvedCwd, resolveWorkspaceFromPath(resolvedCwd));
        }
        discovered.workspaceCanonicalId = workspaceCache.get(resolvedCwd)!;

        if (sessionIsLive) {
          discovered.isLive = true;
        }

        result.discovered.push(discovered);
        sessionFilesProcessed++;
        options?.onProgress?.({ current: sessionFilesProcessed, total: totalSessionFiles, currentDir: item.projectDir });
      }
    })());
  }

  await Promise.all([...sessionWorkers, ...subagentWorkers]);

  // ---------- Phase C: Sort + return ----------

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
 * Ingest discovered sessions directly into Postgres and S3.
 *
 * Replaces the old HTTP-based ingestion path. For each session:
 *   1. Direct DB dedup check (SELECT id FROM sessions WHERE id = $1)
 *   2. ensureSessionRow() — INSERT ... ON CONFLICT DO NOTHING
 *   3. For non-live sessions:
 *      a. endSession() — transition to 'ended' with timestamps
 *      b. uploadMainTranscript() — S3 upload + UPDATE transcript_s3_key
 *      c. Transition to 'transcript_ready'
 *      d. Enqueue for reconcile (parsing/summary)
 *   4. For live sessions: just ensure the row exists at 'detected'
 *
 * @param sessions - Array of discovered sessions to ingest
 * @param deps - Injected dependencies (sql, s3, callbacks)
 */
export async function ingestBackfillSessions(
  sessions: DiscoveredSession[],
  deps: IngestDeps,
): Promise<BackfillResult> {
  const startTime = Date.now();
  const alreadyIngested = deps.alreadyIngested ?? new Set<string>();
  const concurrency = deps.concurrency ?? 10;

  const result: BackfillResult = {
    ingested: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    totalSizeBytes: 0,
    durationMs: 0,
    liveStarted: 0,
  };

  // Ensure the device row exists before inserting any sessions (FK target)
  await resolveOrCreateDevice(deps.sql, deps.deviceId, {
    name: deps.deviceName,
    type: (deps.deviceType as "local" | "remote") ?? "local",
    hostname: os.hostname(),
    os: process.platform,
    arch: process.arch,
  });

  // Build lookup of sub-agent transcripts by parent session ID for use in processSession
  const subagentsBySession = new Map<string, DiscoveredSubagentTranscript[]>();
  if (deps.subagentTranscripts) {
    for (const sa of deps.subagentTranscripts) {
      let list = subagentsBySession.get(sa.parentSessionId);
      if (!list) {
        list = [];
        subagentsBySession.set(sa.parentSessionId, list);
      }
      list.push(sa);
    }
  }

  /**
   * Process a single session: write directly to DB+S3 without HTTP.
   * Called concurrently by the worker pool.
   */
  async function processSession(session: DiscoveredSession): Promise<void> {
    if (deps.signal?.aborted) return;

    // Skip if already ingested in a previous (interrupted) run
    if (alreadyIngested.has(session.sessionId)) {
      result.skipped++;
      return;
    }

    try {
      // Step 1: Direct DB dedup check — does this session already exist?
      const existing = await deps.sql`
        SELECT id FROM sessions WHERE id = ${session.sessionId}
      `;
      if (existing.length > 0) {
        result.skipped++;
        return;
      }

      // Build a SessionSeed from the discovered session for metadata
      const seed = buildSeedFromFilesystem(session, deps.deviceId);

      // Step 2: ensureSessionRow — create session row at 'detected' state
      await ensureSessionRow(deps.sql, seed);

      // Live sessions stop here: only a 'detected' row is created.
      // The session.end hook will close it when Claude exits.
      if (session.isLive) {
        result.liveStarted = (result.liveStarted ?? 0) + 1;
        return;
      }

      // Step 3a: endSession — transition to 'ended' with timestamps
      await endSession(deps.sql, seed);

      // Step 3b: uploadMainTranscript — S3 upload + UPDATE transcript_s3_key
      await uploadMainTranscript(deps.s3, deps.sql, seed);

      // Step 3b2: Upload sub-agent transcripts for this session (if any).
      // Uses direct S3 upload + DB update. Non-fatal: failures are logged but
      // don't block the parent session from proceeding.
      const sessionSubagents = subagentsBySession.get(session.sessionId);
      if (sessionSubagents && sessionSubagents.length > 0) {
        await uploadSubagentTranscripts(
          deps.s3,
          deps.sql,
          sessionSubagents,
          session.workspaceCanonicalId,
          session.sessionId,
        );
      }

      // Step 3c: Transition to 'transcript_ready'
      await transitionSession(deps.sql, seed.ccSessionId, "ended", "transcript_ready");

      // Step 3d: Enqueue for reconcile (parsing, summary, etc.)
      deps.enqueueReconcile?.(seed.ccSessionId);

      result.ingested++;
      result.totalSizeBytes += session.fileSizeBytes;
      deps.onSessionIngested?.(session.sessionId);
    } catch (err) {
      result.failed++;
      result.errors.push({
        sessionId: session.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Concurrent worker pool ---
  const inFlight = new Set<Promise<void>>();
  let sessionIndex = 0;
  let lastReportedSession: string | null = null;

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

      while (inFlight.size < concurrency && sessionIndex < sessions.length) {
        if (deps.signal?.aborted) break;

        const session = sessions[sessionIndex++];

        lastReportedSession = session.sessionId;
        reportProgress(session.sessionId);

        const p = processSession(session).then(() => {
          inFlight.delete(p);
          reportProgress(session.sessionId);
        });
        inFlight.add(p);
      }

      if (inFlight.size >= concurrency) {
        const raceTargets: Promise<void>[] = [...inFlight];
        if (abortPromise) raceTargets.push(abortPromise);
        await Promise.race(raceTargets);
      }
    }

    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  } catch {
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }
  }

  // Final progress report
  reportProgress(null);

  result.durationMs = Date.now() - startTime;
  return result;
}

// ---------------------------------------------------------------------------
// Direct DB+S3 helpers for backfill session ingestion
// ---------------------------------------------------------------------------

/**
 * Insert a session row at 'detected' state. Uses ON CONFLICT DO NOTHING
 * for idempotency — re-running backfill for an existing session is a no-op.
 *
 * Ensures the workspace FK target exists before inserting the session.
 */
async function ensureSessionRow(sql: Sql, seed: SessionSeed): Promise<void> {
  // Ensure workspace exists (FK target for sessions.workspace_id)
  const workspaceId = await resolveOrCreateWorkspace(sql, seed.workspaceCanonicalId);

  await sql`
    INSERT INTO sessions (
      id, workspace_id, device_id, lifecycle, started_at,
      cwd, git_branch, git_remote, model, source
    ) VALUES (
      ${seed.ccSessionId}, ${workspaceId}, ${seed.deviceId}, 'detected',
      ${seed.startedAt}, ${seed.cwd}, ${seed.gitBranch}, ${seed.gitRemote},
      ${seed.model}, ${seed.source}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Transition a session from 'detected' to 'ended', setting ended_at,
 * end_reason, and duration_ms from the seed's metadata.
 */
async function endSession(sql: Sql, seed: SessionSeed): Promise<void> {
  await transitionSession(sql, seed.ccSessionId, ["detected"], "ended", {
    ended_at: seed.endedAt ?? undefined,
    end_reason: seed.endReason ?? "exit",
    duration_ms: seed.durationMs ?? undefined,
  });
}

/**
 * Upload the raw transcript JSONL to S3 and update the session row with
 * the S3 key. Uses Bun.file() for efficient streaming when available.
 */
async function uploadMainTranscript(
  s3: BackfillS3Client,
  sql: Sql,
  seed: SessionSeed,
): Promise<void> {
  if (!seed.transcriptRef || seed.transcriptRef.type !== "disk") {
    throw new Error(`No disk transcript reference for session ${seed.ccSessionId}`);
  }

  const transcriptPath = seed.transcriptRef.path;
  const s3Key = buildTranscriptKey(seed.workspaceCanonicalId, seed.ccSessionId);

  // Read transcript content and upload to S3
  let content: Buffer;
  try {
    content = fs.readFileSync(transcriptPath) as Buffer;
  } catch (err) {
    throw new Error(`Failed to read transcript at ${transcriptPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  await s3.upload(s3Key, content, "application/x-ndjson");

  // Update session row with S3 key
  await sql`
    UPDATE sessions
    SET transcript_s3_key = ${s3Key}, updated_at = now()
    WHERE id = ${seed.ccSessionId}
  `;
}

// ---------------------------------------------------------------------------
// ingestSubagentTranscripts: upload discovered sub-agent transcripts
// ---------------------------------------------------------------------------

/** Result from sub-agent transcript ingestion */
export interface SubagentIngestResult {
  /** Number of sub-agent transcripts successfully uploaded */
  uploaded: number;
  /** Number skipped because parent session wasn't ingested */
  skippedNoParent: number;
  /** Number that failed to upload */
  failed: number;
  /** Per-transcript error details */
  errors: Array<{ parentSessionId: string; agentId: string; error: string }>;
  /** Total bytes uploaded */
  totalSizeBytes: number;
}

/** Progress callback data for sub-agent transcript ingestion */
export interface SubagentIngestProgress {
  /** Total sub-agent transcripts to process */
  total: number;
  /** Number completed (uploaded, skipped, or failed) */
  completed: number;
  /** Currently processing */
  currentAgentId: string | null;
}

/** Dependencies for sub-agent transcript ingestion — direct DB+S3 */
export interface SubagentIngestDeps {
  /** Postgres client for direct DB writes */
  sql: Sql;
  /** S3 client for transcript uploads */
  s3: BackfillS3Client;
  /** Set of parent session IDs that were successfully ingested */
  ingestedParentSessionIds: Set<string>;
  /** Map from session ID to workspace canonical ID (needed for S3 key construction) */
  workspaceBySession: Map<string, string>;
  /** Progress callback */
  onProgress?: (progress: SubagentIngestProgress) => void;
  /** AbortSignal for clean cancellation */
  signal?: AbortSignal;
}

/**
 * Upload discovered sub-agent transcripts directly to S3 and update the DB.
 *
 * Only uploads transcripts whose parent session was successfully ingested
 * (i.e., the session row exists in the DB). For each transcript:
 *   1. Upload to S3 at the correct subagent transcript key
 *   2. If a subagent row exists in the DB, set transcript_s3_key
 *      (if no row exists yet, the reconciler will pick up the S3 object later)
 *
 * Processes sequentially — sub-agent transcripts are typically small and
 * secondary to the main session upload.
 */
export async function ingestSubagentTranscripts(
  transcripts: DiscoveredSubagentTranscript[],
  deps: SubagentIngestDeps,
): Promise<SubagentIngestResult> {
  const result: SubagentIngestResult = {
    uploaded: 0,
    skippedNoParent: 0,
    failed: 0,
    errors: [],
    totalSizeBytes: 0,
  };

  for (let i = 0; i < transcripts.length; i++) {
    if (deps.signal?.aborted) break;

    const tx = transcripts[i];

    deps.onProgress?.({
      total: transcripts.length,
      completed: result.uploaded + result.skippedNoParent + result.failed,
      currentAgentId: tx.agentId,
    });

    // Only upload if the parent session was ingested (or already existed)
    if (!deps.ingestedParentSessionIds.has(tx.parentSessionId)) {
      result.skippedNoParent++;
      continue;
    }

    const workspaceCanonicalId = deps.workspaceBySession.get(tx.parentSessionId);
    if (!workspaceCanonicalId) {
      result.skippedNoParent++;
      continue;
    }

    try {
      const s3Key = buildSubagentTranscriptKey(workspaceCanonicalId, tx.parentSessionId, tx.agentId);

      // Read transcript file from disk
      let content: Buffer;
      try {
        content = fs.readFileSync(tx.transcriptPath) as Buffer;
      } catch (err) {
        throw new Error(`Failed to read sub-agent transcript at ${tx.transcriptPath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Upload to S3
      await deps.s3.upload(s3Key, content, "application/x-ndjson");

      // Update subagent row with S3 key if the row already exists.
      // Uses the UNIQUE index on (session_id, agent_id) to find the right row.
      // If no row exists (subagent not yet tracked via hooks), this is a no-op —
      // the reconciler will create the row and pick up the S3 key later.
      await deps.sql`
        UPDATE subagents
        SET transcript_s3_key = ${s3Key}
        WHERE session_id = ${tx.parentSessionId}
          AND agent_id = ${tx.agentId}
      `;

      result.uploaded++;
      result.totalSizeBytes += tx.fileSizeBytes;
    } catch (err) {
      result.failed++;
      result.errors.push({
        parentSessionId: tx.parentSessionId,
        agentId: tx.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final progress report
  deps.onProgress?.({
    total: transcripts.length,
    completed: result.uploaded + result.skippedNoParent + result.failed,
    currentAgentId: null,
  });

  return result;
}

/**
 * Upload sub-agent transcripts for a single session directly to S3 and update
 * the DB. Called from processSession after the main transcript is uploaded.
 *
 * Each sub-agent transcript is uploaded individually. If the subagent row
 * already exists in the DB, transcript_s3_key is set. If not (no hook data
 * yet), the transcript is still uploaded to S3 at the correct key so the
 * reconciler can pick it up when it creates the subagent row.
 *
 * Errors are logged per-subagent but do not fail the parent session.
 */
async function uploadSubagentTranscripts(
  s3: BackfillS3Client,
  sql: Sql,
  subagents: DiscoveredSubagentTranscript[],
  workspaceCanonicalId: string,
  sessionId: string,
): Promise<void> {
  for (const sa of subagents) {
    try {
      const s3Key = buildSubagentTranscriptKey(workspaceCanonicalId, sessionId, sa.agentId);

      let content: Buffer;
      try {
        content = fs.readFileSync(sa.transcriptPath) as Buffer;
      } catch (err) {
        throw new Error(`Failed to read sub-agent transcript at ${sa.transcriptPath}: ${err instanceof Error ? err.message : String(err)}`);
      }

      await s3.upload(s3Key, content, "application/x-ndjson");

      // Update subagent row if it exists; no-op if the row hasn't been created yet
      await sql`
        UPDATE subagents
        SET transcript_s3_key = ${s3Key}
        WHERE session_id = ${sessionId}
          AND agent_id = ${sa.agentId}
      `;
    } catch {
      // Non-fatal: sub-agent transcript upload failure should not block
      // the parent session from proceeding through the lifecycle.
    }
  }
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

// ---------------------------------------------------------------------------
// Pipeline progress tracking — poll server for processing completion
// ---------------------------------------------------------------------------

/** Terminal lifecycle states where no further processing will occur */
const TERMINAL_LIFECYCLES = new Set(["complete", "failed"]);

/** Progress callback data during pipeline wait phase */
export interface PipelineWaitProgress {
  /** Total sessions being tracked */
  total: number;
  /** Sessions that have reached a terminal lifecycle state */
  completed: number;
  /** Breakdown by current lifecycle state */
  byLifecycle: Record<string, number>;
}

/** Dependencies for waitForPipelineCompletion — queries DB directly */
export interface PipelineWaitDeps {
  /** Postgres client for direct lifecycle queries */
  sql: Sql;
  /** Milliseconds between status polls (default: 3000) */
  pollIntervalMs?: number;
  /** Maximum time to wait before giving up (default: 600000 = 10 min) */
  timeoutMs?: number;
  /** AbortSignal for clean cancellation (Ctrl-C) */
  signal?: AbortSignal;
  /** Progress callback fired after each poll */
  onProgress?: (progress: PipelineWaitProgress) => void;
  /** When using a dynamic session ID getter, signals that the list is finalized.
   *  Polling won't declare "completed" until this returns true. */
  uploadsComplete?: () => boolean;
}

/** Result of waiting for pipeline completion */
export interface PipelineWaitResult {
  /** Whether all sessions reached terminal state */
  completed: boolean;
  /** Whether the wait timed out */
  timedOut: boolean;
  /** Whether the wait was aborted by signal */
  aborted: boolean;
  /** Count of sessions per lifecycle state (e.g., parsed, summarized, archived, failed, pending) */
  summary: Record<string, number>;
}

/**
 * Poll the database until all sessions reach a terminal lifecycle state
 * (any state in TERMINAL_LIFECYCLES: "complete" or "failed").
 *
 * Accepts either a static array or a getter function for session IDs.
 * When a getter is provided, IDs are re-resolved each poll iteration so
 * new sessions (e.g. from concurrent uploads) are picked up dynamically.
 * Pair with `uploadsComplete` in deps to prevent early termination while
 * uploads are still in flight.
 */
export async function waitForPipelineCompletion(
  sessionIds: string[] | (() => string[]),
  deps: PipelineWaitDeps,
): Promise<PipelineWaitResult> {
  const resolveIds = typeof sessionIds === "function" ? sessionIds : () => sessionIds;

  // For static empty arrays (no uploadsComplete), return immediately
  if (typeof sessionIds !== "function" && sessionIds.length === 0) {
    return {
      completed: true,
      timedOut: false,
      aborted: false,
      summary: {},
    };
  }

  const pollInterval = deps.pollIntervalMs ?? 3000;
  const timeout = deps.timeoutMs ?? 600_000;
  const startTime = Date.now();

  while (true) {
    if (deps.signal?.aborted) {
      return buildPipelineResult(resolveIds(), {}, true, false);
    }

    if (Date.now() - startTime > timeout) {
      const currentIds = resolveIds();
      const statuses = await fetchLifecyclesFromDb(deps.sql, currentIds);
      return buildPipelineResult(currentIds, statuses, false, true);
    }

    // Re-resolve IDs each iteration (may have grown since last poll)
    const currentIds = resolveIds();

    // If no IDs yet and uploads still running, wait and re-poll
    if (currentIds.length === 0) {
      if (deps.uploadsComplete?.() === false) {
        try {
          await abortableSleep(pollInterval, deps.signal);
        } catch {
          return buildPipelineResult([], {}, true, false);
        }
        continue;
      }
      // Uploads done with no IDs — nothing to wait for
      return {
        completed: true,
        timedOut: false,
        aborted: false,
        summary: {},
      };
    }

    const statuses = await fetchLifecyclesFromDb(deps.sql, currentIds);

    // Report progress
    if (deps.onProgress) {
      const byLifecycle: Record<string, number> = {};
      let completedCount = 0;
      for (const id of currentIds) {
        const lifecycle = statuses[id] ?? "unknown";
        byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
        if (TERMINAL_LIFECYCLES.has(lifecycle)) completedCount++;
      }
      deps.onProgress({ total: currentIds.length, completed: completedCount, byLifecycle });
    }

    const allTerminal = currentIds.every((id) => {
      const lifecycle = statuses[id];
      return lifecycle && TERMINAL_LIFECYCLES.has(lifecycle);
    });

    // Only declare complete if uploads are also done (or uploadsComplete not provided)
    if (allTerminal && deps.uploadsComplete?.() !== false) {
      return buildPipelineResult(currentIds, statuses, false, false);
    }

    try {
      await abortableSleep(pollInterval, deps.signal);
    } catch {
      return buildPipelineResult(currentIds, statuses, true, false);
    }
  }
}

/**
 * Query session lifecycles directly from the database.
 * Returns a map from session ID to lifecycle state string.
 */
async function fetchLifecyclesFromDb(
  sql: Sql,
  sessionIds: string[],
): Promise<Record<string, string>> {
  if (sessionIds.length === 0) return {};

  const rows = await sql`
    SELECT id, lifecycle FROM sessions WHERE id = ANY(${sessionIds})
  `;

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.id] = row.lifecycle;
  }
  return result;
}

/**
 * Build the final PipelineWaitResult from collected lifecycle statuses.
 * Summary is a per-lifecycle-state count (e.g., { parsed: 3, summarized: 1, failed: 1, pending: 2 }).
 * Sessions not found in the statuses map are counted as "pending".
 */
function buildPipelineResult(
  sessionIds: string[],
  statuses: Record<string, string>,
  aborted: boolean,
  timedOut: boolean,
): PipelineWaitResult {
  const summary: Record<string, number> = {};
  let allTerminal = true;

  for (const id of sessionIds) {
    const lifecycle = statuses[id] ?? "pending";
    summary[lifecycle] = (summary[lifecycle] ?? 0) + 1;
    if (!TERMINAL_LIFECYCLES.has(lifecycle)) {
      allTerminal = false;
    }
  }

  return {
    completed: allTerminal && !aborted && !timedOut,
    timedOut,
    aborted,
    summary,
  };
}

// ---------------------------------------------------------------------------
// waitForPipelineCompletionViaHttp: same polling loop, HTTP-based lifecycle fetch
// ---------------------------------------------------------------------------

/**
 * Dependencies for HTTP-based pipeline polling.
 * Same as PipelineWaitDeps but replaces `sql` with a `fetchLifecycles` callback.
 */
export interface PipelineWaitHttpDeps {
  /** Fetch lifecycle statuses for a batch of session IDs via HTTP */
  fetchLifecycles: (sessionIds: string[]) => Promise<Record<string, string>>;
  /** Milliseconds between status polls (default: 3000) */
  pollIntervalMs?: number;
  /** Maximum time to wait before giving up (default: 600000 = 10 min) */
  timeoutMs?: number;
  /** AbortSignal for clean cancellation (Ctrl-C) */
  signal?: AbortSignal;
  /** Progress callback fired after each poll */
  onProgress?: (progress: PipelineWaitProgress) => void;
  /** Signals that the upload list is finalized.
   *  Polling won't declare "completed" until this returns true. */
  uploadsComplete?: () => boolean;
}

/**
 * Poll via HTTP until all sessions reach a terminal lifecycle state.
 * Same logic as waitForPipelineCompletion but uses a caller-provided
 * fetchLifecycles callback instead of direct DB queries.
 */
export async function waitForPipelineCompletionViaHttp(
  sessionIds: string[] | (() => string[]),
  deps: PipelineWaitHttpDeps,
): Promise<PipelineWaitResult> {
  const resolveIds = typeof sessionIds === "function" ? sessionIds : () => sessionIds;

  if (typeof sessionIds !== "function" && sessionIds.length === 0) {
    return { completed: true, timedOut: false, aborted: false, summary: {} };
  }

  const pollInterval = deps.pollIntervalMs ?? 3000;
  const timeout = deps.timeoutMs ?? 600_000;
  const startTime = Date.now();

  while (true) {
    if (deps.signal?.aborted) {
      return buildPipelineResult(resolveIds(), {}, true, false);
    }

    if (Date.now() - startTime > timeout) {
      const currentIds = resolveIds();
      const statuses = await deps.fetchLifecycles(currentIds);
      return buildPipelineResult(currentIds, statuses, false, true);
    }

    const currentIds = resolveIds();

    if (currentIds.length === 0) {
      if (deps.uploadsComplete?.() === false) {
        try {
          await abortableSleep(pollInterval, deps.signal);
        } catch {
          return buildPipelineResult([], {}, true, false);
        }
        continue;
      }
      return { completed: true, timedOut: false, aborted: false, summary: {} };
    }

    const statuses = await deps.fetchLifecycles(currentIds);

    if (deps.onProgress) {
      const byLifecycle: Record<string, number> = {};
      let completedCount = 0;
      for (const id of currentIds) {
        const lifecycle = statuses[id] ?? "unknown";
        byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
        if (TERMINAL_LIFECYCLES.has(lifecycle)) completedCount++;
      }
      deps.onProgress({ total: currentIds.length, completed: completedCount, byLifecycle });
    }

    const allTerminal = currentIds.every((id) => {
      const lifecycle = statuses[id];
      return lifecycle && TERMINAL_LIFECYCLES.has(lifecycle);
    });

    if (allTerminal && deps.uploadsComplete?.() !== false) {
      return buildPipelineResult(currentIds, statuses, false, false);
    }

    try {
      await abortableSleep(pollInterval, deps.signal);
    } catch {
      return buildPipelineResult(currentIds, statuses, true, false);
    }
  }
}
