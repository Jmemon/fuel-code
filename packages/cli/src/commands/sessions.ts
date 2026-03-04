/**
 * `fuel-code sessions` command.
 *
 * Lists sessions in a tabular format with filtering, pagination, and JSON output.
 * Separates a data layer (fetchSessions, resolve helpers) from the presentation
 * layer (formatSessionsTable, Commander registration) so the TUI can reuse
 * the data functions independently.
 *
 * Sessions with teammates display an inline annotation showing teammate names.
 * Sessions with subagents display an annotation showing agent types.
 */

import { Command } from "commander";
import pc from "picocolors";
import type { Session } from "@fuel-code/shared";
import {
  FuelApiClient,
  ApiError,
  ApiConnectionError,
  type SessionListParams,
  type PaginatedResponse,
} from "../lib/api-client.js";
import {
  formatDuration,
  formatTokensCompact,
  formatRelativeTime,
  formatLifecycle,
  formatEmpty,
  formatError,
  outputResult,
  truncate,
  displayWidth,
} from "../lib/formatters.js";
import { resolveWorkspaceName, resolveDeviceName } from "../lib/resolvers.js";

// ---------------------------------------------------------------------------
// Data Layer — exported for TUI reuse
// ---------------------------------------------------------------------------

/** Parameters for fetchSessions, mapped to API params after resolution */
export interface FetchSessionsParams {
  workspaceId?: string;
  deviceId?: string;
  lifecycle?: string;
  after?: string;
  before?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

/** Result of fetchSessions, wrapping the paginated API response */
export interface FetchSessionsResult {
  sessions: Session[];
  cursor: string | null;
  total: number;
}

/**
 * Fetch sessions from the backend via the API client.
 * Returns a simplified result with sessions array, next cursor, and count.
 */
export async function fetchSessions(
  api: FuelApiClient,
  params: FetchSessionsParams,
): Promise<FetchSessionsResult> {
  const apiParams: SessionListParams = {
    workspaceId: params.workspaceId,
    deviceId: params.deviceId,
    lifecycle: params.lifecycle,
    after: params.after,
    before: params.before,
    tag: params.tag,
    limit: params.limit ?? 20,
    cursor: params.cursor,
  };

  const result: PaginatedResponse<Session> = await api.listSessions(apiParams);

  return {
    sessions: result.data,
    cursor: result.nextCursor,
    total: result.data.length,
  };
}

// ---------------------------------------------------------------------------
// Presentation Layer — enriched table with teammate annotations, subagent
// annotations, and ROLE column
// ---------------------------------------------------------------------------

/** Extended session fields returned by the API list endpoint */
interface SessionExt extends Session {
  workspace_name?: string;
  device_name?: string;
  summary?: string | null;
  initial_prompt?: string | null;
  tokens_in?: number | string | null;
  tokens_out?: number | string | null;
  subagent_count?: number;
  subagent_types?: string[];
  /** Number of teammates in this session's team (from list query) */
  num_teammates?: number;
  /** Display names of teammates (from list query) */
  teammate_names?: string[];
}

/**
 * Derive the ROLE string for a session.
 * Sessions with teammates show "team", sessions with subagents show "parent".
 */
function getRole(s: SessionExt): string {
  if ((s.num_teammates ?? 0) > 0) return pc.magenta("team");
  if ((s.subagent_count ?? 0) > 0) return "parent";
  return "";
}

/** Pad/align a string to a given width (ANSI-aware) */
function pad(str: string, width: number, align: "left" | "right"): string {
  const visibleLen = displayWidth(str);
  if (visibleLen >= width) return str;
  const padding = " ".repeat(width - visibleLen);
  return align === "right" ? padding + str : str + padding;
}

/** Column definition for the enriched table */
interface EnrichedCol {
  header: string;
  align: "left" | "right";
  /** Extract cell value from a session */
  cell: (s: SessionExt) => string;
}

/** Build column definitions */
function getColumns(): EnrichedCol[] {
  return [
    { header: "STATUS", align: "left", cell: (s) => formatLifecycle(s.lifecycle) },
    { header: "ID", align: "left", cell: (s) => pc.dim(s.id.slice(0, 8)) },
    { header: "WORKSPACE", align: "left", cell: (s) => s.workspace_name ?? s.workspace_id },
    { header: "DEVICE", align: "left", cell: (s) => s.device_name ?? s.device_id },
    { header: "DURATION", align: "right", cell: (s) => formatDuration(s.duration_ms) },
    { header: "TOKENS", align: "right", cell: (s) => formatTokensCompact(s.tokens_in ?? null, s.tokens_out ?? null) },
    { header: "STARTED", align: "left", cell: (s) => formatRelativeTime(s.started_at) },
    { header: "ROLE", align: "left", cell: (s) => getRole(s) },
    { header: "SUMMARY", align: "left", cell: (s) => s.summary ?? s.initial_prompt ?? pc.dim("(no summary)") },
  ];
}

/** Calculate column widths from all sessions (auto-size, respect maxWidth) */
function calcWidths(columns: EnrichedCol[], allSessions: SessionExt[]): number[] {
  const gap = 2;
  const maxWidth = process.stdout.columns || 120;

  const widths = columns.map((col, i) => {
    const headerLen = col.header.length;
    const maxCell = allSessions.reduce(
      (max, s) => Math.max(max, displayWidth(col.cell(s))),
      0,
    );
    return Math.max(headerLen, maxCell);
  });

  // Shrink widest columns if total exceeds terminal width
  const totalGaps = (columns.length - 1) * gap;
  let totalWidth = widths.reduce((a, b) => a + b, 0) + totalGaps;
  while (totalWidth > maxWidth && widths.some((w) => w > 10)) {
    const maxIdx = widths.indexOf(Math.max(...widths));
    widths[maxIdx]--;
    totalWidth--;
  }

  return widths;
}

/** Render a single session row as a string */
function renderSessionRow(
  s: SessionExt,
  columns: EnrichedCol[],
  widths: number[],
): string {
  const cells = columns.map((col, i) => {
    const value = col.cell(s);
    return pad(truncate(value, widths[i]), widths[i], col.align);
  });
  return cells.join("  ");
}

/**
 * Calculate the character offset to align annotation lines under the SUMMARY column.
 */
function getSummaryOffset(columns: EnrichedCol[], widths: number[]): number {
  const summaryIdx = columns.findIndex((c) => c.header === "SUMMARY");
  let offset = 0;
  for (let i = 0; i < summaryIdx; i++) {
    offset += widths[i] + 2; // column width + gap
  }
  return offset;
}

/** Render subagent annotation line below a parent session */
function renderSubagentAnnotation(
  s: SessionExt,
  columns: EnrichedCol[],
  widths: number[],
): string {
  const types = (s.subagent_types ?? []).join(", ");
  const count = s.subagent_count ?? 0;
  const annotation = pc.dim(`\u2514\u2500 ${count} agent${count !== 1 ? "s" : ""} (${types})`);
  const offset = getSummaryOffset(columns, widths);
  return " ".repeat(offset) + annotation;
}

/** Render teammate annotation line below a session that has teammates */
function renderTeammateAnnotation(
  s: SessionExt,
  columns: EnrichedCol[],
  widths: number[],
): string {
  const names = (s.teammate_names ?? []).join(", ");
  const annotation = pc.dim(`\u2514\u2500 Teammates: ${names}`);
  const offset = getSummaryOffset(columns, widths);
  return " ".repeat(offset) + annotation;
}

/**
 * Format sessions into an enriched table with teammate and subagent
 * annotations and a ROLE column.
 *
 * Sessions with teammates show a teammate annotation line below.
 * Parent sessions (with subagents) show a subagent annotation line below.
 */
export function formatSessionsTable(sessions: Session[], hasFilters?: boolean): string {
  if (sessions.length === 0) {
    const msg = formatEmpty("sessions");
    if (hasFilters) {
      return msg + "\nTry removing filters or expanding the date range.";
    }
    return msg;
  }

  const allSessions = sessions as SessionExt[];
  const columns = getColumns();
  const widths = calcWidths(columns, allSessions);

  const lines: string[] = [];

  // Header row
  const headerLine = columns
    .map((col, i) => pc.bold(pad(col.header, widths[i], col.align)))
    .join("  ");
  lines.push(headerLine);

  for (const s of allSessions) {
    lines.push(renderSessionRow(s, columns, widths));

    // Teammate annotation: show teammate names when session has teammates
    if ((s.num_teammates ?? 0) > 0 && (s.teammate_names?.length ?? 0) > 0) {
      lines.push(renderTeammateAnnotation(s, columns, widths));
    }

    // Subagent annotation: show agent types when session has subagents
    if ((s.subagent_count ?? 0) > 0 && (s.subagent_types?.length ?? 0) > 0) {
      lines.push(renderSubagentAnnotation(s, columns, widths));
    }
  }

  return lines.join("\n");
}

/**
 * Format a pagination footer showing the cursor for the next page.
 * Returns empty string if there is no next page.
 */
function formatPaginationFooter(cursor: string | null, total: number): string {
  if (!cursor) return "";
  return pc.dim(`\nShowing ${total} sessions (more available). Next page: --cursor ${cursor}`);
}

// ---------------------------------------------------------------------------
// Error Formatting (command-specific messages)
// ---------------------------------------------------------------------------

/**
 * Format errors with command-specific user-friendly messages.
 * Falls back to the generic formatError for unrecognized error types.
 */
function formatSessionsError(error: unknown, baseUrl?: string): string {
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
 * Create the `sessions` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createSessionsCommand(): Command {
  const cmd = new Command("sessions")
    .description("List sessions with filtering and pagination")
    .option("-w, --workspace <name>", "Filter by workspace name or ID")
    .option("-d, --device <name>", "Filter by device name or ID")
    .option("--today", "Show only today's sessions")
    .option("--live", "Show only live (detected) sessions")
    .option("--lifecycle <state>", "Filter by lifecycle state")
    .option("--tag <tag>", "Filter by tag")
    .option("-n, --limit <n>", "Results per page (default 20)", "20")
    .option("--cursor <cursor>", "Pagination cursor for next page")
    .option("--json", "Output raw JSON")
    .action(async (opts) => {
      await runSessions(opts);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

/**
 * Core sessions logic. Loads config, resolves filters, fetches data, renders output.
 * Separated from Commander for testability.
 */
export async function runSessions(opts: {
  workspace?: string;
  device?: string;
  today?: boolean;
  live?: boolean;
  lifecycle?: string;
  tag?: string;
  limit?: string;
  cursor?: string;
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
    // Build params from CLI flags
    const params: FetchSessionsParams = {
      limit: parseInt(opts.limit ?? "20", 10),
      cursor: opts.cursor,
      tag: opts.tag,
    };

    // Resolve workspace name/ID to ULID
    if (opts.workspace) {
      params.workspaceId = await resolveWorkspaceName(api, opts.workspace);
    }

    // Resolve device name/ID to ULID
    if (opts.device) {
      params.deviceId = await resolveDeviceName(api, opts.device);
    }

    // --today: set after to start of today (local timezone)
    if (opts.today) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      params.after = today.toISOString();
    }

    // --live implies lifecycle=detected (active sessions)
    if (opts.live) {
      params.lifecycle = "detected";
    } else if (opts.lifecycle) {
      params.lifecycle = opts.lifecycle;
    }

    // Fetch sessions
    const result = await fetchSessions(api, params);

    // Output
    if (opts.json) {
      outputResult(result, { json: true, format: () => "" });
    } else {
      // Determine if any filters were applied so the empty state can show a hint
      const hasFilters = !!(opts.workspace || opts.device || opts.today || opts.live || opts.lifecycle || opts.tag);
      const table = formatSessionsTable(result.sessions, hasFilters);
      const footer = formatPaginationFooter(result.cursor, result.total);
      process.stdout.write(table + footer + "\n");
    }
  } catch (err) {
    process.stdout.write(formatSessionsError(err, baseUrl) + "\n");
    process.exitCode = 1;
  }
}
