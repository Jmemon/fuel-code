/**
 * Output formatting utilities for the fuel-code CLI.
 *
 * Provides consistent, terminal-friendly formatting for durations, costs,
 * relative times, lifecycle states, tables, and structured output. All color
 * output uses picocolors (lightweight, no dependencies).
 *
 * Used by every CLI query command to render data consistently.
 * NOT used by TUI (TUI renders via Ink components).
 */

import pc from "picocolors";
import type { SessionLifecycle } from "@fuel-code/shared";
import { ApiError, ApiConnectionError } from "./api-client.js";

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
 * Format a duration in milliseconds to a human-readable compound string.
 *
 * Returns "-" for null/undefined/0 values.
 * Uses compound units for readability: "1h22m", "1d1h", "12m"
 *
 * Examples: "0s", "45s", "12m", "1h22m", "1d1h"
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms === 0) return "-";
  if (ms < 1000) return "0s";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d${hours % 24 > 0 ? `${hours % 24}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes % 60 > 0 ? `${String(minutes % 60).padStart(2, "0")}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
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
 * Format an ISO-8601 timestamp as a relative or calendar string.
 *
 * Bands:
 *   - < 60s:        "just now"
 *   - < 60m:        "Nm ago"
 *   - < 24h:        "Nh ago"
 *   - yesterday:    "yesterday 3:45pm"
 *   - < 7d:         "Monday 3:45pm" (full day name)
 *   - same year:    "Feb 10"
 *   - older:        "Feb 10, 2025"
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
  if (date.toDateString() === yesterday.toDateString()) {
    return `yesterday ${formatTime(date)}`;
  }

  // Within the last 7 days: show full day name + time
  const daysAgo = Math.floor(diffHr / 24);
  if (daysAgo < 7) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return `${dayNames[date.getDay()]} ${formatTime(date)}`;
  }

  // Same year: "Feb 10"
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (date.getFullYear() === now.getFullYear()) {
    return `${months[date.getMonth()]} ${date.getDate()}`;
  }

  // Different year: "Feb 10, 2025"
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** Format a Date to 12-hour am/pm format: "3:45pm" */
function formatTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${hours}:${String(minutes).padStart(2, "0")}${ampm}`;
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
  parsed:      { icon: "\u25CC", label: "PARSING",   color: pc.yellow },
  summarized:  { icon: "\u2713", label: "DONE",      color: pc.green },
  archived:    { icon: "\u25AA", label: "ARCHIVED",  color: pc.dim },
  failed:      { icon: "\u2717", label: "FAIL",      color: pc.red },
};

/**
 * Format a session lifecycle state with colored icon and label.
 * Unknown lifecycle values are returned as dimmed uppercase.
 *
 * Examples: dim("○ DETECTED"), green("● LIVE"), red("✗ FAILED")
 */
export function formatLifecycle(lifecycle: string): string {
  const style = LIFECYCLE_STYLES[lifecycle as SessionLifecycle];
  if (!style) return pc.dim(lifecycle.toUpperCase());
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
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
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
  const parts = [
    `${formatNumber(tokensIn ?? 0)} in`,
    `${formatNumber(tokensOut ?? 0)} out`,
  ];
  if (cache && cache > 0) {
    parts.push(`${formatNumber(cache)} cache`);
  }
  return parts.join(" / ");
}

// ---------------------------------------------------------------------------
// Text Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a string to maxLen characters, appending "..." if exceeded.
 * ANSI-aware: measures visible width, not byte length.
 * When maxLen < 4, returns text.slice(0, maxLen) (no room for ellipsis).
 */
export function truncate(text: string, maxLen: number): string {
  if (maxLen < 4) return text.slice(0, maxLen);
  const visible = stripAnsi(text);
  if (visible.length <= maxLen) return text;
  // Strip ANSI, truncate the plain text, then add "..."
  return visible.slice(0, maxLen - 3) + "...";
}

// ---------------------------------------------------------------------------
// Table Rendering
// ---------------------------------------------------------------------------

/** Column definition for renderTable */
export interface ColumnDef {
  /** Column header label */
  header: string;
  /** Fixed width (truncates/pads). If omitted, auto-sized. */
  width?: number;
  /** Alignment: "left" (default) or "right" */
  align?: "left" | "right";
}

/**
 * Render data as an aligned, auto-sized table string for terminal output.
 *
 * Features:
 *   - Auto-sizes columns based on content width
 *   - ANSI-aware width calculation (colored text won't misalign)
 *   - Respects maxWidth by shrinking the widest columns first
 *   - Column gap is 2 spaces
 *   - Headers rendered with pc.bold()
 *   - Returns empty string when rows is empty
 */
export function renderTable(opts: {
  columns: ColumnDef[];
  rows: string[][];
  maxWidth?: number;
}): string {
  const { columns, rows, maxWidth = process.stdout.columns || 120 } = opts;

  if (rows.length === 0) {
    return "";
  }

  const gap = 2;

  // Calculate column widths: start with header lengths, expand to widest cell
  const widths = columns.map((col, i) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxCell = Math.max(headerLen, ...rows.map((row) => displayWidth(row[i] ?? "")));
    return maxCell;
  });

  // If total width exceeds maxWidth, shrink the widest column(s)
  const totalGaps = (columns.length - 1) * gap;
  let totalWidth = widths.reduce((a, b) => a + b, 0) + totalGaps;
  while (totalWidth > maxWidth && widths.some((w) => w > 10)) {
    const maxIdx = widths.indexOf(Math.max(...widths));
    widths[maxIdx]--;
    totalWidth--;
  }

  // Pad/align a string to a given width
  function pad(str: string, width: number, align: "left" | "right"): string {
    const visibleLen = displayWidth(str);
    if (visibleLen >= width) return str;
    const padding = " ".repeat(width - visibleLen);
    return align === "right" ? padding + str : str + padding;
  }

  // Render header row with bold styling
  const headerLine = columns
    .map((col, i) => pc.bold(pad(col.header, widths[i], col.align ?? "left")))
    .join("  ");

  // Render data rows
  const dataLines = rows.map((row) =>
    columns
      .map((col, i) => {
        const value = row[i] ?? "";
        return pad(truncate(value, widths[i]), widths[i], col.align ?? "left");
      })
      .join("  "),
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
  cost_estimate_usd?: number | null;
  started_at: string;
  summary?: string | null;
  initial_prompt?: string | null;
}

/**
 * Format a session into a table row array.
 * Returns: [status, workspace, device, duration, cost, started, summary]
 * Uses cost_estimate_usd field and falls back through summary -> initial_prompt -> (no summary)
 */
export function formatSessionRow(session: SessionRowData): string[] {
  return [
    formatLifecycle(session.lifecycle),
    session.workspace_name ?? session.workspace_id ?? "-",
    session.device_name ?? session.device_id ?? "-",
    formatDuration(session.duration_ms),
    formatCost(session.cost_estimate_usd ?? null),
    formatRelativeTime(session.started_at),
    session.summary ?? session.initial_prompt ?? pc.dim("(no summary)"),
  ];
}

/** Workspace data shape expected by formatWorkspaceRow */
interface WorkspaceRowData {
  display_name: string;
  session_count: number;
  active_session_count: number;
  device_count: number;
  total_cost_usd: number;
  last_session_at: string | null;
}

/**
 * Format a workspace into a table row array.
 * Returns: [name, sessions, active, devices, cost, last_activity]
 * Uses last_session_at field. Null last_session_at renders as dimmed "never".
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
    workspace.last_session_at
      ? formatRelativeTime(workspace.last_session_at)
      : pc.dim("never"),
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
 * Format an error for user-facing display (no stack traces).
 *
 * Handles ApiError (HTTP errors), ApiConnectionError (network failures),
 * and generic Error instances. Matches spec format exactly:
 *   ApiError -> "Error: <message> (HTTP <code>)"
 *   ApiConnectionError -> "Connection error: <message>"
 *   Other -> "Error: <message>"
 */
export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return pc.red(`Error: ${error.message} (HTTP ${error.statusCode})`);
  }

  if (error instanceof ApiConnectionError) {
    return pc.red(`Connection error: ${error.message}`);
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
