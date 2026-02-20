/**
 * Output formatting utilities for the fuel-code CLI.
 *
 * Provides consistent, terminal-friendly formatting for durations, costs,
 * relative times, lifecycle states, tables, and structured output. All color
 * output uses picocolors (lightweight, no dependencies).
 *
 * Used by every CLI query command and TUI view to render data consistently.
 */

import pc from "picocolors";
import type { SessionLifecycle } from "@fuel-code/shared";
import { ApiError, ApiConnectionError, type WorkspaceSummary } from "./api-client.js";

// ---------------------------------------------------------------------------
// ANSI Utilities
// ---------------------------------------------------------------------------

/** Regex to match ANSI escape sequences (colors, cursor movement, etc.) */
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Strip all ANSI escape codes from a string */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

/**
 * Calculate the visible (display) width of a string, ignoring ANSI codes.
 * This is critical for correct table column alignment in terminal output.
 */
function displayWidth(str: string): number {
  return stripAnsi(str).length;
}

// ---------------------------------------------------------------------------
// Duration Formatting
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Returns "-" for null/undefined/0 values.
 * Uses the largest sensible unit: s, m, h, d.
 *
 * Examples: "0s", "45s", "12m", "2h", "3d"
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms === 0) return "-";
  if (ms < 1000) return "0s";

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ---------------------------------------------------------------------------
// Cost Formatting
// ---------------------------------------------------------------------------

/**
 * Format a USD cost value for display.
 *
 * Returns "\u2014" (em dash) for null/undefined.
 * Returns "$0.00" for exactly 0.
 * Returns "<$0.01" for positive values under a cent.
 * Otherwise returns "$X.XX" with 2 decimal places.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "\u2014";
  if (usd === 0) return "$0.00";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Relative Time Formatting
// ---------------------------------------------------------------------------

/**
 * Format an ISO-8601 timestamp as a relative time string.
 *
 * Bands:
 *   - < 60s:        "just now"
 *   - < 60m:        "Nm ago"
 *   - < 24h:        "Nh ago"
 *   - yesterday:    "yesterday HH:MM"
 *   - < 7d:         "DayName HH:MM"
 *   - same year:    "Mon DD"
 *   - older:        "Mon DD, YYYY"
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "-";

  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;

  // Check if it was yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    const time = formatTime(date);
    return `yesterday ${time}`;
  }

  // Within the last 7 days: show day name + time
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
    const time = formatTime(date);
    return `${dayName} ${time}`;
  }

  // Same year: "Mon DD"
  const monthName = date.toLocaleDateString("en-US", { month: "short" });
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${monthName} ${day}`;
  }

  // Older: "Mon DD, YYYY"
  return `${monthName} ${day}, ${date.getFullYear()}`;
}

/** Format a Date to "HH:MM" in 24-hour format */
function formatTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ---------------------------------------------------------------------------
// Lifecycle Formatting
// ---------------------------------------------------------------------------

/** Lifecycle display config: icon and color function */
interface LifecycleStyle {
  icon: string;
  label: string;
  color: (s: string) => string;
}

const LIFECYCLE_STYLES: Record<SessionLifecycle, LifecycleStyle> = {
  detected:    { icon: "\u25CB", label: "DETECTED",  color: pc.dim },
  capturing:   { icon: "\u25CF", label: "LIVE",      color: pc.green },
  ended:       { icon: "\u25D0", label: "ENDED",     color: pc.yellow },
  parsed:      { icon: "\u25D1", label: "PARSED",    color: pc.yellow },
  summarized:  { icon: "\u2713", label: "DONE",      color: pc.green },
  archived:    { icon: "\u25AA", label: "ARCHIVED",  color: pc.dim },
  failed:      { icon: "\u2717", label: "FAILED",    color: pc.red },
};

/**
 * Format a session lifecycle state with colored icon and label.
 *
 * Examples: dim("○ DETECTED"), green("● LIVE"), red("✗ FAILED")
 */
