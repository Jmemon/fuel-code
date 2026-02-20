/**
 * `fuel-code timeline` command.
 *
 * Renders a session-grouped activity feed with date headers, git commits,
 * tool usage summaries, and footer stats. Supports relative date parsing
 * for --after/--before flags (e.g., -3d, -1w, -12h).
 *
 * Data layer (fetchTimeline) and presentation (formatTimeline) are separated
 * so the TUI can reuse the data functions independently.
 */

import { Command } from "commander";
import pc from "picocolors";
import {
  FuelApiClient,
  ApiError,
  ApiConnectionError,
  type TimelineResponse,
  type TimelineItem,
  type TimelineSessionItem,
  type TimelineOrphanItem,
  type TimelineParams,
} from "../lib/api-client.js";
import {
  formatDuration,
  formatCost,
  formatLifecycle,
  formatEmpty,
  formatError,
  outputResult,
} from "../lib/formatters.js";
import { resolveWorkspaceName } from "../lib/resolvers.js";

// ---------------------------------------------------------------------------
// Relative Date Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a relative date string like -3d, -1w, -12h into an ISO-8601 timestamp.
 *
 * Supported formats:
 *   -Nd  (N days ago)
 *   -Nw  (N weeks ago)
 *   -Nh  (N hours ago)
 *
 * Returns the original string if it does not match the relative pattern
 * (assumes it's already an ISO-8601 date string).
 */
export function parseRelativeDate(input: string): string {
  const match = input.match(/^-(\d+)([dwh])$/);
  if (!match) return input;

  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();

  switch (unit) {
    case "d":
      now.setDate(now.getDate() - amount);
      break;
    case "w":
      now.setDate(now.getDate() - amount * 7);
      break;
    case "h":
      now.setHours(now.getHours() - amount);
      break;
  }

  return now.toISOString();
}

// ---------------------------------------------------------------------------
// Data Layer — exported for TUI reuse
// ---------------------------------------------------------------------------

/** Parameters for fetchTimeline, mapped to API params after resolution */
export interface FetchTimelineParams {
  workspaceId?: string;
  after?: string;
  before?: string;
}

/**
 * Fetch timeline data from the backend via the API client.
 * Returns the raw TimelineResponse.
 */
export async function fetchTimeline(
  api: FuelApiClient,
  params: FetchTimelineParams,
): Promise<TimelineResponse> {
  const apiParams: TimelineParams = {
    workspaceId: params.workspaceId,
    after: params.after,
    before: params.before,
  };

  return api.getTimeline(apiParams);
}

// ---------------------------------------------------------------------------
// Presentation Layer
// ---------------------------------------------------------------------------

/**
 * Group timeline items by date (YYYY-MM-DD) for rendering with date headers.
 * Each group contains the items that occurred on that date.
 */
function groupByDate(items: TimelineItem[]): Map<string, TimelineItem[]> {
  const groups = new Map<string, TimelineItem[]>();

  for (const item of items) {
    const startedAt =
      item.type === "session" ? item.session.started_at : item.started_at;
    const dateKey = startedAt.slice(0, 10); // YYYY-MM-DD

    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(item);
  }

  return groups;
}

/**
 * Format a date key (YYYY-MM-DD) into a human-readable header.
 *
 * Returns "Today", "Yesterday", or "Weekday, Mon DD" for the current year,
 * or "Weekday, Mon DD, YYYY" for other years.
 */
function formatDateHeader(dateKey: string): string {
  const date = new Date(dateKey + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const dayNum = date.getDate();

  if (date.getFullYear() === today.getFullYear()) {
    return `${dayName}, ${monthName} ${dayNum}`;
  }
  return `${dayName}, ${monthName} ${dayNum}, ${date.getFullYear()}`;
}

/**
 * Format a time from an ISO string in 24-hour format: "14:30" style.
 */
function formatTimeShort(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Render a single session timeline item.
 * Shows time, lifecycle icon, workspace+device, duration+cost, summary, and git commits.
 */
function renderSessionItem(item: TimelineSessionItem): string {
  const s = item.session;
  const lines: string[] = [];

  // Session header line: time + lifecycle + workspace@device + duration + cost
  const time = formatTimeShort(s.started_at);
  const lifecycle = formatLifecycle(s.lifecycle);
  const location = `${s.workspace_name} \u00b7 ${s.device_name}`;
  const duration = formatDuration(s.duration_ms);
  const cost = formatCost(s.cost_estimate_usd);

  lines.push(`  ${pc.dim(time)}  ${lifecycle}  ${location}  ${pc.dim(duration)}  ${pc.dim(cost)}`);

  // Summary line (indented under the session header)
  if (s.summary) {
    lines.push(`           ${s.summary}`);
  }

  // Git commits (indented, with commit icon)
  for (const git of item.git_activity) {
    if (git.type === "commit" && git.commit_sha && git.message) {
      const sha = pc.dim(git.commit_sha.slice(0, 7));
      lines.push(`           ${pc.yellow("\u2191")} ${sha} ${git.message}`);
    }
  }

  // Tool usage summary — count by type (excluding commits already shown)
  const toolCounts = new Map<string, number>();
  for (const git of item.git_activity) {
    if (git.type !== "commit") {
      toolCounts.set(git.type, (toolCounts.get(git.type) ?? 0) + 1);
    }
  }
  if (toolCounts.size > 0) {
    const parts = Array.from(toolCounts.entries()).map(
      ([type, count]) => `${count} ${type}${count > 1 ? "s" : ""}`,
    );
    lines.push(`           ${pc.dim(parts.join(", "))}`);
  }

  return lines.join("\n");
}

/**
 * Render an orphan git activity item (git events outside any session).
 */
function renderOrphanItem(item: TimelineOrphanItem): string {
  const lines: string[] = [];
  const time = formatTimeShort(item.started_at);
  const location = `${item.workspace_name} \u00b7 ${item.device_name}`;

  lines.push(`  ${pc.dim(time)}  ${pc.dim("git")}  ${location}`);

  for (const git of item.git_activity) {
    if (git.type === "commit" && git.commit_sha && git.message) {
      const sha = pc.dim(git.commit_sha.slice(0, 7));
      lines.push(`           ${pc.yellow("\u2191")} ${sha} ${git.message}`);
    } else if (git.type === "push") {
      lines.push(`           ${pc.blue("\u2191")} push to ${git.branch ?? "unknown"}`);
    }
  }

  return lines.join("\n");
}

/**
 * Compute footer stats from timeline items: total sessions, duration, cost.
 */
function computeStats(items: TimelineItem[]): {
  sessions: number;
  totalDurationMs: number;
  totalCostUsd: number;
  commits: number;
} {
  let sessions = 0;
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let commits = 0;

  for (const item of items) {
    if (item.type === "session") {
      sessions++;
      totalDurationMs += item.session.duration_ms ?? 0;
      totalCostUsd += item.session.cost_estimate_usd ?? 0;
    }
    const gitActivity = item.git_activity;
    for (const git of gitActivity) {
      if (git.type === "commit") commits++;
    }
  }

  return { sessions, totalDurationMs, totalCostUsd, commits };
}

/**
 * Format the full timeline output with date headers, session blocks, and footer.
 *
 * If there is only one date group, the date header is still shown for context.
 */
export function formatTimeline(data: TimelineResponse): string {
  if (data.items.length === 0) {
    return formatEmpty("activity") + "\n" + pc.dim("No activity found for today.");
  }

  const groups = groupByDate(data.items);
  const lines: string[] = [];

  for (const [dateKey, items] of groups) {
    // Date header
    lines.push("");
    lines.push(pc.bold(formatDateHeader(dateKey)));
    lines.push("");

    // Render each item
    for (const item of items) {
      if (item.type === "session") {
        lines.push(renderSessionItem(item));
      } else {
        lines.push(renderOrphanItem(item));
      }
      lines.push(""); // blank line between items
    }
  }

  // Footer stats
  const stats = computeStats(data.items);
  lines.push(
    pc.dim(
      `${stats.sessions} session${stats.sessions !== 1 ? "s" : ""}` +
        ` | ${formatDuration(stats.totalDurationMs)}` +
        ` | ${formatCost(stats.totalCostUsd)}` +
        ` | ${stats.commits} commit${stats.commits !== 1 ? "s" : ""}`,
    ),
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Error Formatting (command-specific messages)
// ---------------------------------------------------------------------------

function formatTimelineError(error: unknown, baseUrl?: string): string {
  if (error instanceof ApiConnectionError) {
    return pc.red(
      `Cannot connect to backend at ${baseUrl ?? "unknown"}. Is it running?`,
    );
  }
  if (error instanceof ApiError) {
    if (error.statusCode === 401) {
      return pc.red("Invalid API key. Run 'fuel-code init' to reconfigure.");
    }
  }
  return formatError(error);
}

// ---------------------------------------------------------------------------
// Commander Registration
// ---------------------------------------------------------------------------

/**
 * Create the `timeline` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createTimelineCommand(): Command {
  const cmd = new Command("timeline")
    .description("Show session-grouped activity feed")
    .option("-w, --workspace <name>", "Filter by workspace name or ID")
    .option("--today", "Show today's activity (default)")
    .option("--week", "Show this week's activity")
    .option("--after <date>", "Show activity after date (ISO or -Nd/-Nw/-Nh)")
    .option("--before <date>", "Show activity before date (ISO or -Nd/-Nw/-Nh)")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runTimeline(opts);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

/**
 * Core timeline logic. Loads config, resolves filters, fetches data, renders output.
 * Separated from Commander for testability.
 */
export async function runTimeline(opts: {
  workspace?: string;
  today?: boolean;
  week?: boolean;
  after?: string;
  before?: string;
  json?: boolean;
}): Promise<void> {
  let api: FuelApiClient;
  try {
    api = FuelApiClient.fromConfig();
  } catch (err) {
    process.stdout.write(formatError(err) + "\n");
    process.exitCode = 1;
    return;
  }

  const baseUrl = (api as any).baseUrl as string;

  try {
    const params: FetchTimelineParams = {};

    // Resolve workspace
    if (opts.workspace) {
      params.workspaceId = await resolveWorkspaceName(api, opts.workspace);
    }

    // Date range: --week, --after, --before, default to --today
    if (opts.week) {
      // Calculate Monday 00:00 of the current week (ISO week starts on Monday)
      const now = new Date();
      const day = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const diff = day === 0 ? 6 : day - 1; // days since Monday
      const monday = new Date(now);
      monday.setDate(monday.getDate() - diff);
      monday.setHours(0, 0, 0, 0);
      params.after = monday.toISOString();
    } else if (opts.after) {
      params.after = parseRelativeDate(opts.after);
    } else {
      // Default: today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      params.after = today.toISOString();
    }

    if (opts.before) {
      params.before = parseRelativeDate(opts.before);
    }

    // Fetch timeline
    const data = await fetchTimeline(api, params);

    // Output
    if (opts.json) {
      outputResult(data, { json: true, format: () => "" });
    } else {
      const output = formatTimeline(data);
      process.stdout.write(output + "\n");
    }
  } catch (err) {
    process.stdout.write(formatTimelineError(err, baseUrl) + "\n");
    process.exitCode = 1;
  }
}
