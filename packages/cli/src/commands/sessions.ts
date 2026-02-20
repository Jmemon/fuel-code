/**
 * `fuel-code sessions` command.
 *
 * Lists sessions in a tabular format with filtering, pagination, and JSON output.
 * Separates a data layer (fetchSessions, resolve helpers) from the presentation
 * layer (formatSessionsTable, Commander registration) so the TUI can reuse
 * the data functions independently.
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
  renderTable,
  formatDuration,
  formatCost,
  formatRelativeTime,
  formatLifecycle,
  formatEmpty,
  formatError,
  outputResult,
  truncate,
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
// Presentation Layer
// ---------------------------------------------------------------------------

/**
 * Format sessions into a table string for terminal output.
 *
 * Columns: STATUS, ID, WORKSPACE, DEVICE, DURATION, COST, STARTED, SUMMARY
 * ID column shows 8-char prefix in dimmed text.
 */
export function formatSessionsTable(sessions: Session[], hasFilters?: boolean): string {
  if (sessions.length === 0) {
    const msg = formatEmpty("sessions");
    if (hasFilters) {
      return msg + "\nTry removing filters or expanding the date range.";
    }
    return msg;
  }

  const rows = sessions.map((s) => {
    // Cast to any to access extended fields from the API response
    // (the server joins workspace_name, device_name, summary, cost_estimate_usd, tags)
    const ext = s as any;
    return [
      formatLifecycle(s.lifecycle),
      pc.dim(s.id.slice(0, 8)),
      ext.workspace_name ?? s.workspace_id,
      ext.device_name ?? s.device_id,
      formatDuration(s.duration_ms),
      formatCost(ext.cost_estimate_usd ?? null),
      formatRelativeTime(s.started_at),
      ext.summary ?? ext.initial_prompt ?? pc.dim("(no summary)"),
    ];
  });

  return renderTable({
    columns: [
      { header: "STATUS" },
      { header: "ID" },
      { header: "WORKSPACE" },
      { header: "DEVICE" },
      { header: "DURATION", align: "right" },
      { header: "COST", align: "right" },
      { header: "STARTED" },
      { header: "SUMMARY" },
    ],
    rows,
  });
}

/**
 * Format a pagination footer showing the cursor for the next page.
 * Returns empty string if there is no next page.
 */
function formatPaginationFooter(cursor: string | null, total: number): string {
  if (!cursor) return "";
  return pc.dim(`\nShowing ${total} sessions. Next page: --cursor ${cursor}`);
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
    .option("--live", "Show only live (capturing) sessions")
    .option("--lifecycle <state>", "Filter by lifecycle state")
    .option("--tag <tag>", "Filter by tag")
    .option("-l, --limit <n>", "Max results (default 20)", "20")
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

    // --live implies lifecycle=capturing
    if (opts.live) {
      params.lifecycle = "capturing";
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
