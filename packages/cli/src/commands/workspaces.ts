/**
 * `fuel-code workspaces` and `fuel-code workspace <name>` commands.
 *
 * Provides two views:
 *   - `workspaces`      — List all workspaces with aggregated stats (sessions, cost, time)
 *   - `workspace <name>` — Detailed view of a single workspace (devices, sessions, git activity)
 *
 * Both support --json for machine-readable output.
 * Workspace name resolution: ULID (26-char) passed through, "/" treated as canonical ID,
 * otherwise case-insensitive prefix match via resolveWorkspaceName.
 */

import { Command } from "commander";
import pc from "picocolors";
import {
  FuelApiClient,
  type WorkspaceSummary,
  type WorkspaceDetailResponse,
} from "../lib/api-client.js";
import { resolveWorkspaceName } from "../lib/resolvers.js";
import { configExists, loadConfig } from "../lib/config.js";
import {
  renderTable,
  formatDuration,
  formatCost,
  formatRelativeTime,
  formatWorkspaceRow,
  formatSessionRow,
  formatEmpty,
  formatError,
  outputResult,
} from "../lib/formatters.js";

// ---------------------------------------------------------------------------
// Data Layer
// ---------------------------------------------------------------------------

/**
 * Fetch all workspaces from the backend, sorted by last activity (most recent first).
 * Returns an empty array on connection failure.
 */
export async function fetchWorkspaces(
  api: FuelApiClient,
): Promise<WorkspaceSummary[]> {
  const { data } = await api.listWorkspaces({ limit: 250 });
  // Sort by last activity descending (null last_session_at goes to the bottom)
  return data.sort((a, b) => {
    if (!a.last_session_at && !b.last_session_at) return 0;
    if (!a.last_session_at) return 1;
    if (!b.last_session_at) return -1;
    return (
      new Date(b.last_session_at).getTime() -
      new Date(a.last_session_at).getTime()
    );
  });
}

/**
 * Fetch detailed workspace information by workspace ID.
 */
export async function fetchWorkspaceDetail(
  api: FuelApiClient,
  workspaceId: string,
): Promise<WorkspaceDetailResponse> {
  return api.getWorkspace(workspaceId);
}

// ---------------------------------------------------------------------------
// Presentation: Workspaces List
// ---------------------------------------------------------------------------

/**
 * Format the workspaces list as a table with columns:
 * WORKSPACE, SESSIONS, ACTIVE, DEVICES, LAST ACTIVITY, TOTAL COST, TOTAL TIME
 *
 * Workspaces with active sessions get bold names.
 */
export function formatWorkspacesTable(workspaces: WorkspaceSummary[]): string {
  if (workspaces.length === 0) {
    return formatEmpty("workspaces") +
      "\n\n" +
      pc.dim(
        "No workspaces tracked yet. Run 'fuel-code init' in a git repo, then start a Claude Code session to begin tracking.",
      );
  }

  const columns = [
    { header: "WORKSPACE" },
    { header: "SESSIONS", align: "right" as const },
    { header: "ACTIVE", align: "right" as const },
    { header: "DEVICES", align: "right" as const },
    { header: "LAST ACTIVITY" },
    { header: "TOTAL COST", align: "right" as const },
    { header: "TOTAL TIME", align: "right" as const },
  ];

  const rows = workspaces.map((ws) => {
    // Bold name if workspace has active sessions
    const name =
      ws.active_session_count > 0
        ? pc.bold(ws.display_name)
        : ws.display_name;

    return [
      name,
      String(ws.session_count),
      ws.active_session_count > 0
        ? pc.green(String(ws.active_session_count))
        : "0",
      String(ws.device_count),
      ws.last_session_at
        ? formatRelativeTime(ws.last_session_at)
        : pc.dim("never"),
      formatCost(ws.total_cost_usd),
      formatDuration(ws.total_duration_ms),
    ];
  });

  return renderTable({ columns, rows });
}

// ---------------------------------------------------------------------------
// Presentation: Workspace Detail
// ---------------------------------------------------------------------------

/**
 * Format detailed workspace view including header, devices, recent sessions,
 * and git activity summary.
 */
