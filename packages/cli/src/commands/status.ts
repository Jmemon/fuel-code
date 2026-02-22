/**
 * `fuel-code status` command — enriched system status.
 *
 * Displays comprehensive system state: device info, backend connectivity
 * with latency measurement, active and recent sessions, queue depth,
 * hook installation status, and today's summary.
 *
 * Graceful degradation: if backend is unreachable, shows local-only data
 * (device, queue, hooks) and a clear offline message.
 *
 * Health check, active sessions, recent sessions, and today's query all
 * run in parallel via Promise.all for speed (target < 4 seconds).
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pc from "picocolors";
import type { Session } from "@fuel-code/shared";
import { ConfigError } from "@fuel-code/shared";
import {
  configExists,
  loadConfig,
  getQueueDir,
  getDeadLetterDir,
  type FuelCodeConfig,
} from "../lib/config.js";
import {
  FuelApiClient,
  ApiConnectionError,
  type HealthStatus,
} from "../lib/api-client.js";
import {
  formatDuration,
  formatCost,
  formatRelativeTime,
  formatError,
  outputResult,
} from "../lib/formatters.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Comprehensive status data collected by fetchStatus */
export interface StatusData {
  device: { id: string; name: string; type: string };
  backend: {
    url: string;
    status: "connected" | "unreachable";
    latencyMs?: number;
    health?: HealthStatus;
  };
  activeSessions: Session[];
  queue: { pending: number; deadLetter: number };
  recentSessions: Session[];
  hooks: { ccHooksInstalled: boolean; gitHooksInstalled: boolean };
  today?: {
    sessionCount: number;
    totalDurationMs: number;
    totalCostUsd: number;
  };
}

// ---------------------------------------------------------------------------
// Settings path override for testability
// ---------------------------------------------------------------------------

let settingsPathOverride: string | undefined;

/** Override the Claude settings path (for tests only). Set to undefined to reset. */
export function overrideSettingsPath(p: string | undefined): void {
  settingsPathOverride = p;
}

function getSettingsPath(): string {
  return settingsPathOverride ?? path.join(os.homedir(), ".claude", "settings.json");
}

// ---------------------------------------------------------------------------
// Data Layer
// ---------------------------------------------------------------------------

/**
 * Count .json files in a directory. Returns 0 if directory doesn't exist.
 */
