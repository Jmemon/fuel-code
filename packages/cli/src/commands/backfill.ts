/**
 * `fuel-code backfill` command.
 *
 * Discovers all historical Claude Code sessions from ~/.claude/projects/
 * and ingests them into the fuel-code backend. Supports:
 *   --dry-run  — Scan and report without ingesting
 *   --status   — Show last backfill state
 *   --force    — Run even if a backfill appears to be in progress
 *
 * After discovery, the command uploads transcript files and emits synthetic
 * session.start/session.end events through the normal ingest pipeline.
 *
 * Backfill state is persisted at ~/.fuel-code/backfill-state.json for:
 *   - Status reporting
 *   - Resume after interruption
 *   - Concurrent run detection
 */

import { Command } from "commander";
import * as path from "node:path";
import {
  scanForSessions,
  ingestBackfillSessions,
  waitForPipelineCompletion,
  loadBackfillState,
  saveBackfillState,
  type DiscoveredSession,
  type ScanResult,
  type BackfillProgress,
  type BackfillState,
  type PipelineWaitProgress,
} from "@fuel-code/core";
import { configExists, loadConfig, getConfigDir } from "../lib/config.js";

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

  // Phase 1: Scan for sessions
  console.error("Scanning ~/.claude/projects/...");

  const scanResult = await scanForSessions(undefined, {
    onProgress: (dir) => {
      // Progress dots for scanning (stderr to not pollute stdout)
    },
  });

  if (scanResult.discovered.length === 0) {
    console.log("No historical sessions found.");
    return;
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
    showDryRunSummary(byProject, scanResult, totalSize);
    return;
  }

  // Phase 2: Mark as running and persist state
  const updatedState: BackfillState = {
    ...state,
    isRunning: true,
    startedAt: new Date().toISOString(),
  };
  saveBackfillState(updatedState, stateDir);

  // Build the set of already-ingested sessions for resume
  const alreadyIngested = new Set(state.ingestedSessionIds);

  // Phase 3+4: Ingest sessions, then wait for server-side processing.
  // Both progress bars are rendered simultaneously so the user sees the
  // full pipeline at a glance.
  console.error("");

  // Set up Ctrl-C handling for clean abort
  const abortController = new AbortController();
  const onSigint = () => {
    console.error("\nBackfill interrupted. Progress saved for resume.");
    abortController.abort();
  };
  process.on("SIGINT", onSigint);

  // Dual-bar rendering state — two lines updated in place via ANSI escapes
  let dualBarInit = false;
  const writeDualBars = (line1: string, line2: string): void => {
    if (dualBarInit) {
      // Move cursor up one line so we overwrite both lines
      process.stderr.write("\x1b[1A\r");
    }
    // Clear each line before writing to avoid leftover characters
    process.stderr.write(`\x1b[2K${line1}\n\x1b[2K${line2}`);
    dualBarInit = true;
  };

  try {
    const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 10);
    console.error(`Processing with concurrency: ${concurrency}`);

    const result = await ingestBackfillSessions(scanResult.discovered, {
      serverUrl: config.backend.url,
      apiKey: config.backend.api_key,
      deviceId: config.device.id,
      deviceName: config.device.name,
      deviceType: config.device.type,
      signal: abortController.signal,
      alreadyIngested,
      concurrency,
      onProgress: (progress: BackfillProgress) => {
        const bar = buildProgressBar(progress.completed, progress.total, 30);
        const sessionShort = progress.currentSession
          ? progress.currentSession.slice(0, 8) + "..."
          : "";
        const failStr = progress.failed > 0 ? `  (${progress.failed} failed)` : "";
        writeDualBars(
          `  Uploading:   ${bar} ${progress.completed}/${progress.total}  ${sessionShort}${failStr}`,
          `  Processing:  waiting for uploads...`,
        );
      },
    });

    // Save final state
    const finalState: BackfillState = {
      lastRunAt: new Date().toISOString(),
      lastRunResult: result,
      isRunning: false,
      startedAt: null,
      ingestedSessionIds: [
        ...alreadyIngested,
        ...scanResult.discovered
          .filter((s) => !alreadyIngested.has(s.sessionId))
          .slice(0, result.ingested)
          .map((s) => s.sessionId),
      ],
    };
    saveBackfillState(finalState, stateDir);

    // Phase 4: Wait for server-side processing (parse + summarize)
    const ingestedIds = scanResult.discovered
      .filter((s) => !alreadyIngested.has(s.sessionId))
      .slice(0, result.ingested)
      .map((s) => s.sessionId);

    // Freeze upload bar as "done" for the processing phase.
    // Use scanResult.discovered.length as total to match the ingestion progress bar.
    const uploadTotal = scanResult.discovered.length;
    const uploadCompleted = result.ingested + result.skipped + result.failed;
    const uploadDoneStr = result.failed > 0
      ? `done (${result.failed} failed)`
      : "done";
    const uploadDoneLine = `  Uploading:   ${buildProgressBar(uploadCompleted, uploadTotal, 30)} ${uploadCompleted}/${uploadTotal}  ${uploadDoneStr}`;

    if (ingestedIds.length > 0) {
      // Update upload bar to "done", show processing bar starting
      writeDualBars(
        uploadDoneLine,
        `  Processing:  ${buildProgressBar(0, ingestedIds.length, 30)} 0/${ingestedIds.length}`,
      );

      const pipelineResult = await waitForPipelineCompletion(ingestedIds, {
        serverUrl: config.backend.url,
        apiKey: config.backend.api_key,
        signal: abortController.signal,
        onProgress: (progress: PipelineWaitProgress) => {
          const bar = buildProgressBar(progress.completed, progress.total, 30);
          // Show breakdown of non-terminal states so user knows what's pending
          const parts: string[] = [];
          for (const [lifecycle, count] of Object.entries(progress.byLifecycle)) {
            if (count > 0 && lifecycle !== "parsed" && lifecycle !== "summarized" && lifecycle !== "archived" && lifecycle !== "failed") {
              parts.push(`${count} ${lifecycle}`);
            }
          }
          const statusStr = parts.length > 0 ? `  ${parts.join(", ")}` : "";
          writeDualBars(
            uploadDoneLine,
            `  Processing:  ${bar} ${progress.completed}/${progress.total}${statusStr}`,
          );
        },
      });

      // Clear dual bars and print final summary
      process.stderr.write("\n");

      console.log("");
      if (pipelineResult.completed) {
        console.log("Backfill complete!");
      } else if (pipelineResult.timedOut) {
        console.log("Backfill uploaded. Processing timed out (server still working in background).");
      } else if (pipelineResult.aborted) {
        console.log("Backfill uploaded. Processing watch cancelled (server still working in background).");
      }

      // Summary
      console.log(`  Uploaded:   ${result.ingested} sessions` +
        (result.skipped > 0 ? ` (${result.skipped} skipped)` : ""));
      const ps = pipelineResult.summary;
      const processedParts: string[] = [];
      if (ps.summarized > 0) processedParts.push(`${ps.summarized} summarized`);
      if (ps.parsed > 0) processedParts.push(`${ps.parsed} parsed`);
      if (ps.archived > 0) processedParts.push(`${ps.archived} archived`);
      if (ps.failed > 0) processedParts.push(`${ps.failed} failed`);
      if (ps.pending > 0) processedParts.push(`${ps.pending} pending`);
      console.log(`  Processed:  ${ps.summarized + ps.parsed + ps.archived}/${ingestedIds.length}` +
        (processedParts.length > 0 ? ` (${processedParts.join(", ")})` : ""));
    } else {
      // Nothing to process (all skipped/failed)
      process.stderr.write("\n");
      console.log("");
      console.log("Backfill complete!");
      console.log(`  Uploaded:   ${result.ingested} sessions` +
        (result.skipped > 0 ? ` (${result.skipped} skipped)` : ""));
    }

    // Show errors at the end with full detail
    if (result.errors.length > 0) {
      console.log("");
      console.log(`Errors (${result.errors.length}):`);
      for (const err of result.errors.slice(0, 20)) {
        console.log(`  ${err.sessionId.slice(0, 8)}  ${err.error}`);
      }
      if (result.errors.length > 20) {
        console.log(`  ... and ${result.errors.length - 20} more`);
      }
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

  console.log("");
  console.log(
    `Total: ${scanResult.discovered.length} sessions (${formatBytes(totalSize)})`,
  );

  if (scanResult.skipped.potentiallyActive > 0) {
    console.log(
      `Skipped (potentially active): ${scanResult.skipped.potentiallyActive}`,
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
