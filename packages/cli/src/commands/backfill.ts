/**
 * `fuel-code backfill` command.
 *
 * Discovers all historical Claude Code sessions from ~/.claude/projects/
 * and ingests them into the fuel-code backend via the server HTTP API.
 * Supports:
 *   --dry-run  — Scan and report without ingesting
 *   --status   — Show last backfill state
 *   --force    — Run even if a backfill appears to be in progress
 *
 * After discovery, sessions are created via POST /api/backfill/sessions and
 * transcripts uploaded via POST /api/sessions/:id/transcript/upload. The CLI
 * only needs backend.url + api_key from ~/.fuel-code/config.yaml.
 *
 * Backfill state is persisted at ~/.fuel-code/backfill-state.json for:
 *   - Status reporting
 *   - Resume after interruption
 *   - Concurrent run detection
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanForSessions,
  waitForPipelineCompletionViaHttp,
  loadBackfillState,
  saveBackfillState,
  type DiscoveredSession,
  type ScanResult,
  type ScanProgress,
  type BackfillState,
  type PipelineWaitProgress,
} from "@fuel-code/core";
import type { BackfillResult } from "@fuel-code/core";
import { configExists, loadConfig, getConfigDir } from "../lib/config.js";
import { FuelApiClient } from "../lib/api-client.js";

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Create the `backfill` command for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createBackfillCommand(): Command {
  const cmd = new Command("backfill")
    .description(
      "Discover and ingest historical Claude Code sessions from ~/.claude/projects/",
    )
    .option("--dry-run", "Scan and report without ingesting", false)
    .option("--status", "Show last backfill run status", false)
    .option(
      "--force",
      "Run even if a backfill appears to be in progress",
      false,
    )
    .option(
      "--concurrency <n>",
      "Number of sessions to process concurrently (default: 5)",
      "5",
    )
    .action(async (opts: BackfillOptions) => {
      await runBackfill(opts);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options parsed by Commander for the backfill command */
interface BackfillOptions {
  dryRun: boolean;
  status: boolean;
  force: boolean;
  concurrency: string;
}

// ---------------------------------------------------------------------------
// Core backfill logic
// ---------------------------------------------------------------------------

/**
 * Main backfill logic. Handles --status, --dry-run, and default (ingest) modes.
 * Separated from the Commander action for testability.
 */
