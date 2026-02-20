/**
 * Tests for the `fuel-code timeline` command.
 *
 * Uses Bun.serve() as a mock HTTP server for real HTTP round-trips through
 * FuelApiClient. Tests the data layer (fetchTimeline, parseRelativeDate),
 * presentation layer (formatTimeline), and output formatting.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "bun";
import { FuelApiClient } from "../../lib/api-client.js";
import { stripAnsi } from "../../lib/formatters.js";
import {
  fetchTimeline,
  formatTimeline,
  parseRelativeDate,
  type FetchTimelineParams,
} from "../timeline.js";
import type {
  TimelineResponse,
  TimelineSessionItem,
  TimelineOrphanItem,
} from "../../lib/api-client.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server
// ---------------------------------------------------------------------------

let server: Server;
let serverPort: number;
let lastRequestUrl: string;
let nextResponse: { status: number; body: unknown } = {
  status: 200,
  body: {},
};

function mockResponse(status: number, body: unknown) {
  nextResponse = { status, body };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      lastRequestUrl = url.pathname + url.search;

      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  serverPort = server.port;
});

afterAll(() => {
  server.stop();
});

function makeClient(): FuelApiClient {
  return new FuelApiClient({
    baseUrl: `http://localhost:${serverPort}`,
    apiKey: "test-key",
    timeout: 5000,
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSessionItem(overrides?: Partial<TimelineSessionItem>): TimelineSessionItem {
  return {
    type: "session",
    session: {
      id: "sess-001",
      workspace_id: "ws-001",
      workspace_name: "fuel-code",
      device_id: "dev-001",
      device_name: "macbook",
      lifecycle: "summarized",
      started_at: "2025-06-15T10:00:00Z",
      ended_at: "2025-06-15T11:30:00Z",
      duration_ms: 5400000,
      summary: "Built user auth flow",
      cost_estimate_usd: 1.50,
      total_messages: 25,
      tags: ["feature"],
    },
    git_activity: [],
    ...overrides,
  };
}

function makeOrphanItem(overrides?: Partial<TimelineOrphanItem>): TimelineOrphanItem {
  return {
    type: "git_activity",
    workspace_id: "ws-001",
    workspace_name: "fuel-code",
    device_id: "dev-001",
    device_name: "macbook",
    git_activity: [
      {
        id: "git-001",
        type: "commit",
        branch: "main",
        commit_sha: "abc1234567890",
        message: "fix: resolve login bug",
        files_changed: 3,
        timestamp: "2025-06-15T09:00:00Z",
        data: {},
      },
    ],
    started_at: "2025-06-15T09:00:00Z",
    ...overrides,
  };
}

function makeTimelineResponse(
  items: (TimelineSessionItem | TimelineOrphanItem)[] = [],
): TimelineResponse {
  return {
    items,
    next_cursor: null,
    has_more: false,
  };
}

// ---------------------------------------------------------------------------
// parseRelativeDate tests
// ---------------------------------------------------------------------------

describe("parseRelativeDate", () => {
  it("parses -3d as 3 days ago", () => {
    const result = parseRelativeDate("-3d");
    const parsed = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 3);

    // Allow 1 second tolerance
    expect(Math.abs(parsed.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("parses -1w as 7 days ago", () => {
    const result = parseRelativeDate("-1w");
    const parsed = new Date(result);
    const expected = new Date();
    expected.setDate(expected.getDate() - 7);

    expect(Math.abs(parsed.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("parses -12h as 12 hours ago", () => {
    const result = parseRelativeDate("-12h");
    const parsed = new Date(result);
    const expected = new Date();
    expected.setHours(expected.getHours() - 12);

    expect(Math.abs(parsed.getTime() - expected.getTime())).toBeLessThan(1000);
  });

  it("returns ISO date strings as-is", () => {
    const iso = "2025-06-15T10:00:00Z";
    expect(parseRelativeDate(iso)).toBe(iso);
  });

  it("returns non-matching strings as-is", () => {
    const date = "2025-06-15";
    expect(parseRelativeDate(date)).toBe(date);
  });

  it("parses -0d as current time", () => {
    const result = parseRelativeDate("-0d");
    const parsed = new Date(result);
    const now = new Date();
    expect(Math.abs(parsed.getTime() - now.getTime())).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// fetchTimeline tests (data layer)
// ---------------------------------------------------------------------------

describe("fetchTimeline", () => {
  it("calls GET /api/timeline and returns TimelineResponse", async () => {
    const sessionItem = makeSessionItem();
    mockResponse(200, {
      items: [sessionItem],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchTimeline(makeClient(), {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].type).toBe("session");
    expect(result.has_more).toBe(false);
  });

  it("passes workspaceId as workspace_id query param", async () => {
    mockResponse(200, makeTimelineResponse());

    await fetchTimeline(makeClient(), { workspaceId: "ws-123" });
    expect(lastRequestUrl).toContain("workspace_id=ws-123");
  });

  it("passes after and before query params", async () => {
    mockResponse(200, makeTimelineResponse());

    await fetchTimeline(makeClient(), {
      after: "2025-01-01",
      before: "2025-12-31",
    });
    expect(lastRequestUrl).toContain("after=2025-01-01");
    expect(lastRequestUrl).toContain("before=2025-12-31");
  });

  it("returns empty items array", async () => {
    mockResponse(200, makeTimelineResponse());

    const result = await fetchTimeline(makeClient(), {});
    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatTimeline tests (presentation layer)
// ---------------------------------------------------------------------------

describe("formatTimeline", () => {
  it("shows empty state when no items", () => {
    const data = makeTimelineResponse();
    const output = formatTimeline(data);
    const plain = stripAnsi(output);
    expect(plain).toContain("No activity found for today");
  });

  it("renders session with lifecycle, workspace@device, duration, cost", () => {
    const sessionItem = makeSessionItem();
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("fuel-code \u00b7 macbook");
    expect(plain).toContain("1h30m");
    expect(plain).toContain("$1.50");
  });

  it("renders session summary", () => {
    const sessionItem = makeSessionItem();
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("Built user auth flow");
  });

  it("renders git commits within a session", () => {
    const sessionItem = makeSessionItem({
      git_activity: [
        {
          id: "g-1",
          type: "commit",
          branch: "main",
          commit_sha: "abc1234567890",
          message: "add login endpoint",
          files_changed: 5,
          timestamp: "2025-06-15T10:30:00Z",
          data: {},
        },
        {
          id: "g-2",
          type: "commit",
          branch: "main",
          commit_sha: "def5678901234",
          message: "add tests for login",
          files_changed: 3,
          timestamp: "2025-06-15T10:45:00Z",
          data: {},
        },
      ],
    });
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("abc1234");
    expect(plain).toContain("add login endpoint");
    expect(plain).toContain("def5678");
    expect(plain).toContain("add tests for login");
  });

  it("renders orphan git events", () => {
    const orphanItem = makeOrphanItem();
    const data = makeTimelineResponse([orphanItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("git");
    expect(plain).toContain("fuel-code \u00b7 macbook");
    expect(plain).toContain("abc1234");
    expect(plain).toContain("fix: resolve login bug");
  });

  it("renders date header for items", () => {
    // Use a fixed past date to avoid "Today" label
    const sessionItem = makeSessionItem();
    sessionItem.session.started_at = "2024-03-15T10:00:00Z";
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    // Should contain a date header (day name or "Today"/"Yesterday")
    expect(plain).toMatch(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Today|Yesterday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
  });

  it("renders footer stats with session count, duration, cost, commits", () => {
    const sessionItem = makeSessionItem({
      git_activity: [
        {
          id: "g-1",
          type: "commit",
          branch: "main",
          commit_sha: "abc1234567890",
          message: "test commit",
          files_changed: 1,
          timestamp: "2025-06-15T10:30:00Z",
          data: {},
        },
      ],
    });
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("1 session");
    expect(plain).toContain("1h30m");
    expect(plain).toContain("$1.50");
    expect(plain).toContain("1 commit");
  });

  it("pluralizes footer stats correctly for multiple items", () => {
    const s1 = makeSessionItem();
    s1.session.started_at = "2025-06-15T10:00:00Z";
    const s2 = makeSessionItem();
    s2.session.id = "sess-002";
    s2.session.started_at = "2025-06-15T14:00:00Z";
    s2.session.duration_ms = 3600000;
    s2.session.cost_estimate_usd = 0.75;
    s2.git_activity = [
      {
        id: "g-1",
        type: "commit",
        branch: "main",
        commit_sha: "aaa1111111111",
        message: "commit 1",
        files_changed: 1,
        timestamp: "2025-06-15T14:30:00Z",
        data: {},
      },
      {
        id: "g-2",
        type: "commit",
        branch: "main",
        commit_sha: "bbb2222222222",
        message: "commit 2",
        files_changed: 1,
        timestamp: "2025-06-15T14:45:00Z",
        data: {},
      },
    ];

    const data = makeTimelineResponse([s1, s2]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("2 sessions");
    expect(plain).toContain("2 commits");
  });

  it("groups items by date with separate headers", () => {
    const s1 = makeSessionItem();
    s1.session.started_at = "2024-03-15T10:00:00Z";

    const s2 = makeSessionItem();
    s2.session.id = "sess-002";
    s2.session.started_at = "2024-03-16T14:00:00Z";

    const data = makeTimelineResponse([s1, s2]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    // Should have at least two date-like headers for two different dates
    const lines = plain.split("\n").filter((l) => l.trim().length > 0);
    // Count non-indented, non-stat lines that look like date headers (they will contain month names)
    const dateHeaders = lines.filter(
      (l) => !l.startsWith("  ") && /(?:Mar|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(l),
    );
    expect(dateHeaders.length).toBeGreaterThanOrEqual(2);
  });

  it("renders tool usage summary for non-commit git events", () => {
    const sessionItem = makeSessionItem({
      git_activity: [
        {
          id: "g-1",
          type: "push",
          branch: "main",
          commit_sha: null,
          message: null,
          files_changed: null,
          timestamp: "2025-06-15T10:30:00Z",
          data: {},
        },
        {
          id: "g-2",
          type: "push",
          branch: "main",
          commit_sha: null,
          message: null,
          files_changed: null,
          timestamp: "2025-06-15T10:35:00Z",
          data: {},
        },
      ],
    });
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("2 pushs");
  });

  it("renders single-day timeline with date header", () => {
    const sessionItem = makeSessionItem();
    const data = makeTimelineResponse([sessionItem]);
    const output = formatTimeline(data);
    // Even with a single date, a header should be present
    expect(output.length).toBeGreaterThan(0);
    // The output should have content beyond just the empty state
    const plain = stripAnsi(output);
    expect(plain).not.toContain("No activity found");
  });
});

// ---------------------------------------------------------------------------
// JSON output tests
// ---------------------------------------------------------------------------

describe("timeline — JSON output", () => {
  it("fetchTimeline result is JSON-serializable", async () => {
    const sessionItem = makeSessionItem();
    mockResponse(200, {
      items: [sessionItem],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchTimeline(makeClient(), {});
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.has_more).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Week/after/before date handling tests
// ---------------------------------------------------------------------------

describe("timeline — date handling", () => {
  it("--after with relative date parses correctly", () => {
    const iso = parseRelativeDate("-3d");
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("--after with ISO date passes through", () => {
    const iso = parseRelativeDate("2025-06-01T00:00:00Z");
    expect(iso).toBe("2025-06-01T00:00:00Z");
  });
});
