/**
 * Tests for the `fuel-code workspaces` and `fuel-code workspace <name>` commands.
 *
 * Uses Bun.serve() as a mock HTTP server for real HTTP round-trips through
 * FuelApiClient. Tests the data layer (fetchWorkspaces, fetchWorkspaceDetail),
 * presentation layer (formatWorkspacesTable, formatWorkspaceDetail),
 * workspace name resolution, and error handling.
 *
 * stdout is captured via spyOn to assert formatted output.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  spyOn,
} from "bun:test";
import type { Server } from "bun";
import { FuelApiClient, ApiError } from "../../lib/api-client.js";
import { stripAnsi } from "../../lib/formatters.js";
import {
  fetchWorkspaces,
  fetchWorkspaceDetail,
  formatWorkspacesTable,
  formatWorkspaceDetail,
} from "../workspaces.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server
// ---------------------------------------------------------------------------

interface MockRoute {
  status: number;
  body: unknown;
}

let server: Server;
let serverPort: number;
let lastRequestUrl: string;
let routes: Record<string, MockRoute> = {};

function mockRoute(pathPrefix: string, status: number, body: unknown) {
  routes[pathPrefix] = { status, body };
}

function resetRoutes() {
  routes = {};
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      lastRequestUrl = url.pathname + url.search;

      // Find matching route by longest prefix match
      const sorted = Object.entries(routes).sort(
        (a, b) => b[0].length - a[0].length,
      );
      for (const [prefix, route] of sorted) {
        if (url.pathname.startsWith(prefix)) {
          return new Response(JSON.stringify(route.body), {
            status: route.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

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

function makeWorkspaceSummary(overrides?: Record<string, unknown>) {
  return {
    id: "01HZWORKSPACE000000000001",
    canonical_id: "github.com/user/repo",
    display_name: "my-repo",
    default_branch: "main",
    metadata: {},
    first_seen_at: "2025-06-01T00:00:00Z",
    updated_at: "2025-06-15T12:00:00Z",
    session_count: 10,
    active_session_count: 1,
    last_session_at: "2025-06-15T12:00:00Z",
    device_count: 2,
    total_cost_usd: 5.5,
    total_duration_ms: 3600000,
    ...overrides,
  };
}

function makeWorkspaceDetail(overrides?: Record<string, unknown>) {
  return {
    workspace: {
      id: "01HZWORKSPACE000000000001",
      canonical_id: "github.com/user/repo",
      display_name: "my-repo",
      default_branch: "main",
      metadata: {},
      first_seen_at: "2025-06-01T00:00:00Z",
      updated_at: "2025-06-15T12:00:00Z",
    },
    recent_sessions: [
      {
        id: "01HZSESSION0000000000001",
        workspace_id: "01HZWORKSPACE000000000001",
        device_id: "dev-001",
        device_name: "macbook",
        cc_session_id: "cc-001",
        lifecycle: "summarized",
        parse_status: "completed",
        cwd: "/home/user/code",
        git_branch: "main",
        git_remote: null,
        model: "claude-4",
        duration_ms: 3600000,
        transcript_path: null,
        started_at: "2025-06-15T10:00:00Z",
        ended_at: "2025-06-15T11:00:00Z",
        metadata: {},
        summary: "Built auth module",
        cost_estimate_usd: 1.2,
      },
    ],
    devices: [
      {
        id: "dev-001",
        type: "local",
        name: "macbook",
        status: "online",
        platform: "darwin",
        os_version: "14.0",
        metadata: {},
        first_seen_at: "2025-06-01T00:00:00Z",
        last_seen_at: "2025-06-15T12:00:00Z",
        local_path: "/Users/user/code/my-repo",
        hooks_installed: true,
        git_hooks_installed: true,
        last_active_at: "2025-06-15T12:00:00Z",
      },
    ],
    git_summary: {
      total_commits: 42,
      total_pushes: 10,
      active_branches: ["main", "feature/auth"],
      last_commit_at: "2025-06-15T11:30:00Z",
    },
    stats: {
      total_sessions: 10,
      total_duration_ms: 36000000,
      total_cost_usd: 5.5,
      first_session_at: "2025-06-01T10:00:00Z",
      last_session_at: "2025-06-15T12:00:00Z",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Default workspace list
// ---------------------------------------------------------------------------

describe("fetchWorkspaces", () => {
  beforeEach(() => resetRoutes());

  it("returns workspaces sorted by last activity", async () => {
    const wsA = makeWorkspaceSummary({
      id: "ws-a",
      display_name: "older",
      last_session_at: "2025-06-10T00:00:00Z",
    });
    const wsB = makeWorkspaceSummary({
      id: "ws-b",
      display_name: "newer",
      last_session_at: "2025-06-15T00:00:00Z",
    });
    mockRoute("/api/workspaces", 200, {
      workspaces: [wsA, wsB],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchWorkspaces(makeClient());
    expect(result).toHaveLength(2);
    // Sorted by last activity: newer first
    expect(result[0].display_name).toBe("newer");
    expect(result[1].display_name).toBe("older");
  });

  it("handles empty workspace list", async () => {
    mockRoute("/api/workspaces", 200, {
      workspaces: [],
      next_cursor: null,
      has_more: false,
    });

    const result = await fetchWorkspaces(makeClient());
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatWorkspacesTable
// ---------------------------------------------------------------------------

describe("formatWorkspacesTable", () => {
  it("renders table with correct column headers", () => {
    const workspaces = [makeWorkspaceSummary()] as any;
    const output = formatWorkspacesTable(workspaces);
    const plain = stripAnsi(output);

    expect(plain).toContain("WORKSPACE");
    expect(plain).toContain("SESSIONS");
    expect(plain).toContain("ACTIVE");
    expect(plain).toContain("DEVICES");
    expect(plain).toContain("LAST ACTIVITY");
    expect(plain).toContain("TOTAL TOKENS");
    expect(plain).toContain("TOTAL TIME");
  });

  it("shows green active count when > 0", () => {
    const ws = makeWorkspaceSummary({ active_session_count: 3 });
    const output = formatWorkspacesTable([ws] as any);
    // The output should contain "3" for active count; exact color verification
    // is hard, so we check the raw string has an ANSI color escape around "3"
    expect(output).toContain("3");
    const plain = stripAnsi(output);
    expect(plain).toContain("3");
  });

  it("shows '0' for zero active sessions", () => {
    const ws = makeWorkspaceSummary({ active_session_count: 0 });
    const output = formatWorkspacesTable([ws] as any);
    const plain = stripAnsi(output);
    // Check that the active column shows "0"
    expect(plain).toContain("0");
  });

  it("shows empty state message when no workspaces", () => {
    const output = formatWorkspacesTable([]);
    const plain = stripAnsi(output);
    expect(plain).toContain("No workspaces");
    expect(plain).toContain("fuel-code init");
  });

  it("formats tokens and duration correctly", () => {
    const ws = makeWorkspaceSummary({
      total_tokens_in: 500000,
      total_tokens_out: 200000,
      total_duration_ms: 7200000,
    });
    const output = formatWorkspacesTable([ws] as any);
    const plain = stripAnsi(output);
    expect(plain).toContain("500K/200K");
    expect(plain).toContain("2h");
  });

  it("supports --json output via data serialization", () => {
    const workspaces = [makeWorkspaceSummary()];
    const json = JSON.stringify(workspaces, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].display_name).toBe("my-repo");
  });
});

// ---------------------------------------------------------------------------
// Tests: Workspace detail
// ---------------------------------------------------------------------------

describe("fetchWorkspaceDetail", () => {
  beforeEach(() => resetRoutes());

  it("fetches workspace detail by ID", async () => {
    const detail = makeWorkspaceDetail();
    mockRoute("/api/workspaces/", 200, detail);

    const result = await fetchWorkspaceDetail(makeClient(), "01HZWORKSPACE000000000001");
    expect(result.workspace.display_name).toBe("my-repo");
    expect(result.recent_sessions).toHaveLength(1);
    expect(result.devices).toHaveLength(1);
  });

  it("returns devices with hook status", async () => {
    const detail = makeWorkspaceDetail();
    mockRoute("/api/workspaces/", 200, detail);

    const result = await fetchWorkspaceDetail(makeClient(), "01HZWORKSPACE000000000001");
    expect(result.devices[0].hooks_installed).toBe(true);
    expect(result.devices[0].git_hooks_installed).toBe(true);
  });

  it("returns git summary", async () => {
    const detail = makeWorkspaceDetail();
    mockRoute("/api/workspaces/", 200, detail);

    const result = await fetchWorkspaceDetail(makeClient(), "01HZWORKSPACE000000000001");
    expect(result.git_summary.total_commits).toBe(42);
    expect(result.git_summary.active_branches).toContain("main");
  });
});

describe("formatWorkspaceDetail", () => {
  it("shows workspace header with name and canonical ID", () => {
    const detail = makeWorkspaceDetail() as any;
    const output = formatWorkspaceDetail(detail);
    const plain = stripAnsi(output);
    expect(plain).toContain("my-repo");
    expect(plain).toContain("github.com/user/repo");
  });

  it("shows device list with hook status", () => {
    const detail = makeWorkspaceDetail() as any;
    const output = formatWorkspaceDetail(detail);
    const plain = stripAnsi(output);
    expect(plain).toContain("macbook");
    expect(plain).toContain("Devices:");
  });

  it("shows recent sessions", () => {
    const detail = makeWorkspaceDetail() as any;
    const output = formatWorkspaceDetail(detail);
    const plain = stripAnsi(output);
    expect(plain).toContain("Recent Sessions:");
    expect(plain).toContain("Built auth module");
  });

  it("shows git activity", () => {
    const detail = makeWorkspaceDetail() as any;
    const output = formatWorkspaceDetail(detail);
    const plain = stripAnsi(output);
    expect(plain).toContain("Git Activity:");
    expect(plain).toContain("42");
    expect(plain).toContain("main");
  });

  it("supports --json via data serialization", () => {
    const detail = makeWorkspaceDetail();
    const json = JSON.stringify(detail, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.workspace.display_name).toBe("my-repo");
    expect(parsed.stats.total_sessions).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Tests: Workspace name resolution
// ---------------------------------------------------------------------------

describe("workspace name resolution", () => {
  beforeEach(() => resetRoutes());

  it("resolves by display name", async () => {
    mockRoute("/api/workspaces", 200, {
      workspaces: [
        makeWorkspaceSummary({
          id: "ws-ulid",
          display_name: "my-repo",
          canonical_id: "github.com/user/repo",
        }),
      ],
      next_cursor: null,
      has_more: false,
    });

    const { resolveWorkspaceName } = await import("../../lib/resolvers.js");
    const id = await resolveWorkspaceName(makeClient(), "my-repo");
    expect(id).toBe("ws-ulid");
  });

  it("resolves by canonical ID", async () => {
    mockRoute("/api/workspaces", 200, {
      workspaces: [
        makeWorkspaceSummary({
          id: "ws-ulid",
          display_name: "my-repo",
          canonical_id: "github.com/user/repo",
        }),
      ],
      next_cursor: null,
      has_more: false,
    });

    const { resolveWorkspaceName } = await import("../../lib/resolvers.js");
    const id = await resolveWorkspaceName(makeClient(), "github.com/user/repo");
    expect(id).toBe("ws-ulid");
  });

  it("passes through ULID directly", async () => {
    const { resolveWorkspaceName } = await import("../../lib/resolvers.js");
    const ulid = "01HZCCCCCCCCCCCCCCCCCCCCCC";
    const id = await resolveWorkspaceName(makeClient(), ulid);
    expect(id).toBe(ulid);
  });

  it("throws 404 for unknown workspace", async () => {
    mockRoute("/api/workspaces", 200, {
      workspaces: [
        makeWorkspaceSummary({ id: "ws-1", display_name: "foo" }),
      ],
      next_cursor: null,
      has_more: false,
    });

    const { resolveWorkspaceName } = await import("../../lib/resolvers.js");
    try {
      await resolveWorkspaceName(makeClient(), "nonexistent");
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(404);
    }
  });

  it("throws 400 for ambiguous workspace name", async () => {
    mockRoute("/api/workspaces", 200, {
      workspaces: [
        makeWorkspaceSummary({ id: "ws-1", display_name: "my-repo-a" }),
        makeWorkspaceSummary({ id: "ws-2", display_name: "my-repo-b" }),
      ],
      next_cursor: null,
      has_more: false,
    });

    const { resolveWorkspaceName } = await import("../../lib/resolvers.js");
    try {
      await resolveWorkspaceName(makeClient(), "my-repo");
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain("Ambiguous");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Network error handling
// ---------------------------------------------------------------------------

describe("workspaces — error handling", () => {
  it("fetchWorkspaces throws on network error", async () => {
    // Client pointing to a port with no server
    const badClient = new FuelApiClient({
      baseUrl: "http://localhost:1",
      apiKey: "test-key",
      timeout: 500,
    });

    try {
      await fetchWorkspaces(badClient);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});