export async function runBackfill(opts: BackfillOptions): Promise<void> {
  const stateDir = getConfigDir();

  // --status: show last backfill state and exit
  if (opts.status) {
    showStatus(stateDir);
    return;
  }

  // Config check: fuel-code must be initialized
  if (!configExists()) {
    console.error("Run 'fuel-code init' first.");
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();

  // Load backfill state for resume support and concurrent run detection
  const state = loadBackfillState(stateDir);

  // Warn if a backfill appears to be in progress (unless --force)
  if (state.isRunning && !opts.force) {
    console.error(
      "A backfill may already be running (started at " +
        (state.startedAt ?? "unknown") +
        ").",
    );
    console.error("Use --force to run anyway.");
    process.exitCode = 1;
    return;
  }

  // Set up Ctrl-C handling for clean abort (used in both scan and ingest phases)
  const abortController = new AbortController();
  const onSigint = () => {
    console.error("\nBackfill interrupted. Progress saved for resume.");
    abortController.abort();
  };
  process.on("SIGINT", onSigint);

  // Phase 1: Scan for sessions (parallelized with concurrency)
  const scanResult = await scanForSessions(undefined, {
    signal: abortController.signal,
    onProgress: (progress: ScanProgress) => {
      const displayDir = progress.currentDir.length > 20
        ? "..." + progress.currentDir.slice(-17)
        : progress.currentDir;
      const bar = buildProgressBar(progress.current, progress.total, 30);
      process.stderr.write(
        `\r\x1b[2K  Scanning:    ${bar} ${progress.current}/${progress.total}  ${displayDir}`,
      );
    },
  });
  // Clear scanning line and move to next line
  process.stderr.write("\r\x1b[2K");

  if (scanResult.discovered.length === 0) {
    process.removeListener("SIGINT", onSigint);
    console.log("No historical sessions found.");
    return;
  }

  // Build a lookup map from sessionId → transcriptPath for error display
  const sessionPathMap = new Map(
    scanResult.discovered.map(s => [s.sessionId, s.transcriptPath])
  );

  // Build a lookup of sub-agent transcripts by parent session ID
  const subagentsBySession = new Map<string, typeof scanResult.subagentTranscripts>();
  for (const sa of scanResult.subagentTranscripts) {
    let list = subagentsBySession.get(sa.parentSessionId);
    if (!list) {
      list = [];
      subagentsBySession.set(sa.parentSessionId, list);
    }
    list.push(sa);
  }

  // Group sessions by project for summary display
  const byProject = groupByProject(scanResult.discovered);
  const totalSize = scanResult.discovered.reduce(
    (sum, s) => sum + s.fileSizeBytes,
    0,
  );

  console.log(
    `Found ${scanResult.discovered.length} sessions across ${byProject.size} projects`,
  );

  // --dry-run: print summary and exit without ingesting
  if (opts.dryRun) {
    process.removeListener("SIGINT", onSigint);
    showDryRunSummary(byProject, scanResult, totalSize);
    return;
  }

  console.error("Preparing ingestion...");

  // Phase 2: Create API client from config (no DB/S3 env vars needed)
  const api = FuelApiClient.fromConfig(config);

  // Mark as running and persist state
  const updatedState: BackfillState = {
    ...state,
    isRunning: true,
    startedAt: new Date().toISOString(),
  };
  saveBackfillState(updatedState, stateDir);

  // Build the set of already-ingested sessions for resume
  const alreadyIngested = new Set(state.ingestedSessionIds);

  // Phase 3+4: Ingest sessions via HTTP, then wait for reconcile completion.
  // Both progress bars are rendered simultaneously so the user sees the
  // full pipeline at a glance.
  console.error("");

  // Dual-bar rendering state — two lines updated in place via ANSI escapes.
  // Uses a single atomic write to prevent interleaving when called from
  // concurrent async contexts (upload worker pool + pipeline poller).
  let dualBarInit = false;
  const writeDualBars = (line1: string, line2: string): void => {
    const prefix = dualBarInit ? "\x1b[1A\r" : "";
    process.stderr.write(`${prefix}\x1b[2K${line1}\n\x1b[2K${line2}`);
    dualBarInit = true;
  };

  try {
    const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 10);
    console.error(`Processing with concurrency: ${concurrency}`);

    // Shared state for concurrent upload + pipeline polling
    const ingestedIds: string[] = [];
    let uploadsDone = false;
    let uploadBarLine = `  Uploading:   ${buildProgressBar(0, scanResult.discovered.length, 30)} 0/${scanResult.discovered.length}`;
    let processingBarLine = "  Processing:  waiting...";
    const renderBars = () => writeDualBars(uploadBarLine, processingBarLine);

    // Result tracking (replaces BackfillResult from ingestBackfillSessions)
    const result: BackfillResult = {
      ingested: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      totalSizeBytes: 0,
      durationMs: 0,
      liveStarted: 0,
    };
    const startTime = Date.now();

    /**
     * Process a single session via HTTP API.
     * Called concurrently by the worker pool.
     */
    async function processSession(session: DiscoveredSession): Promise<void> {
      if (abortController.signal.aborted) return;

      // Skip if already ingested in a previous (interrupted) run
      if (alreadyIngested.has(session.sessionId)) {
        result.skipped++;
        return;
      }

      try {
        // Step 1: Create session row via server API (replaces ensureSessionRow + endSession)
        const createResult = await api.createBackfillSession({
          session_id: session.sessionId,
          workspace_canonical_id: session.workspaceCanonicalId,
          device_id: config.device.id,
          device_name: config.device.name,
          device_type: (config.device.type as "local" | "remote") ?? "local",
          started_at: session.firstTimestamp ?? new Date().toISOString(),
          ended_at: session.isLive ? null : (session.lastTimestamp ?? null),
          duration_ms: (!session.isLive && session.firstTimestamp && session.lastTimestamp)
            ? new Date(session.lastTimestamp).getTime() - new Date(session.firstTimestamp).getTime()
            : null,
          cwd: session.resolvedCwd ?? undefined,
          git_branch: session.gitBranch ?? null,
          source: "backfill:scan",
          is_live: session.isLive ?? false,
        });

        // Step 2: Dedup — session already existed on server
        if (createResult.status === "exists") {
          result.skipped++;
          return;
        }

        // Step 3: Live sessions stop here — only a 'detected' row was created
        if (session.isLive) {
          result.liveStarted = (result.liveStarted ?? 0) + 1;
          return;
        }

        // Step 4: Read and upload main transcript
        const content = fs.readFileSync(session.transcriptPath);
        await api.uploadTranscript(session.sessionId, content as Buffer);

        // Step 5: Upload sub-agent transcripts for this session (if any)
        const sessionSubagents = subagentsBySession.get(session.sessionId);
        if (sessionSubagents) {
          for (const sa of sessionSubagents) {
            try {
              const saContent = fs.readFileSync(sa.transcriptPath);
              await api.uploadTranscript(session.sessionId, saContent as Buffer, sa.agentId);
            } catch {
              // Non-fatal: sub-agent upload failures don't block parent
            }
          }
        }

        result.ingested++;
        result.totalSizeBytes += session.fileSizeBytes;
        ingestedIds.push(session.sessionId);
      } catch (err) {
        result.failed++;
        result.errors.push({
          sessionId: session.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- Concurrent worker pool (same pattern as ingestBackfillSessions) ---
    const inFlight = new Set<Promise<void>>();
    let sessionIndex = 0;
    let lastReportedSession: string | null = null;

    const abortPromise = abortController.signal
      ? new Promise<void>((_, reject) => {
          if (abortController.signal.aborted) { reject(new Error("Aborted")); return; }
          abortController.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        })
      : null;

    function reportProgress(currentSession: string | null): void {
      const completed = result.ingested + result.skipped + result.failed;
      const sessionShort = (currentSession ?? lastReportedSession ?? "").slice(0, 8);
      const failStr = result.failed > 0 ? `  (${result.failed} failed)` : "";
      uploadBarLine = `  Uploading:   ${buildProgressBar(completed, scanResult.discovered.length, 30)} ${completed}/${scanResult.discovered.length}  ${sessionShort}...${failStr}`;
      renderBars();
    }

    // Upload promise: processes sessions via HTTP (worker pool)
    const uploadPromise = (async () => {
      try {
        while (sessionIndex < scanResult.discovered.length) {
          if (abortController.signal.aborted) break;

          while (inFlight.size < concurrency && sessionIndex < scanResult.discovered.length) {
            if (abortController.signal.aborted) break;

            const session = scanResult.discovered[sessionIndex++];
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

      result.durationMs = Date.now() - startTime;
      uploadsDone = true;
      return result;
    })();

    // Pipeline polling promise: polls lifecycle statuses via HTTP
    const pipelinePromise = waitForPipelineCompletionViaHttp(
      () => [...ingestedIds],
      {
        fetchLifecycles: async (ids: string[]) => {
          if (ids.length === 0) return {};
          const res = await api.batchStatus(ids);
          const map: Record<string, string> = {};
          for (const [id, status] of Object.entries(res.statuses)) {
            map[id] = status.lifecycle;
          }
          return map;
        },
        signal: abortController.signal,
        uploadsComplete: () => uploadsDone,
        onProgress: (progress: PipelineWaitProgress) => {
          const bar = buildProgressBar(progress.completed, progress.total, 30);
          const parts: string[] = [];
          for (const [lifecycle, count] of Object.entries(progress.byLifecycle)) {
            if (count > 0 && lifecycle !== "complete" && lifecycle !== "failed") {
              parts.push(`${count} ${lifecycle}`);
            }
          }
          const statusStr = parts.length > 0 ? `  ${parts.join(", ")}` : "";
          processingBarLine = `  Processing:  ${bar} ${progress.completed}/${progress.total}${statusStr}`;
          renderBars();
        },
      },
    );

    const [uploadResult, pipelineResult] = await Promise.all([uploadPromise, pipelinePromise]);

    // Save final state.
    // failedSessionIds: sessions that failed this run (need transcript retry next time).
    // Previously-failed sessions that succeeded this run are removed from the set.
    const currentRunFailedIds = new Set(uploadResult.errors.map(e => e.sessionId));
    const finalState: BackfillState = {
      lastRunAt: new Date().toISOString(),
      lastRunResult: uploadResult,
      isRunning: false,
      startedAt: null,
      ingestedSessionIds: [
        ...alreadyIngested,
        ...ingestedIds,
      ],
      failedSessionIds: [...currentRunFailedIds],
    };
    saveBackfillState(finalState, stateDir);

    // Freeze upload bar as "done"
    const uploadTotal = scanResult.discovered.length;
    const uploadCompleted = uploadResult.ingested + uploadResult.skipped + uploadResult.failed;
    const uploadDoneStr = uploadResult.failed > 0
      ? `done (${uploadResult.failed} failed)`
      : "done";
    const uploadDoneLine = `  Uploading:   ${buildProgressBar(uploadCompleted, uploadTotal, 30)} ${uploadCompleted}/${uploadTotal}  ${uploadDoneStr}`;
    writeDualBars(uploadDoneLine, processingBarLine);

    // Clear dual bars and print final summary
    process.stderr.write("\n");
    console.log("");

    if (ingestedIds.length > 0) {
      if (pipelineResult.completed) {
        console.log("Backfill complete!");
      } else if (pipelineResult.timedOut) {
        console.log("Backfill uploaded. Processing timed out (server still working in background).");
      } else if (pipelineResult.aborted) {
        console.log("Backfill uploaded. Processing watch cancelled (server still working in background).");
      }

      console.log(`  Uploaded:   ${uploadResult.ingested} sessions` +
        (uploadResult.skipped > 0 ? ` (${uploadResult.skipped} skipped)` : ""));
      if (uploadResult.liveStarted && uploadResult.liveStarted > 0) {
        console.log(`  Live:       ${uploadResult.liveStarted} session${uploadResult.liveStarted === 1 ? "" : "s"} started (no end event — session still running)`);
      }
      const ps = pipelineResult.summary;
      const processedParts: string[] = [];
      // Summarize per-lifecycle counts (complete and failed are terminal, others are in-progress)
      const terminalCount = (ps.complete ?? 0) + (ps.failed ?? 0);
      for (const [lifecycle, count] of Object.entries(ps)) {
        if (count > 0) processedParts.push(`${count} ${lifecycle}`);
      }
      console.log(`  Processed:  ${terminalCount}/${ingestedIds.length}` +
        (processedParts.length > 0 ? ` (${processedParts.join(", ")})` : ""));
    } else {
      console.log("Backfill complete!");
      console.log(`  Uploaded:   ${uploadResult.ingested} sessions` +
        (uploadResult.skipped > 0 ? ` (${uploadResult.skipped} skipped)` : ""));
      if (uploadResult.liveStarted && uploadResult.liveStarted > 0) {
        console.log(`  Live:       ${uploadResult.liveStarted} session${uploadResult.liveStarted === 1 ? "" : "s"} started (no end event — session still running)`);
      }
    }

    // Show errors at the end with full detail: category, transcript path, error message, retry hint
    if (uploadResult.errors.length > 0) {
      console.log("");
      console.log(formatErrorBlock(uploadResult.errors, sessionPathMap));
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Display the --status output: last backfill run information.
 */
function showStatus(stateDir: string): void {
  const state = loadBackfillState(stateDir);

  if (!state.lastRunAt) {
    console.log("No backfill has been run yet.");
    console.log(
      `Currently running: ${state.isRunning ? "Yes (started " + state.startedAt + ")" : "No"}`,
    );
    return;
  }

  console.log(`Last backfill: ${state.lastRunAt}`);
  if (state.lastRunResult) {
    console.log(
      `  Ingested: ${state.lastRunResult.ingested}, ` +
        `Skipped: ${state.lastRunResult.skipped}, ` +
        `Failed: ${state.lastRunResult.failed}`,
    );
  }
  console.log(
    `Currently running: ${state.isRunning ? "Yes (started " + state.startedAt + ")" : "No"}`,
  );
}

/**
 * Display --dry-run summary grouped by project.
 */
function showDryRunSummary(
  byProject: Map<string, DiscoveredSession[]>,
  scanResult: ScanResult,
  totalSize: number,
): void {
  console.log("");
  console.log("Would ingest:");

  for (const [project, sessions] of byProject) {
    const projSize = sessions.reduce((sum, s) => sum + s.fileSizeBytes, 0);
    // Use the last segment of resolvedCwd or the project dir name for display
    const displayName =
      sessions[0]?.resolvedCwd
        ? path.basename(sessions[0].resolvedCwd)
        : project;
    console.log(
      `  ${displayName.padEnd(30)} — ${sessions.length} sessions (${formatBytes(projSize)})`,
    );
  }

  const liveCount = scanResult.discovered.filter(s => s.isLive).length;
  const finishedCount = scanResult.discovered.length - liveCount;

  console.log("");
  console.log(
    `Total: ${finishedCount} finished sessions (${formatBytes(totalSize)})`,
  );

  if (liveCount > 0) {
    console.log(
      `Live:  ${liveCount} session${liveCount === 1 ? "" : "s"} (start event only — session.end comes from hook)`,
    );
  }
}

/** Group discovered sessions by project directory name */
function groupByProject(
  sessions: DiscoveredSession[],
): Map<string, DiscoveredSession[]> {
  const map = new Map<string, DiscoveredSession[]>();
  for (const session of sessions) {
    const existing = map.get(session.projectDir) ?? [];
    existing.push(session);
    map.set(session.projectDir, existing);
  }
  return map;
}

/** Build a simple ASCII progress bar: [████████░░░░] */
function buildProgressBar(
  current: number,
  total: number,
  width: number,
): string {
  const filled = total > 0 ? Math.round((current / total) * width) : 0;
  const empty = width - filled;
  return "[" + "\u2588".repeat(filled) + "\u2591".repeat(empty) + "]";
}

/** Format bytes into a human-readable string */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Classify a raw exception message into a human-readable error category label.
 *
 * Labels are always exactly 9 characters (including brackets) so they can be
 * padded uniformly in the error block display. Patterns are checked in order;
 * the first match wins.
 */
export function categorizeError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("econnrefused") || m.includes("fetch failed") || m.includes("socket hang up") || m.includes("etimedout")) return "[network]";
  if (m.includes("401") || m.includes("unauthorized") || m.includes("403") || m.includes("forbidden")) return "[auth]";
  if (m.includes("413") || m.includes("payload too large") || m.includes("request entity too large")) return "[payload]";
  if (m.includes("500") || m.includes("502") || m.includes("503") || m.includes("504") || m.includes("internal server error")) return "[server]";
  // "socket was closed" catches bun/undici abort messages like
  // "The socket was closed before the response was received"
  if (m.includes("timeouterror") || m.includes("aborterror") || m.includes("timed out") || m.includes("timeout") || m.includes("socket was closed")) return "[timeout]";
  if (m.includes("enoent") || m.includes("eacces") || m.includes("eperm") || m.includes("no such file")) return "[file]";
  if (m.includes("syntaxerror") || m.includes("json") || m.includes("parse")) return "[parse]";
  return "[error]";
}

/**
 * Replace the home directory prefix in a path with "~" for compact display.
 * Paths outside the home directory are returned unchanged.
 */
export function shortenPath(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

/**
 * Format the full error block displayed at the end of a backfill run.
 *
 * Each error entry spans two lines:
 *   "  [category]  <transcript-path>"
 *   "             <raw error message>"
 *
 * Category labels are padded to 9 characters so path columns align regardless
 * of which category fired. Blank lines separate consecutive entries for
 * scannability. A retry instruction is always appended.
 *
 * @param errors    - Array of {sessionId, error} from BackfillResult
 * @param pathMap   - Map from sessionId → transcript file path (built from ScanResult)
 * @param limit     - Maximum number of errors to display in full (default: 20)
 */
export function formatErrorBlock(
  errors: Array<{ sessionId: string; error: string }>,
  pathMap: Map<string, string>,
  limit = 20,
): string {
  // 2 spaces + 9-char padded label + 2 spaces = 13 chars before the path/error text
  const LABEL_WIDTH = 9;
  const PREFIX = " ".repeat(2);
  const GAP = " ".repeat(2);
  const INDENT = " ".repeat(PREFIX.length + LABEL_WIDTH + GAP.length);

  const lines: string[] = [`Errors (${errors.length}):`];
  const shown = errors.slice(0, limit);

  for (let i = 0; i < shown.length; i++) {
    const err = shown[i];
    // Blank line between entries (not before the first)
    if (i > 0) lines.push("");

    const label = categorizeError(err.error).padEnd(LABEL_WIDTH);
    const rawPath = pathMap.get(err.sessionId);
    const displayPath = rawPath
      ? shortenPath(rawPath)
      : `(session ${err.sessionId})`;

    lines.push(`${PREFIX}${label}${GAP}${displayPath}`);
    lines.push(`${INDENT}${err.error}`);
  }

  if (errors.length > limit) {
    lines.push("");
    lines.push(`  ... and ${errors.length - limit} more`);
  }

  lines.push("");
  lines.push("To retry failed sessions: fuel-code backfill");

  return lines.join("\n");
}
