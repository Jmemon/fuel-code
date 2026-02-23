/**
 * Tests for the `fuel-code sessions` command.
 *
 * Uses Bun.serve() as a mock HTTP server for real HTTP round-trips through
 * FuelApiClient. Tests the data layer (fetchSessions), presentation layer
 * (formatSessionsTable), and error handling.
 *
 * stdout is captured via spyOn to assert formatted output.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from "bun:test";
import type { Server } from "bun";
import { FuelApiClient, ApiError, ApiConnectionError } from "../../lib/api-client.js";
import { stripAnsi } from "../../lib/formatters.js";
import {
  fetchSessions,
  formatSessionsTable,
  type FetchSessionsParams,
} from "../sessions.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server — route-aware for sessions + workspace/device resolution
// ---------------------------------------------------------------------------

interface MockRoute {
  status: number;
  body: unknown;
}

let server: Server;
let serverPort: number;
let lastRequestUrl: string;
let routes: Record<string, MockRoute> = {};

/** Set a mock response for a specific path prefix */
function mockRoute(pathPrefix: string, status: number, body: unknown) {
  routes[pathPrefix] = { status, body };
}

/** Reset all routes */
function resetRoutes() {
  routes = {};
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      lastRequestUrl = url.pathname + url.search;

      // Find matching route by prefix
      for (const [prefix, route] of Object.entries(routes)) {
        if (url.pathname.startsWith(prefix)) {
          return new Response(JSON.stringify(route.body), {
            status: route.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Default 404
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
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

/** Create a mock session object with extended fields matching API response */
function makeSession(overrides?: Record<string, unknown>) {
  return {
    id: "01HZSESSION0000000000001",
    workspace_id: "ws-001",
    workspace_name: "fuel-code",
    device_id: "dev-001",
    device_name: "macbook",
    lifecycle: "summarized",
    started_at: "2025-06-15T10:00:00Z",
    ended_at: "2025-06-15T11:30:00Z",
    duration_ms: 5400000,
    summary: "Implemented user auth",
    initial_prompt: "add login page",
    cost_estimate_usd: 1.23,
    tags: ["feature"],
    cc_session_id: "cc-001",
    parse_status: "completed",
    cwd: "/home/user/code",
    git_branch: "main",
    git_remote: null,
    model: "claude-4",
    transcript_path: null,
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fetchSessions tests (data layer)
// ---------------------------------------------------------------------------

describe("fetchSessions", () => {
  beforeEach(() => resetRoutes());

  it("returns sessions, cursor, and total from API", async () => {
    const session = makeSession();
    mockRoute("/api/sessions", 200, {
      sessions: [session],
      next_cursor: "cursor-abc",
      has_more: true,
    });

    const result = await fetchSessions(makeClient(), {});
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(session.id);
    expect(result.cursor).toBe("cursor-abc");
    expect(result.total).toBe(1);
  });

  it("passes limit parameter to API (default 20)", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    await fetchSessions(makeClient(), {});
    expect(lastRequestUrl).toContain("limit=20");
  });

  it("passes workspaceId and deviceId to API", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    await fetchSessions(makeClient(), {
      workspaceId: "ws-123",
      deviceId: "dev-456",
    });
    expect(lastRequestUrl).toContain("workspace_id=ws-123");
    expect(lastRequestUrl).toContain("device_id=dev-456");
  });

  it("passes lifecycle, tag, after, before, cursor parameters", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    await fetchSessions(makeClient(), {
      lifecycle: "detected,capturing",
      tag: "feature",
      after: "2025-01-01",
      before: "2025-12-31",
      cursor: "page-2",
    });

    expect(lastRequestUrl).toContain("lifecycle=detected%2Ccapturing");
    expect(lastRequestUrl).toContain("tag=feature");
    expect(lastRequestUrl).toContain("after=2025-01-01");
    expect(lastRequestUrl).toContain("before=2025-12-31");
    expect(lastRequestUrl).toContain("cursor=page-2");
  });

  it("passes custom limit", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    await fetchSessions(makeClient(), { limit: 50 });
    expect(lastRequestUrl).toContain("limit=50");
  });

  it("returns empty sessions array", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchSessions(makeClient(), {});
    expect(result.sessions).toHaveLength(0);
    expect(result.cursor).toBeNull();
    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatSessionsTable tests (presentation layer)
// ---------------------------------------------------------------------------

describe("formatSessionsTable", () => {
  it("renders empty state when no sessions", () => {
    const output = formatSessionsTable([]);
    expect(stripAnsi(output)).toContain("No sessions found");
  });

  it("appends filter hint on empty result when filters are applied", () => {
    const output = formatSessionsTable([], true);
    const plain = stripAnsi(output);
    expect(plain).toContain("No sessions found");
    expect(plain).toContain("Try removing filters or expanding the date range.");
  });

  it("does not append filter hint on empty result without filters", () => {
    const output = formatSessionsTable([], false);
    const plain = stripAnsi(output);
    expect(plain).toContain("No sessions found");
    expect(plain).not.toContain("Try removing filters");
  });

  it("renders table with STATUS, ID, WORKSPACE, DEVICE columns", () => {
    const sessions = [makeSession()] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);

    expect(plain).toContain("STATUS");
    expect(plain).toContain("ID");
    expect(plain).toContain("WORKSPACE");
    expect(plain).toContain("DEVICE");
  });

  it("renders DURATION, TOKENS, STARTED, SUMMARY columns", () => {
    const sessions = [makeSession()] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);

    expect(plain).toContain("DURATION");
    expect(plain).toContain("TOKENS");
    expect(plain).toContain("STARTED");
    expect(plain).toContain("SUMMARY");
  });

  it("shows 8-char ID prefix", () => {
    const sessions = [makeSession({ id: "01HZSESSION0000000000001" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("01HZSESS");
  });

  it("shows workspace_name not workspace_id", () => {
    const sessions = [makeSession({ workspace_name: "my-repo" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("my-repo");
  });

  it("falls back to workspace_id when workspace_name is missing", () => {
    const session = makeSession();
    delete (session as any).workspace_name;
    const sessions = [session] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("ws-001");
  });

  it("shows device_name", () => {
    const sessions = [makeSession({ device_name: "linux-box" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("linux-box");
  });

  it("shows formatted duration", () => {
    const sessions = [makeSession({ duration_ms: 5400000 })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("1h30m");
  });

  it("shows formatted tokens", () => {
    const sessions = [makeSession({ tokens_in: 125000, tokens_out: 48000 })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("125K/48K");
  });

  it("shows summary text", () => {
    const sessions = [makeSession({ summary: "Built the login page" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("Built the login page");
  });

  it("falls back to initial_prompt when no summary", () => {
    const sessions = [makeSession({ summary: null, initial_prompt: "add auth" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("add auth");
  });

  it("shows (no summary) when both summary and initial_prompt are null", () => {
    const sessions = [makeSession({ summary: null, initial_prompt: null })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("(no summary)");
  });

  it("renders lifecycle with appropriate labels", () => {
    const capturingSession = makeSession({ lifecycle: "capturing" });
    const output = formatSessionsTable([capturingSession] as any);
    const plain = stripAnsi(output);
    // "capturing" lifecycle renders as "LIVE" per formatLifecycle
    expect(plain).toContain("LIVE");
  });

  it("renders summarized lifecycle as DONE", () => {
    const sessions = [makeSession({ lifecycle: "summarized" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("DONE");
  });

  it("renders failed lifecycle as FAIL", () => {
    const sessions = [makeSession({ lifecycle: "failed" })] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("FAIL");
  });

  it("renders multiple sessions as multiple rows", () => {
    const sessions = [
      makeSession({ id: "01HZAAAA0000000000000001", summary: "First" }),
      makeSession({ id: "01HZBBBB0000000000000002", summary: "Second" }),
    ] as any;
    const output = formatSessionsTable(sessions);
    const plain = stripAnsi(output);
    expect(plain).toContain("First");
    expect(plain).toContain("Second");
  });
});

// ---------------------------------------------------------------------------
// Workspace resolution integration tests
// ---------------------------------------------------------------------------

describe("sessions — workspace resolution", () => {
  beforeEach(() => resetRoutes());

  it("resolves workspace name to ULID for filtering", async () => {
    mockRoute("/api/workspaces", 200, {
      workspaces: [
        { id: "ws-ulid", display_name: "my-project", canonical_id: "c1" },
      ],
      next_cursor: null,
      has_more: false,
    });
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    const api = makeClient();
    const { resolveWorkspaceName } = await import("../../lib/resolvers.js");
    const wsId = await resolveWorkspaceName(api, "my-project");
    expect(wsId).toBe("ws-ulid");
  });
});

// ---------------------------------------------------------------------------
// Device resolution integration tests
// ---------------------------------------------------------------------------

describe("sessions — device resolution", () => {
  beforeEach(() => resetRoutes());

  it("resolves device name to ULID for filtering", async () => {
    mockRoute("/api/devices", 200, {
      devices: [{ id: "dev-ulid", name: "macbook" }],
    });

    const api = makeClient();
    const { resolveDeviceName } = await import("../../lib/resolvers.js");
    const devId = await resolveDeviceName(api, "macbook");
    expect(devId).toBe("dev-ulid");
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe("sessions — error handling", () => {
  it("ApiConnectionError produces connection error message", () => {
    const err = new ApiConnectionError("connection refused");
    expect(err.message).toContain("connection refused");
    expect(err.name).toBe("ApiConnectionError");
  });

  it("ApiError 401 is identifiable", () => {
    const err = new ApiError("Unauthorized", 401);
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("Unauthorized");
  });

  it("ApiError 404 for workspace not found", () => {
    const err = new ApiError('Workspace "nope" not found.', 404);
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// JSON output tests
// ---------------------------------------------------------------------------

describe("sessions — JSON output", () => {
  beforeEach(() => resetRoutes());

  it("fetchSessions result is JSON-serializable", async () => {
    const session = makeSession();
    mockRoute("/api/sessions", 200, {
      sessions: [session],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchSessions(makeClient(), {});
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.cursor).toBeNull();
    expect(parsed.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pagination tests
// ---------------------------------------------------------------------------

describe("sessions — pagination", () => {
  beforeEach(() => resetRoutes());

  it("returns cursor when has_more is true", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [makeSession()],
      next_cursor: "next-page-cursor",
      has_more: true,
    });

    const result = await fetchSessions(makeClient(), {});
    expect(result.cursor).toBe("next-page-cursor");
  });

  it("returns null cursor when has_more is false", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [makeSession()],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchSessions(makeClient(), {});
    expect(result.cursor).toBeNull();
  });

  it("passes cursor parameter for subsequent pages", async () => {
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    await fetchSessions(makeClient(), { cursor: "page-2-cursor" });
    expect(lastRequestUrl).toContain("cursor=page-2-cursor");
  });
});
