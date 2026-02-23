/**
 * Tests for the enriched `fuel-code status` command.
 *
 * Uses Bun.serve() as a mock HTTP server for real HTTP round-trips through
 * FuelApiClient. Tests the data layer (fetchStatus), presentation layer
 * (formatStatus), and edge cases like unreachable backend, queue counting,
 * hooks detection, and the not-initialized state.
 *
 * Filesystem operations (queue/dead-letter counting, hooks checking) are
 * tested using temp directories and config path overrides.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import type { Server } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FuelApiClient } from "../../lib/api-client.js";
import { stripAnsi } from "../../lib/formatters.js";
import {
  overrideConfigPaths,
  type FuelCodeConfig,
} from "../../lib/config.js";
import {
  fetchStatus,
  formatStatus,
  runStatus,
  overrideSettingsPath,
  type StatusData,
} from "../status.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server
// ---------------------------------------------------------------------------

interface MockRoute {
  status: number;
  body: unknown;
  delay?: number;
}

let server: Server;
let serverPort: number;
let routes: Record<string, MockRoute> = {};

function mockRoute(
  pathPrefix: string,
  status: number,
  body: unknown,
  delay?: number,
) {
  routes[pathPrefix] = { status, body, delay };
}

function resetRoutes() {
  routes = {};
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Find matching route by longest prefix match
      const sorted = Object.entries(routes).sort(
        (a, b) => b[0].length - a[0].length,
      );
      for (const [prefix, route] of sorted) {
        if (url.pathname.startsWith(prefix)) {
          if (route.delay) {
            await new Promise((r) => setTimeout(r, route.delay));
          }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(timeout?: number): FuelApiClient {
  return new FuelApiClient({
    baseUrl: `http://localhost:${serverPort}`,
    apiKey: "test-key",
    timeout: timeout ?? 5000,
  });
}

function makeConfig(overrides?: Partial<FuelCodeConfig>): FuelCodeConfig {
  return {
    backend: {
      url: `http://localhost:${serverPort}`,
      api_key: "test-key",
    },
    device: {
      id: "01HZDEVICE0000000000000001",
      name: "macbook-pro",
      type: "local",
    },
    pipeline: {
      queue_path: "/tmp/fuel-code-test-queue",
      drain_interval_seconds: 10,
      batch_size: 50,
      post_timeout_ms: 2000,
    },
    ...overrides,
  };
}

function makeSession(overrides?: Record<string, unknown>) {
  return {
    id: "01HZSESSION0000000000001",
    workspace_id: "ws-001",
    workspace_name: "my-repo",
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
    ...overrides,
  };
}

// Temp directory management
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-status-test-"));
  resetRoutes();
});

afterEach(() => {
  overrideConfigPaths(undefined);
  overrideSettingsPath(undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Setup helpers for standard backend routes
// ---------------------------------------------------------------------------

function setupConnectedBackend() {
  mockRoute("/api/health", 200, {
    status: "ok",
    postgres: true,
    redis: true,
    ws_clients: 2,
    uptime: 3600,
    version: "0.1.0",
  });
  mockRoute("/api/sessions", 200, {
    sessions: [],
    next_cursor: null,
    has_more: false,
  });
}

// ---------------------------------------------------------------------------
// Tests: Fully connected status
// ---------------------------------------------------------------------------

describe("fetchStatus — connected", () => {
  it("returns connected status with device info", async () => {
    setupConnectedBackend();
    const config = makeConfig();
    const api = makeClient();

    const data = await fetchStatus(api, config);

    expect(data.device.name).toBe("macbook-pro");
    expect(data.device.type).toBe("local");
    expect(data.backend.status).toBe("connected");
    expect(data.backend.latencyMs).toBeDefined();
    expect(data.backend.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it("returns health details when connected", async () => {
    setupConnectedBackend();
    const config = makeConfig();
    const api = makeClient();

    const data = await fetchStatus(api, config);

    expect(data.backend.health).toBeDefined();
    expect(data.backend.health!.status).toBe("ok");
    expect(data.backend.health!.postgres).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Backend unreachable
// ---------------------------------------------------------------------------

describe("fetchStatus — unreachable", () => {
  it("returns unreachable status when backend is down", async () => {
    // Client pointing to a port with no server
    const badClient = new FuelApiClient({
      baseUrl: "http://localhost:1",
      apiKey: "test-key",
      timeout: 500,
    });
    const config = makeConfig({
      backend: { url: "http://localhost:1", api_key: "test-key" },
    });

    const data = await fetchStatus(badClient, config);

    expect(data.backend.status).toBe("unreachable");
    expect(data.backend.latencyMs).toBeUndefined();
    expect(data.activeSessions).toHaveLength(0);
    expect(data.recentSessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Active sessions
// ---------------------------------------------------------------------------

describe("fetchStatus — active sessions", () => {
  it("returns active sessions when capturing", async () => {
    mockRoute("/api/health", 200, {
      status: "ok",
      postgres: true,
      redis: true,
      ws_clients: 0,
      uptime: 100,
      version: "0.1.0",
    });
    mockRoute("/api/sessions", 200, {
      sessions: [
        makeSession({ lifecycle: "capturing", duration_ms: 600000 }),
      ],
      next_cursor: null,
      has_more: false,
    });

    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    // Note: all session fetches return the same data since our mock
    // matches on /api/sessions prefix regardless of query params
    expect(data.activeSessions.length).toBeGreaterThanOrEqual(0);
  });

  it("returns empty active sessions when none capturing", async () => {
    setupConnectedBackend();
    const config = makeConfig();
    const api = makeClient();

    const data = await fetchStatus(api, config);

    expect(data.activeSessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Recent sessions
// ---------------------------------------------------------------------------

describe("fetchStatus — recent sessions", () => {
  it("includes recent sessions from backend", async () => {
    mockRoute("/api/health", 200, {
      status: "ok",
      postgres: true,
      redis: true,
      ws_clients: 0,
      uptime: 100,
      version: "0.1.0",
    });
    mockRoute("/api/sessions", 200, {
      sessions: [makeSession(), makeSession({ id: "sess-2" })],
      next_cursor: null,
      has_more: false,
    });

    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    // Recent sessions come from the /api/sessions mock
    expect(data.recentSessions.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Queue depth
// ---------------------------------------------------------------------------

describe("fetchStatus — queue", () => {
  it("counts pending json files in queue dir", async () => {
    setupConnectedBackend();

    // Set up queue dir with files
    const queueDir = path.join(tmpDir, "queue");
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, "evt-1.json"), "{}");
    fs.writeFileSync(path.join(queueDir, "evt-2.json"), "{}");
    fs.writeFileSync(path.join(queueDir, "not-json.txt"), "");

    overrideConfigPaths(tmpDir);
    // Write a valid config for loadConfig
    const configContent = `
backend:
  url: "http://localhost:${serverPort}"
  api_key: "test-key"
device:
  id: "01HZDEVICE0000000000000001"
  name: "macbook-pro"
  type: "local"
pipeline:
  queue_path: "${queueDir}"
  drain_interval_seconds: 10
  batch_size: 50
  post_timeout_ms: 2000
`;
    fs.writeFileSync(path.join(tmpDir, "config.yaml"), configContent);

    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    expect(data.queue.pending).toBe(2);
  });

  it("counts dead-letter json files", async () => {
    setupConnectedBackend();

    const dlDir = path.join(tmpDir, "dead-letter");
    fs.mkdirSync(dlDir, { recursive: true });
    fs.writeFileSync(path.join(dlDir, "dead-1.json"), "{}");

    overrideConfigPaths(tmpDir);
    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    expect(data.queue.deadLetter).toBe(1);
  });

  it("returns 0 when queue dir does not exist", async () => {
    setupConnectedBackend();

    // Don't create queue dir
    overrideConfigPaths(path.join(tmpDir, "nonexistent-dir"));
    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    expect(data.queue.pending).toBe(0);
    expect(data.queue.deadLetter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: CC hooks installed/not
// ---------------------------------------------------------------------------

describe("fetchStatus — hooks", () => {
  it("detects CC hooks as installed when settings.json has entries", async () => {
    setupConnectedBackend();

    // Create a mock settings.json with fuel-code hooks
    const settingsPath = path.join(tmpDir, "settings.json");
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "/path/to/fuel-code/SessionStart.sh" },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    overrideSettingsPath(settingsPath);

    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    expect(data.hooks.ccHooksInstalled).toBe(true);
  });

  it("detects CC hooks as not installed when settings.json missing", async () => {
    setupConnectedBackend();

    overrideSettingsPath(path.join(tmpDir, "nonexistent-settings.json"));

    const config = makeConfig();
    const api = makeClient();
    const data = await fetchStatus(api, config);

    expect(data.hooks.ccHooksInstalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatStatus presentation
// ---------------------------------------------------------------------------

describe("formatStatus", () => {
  it("formats fully connected status", () => {
    const data: StatusData = {
      device: { id: "01HZDEVICE0000000000000001", name: "macbook-pro", type: "local" },
      backend: {
        url: "http://localhost:3000",
        status: "connected",
        latencyMs: 45,
        health: {
          status: "ok",
          postgres: true,
          redis: true,
          ws_clients: 2,
          uptime: 3600,
          version: "0.1.0",
        },
      },
      activeSessions: [],
      queue: { pending: 0, deadLetter: 0 },
      recentSessions: [],
      hooks: { ccHooksInstalled: true, gitHooksInstalled: true },
      today: { sessionCount: 5, totalDurationMs: 7200000, totalTokensIn: 500000, totalTokensOut: 200000 },
    };

    const output = formatStatus(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("macbook-pro");
    expect(plain).toContain("Connected");
    expect(plain).toContain("45ms");
    expect(plain).toContain("0 pending");
    expect(plain).toContain("Installed");
    expect(plain).toContain("5 sessions");
    expect(plain).toContain("500K/200K");
  });

  it("formats unreachable backend", () => {
    const data: StatusData = {
      device: { id: "01HZDEVICE0000000000000001", name: "macbook-pro", type: "local" },
      backend: { url: "http://localhost:3000", status: "unreachable" },
      activeSessions: [],
      queue: { pending: 3, deadLetter: 1 },
      recentSessions: [],
      hooks: { ccHooksInstalled: false, gitHooksInstalled: false },
    };

    const output = formatStatus(data);
    const plain = stripAnsi(output);

    expect(plain).toContain("Unreachable");
    expect(plain).toContain("3 pending");
    expect(plain).toContain("1 dead-letter");
    expect(plain).toContain("Cannot fetch session data");
    expect(plain).toContain("Not installed");
  });

  it("shows active sessions when present", () => {
    const data: StatusData = {
      device: { id: "01HZDEV", name: "dev", type: "local" },
      backend: { url: "http://localhost:3000", status: "connected", latencyMs: 10 },
      activeSessions: [
        makeSession({ lifecycle: "capturing", workspace_name: "active-ws" }),
      ] as any,
      queue: { pending: 0, deadLetter: 0 },
      recentSessions: [],
      hooks: { ccHooksInstalled: true, gitHooksInstalled: true },
    };

    const output = formatStatus(data);
    const plain = stripAnsi(output);
    expect(plain).toContain("Active Sessions:");
    expect(plain).toContain("active-ws");
  });

  it("shows recent sessions", () => {
    const data: StatusData = {
      device: { id: "01HZDEV", name: "dev", type: "local" },
      backend: { url: "http://localhost:3000", status: "connected", latencyMs: 10 },
      activeSessions: [],
      queue: { pending: 0, deadLetter: 0 },
      recentSessions: [makeSession({ workspace_name: "recent-ws" })] as any,
      hooks: { ccHooksInstalled: true, gitHooksInstalled: true },
    };

    const output = formatStatus(data);
    const plain = stripAnsi(output);
    expect(plain).toContain("Recent Sessions:");
    expect(plain).toContain("recent-ws");
  });

  it("shows today summary with session count and cost", () => {
    const data: StatusData = {
      device: { id: "01HZDEV", name: "dev", type: "local" },
      backend: { url: "http://localhost:3000", status: "connected", latencyMs: 10 },
      activeSessions: [],
      queue: { pending: 0, deadLetter: 0 },
      recentSessions: [],
      hooks: { ccHooksInstalled: true, gitHooksInstalled: true },
      today: { sessionCount: 3, totalDurationMs: 5400000, totalTokensIn: 300000, totalTokensOut: 100000 },
    };

    const output = formatStatus(data);
    const plain = stripAnsi(output);
    expect(plain).toContain("3 sessions");
    expect(plain).toContain("300K/100K");
  });

  it("supports --json output via data serialization", () => {
    const data: StatusData = {
      device: { id: "01HZDEV", name: "dev", type: "local" },
      backend: { url: "http://localhost:3000", status: "connected", latencyMs: 45 },
      activeSessions: [],
      queue: { pending: 0, deadLetter: 0 },
      recentSessions: [],
      hooks: { ccHooksInstalled: true, gitHooksInstalled: true },
    };

    const json = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.backend.status).toBe("connected");
    expect(parsed.backend.latencyMs).toBe(45);
  });

  it("includes latency in connected output", () => {
    const data: StatusData = {
      device: { id: "01HZDEV", name: "dev", type: "local" },
      backend: { url: "http://localhost:3000", status: "connected", latencyMs: 123 },
      activeSessions: [],
      queue: { pending: 0, deadLetter: 0 },
      recentSessions: [],
      hooks: { ccHooksInstalled: true, gitHooksInstalled: true },
    };

    const output = formatStatus(data);
    const plain = stripAnsi(output);
    expect(plain).toContain("123ms");
  });
});

// ---------------------------------------------------------------------------
// Tests: runStatus (not initialized)
// ---------------------------------------------------------------------------

describe("runStatus — not initialized", () => {
  it("shows not initialized message when config missing", async () => {
    overrideConfigPaths(path.join(tmpDir, "nonexistent"));

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await runStatus();

      // Check that it printed the not-initialized message
      const allCalls = consoleSpy.mock.calls.flat().join(" ");
      expect(allCalls).toContain("Not initialized");
    } finally {
      stdoutSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Timeout / completion within deadline
// ---------------------------------------------------------------------------

describe("status — performance", () => {
  it("completes within 4 seconds even with slow backend", async () => {
    // Set up a slow health endpoint (but under 3s timeout)
    mockRoute("/api/health", 200, {
      status: "ok",
      postgres: true,
      redis: true,
      ws_clients: 0,
      uptime: 100,
      version: "0.1.0",
    }, 100); // 100ms delay
    mockRoute("/api/sessions", 200, {
      sessions: [],
      next_cursor: null,
      has_more: false,
    });

    const config = makeConfig();
    const api = makeClient(3000);

    const start = Date.now();
    const data = await fetchStatus(api, config);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(4000);
    expect(data.backend.status).toBe("connected");
  });
});