function countJsonFiles(dir: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/**
 * Check if CC (Claude Code) hooks are installed by reading ~/.claude/settings.json
 * and looking for fuel-code hook entries in SessionStart or SessionEnd events.
 */
function checkCCHooksInstalled(): boolean {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return false;
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== "object") return false;

    // Check if SessionStart or Stop has a fuel-code hook entry
    for (const eventName of ["SessionStart", "SessionEnd"]) {
      const configs = hooks[eventName];
      if (!Array.isArray(configs)) continue;
      for (const config of configs) {
        if (!Array.isArray(config.hooks)) continue;
        for (const h of config.hooks) {
          if (
            h.command &&
            (h.command.includes("fuel-code") ||
              h.command.includes("SessionStart.sh") ||
              h.command.includes("SessionEnd.sh"))
          ) {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if git hooks are installed by checking global core.hooksPath.
 * Returns true if it points to the fuel-code git-hooks directory.
 */
function checkGitHooksInstalled(): boolean {
  try {
    const result = Bun.spawnSync(["git", "config", "--global", "core.hooksPath"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const hooksPath = result.stdout.toString().trim();
    if (!hooksPath) return false;
    const fuelCodeHooksDir = path.join(os.homedir(), ".fuel-code", "git-hooks");
    return path.resolve(hooksPath) === path.resolve(fuelCodeHooksDir);
  } catch {
    return false;
  }
}

/**
 * Fetch all status data with graceful degradation.
 * Health check, active sessions, recent sessions, and today's query run in parallel.
 */
export async function fetchStatus(
  api: FuelApiClient,
  config: FuelCodeConfig,
): Promise<StatusData> {
  // Local data (synchronous, always available)
  const device = {
    id: config.device.id,
    name: config.device.name,
    type: config.device.type,
  };

  const pending = countJsonFiles(getQueueDir());
  const deadLetter = countJsonFiles(getDeadLetterDir());
  const ccHooksInstalled = checkCCHooksInstalled();
  const gitHooksInstalled = checkGitHooksInstalled();

  // Backend data (parallel fetch with 3-second timeout)
  const startMs = Date.now();

  // Build today's midnight ISO string for the "today" query
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightIso = midnight.toISOString();

  // Run all backend queries in parallel with graceful degradation
  type HealthResult = { health: HealthStatus; latencyMs: number };
  type SessionsResult = Session[];

  const [healthResult, activeResult, recentResult, todayResult] =
    await Promise.allSettled([
      // Health check with latency measurement
      (async (): Promise<HealthResult> => {
        const health = await api.getHealth();
        return { health, latencyMs: Date.now() - startMs };
      })(),
      // Active sessions
      (async (): Promise<SessionsResult> => {
        const { data } = await api.listSessions({
          lifecycle: "capturing",
          limit: 10,
        });
        return data;
      })(),
      // Recent sessions
      (async (): Promise<SessionsResult> => {
        const { data } = await api.listSessions({ limit: 3 });
        return data;
      })(),
      // Today's sessions for aggregation
      (async (): Promise<SessionsResult> => {
        const { data } = await api.listSessions({
          after: midnightIso,
          limit: 250,
        });
        return data;
      })(),
    ]);

  // Determine backend status
  const backendConnected = healthResult.status === "fulfilled";
  const backend = backendConnected
    ? {
        url: config.backend.url,
        status: "connected" as const,
        latencyMs: healthResult.value.latencyMs,
        health: healthResult.value.health,
      }
    : {
        url: config.backend.url,
        status: "unreachable" as const,
      };

  // Extract results (empty arrays for failed fetches)
  const activeSessions =
    activeResult.status === "fulfilled" ? activeResult.value : [];
  const recentSessions =
    recentResult.status === "fulfilled" ? recentResult.value : [];

  // Aggregate today's summary
  let today: StatusData["today"] | undefined;
  if (todayResult.status === "fulfilled") {
    const todaySessions = todayResult.value;
    const totalDurationMs = todaySessions.reduce(
      (sum, s) => sum + (s.duration_ms ?? 0),
      0,
    );
    const totalCostUsd = todaySessions.reduce(
      (sum, s) => sum + ((s as any).cost_estimate_usd ?? 0),
      0,
    );
    today = {
      sessionCount: todaySessions.length,
      totalDurationMs,
      totalCostUsd,
    };
  }

  return {
    device,
    backend,
    activeSessions,
    queue: { pending, deadLetter },
    recentSessions,
    hooks: { ccHooksInstalled, gitHooksInstalled },
    today,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Format the full status output for terminal display.
 * Handles connected, unreachable, and not-initialized states.
 */
export function formatStatus(data: StatusData): string {
  const lines: string[] = [];
  lines.push("fuel-code status");
  lines.push("");

  // Device info
  lines.push(`  Device:     ${data.device.name} (${data.device.id.slice(0, 8)}...)`);
  lines.push(`  Type:       ${data.device.type}`);

  // Backend connectivity
  if (data.backend.status === "connected") {
    lines.push(
      `  Backend:    ${pc.green("\u2713")} Connected (${data.backend.url})${data.backend.latencyMs !== undefined ? ` \u00B7 ${data.backend.latencyMs}ms` : ""}`,
    );
  } else {
    lines.push(
      `  Backend:    ${pc.red("\u2717")} Unreachable (${data.backend.url})`,
    );
    lines.push(pc.dim("              Connection timed out. Events will queue locally."));
  }

  // Queue
  lines.push(
    `  Queue:      ${data.queue.pending} pending \u00B7 ${data.queue.deadLetter} dead-letter`,
  );

  // Active sessions (backend only)
  if (data.backend.status === "connected") {
    lines.push("");
    lines.push("  Active Sessions:");
    if (data.activeSessions.length === 0) {
      lines.push("    " + pc.dim("No active sessions"));
    } else {
      // Cap displayed active sessions at 5 with overflow indicator
      const displayed = data.activeSessions.slice(0, 5);
      for (const session of displayed) {
        const ws = (session as any).workspace_name ?? session.workspace_id;
        const dev = (session as any).device_name ?? session.device_id;
        const dur = formatDuration(session.duration_ms);
        const cost = formatCost((session as any).cost_estimate_usd ?? null);
        lines.push(`    ${pc.green("\u25CF")} ${ws} \u00B7 ${dev} \u00B7 ${dur} \u00B7 ${cost}`);
        const summary = (session as any).summary ?? (session as any).initial_prompt;
        if (summary) {
          lines.push(`      ${pc.dim(summary)}`);
        }
      }
      if (data.activeSessions.length > 5) {
        lines.push(`    ...and ${data.activeSessions.length - 5} more capturing`);
      }
    }

    // Recent sessions (backend only)
    lines.push("");
    lines.push("  Recent Sessions:");
    if (data.recentSessions.length === 0) {
      lines.push("    " + pc.dim("(none)"));
    } else {
      for (const session of data.recentSessions) {
        const ws = (session as any).workspace_name ?? session.workspace_id;
        const dev = (session as any).device_name ?? session.device_id;
        const dur = formatDuration(session.duration_ms);
        const cost = formatCost((session as any).cost_estimate_usd ?? null);
        const ago = formatRelativeTime(session.started_at);
        lines.push(`    \u2713 ${ws} \u00B7 ${dev} \u00B7 ${dur} \u00B7 ${cost} \u00B7 ${ago}`);
      }
    }
  } else {
    lines.push("");
    lines.push(
      "  " + pc.dim("(Cannot fetch session data -- backend offline)"),
    );
  }

  // Hooks
  lines.push("");
  lines.push("  Hooks:");
  lines.push(
    `    CC hooks:   ${data.hooks.ccHooksInstalled ? pc.green("\u2713 Installed") : pc.dim("\u2717 Not installed")}`,
  );
  lines.push(
    `    Git hooks:  ${data.hooks.gitHooksInstalled ? pc.green("\u2713 Installed") : pc.dim("\u2717 Not installed")}`,
  );

  // Today's summary (backend only)
  if (data.today) {
    lines.push("");
    lines.push(
      `  Today: ${data.today.sessionCount} sessions \u00B7 ${formatDuration(data.today.totalDurationMs)} \u00B7 ${formatCost(data.today.totalCostUsd)}`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command Definition
// ---------------------------------------------------------------------------

/**
 * Create the `status` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createStatusCommand(): Command {
  const cmd = new Command("status")
    .description("Show device info, queue depth, and connectivity status")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runStatus(opts);
    });

  return cmd;
}

/**
 * Core status logic. Separated from Commander for testability.
 */
export async function runStatus(opts?: { json?: boolean }): Promise<void> {
  // Not initialized state
  if (!configExists()) {
    if (opts?.json) {
      process.stdout.write(
        JSON.stringify({ device: { status: "not_initialized" } }, null, 2) + "\n",
      );
    } else {
      console.log("Device: Not initialized");
      console.log("Run 'fuel-code init' to set up this device.");
    }
    return;
  }

  // Load config
  let config: FuelCodeConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error (${err.code}): ${err.message}`);
    } else {
      console.error("Failed to load config:", err);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const api = new FuelApiClient({
      baseUrl: config.backend.url,
      apiKey: config.backend.api_key,
      timeout: 3000, // 3-second timeout for status checks
    });

    const data = await fetchStatus(api, config);

    outputResult(data, {
      json: opts?.json,
      format: formatStatus,
    });
  } catch (err) {
    console.error(formatError(err));
    process.exitCode = 1;
  }
}
