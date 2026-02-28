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

  // Phase 3: Ingest sessions
  console.error("");

  // Set up Ctrl-C handling for clean abort
  const abortController = new AbortController();
  const onSigint = () => {
    console.error("\nBackfill interrupted. Progress saved for resume.");
    abortController.abort();
  };
  process.on("SIGINT", onSigint);

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
        // Print progress line (overwrite previous with \r)
        const bar = buildProgressBar(progress.completed, progress.total, 30);
        const sessionShort = progress.currentSession
          ? progress.currentSession.slice(0, 8) + "..."
          : "";
        process.stderr.write(
          `\rBackfilling: ${bar} ${progress.completed}/${progress.total}  ${sessionShort}    `,
        );
      },
    });

    // Clear progress line
    process.stderr.write("\r" + " ".repeat(80) + "\r");

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

    // Print results
    console.log("Backfill complete!");
    console.log(`  Ingested:  ${result.ingested} sessions`);
    console.log(
      `  Skipped:   ${result.skipped} (already tracked)`,
    );
    console.log(`  Failed:    ${result.failed}`);

    // Phase 4: Wait for server-side processing (parse + summarize)
    // Collect all session IDs that were successfully ingested
    const ingestedIds = scanResult.discovered
      .filter((s) => !alreadyIngested.has(s.sessionId))
      .slice(0, result.ingested)
      .map((s) => s.sessionId);

    if (ingestedIds.length > 0) {
      console.error("");
      console.error("Waiting for server-side processing...");

      const pipelineResult = await waitForPipelineCompletion(ingestedIds, {
        serverUrl: config.backend.url,
        apiKey: config.backend.api_key,
        signal: abortController.signal,
        onProgress: (progress: PipelineWaitProgress) => {
          const bar = buildProgressBar(progress.completed, progress.total, 30);
          // Build status breakdown string for non-terminal states
          const parts: string[] = [];
          for (const [state, count] of Object.entries(progress.byLifecycle)) {
            if (count > 0 && state !== "parsed" && state !== "summarized" && state !== "archived" && state !== "failed") {
              parts.push(`${count} ${state}`);
            }
          }
          const statusStr = parts.length > 0 ? `  ${parts.join(", ")}` : "";
          process.stderr.write(
            `\rProcessing:  ${bar} ${progress.completed}/${progress.total}${statusStr}    `,
          );
        },
      });

      // Clear progress line
      process.stderr.write("\r" + " ".repeat(80) + "\r");

      if (pipelineResult.completed) {
        console.log("Processing complete!");
      } else if (pipelineResult.timedOut) {
        console.log("Processing timed out (server is still working in the background).");
      } else if (pipelineResult.aborted) {
        console.log("Processing watch cancelled (server is still working in the background).");
      }

      // Show processing summary
      const ps = pipelineResult.summary;
      if (ps.summarized > 0) console.log(`  Summarized: ${ps.summarized}`);
      if (ps.parsed > 0)     console.log(`  Parsed:     ${ps.parsed}`);
      if (ps.archived > 0)   console.log(`  Archived:   ${ps.archived}`);
      if (ps.failed > 0)     console.log(`  Failed:     ${ps.failed}`);
      if (ps.pending > 0)    console.log(`  Pending:    ${ps.pending}`);
    }

    if (result.errors.length > 0) {
      console.log("Errors:");
      for (const err of result.errors.slice(0, 20)) {
        console.log(`  session ${err.sessionId}: ${err.error}`);
      }
      if (result.errors.length > 20) {
        console.log(
          `  ... and ${result.errors.length - 20} more errors`,
        );
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