export function formatLifecycle(lifecycle: string): string {
  const style = LIFECYCLE_STYLES[lifecycle as SessionLifecycle];
  if (!style) return lifecycle;
  return style.color(`${style.icon} ${style.label}`);
}

// ---------------------------------------------------------------------------
// Number and Token Formatting
// ---------------------------------------------------------------------------

/**
 * Format a number with K/M suffixes for readability.
 *
 * 500 -> "500", 1500 -> "1.5K", 125000 -> "125K", 1500000 -> "1.5M"
 */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    // Show decimal only if meaningful (e.g., 1.5K but not 2.0K)
    return k % 1 === 0 ? `${k}K` : `${parseFloat(k.toFixed(1))}K`;
  }
  const m = n / 1_000_000;
  return m % 1 === 0 ? `${m}M` : `${parseFloat(m.toFixed(1))}M`;
}

/**
 * Format token counts for display.
 *
 * Example: "125K in / 48K out / 890K cache"
 * Omits the cache segment if cache is null/undefined/0.
 */
export function formatTokens(
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  cache?: number | null,
): string {
  const inStr = formatNumber(tokensIn ?? 0);
  const outStr = formatNumber(tokensOut ?? 0);
  let result = `${inStr} in / ${outStr} out`;
  if (cache && cache > 0) {
    result += ` / ${formatNumber(cache)} cache`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Text Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a string to maxLen characters, appending "..." if exceeded.
 * ANSI-aware: measures visible width, not byte length.
 */
export function truncate(text: string, maxLen: number): string {
  if (displayWidth(text) <= maxLen) return text;
  if (maxLen <= 3) return "...".slice(0, maxLen);

  // Strip ANSI, truncate the plain text, then add "..."
  const plain = stripAnsi(text);
  return plain.slice(0, maxLen - 3) + "...";
}

// ---------------------------------------------------------------------------
// Table Rendering
// ---------------------------------------------------------------------------

/** Column definition for renderTable */
interface ColumnDef {
  /** Column header label */
  header: string;
  /** Minimum column width (defaults to header length) */
  minWidth?: number;
  /** Alignment: "left" (default) or "right" */
  align?: "left" | "right";
}

/**
 * Render data as an aligned, auto-sized table string for terminal output.
 *
 * Features:
 *   - Auto-sizes columns based on content width
 *   - ANSI-aware width calculation (colored text won't misalign)
 *   - Respects maxWidth by truncating the widest columns first
 *   - Column gap is 2 spaces
 */
export function renderTable(opts: {
  columns: ColumnDef[];
  rows: string[][];
  maxWidth?: number;
}): string {
  const { columns, rows, maxWidth } = opts;
  const colGap = 2;
  const numCols = columns.length;

  if (rows.length === 0) {
    // Just render the header
    return columns.map((c) => c.header).join(" ".repeat(colGap));
  }

  // Calculate the natural width of each column (max of header and all row cells)
  const colWidths: number[] = columns.map((col, i) => {
    const headerWidth = displayWidth(col.header);
    const minWidth = col.minWidth ?? headerWidth;
    let maxCellWidth = 0;
    for (const row of rows) {
      const cellWidth = displayWidth(row[i] ?? "");
      if (cellWidth > maxCellWidth) maxCellWidth = cellWidth;
    }
    return Math.max(minWidth, headerWidth, maxCellWidth);
  });

  // If maxWidth is specified, shrink columns to fit
  if (maxWidth) {
    const totalGap = colGap * (numCols - 1);
    let totalWidth = colWidths.reduce((a, b) => a + b, 0) + totalGap;

    // Iteratively shrink the widest column until we fit
    while (totalWidth > maxWidth) {
      const maxIdx = colWidths.indexOf(Math.max(...colWidths));
      const excess = totalWidth - maxWidth;
      const shrinkBy = Math.min(excess, colWidths[maxIdx] - 3); // Never shrink below 3
      if (shrinkBy <= 0) break;
      colWidths[maxIdx] -= shrinkBy;
      totalWidth -= shrinkBy;
    }
  }

  // Pad/truncate a cell value to the target width
  function formatCell(value: string, colIdx: number): string {
    const width = colWidths[colIdx];
    const visWidth = displayWidth(value);
    const align = columns[colIdx].align ?? "left";

    if (visWidth > width) {
      // Need to truncate
      return truncate(value, width);
    }

    const padding = " ".repeat(width - visWidth);
    return align === "right" ? padding + value : value + padding;
  }

  // Build header line
  const headerLine = columns
    .map((col, i) => formatCell(pc.dim(col.header), i))
    .join(" ".repeat(colGap));

  // Build data rows
  const dataLines = rows.map((row) =>
    row.map((cell, i) => formatCell(cell ?? "", i)).join(" ".repeat(colGap)),
  );

  return [headerLine, ...dataLines].join("\n");
}

// ---------------------------------------------------------------------------
// Session and Workspace Row Formatters
// ---------------------------------------------------------------------------

/** Session data shape expected by formatSessionRow */
interface SessionRowData {
  lifecycle: string;
  workspace_name?: string;
  workspace_id?: string;
  device_name?: string;
  device_id?: string;
  duration_ms: number | null;
  cost_usd?: number | null;
  started_at: string;
  summary?: string | null;
}

/**
 * Format a session into a table row array.
 * Returns: [status, workspace, device, duration, cost, started, summary]
 */
export function formatSessionRow(session: SessionRowData): string[] {
  return [
    formatLifecycle(session.lifecycle),
    session.workspace_name ?? session.workspace_id ?? "-",
    session.device_name ?? session.device_id ?? "-",
    formatDuration(session.duration_ms),
    formatCost(session.cost_usd ?? null),
    formatRelativeTime(session.started_at),
    session.summary ?? pc.dim("(no summary)"),
  ];
}

/** Workspace data shape expected by formatWorkspaceRow */
interface WorkspaceRowData {
  display_name: string;
  session_count: number;
  active_session_count: number;
  device_count: number;
  total_cost_usd: number;
  last_activity_at: string | null;
}

/**
 * Format a workspace into a table row array.
 * Returns: [name, sessions, active, devices, cost, last_activity]
 */
export function formatWorkspaceRow(workspace: WorkspaceRowData): string[] {
  return [
    workspace.display_name,
    String(workspace.session_count),
    workspace.active_session_count > 0
      ? pc.green(String(workspace.active_session_count))
      : "0",
    String(workspace.device_count),
    formatCost(workspace.total_cost_usd),
    formatRelativeTime(workspace.last_activity_at),
  ];
}

// ---------------------------------------------------------------------------
// Empty State and Error Formatting
// ---------------------------------------------------------------------------

/**
 * Format an empty state message for when no data is found.
 * Returns a dimmed "No {entity} found." string.
 */
export function formatEmpty(entity: string): string {
  return pc.dim(`No ${entity} found.`);
}

/**
 * Format an error for user-facing display.
 *
 * Handles ApiError (HTTP errors), ApiConnectionError (network failures),
 * and generic Error instances with appropriate messaging.
 */
export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 401) {
      return pc.red("Authentication failed. Check your API key.");
    }
    if (error.statusCode === 404) {
      return pc.red(`Not found: ${error.message}`);
    }
    return pc.red(`API error (${error.statusCode}): ${error.message}`);
  }

  if (error instanceof ApiConnectionError) {
    return pc.red(`Connection failed: ${error.message}`);
  }

  if (error instanceof Error) {
    return pc.red(`Error: ${error.message}`);
  }

  return pc.red(`Error: ${String(error)}`);
}

// ---------------------------------------------------------------------------
// Output Result Helper
// ---------------------------------------------------------------------------

/**
 * Output structured data to stdout as either JSON or formatted text.
 *
 * When json=true, outputs JSON.stringify with 2-space indent.
 * Otherwise, calls the provided format function and writes its result.
 */
export function outputResult<T>(
  data: T,
  opts: { json?: boolean; format: (data: T) => string },
): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(opts.format(data) + "\n");
  }
}
