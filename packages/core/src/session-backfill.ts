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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
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
        discovered.gitBranch = indexEntry.gitBranch ?? null;
        discovered.firstPrompt = indexEntry.firstPrompt ?? null;
        discovered.firstTimestamp = indexEntry.created ?? null;
        discovered.lastTimestamp = indexEntry.modified ?? null;
        discovered.messageCount = indexEntry.messageCount ?? null;
      }

      // If sessions-index.json didn't provide timestamps, read from the JSONL file
      if (!discovered.firstTimestamp || !discovered.lastTimestamp) {
        try {
          const metadata = await readJsonlMetadata(entryPath);
          discovered.firstTimestamp =
            discovered.firstTimestamp ?? metadata.firstTimestamp;
          discovered.lastTimestamp =
            discovered.lastTimestamp ?? metadata.lastTimestamp;
          discovered.gitBranch =
            discovered.gitBranch ?? metadata.gitBranch;
        } catch (err) {
          result.errors.push({
            path: entryPath,
            error: `Failed to read JSONL metadata: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Resolve workspace: convert dir name to path, check for git repo
      const resolvedPath = projectDirToPath(projectDir);
      discovered.resolvedCwd = resolvedPath;

      // Check if the resolved path exists and has a .git directory
      const workspaceId = resolveWorkspaceFromPath(resolvedPath);
      discovered.workspaceCanonicalId = workspaceId;

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
 * For each session:
 *   1. Check if already ingested (dedup via GET /api/sessions/:id)
 *   2. Upload transcript file (POST /api/sessions/:id/transcript/upload)
 *   3. Emit synthetic session.start + session.end events via POST /api/events/ingest
 *   4. Report progress
 *
 * Events are batched and throttled to avoid overwhelming the backend.
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

  const result: BackfillResult = {
    ingested: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    totalSizeBytes: 0,
    durationMs: 0,
  };

  // Collect events for batched ingestion
  let eventBatch: Event[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];

    // Check for cancellation
    if (deps.signal?.aborted) {
      break;
    }

    // Report progress
    deps.onProgress?.({
      total: sessions.length,
      completed: result.ingested + result.skipped + result.failed,
      skipped: result.skipped,
      failed: result.failed,
      currentSession: session.sessionId,
    });

    // Skip if already ingested in a previous (interrupted) run
    if (alreadyIngested.has(session.sessionId)) {
      result.skipped++;
      continue;
    }

    try {
      // Step 1: Dedup check — does this session already exist in the backend?
      const exists = await checkSessionExists(
        baseUrl,
        deps.apiKey,
        session.sessionId,
      );
      if (exists) {
        result.skipped++;
        continue;
      }

      // Step 2: Upload transcript file to the server
      await uploadTranscript(
        baseUrl,
        deps.apiKey,
        session.sessionId,
        session.transcriptPath,
      );

      // Step 3: Build synthetic session.start and session.end events
      const now = new Date().toISOString();

      const startEvent: Event = {
        id: generateId(),
        type: "session.start" as EventType,
        timestamp: session.firstTimestamp ?? now,
        device_id: deps.deviceId,
        workspace_id: session.workspaceCanonicalId,
        session_id: session.sessionId,
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

      // Calculate approximate duration from timestamps
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

      eventBatch.push(startEvent, endEvent);

      // Step 4: Flush batch if it's full
      if (eventBatch.length >= batchSize) {
        await flushEventBatch(baseUrl, deps.apiKey, eventBatch);
        eventBatch = [];

        // Throttle between batches
        if (throttleMs > 0) {
          await sleep(throttleMs);
        }
      }

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

  // Flush any remaining events in the batch
  if (eventBatch.length > 0) {
    try {
      await flushEventBatch(baseUrl, deps.apiKey, eventBatch);
    } catch (err) {
      // If the final batch flush fails, those sessions' events are lost
      // but the transcripts are already uploaded
    }
  }

  // Final progress report
  deps.onProgress?.({
    total: sessions.length,
    completed: result.ingested + result.skipped + result.failed,
    skipped: result.skipped,
    failed: result.failed,
    currentSession: null,
  });

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

    // sessions-index.json is an array of session entries
    if (!Array.isArray(parsed)) {
      return null;
    }

    const map = new Map<string, SessionsIndexEntry>();
    for (const entry of parsed) {
      if (entry && typeof entry === "object" && entry.sessionId) {
        map.set(entry.sessionId, entry as SessionsIndexEntry);
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
}> {
  const result = {
    firstTimestamp: null as string | null,
    lastTimestamp: null as string | null,
    gitBranch: null as string | null,
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
 * Resolve a workspace canonical ID from a filesystem path.
 *
 * Checks if the path exists on disk and contains a .git directory.
 * If so, tries to read the git remote URL. Falls back to "_unassociated".
 */
function resolveWorkspaceFromPath(resolvedPath: string): string {
  try {
    if (!fs.existsSync(resolvedPath)) {
      return "_unassociated";
    }

    const gitDir = path.join(resolvedPath, ".git");
    if (!fs.existsSync(gitDir)) {
      return "_unassociated";
    }

    // Try to read git remote URL from .git/config
    const gitConfigPath = path.join(gitDir, "config");
    if (fs.existsSync(gitConfigPath)) {
      const configContent = fs.readFileSync(gitConfigPath, "utf-8");
      // Parse the [remote "origin"] section for the url
      const remoteMatch = configContent.match(
        /\[remote "origin"\][^[]*url\s*=\s*(.+)/,
      );
      if (remoteMatch) {
        const remoteUrl = remoteMatch[1].trim();
        // Use a simple normalization: strip protocol, auth, .git suffix
        const normalized = normalizeGitRemote(remoteUrl);
        if (normalized) {
          return normalized;
        }
      }
    }

    // Has .git but no remote — it's a local repo
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
): Promise<boolean> {
  try {
    const response = await fetch(
      `${baseUrl}/api/sessions/${sessionId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    return response.ok;
  } catch {
    // Network error or timeout — treat as "not exists" to allow ingestion
    return false;
  }
}

/**
 * Upload a transcript JSONL file to the backend for a specific session.
 *
 * Uses streaming for large files to avoid loading entire transcripts into memory.
 * Throws on failure so the caller can record the error.
 */
async function uploadTranscript(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  transcriptPath: string,
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
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `Transcript upload failed (HTTP ${response.status}): ${responseBody}`,
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
): Promise<void> {
  const url = `${baseUrl}/api/events/ingest`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new Error(`Event ingest failed (HTTP ${response.status}): ${body}`);
  }
}

/** Simple sleep utility for throttling between batches */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
