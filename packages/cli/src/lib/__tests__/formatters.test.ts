/**
 * Tests for CLI output formatting utilities.
 *
 * Pure unit tests — no I/O, no mocks. Tests all formatter functions
 * for correctness with edge cases, null handling, and ANSI-aware behavior.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import pc from "picocolors";
import {
  formatDuration,
  formatCost,
  formatRelativeTime,
  formatLifecycle,
  formatNumber,
  formatTokens,
  truncate,
  stripAnsi,
  renderTable,
  formatSessionRow,
  formatWorkspaceRow,
  formatEmpty,
  formatError,
  outputResult,
} from "../formatters.js";
import { ApiError, ApiConnectionError } from "../api-client.js";

// ---------------------------------------------------------------------------
// Tests: formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("returns '-' for null", () => {
    expect(formatDuration(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(formatDuration(undefined)).toBe("-");
  });

  it("returns '-' for 0", () => {
    expect(formatDuration(0)).toBe("-");
  });

  it("returns '0s' for values under 1000ms", () => {
    expect(formatDuration(500)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
  });

  it("formats seconds correctly", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45000)).toBe("45s");
    expect(formatDuration(59999)).toBe("59s");
  });

  it("formats minutes correctly", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(300000)).toBe("5m");
    expect(formatDuration(3599999)).toBe("59m");
  });

  it("formats hours correctly", () => {
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(7200000)).toBe("2h");
    expect(formatDuration(86399999)).toBe("23h");
  });

  it("formats days correctly", () => {
    expect(formatDuration(86400000)).toBe("1d");
    expect(formatDuration(172800000)).toBe("2d");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatCost
// ---------------------------------------------------------------------------

describe("formatCost", () => {
  it("returns em dash for null", () => {
    expect(formatCost(null)).toBe("\u2014");
  });

  it("returns em dash for undefined", () => {
    expect(formatCost(undefined)).toBe("\u2014");
  });

  it("returns '$0.00' for zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("returns '<$0.01' for tiny amounts", () => {
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0.009)).toBe("<$0.01");
    expect(formatCost(0.0001)).toBe("<$0.01");
  });

  it("formats normal amounts with 2 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(123.456)).toBe("$123.46");
    expect(formatCost(0.1)).toBe("$0.10");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatRelativeTime
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  it("returns '-' for null", () => {
    expect(formatRelativeTime(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(formatRelativeTime(undefined)).toBe("-");
  });

  it("returns 'just now' for timestamps within last 60 seconds", () => {
    const now = new Date();
    expect(formatRelativeTime(now.toISOString())).toBe("just now");

    const thirtySecsAgo = new Date(now.getTime() - 30 * 1000);
    expect(formatRelativeTime(thirtySecsAgo.toISOString())).toBe("just now");
  });

  it("returns 'Nm ago' for timestamps within last hour", () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinAgo.toISOString())).toBe("5m ago");

    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    expect(formatRelativeTime(thirtyMinAgo.toISOString())).toBe("30m ago");
  });

  it("returns 'Nh ago' for timestamps within last 24 hours", () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo.toISOString())).toBe("2h ago");
  });

  it("returns 'yesterday HH:MM' for yesterday's timestamps", () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 30, 0, 0);

    const result = formatRelativeTime(yesterday.toISOString());
    expect(result).toContain("yesterday");
    expect(result).toContain("14:30");
  });

  it("returns 'DayName HH:MM' for timestamps within last 7 days", () => {
    const now = new Date();
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    threeDaysAgo.setHours(10, 15, 0, 0);

    const result = formatRelativeTime(threeDaysAgo.toISOString());
    // Should contain a short day name and time
    expect(result).toMatch(/\w{3} \d{2}:\d{2}/);
  });

  it("returns 'Mon DD' for same-year timestamps older than 7 days", () => {
    const now = new Date();
    const oldDate = new Date(now.getFullYear(), 0, 15); // Jan 15 of this year

    // Only test if it's actually more than 7 days ago
    if (now.getTime() - oldDate.getTime() > 7 * 24 * 60 * 60 * 1000) {
      const result = formatRelativeTime(oldDate.toISOString());
      expect(result).toBe("Jan 15");
    }
  });

  it("returns 'Mon DD, YYYY' for different-year timestamps", () => {
    const result = formatRelativeTime("2020-06-15T10:00:00Z");
    expect(result).toBe("Jun 15, 2020");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatLifecycle
// ---------------------------------------------------------------------------

describe("formatLifecycle", () => {
  it("formats 'detected' with dim color and circle icon", () => {
    const result = formatLifecycle("detected");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("\u25CB");
    expect(stripped).toContain("DETECTED");
  });

  it("formats 'capturing' with green color", () => {
    const result = formatLifecycle("capturing");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("\u25CF");
    expect(stripped).toContain("LIVE");
  });

  it("formats 'ended' with yellow color", () => {
    const result = formatLifecycle("ended");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("ENDED");
  });

  it("formats 'parsed' with yellow color", () => {
    const result = formatLifecycle("parsed");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("PARSED");
  });

  it("formats 'summarized' with green color", () => {
    const result = formatLifecycle("summarized");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("\u2713");
    expect(stripped).toContain("DONE");
  });

  it("formats 'archived' with dim color", () => {
    const result = formatLifecycle("archived");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("ARCHIVED");
  });

  it("formats 'failed' with red color", () => {
    const result = formatLifecycle("failed");
    const stripped = stripAnsi(result);
    expect(stripped).toContain("\u2717");
    expect(stripped).toContain("FAILED");
  });

  it("returns unknown lifecycle string as-is", () => {
    expect(formatLifecycle("unknown_state")).toBe("unknown_state");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatNumber
// ---------------------------------------------------------------------------

describe("formatNumber", () => {
  it("returns '-' for null", () => {
    expect(formatNumber(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(formatNumber(undefined)).toBe("-");
  });

  it("returns plain number for values under 1000", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(500)).toBe("500");
    expect(formatNumber(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatNumber(1000)).toBe("1K");
    expect(formatNumber(1500)).toBe("1.5K");
    expect(formatNumber(125000)).toBe("125K");
    expect(formatNumber(999999)).toBe("1000K");
  });

  it("formats millions with M suffix", () => {
    expect(formatNumber(1000000)).toBe("1M");
    expect(formatNumber(1500000)).toBe("1.5M");
    expect(formatNumber(2000000)).toBe("2M");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  it("formats basic in/out tokens", () => {
    expect(formatTokens(125000, 48000)).toBe("125K in / 48K out");
  });

  it("includes cache when provided and non-zero", () => {
    expect(formatTokens(125000, 48000, 890000)).toBe("125K in / 48K out / 890K cache");
  });

  it("omits cache when zero", () => {
    expect(formatTokens(1000, 2000, 0)).toBe("1K in / 2K out");
  });

  it("omits cache when null", () => {
    expect(formatTokens(1000, 2000, null)).toBe("1K in / 2K out");
  });

  it("handles null input tokens as 0", () => {
    expect(formatTokens(null, null)).toBe("0 in / 0 out");
  });
});

// ---------------------------------------------------------------------------
// Tests: stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    const colored = pc.red("hello");
    expect(stripAnsi(colored)).toBe("hello");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips multiple ANSI codes", () => {
    const text = pc.bold(pc.green("test"));
    expect(stripAnsi(text)).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Tests: truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long text with ellipsis", () => {
    expect(truncate("hello world!", 8)).toBe("hello...");
  });

  it("handles exact length", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("handles very short maxLen", () => {
    expect(truncate("hello", 3)).toBe("...");
    expect(truncate("hello", 2)).toBe("..");
    expect(truncate("hello", 1)).toBe(".");
  });

  it("is ANSI-aware for width calculation", () => {
    const colored = pc.red("short");
    // "short" is 5 chars visually, so maxLen=10 should not truncate
    expect(stripAnsi(truncate(colored, 10))).toBe("short");
  });
});

// ---------------------------------------------------------------------------
// Tests: renderTable
// ---------------------------------------------------------------------------

describe("renderTable", () => {
  it("renders header and rows with aligned columns", () => {
    const result = renderTable({
      columns: [
        { header: "NAME" },
        { header: "COUNT" },
      ],
      rows: [
        ["alpha", "10"],
        ["beta-long-name", "5"],
      ],
    });

    const lines = result.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    // All lines should have consistent width
    expect(stripAnsi(lines[0]).length).toBe(stripAnsi(lines[1]).length);
  });

  it("handles empty rows (just renders header)", () => {
    const result = renderTable({
      columns: [{ header: "NAME" }, { header: "VALUE" }],
      rows: [],
    });

    expect(result).toContain("NAME");
    expect(result).toContain("VALUE");
  });

  it("respects right alignment", () => {
    const result = renderTable({
      columns: [
        { header: "NAME" },
        { header: "COUNT", align: "right" },
      ],
      rows: [["test", "42"]],
    });

    // The "42" should be right-aligned (padded on the left)
    const lines = result.split("\n");
    const dataLine = stripAnsi(lines[1]);
    // COUNT column should have leading spaces before "42"
    expect(dataLine).toContain("  42");
  });

  it("respects maxWidth by truncating widest columns", () => {
    const result = renderTable({
      columns: [
        { header: "SHORT" },
        { header: "VERY_LONG_COLUMN" },
      ],
      rows: [["a", "this is a very long value that should be truncated"]],
      maxWidth: 40,
    });

    const lines = result.split("\n");
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
    }
  });

  it("handles ANSI-colored cell values without misalignment", () => {
    const result = renderTable({
      columns: [{ header: "STATUS" }, { header: "NAME" }],
      rows: [
        [pc.green("OK"), "server-1"],
        [pc.red("FAIL"), "server-2"],
      ],
    });

    const lines = result.split("\n");
    // Plain text widths should be consistent across rows
    const widths = lines.map((l) => stripAnsi(l).length);
    expect(widths[1]).toBe(widths[2]);
  });

  it("respects minWidth on columns", () => {
    const result = renderTable({
      columns: [
        { header: "ID", minWidth: 10 },
        { header: "V" },
      ],
      rows: [["1", "x"]],
    });

    const lines = result.split("\n");
    const headerPlain = stripAnsi(lines[0]);
    // The first column should be at least 10 chars wide
    const firstColEnd = headerPlain.indexOf("V");
    expect(firstColEnd).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatSessionRow
// ---------------------------------------------------------------------------

describe("formatSessionRow", () => {
  it("returns array with 7 elements", () => {
    const row = formatSessionRow({
      lifecycle: "capturing",
      workspace_name: "my-repo",
      device_name: "macbook",
      duration_ms: 3600000,
      cost_usd: 1.5,
      started_at: "2020-01-01T00:00:00Z",
      summary: "Fixed a bug",
    });

    expect(row).toHaveLength(7);
  });

  it("formats lifecycle state", () => {
    const row = formatSessionRow({
      lifecycle: "capturing",
      duration_ms: null,
      started_at: new Date().toISOString(),
    });

    expect(stripAnsi(row[0])).toContain("LIVE");
  });

  it("falls back to workspace_id when workspace_name is missing", () => {
    const row = formatSessionRow({
      lifecycle: "ended",
      workspace_id: "ws-001",
      duration_ms: 1000,
      started_at: new Date().toISOString(),
    });

    expect(row[1]).toBe("ws-001");
  });

  it("shows (no summary) when summary is null", () => {
    const row = formatSessionRow({
      lifecycle: "ended",
      duration_ms: 1000,
      started_at: new Date().toISOString(),
      summary: null,
    });

    expect(stripAnsi(row[6])).toBe("(no summary)");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatWorkspaceRow
// ---------------------------------------------------------------------------

describe("formatWorkspaceRow", () => {
  it("returns array with 6 elements", () => {
    const row = formatWorkspaceRow({
      display_name: "my-repo",
      session_count: 10,
      active_session_count: 2,
      device_count: 3,
      total_cost_usd: 5.5,
      last_activity_at: "2020-01-01T00:00:00Z",
    });

    expect(row).toHaveLength(6);
    expect(row[0]).toBe("my-repo");
    expect(row[1]).toBe("10");
    expect(row[3]).toBe("3");
  });

  it("highlights active sessions in green when > 0", () => {
    const row = formatWorkspaceRow({
      display_name: "repo",
      session_count: 5,
      active_session_count: 2,
      device_count: 1,
      total_cost_usd: 0,
      last_activity_at: null,
    });

    // The visible text should be "2" regardless of color support
    expect(stripAnsi(row[2])).toBe("2");
    // Verify it went through pc.green (which is a no-op when colors are off)
    expect(row[2]).toBe(pc.green("2"));
  });

  it("shows '0' without color for zero active sessions", () => {
    const row = formatWorkspaceRow({
      display_name: "repo",
      session_count: 5,
      active_session_count: 0,
      device_count: 1,
      total_cost_usd: 0,
      last_activity_at: null,
    });

    expect(row[2]).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatEmpty
// ---------------------------------------------------------------------------

describe("formatEmpty", () => {
  it("returns dimmed message with entity name", () => {
    const result = formatEmpty("sessions");
    expect(stripAnsi(result)).toBe("No sessions found.");
  });

  it("works with different entity names", () => {
    expect(stripAnsi(formatEmpty("workspaces"))).toBe("No workspaces found.");
    expect(stripAnsi(formatEmpty("devices"))).toBe("No devices found.");
  });
});

// ---------------------------------------------------------------------------
// Tests: formatError
// ---------------------------------------------------------------------------

describe("formatError", () => {
  it("formats ApiError 401 as authentication message", () => {
    const err = new ApiError("unauthorized", 401);
    const result = formatError(err);
    expect(stripAnsi(result)).toContain("Authentication failed");
  });

  it("formats ApiError 404 with not found message", () => {
    const err = new ApiError("session not found", 404);
    const result = formatError(err);
    expect(stripAnsi(result)).toContain("Not found");
  });

  it("formats generic ApiError with status code", () => {
    const err = new ApiError("server error", 500);
    const result = formatError(err);
    expect(stripAnsi(result)).toContain("500");
  });

  it("formats ApiConnectionError as connection failure", () => {
    const err = new ApiConnectionError("ECONNREFUSED");
    const result = formatError(err);
    expect(stripAnsi(result)).toContain("Connection failed");
  });

  it("formats generic Error", () => {
    const err = new Error("something broke");
    const result = formatError(err);
    expect(stripAnsi(result)).toContain("something broke");
  });

  it("formats non-Error values", () => {
    const result = formatError("string error");
    expect(stripAnsi(result)).toContain("string error");
  });
});

// ---------------------------------------------------------------------------
// Tests: outputResult
// ---------------------------------------------------------------------------

describe("outputResult", () => {
  let writtenData: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    writtenData = "";
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writtenData += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("outputs JSON when json=true", () => {
    const data = { name: "test", count: 42 };
    outputResult(data, {
      json: true,
      format: () => "formatted",
    });

    const parsed = JSON.parse(writtenData.trim());
    expect(parsed.name).toBe("test");
    expect(parsed.count).toBe(42);
  });

  it("outputs formatted text when json=false", () => {
    outputResult("hello", {
      json: false,
      format: (d) => `Formatted: ${d}`,
    });

    expect(writtenData.trim()).toBe("Formatted: hello");
  });

  it("defaults to formatted output when json is undefined", () => {
    outputResult(123, {
      format: (d) => `Number: ${d}`,
    });

    expect(writtenData.trim()).toBe("Number: 123");
  });
});