export function formatWorkspaceDetail(detail: WorkspaceDetailResponse): string {
  const { workspace, devices, recent_sessions, git_summary, stats } = detail;
  const lines: string[] = [];

  // -- Header section --
  lines.push(pc.bold(workspace.display_name));
  lines.push(`  Canonical ID:  ${workspace.canonical_id}`);
  if (workspace.default_branch) {
    lines.push(`  Branch:        ${workspace.default_branch}`);
  }
  lines.push(`  First seen:    ${formatRelativeTime(workspace.first_seen_at)}`);
  lines.push(
    `  Sessions:      ${stats.total_sessions}  |  Cost: ${formatCost(stats.total_cost_usd)}  |  Time: ${formatDuration(stats.total_duration_ms)}`,
  );

  // -- Devices section --
  lines.push("");
  lines.push(pc.bold("Devices:"));
  if (devices.length === 0) {
    lines.push("  " + pc.dim("(none)"));
  } else {
    for (const device of devices) {
      const ccHook = device.hooks_installed ? pc.green("\u2713") : pc.red("\u2717");
      const gitHook = device.git_hooks_installed
        ? pc.green("\u2713")
        : pc.red("\u2717");
      const lastActive = (device as any).last_active_at
        ? formatRelativeTime((device as any).last_active_at)
        : pc.dim("never");
      lines.push(
        `  ${device.name} (${device.type})  CC: ${ccHook}  Git: ${gitHook}  last active: ${lastActive}`,
      );
    }
  }

  // -- Recent sessions section --
  lines.push("");
  lines.push(pc.bold("Recent Sessions:"));
  if (recent_sessions.length === 0) {
    lines.push("  " + pc.dim("(none)"));
  } else {
    const sessionColumns = [
      { header: "STATUS" },
      { header: "DEVICE" },
      { header: "DURATION" },
      { header: "COST", align: "right" as const },
      { header: "STARTED" },
      { header: "SUMMARY" },
    ];
    const sessionRows = recent_sessions.slice(0, 5).map((s) => [
      (s as any).lifecycle ?? "unknown",
      (s as any).device_name ?? s.device_id,
      formatDuration(s.duration_ms),
      formatCost((s as any).cost_estimate_usd ?? null),
      formatRelativeTime(s.started_at),
      (s as any).summary ?? (s as any).initial_prompt ?? pc.dim("(no summary)"),
    ]);
    lines.push(
      renderTable({ columns: sessionColumns, rows: sessionRows })
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );
  }

  // -- Git activity section --
  lines.push("");
  lines.push(pc.bold("Git Activity:"));
  if (
    git_summary.total_commits === 0 &&
    git_summary.total_pushes === 0
  ) {
    lines.push("  " + pc.dim("(no git activity)"));
  } else {
    lines.push(`  Commits: ${git_summary.total_commits}  |  Pushes: ${git_summary.total_pushes}`);
    if (git_summary.active_branches.length > 0) {
      lines.push(`  Active branches: ${git_summary.active_branches.join(", ")}`);
    }
    if (git_summary.last_commit_at) {
      lines.push(`  Last commit: ${formatRelativeTime(git_summary.last_commit_at)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

/**
 * Create the `workspaces` list command.
 */
export function createWorkspacesCommand(): Command {
  return new Command("workspaces")
    .description("List all workspaces with aggregated stats")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runWorkspacesList(opts);
    });
}

/**
 * Create the `workspace <name>` detail command.
 */
export function createWorkspaceDetailCommand(): Command {
  return new Command("workspace")
    .description("Show detailed workspace information")
    .argument("<name>", "Workspace name, canonical ID, or ULID")
    .option("--json", "Output as JSON")
    .action(async (name, opts) => {
      await runWorkspaceDetail(name, opts);
    });
}

/**
 * Register both workspace commands on the program.
 */
export function registerWorkspacesCommands(program: Command): void {
  program.addCommand(createWorkspacesCommand());
  program.addCommand(createWorkspaceDetailCommand());
}

// ---------------------------------------------------------------------------
// Command Runners (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Run the workspaces list command. Fetches all workspaces and renders
 * a summary table sorted by last activity.
 */
export async function runWorkspacesList(opts: {
  json?: boolean;
}): Promise<void> {
  if (!configExists()) {
    console.log(
      "No workspaces tracked yet. Run 'fuel-code init' in a git repo, then start a Claude Code session to begin tracking.",
    );
    return;
  }

  try {
    const config = loadConfig();
    const api = FuelApiClient.fromConfig(config);
    const workspaces = await fetchWorkspaces(api);

    outputResult(workspaces, {
      json: opts.json,
      format: formatWorkspacesTable,
    });
  } catch (err) {
    console.error(formatError(err));
    process.exitCode = 1;
  }
}

/**
 * Run the workspace detail command. Resolves the name/ID argument,
 * fetches detail, and renders the full workspace view.
 */
export async function runWorkspaceDetail(
  name: string,
  opts: { json?: boolean },
): Promise<void> {
  if (!configExists()) {
    console.log(
      "No workspaces tracked yet. Run 'fuel-code init' in a git repo, then start a Claude Code session to begin tracking.",
    );
    return;
  }

  try {
    const config = loadConfig();
    const api = FuelApiClient.fromConfig(config);

    // Resolve workspace name to ULID
    const workspaceId = await resolveWorkspaceName(api, name);
    const detail = await fetchWorkspaceDetail(api, workspaceId);

    outputResult(detail, {
      json: opts.json,
      format: formatWorkspaceDetail,
    });
  } catch (err) {
    console.error(formatError(err));
    process.exitCode = 1;
  }
}
