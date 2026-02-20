/**
 * Integration tests for device API endpoints.
 *
 * Uses a real Express app with mock SQL dependencies.
 * The mock SQL is a proxy that intercepts postgres.js tagged template calls
 * and returns canned data based on query patterns.
 *
 * Test coverage (12 tests):
 *   - GET /api/devices: list, aggregate fields, response shape
 *   - GET /api/devices/:id: detail, 404, response shape with workspaces/sessions/stats
 *   - Auth: 401 without token
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { logger } from "../../logger.js";
import { createAuthMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createDevicesRouter } from "../devices.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_devices";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// Sample test data
// ---------------------------------------------------------------------------

const DEVICE_1 = {
  id: "dev-01",
  name: "macbook-pro",
  type: "local",
  hostname: "macbook-pro.local",
  os: "darwin",
  arch: "arm64",
  status: "online",
  metadata: {},
  first_seen_at: "2025-01-01T00:00:00.000Z",
  last_seen_at: "2025-01-15T14:00:00.000Z",
  session_count: 8,
  workspace_count: 3,
  active_session_count: 1,
  last_session_at: "2025-01-15T14:00:00.000Z",
  total_cost_usd: "3.50",
  total_duration_ms: "28800000",
};

const DEVICE_2 = {
  id: "dev-02",
  name: "linux-desktop",
  type: "local",
  hostname: "linux-desktop.local",
  os: "linux",
  arch: "x86_64",
  status: "offline",
  metadata: {},
  first_seen_at: "2025-01-05T00:00:00.000Z",
  last_seen_at: "2025-01-14T10:00:00.000Z",
  session_count: 2,
  workspace_count: 1,
  active_session_count: 0,
  last_session_at: "2025-01-14T10:00:00.000Z",
  total_cost_usd: "0.50",
  total_duration_ms: "7200000",
};

const ALL_DEVICES = [DEVICE_1, DEVICE_2];

// Detail sub-query data

const DEVICE_WORKSPACES = [
  {
    id: "ws-01",
    canonical_id: "github.com/user/repo-alpha",
    display_name: "user/repo-alpha",
    default_branch: "main",
    local_path: "/Users/john/code/repo-alpha",
    hooks_installed: true,
    last_active_at: "2025-01-15T14:00:00.000Z",
  },
  {
    id: "ws-02",
    canonical_id: "github.com/user/repo-beta",
    display_name: "user/repo-beta",
    default_branch: "main",
    local_path: "/Users/john/code/repo-beta",
    hooks_installed: false,
    last_active_at: "2025-01-14T10:00:00.000Z",
  },
];

const DEVICE_SESSIONS = [
  {
    id: "sess-01",
    workspace_id: "ws-01",
    lifecycle: "parsed",
    started_at: "2025-01-15T14:00:00.000Z",
    ended_at: "2025-01-15T15:00:00.000Z",
    duration_ms: 3600000,
    summary: "Added dashboard",
    cost_estimate_usd: "0.50",
    total_messages: 20,
    tags: ["feature"],
    model: "claude-opus-4-20250514",
    git_branch: "main",
    workspace_name: "user/repo-alpha",
  },
  {
    id: "sess-02",
    workspace_id: "ws-01",
    lifecycle: "ended",
    started_at: "2025-01-15T10:00:00.000Z",
    ended_at: "2025-01-15T11:00:00.000Z",
    duration_ms: 3600000,
    summary: "Fixed CSS bug",
    cost_estimate_usd: "0.25",
    total_messages: 10,
    tags: ["bugfix"],
    model: "claude-opus-4-20250514",
    git_branch: "feature/fix-css",
    workspace_name: "user/repo-alpha",
  },
];

const DEVICE_STATS = {
  total_sessions: 8,
  active_sessions: 1,
  total_duration_ms: "28800000",
  total_cost_usd: "3.50",
  total_messages: "150",
  first_session_at: "2025-01-01T08:00:00.000Z",
  last_session_at: "2025-01-15T14:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Mock SQL factory (fragment-aware)
// ---------------------------------------------------------------------------

function buildMockSql(
  queryHandler: (queryText: string, values: unknown[]) => unknown[],
) {
  const FRAGMENT_MARKER = Symbol("sql-fragment");

  interface SqlFragment {
    [key: symbol]: true;
    text: string;
    values: unknown[];
  }

  function isFragment(val: unknown): val is SqlFragment {
    return typeof val === "object" && val !== null && FRAGMENT_MARKER in val;
  }

  function sqlHelper(...args: unknown[]): unknown {
    return args[0];
  }

  function sqlTaggedTemplate(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): unknown {
    const rawText = strings.join("$");
    const allValues: unknown[] = [];
    let fullText = rawText;

    for (const v of values) {
      if (isFragment(v)) {
        fullText += " " + v.text;
        allValues.push(...v.values);
      } else {
        allValues.push(v);
      }
    }

    const isFullQuery = /SELECT|UPDATE|INSERT|DELETE/i.test(rawText);

    if (!isFullQuery) {
      const fragment: SqlFragment = {
        [FRAGMENT_MARKER]: true,
        text: fullText,
        values: allValues,
      };
      return fragment;
    }

    return Promise.resolve(queryHandler(fullText, allValues));
  }

  const proxy = new Proxy(sqlTaggedTemplate, {
    apply(_target, _thisArg, args) {
      if (args[0] && Array.isArray(args[0]) && "raw" in args[0]) {
        return sqlTaggedTemplate(
          args[0] as TemplateStringsArray,
          ...args.slice(1),
        );
      }
      return sqlHelper(...args);
    },
  });

  return proxy;
}

// ---------------------------------------------------------------------------
// Query handler
// ---------------------------------------------------------------------------

function defaultQueryHandler(queryText: string, values: unknown[]): unknown[] {
  // Device list with aggregates
  if (
    queryText.includes("FROM devices d") &&
    queryText.includes("LEFT JOIN sessions s") &&
    queryText.includes("GROUP BY d.id")
  ) {
    return ALL_DEVICES;
  }

  // Device lookup by id
  if (queryText.includes("FROM devices") && queryText.includes("WHERE id =")) {
    const id = values.find((v) => typeof v === "string");
    const device = ALL_DEVICES.find((d) => d.id === id);
    return device ? [device] : [];
  }

  // Workspaces for device (via workspace_devices junction)
  if (
    queryText.includes("FROM workspaces w") &&
    queryText.includes("JOIN workspace_devices wd") &&
    queryText.includes("wd.device_id =")
  ) {
    return DEVICE_WORKSPACES;
  }

  // Recent sessions for device
  if (
    queryText.includes("FROM sessions s") &&
    queryText.includes("JOIN workspaces w") &&
    queryText.includes("s.device_id =")
  ) {
    return DEVICE_SESSIONS;
  }

  // Aggregate stats for device
  if (
    queryText.includes("FROM sessions") &&
    queryText.includes("SUM(duration_ms)") &&
    queryText.includes("device_id =")
  ) {
    return [DEVICE_STATS];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function buildTestApp(
  queryHandler: (queryText: string, values: unknown[]) => unknown[],
) {
  const sql = buildMockSql(queryHandler);
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createAuthMiddleware(TEST_API_KEY));
  app.use(
    "/api",
    createDevicesRouter({
      sql: sql as any,
      logger,
    }),
  );
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = buildTestApp(defaultQueryHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: AUTH_HEADER, ...headers },
  });
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/devices (list)
// ---------------------------------------------------------------------------

describe("GET /api/devices", () => {
  test("returns devices list", async () => {
    const res = await get("/api/devices");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.devices).toBeDefined();
    expect(Array.isArray(body.devices)).toBe(true);
    expect(body.devices.length).toBe(2);
  });

  test("devices include aggregate fields", async () => {
    const res = await get("/api/devices");
    const body = await res.json();

    const device = body.devices[0];
    expect(device).toHaveProperty("id");
    expect(device).toHaveProperty("name");
    expect(device).toHaveProperty("type");
    expect(device).toHaveProperty("status");
    expect(device).toHaveProperty("session_count");
    expect(device).toHaveProperty("workspace_count");
    expect(device).toHaveProperty("active_session_count");
    expect(device).toHaveProperty("last_session_at");
    expect(device).toHaveProperty("total_cost_usd");
    expect(device).toHaveProperty("total_duration_ms");
  });

  test("returns correct device data", async () => {
    const res = await get("/api/devices");
    const body = await res.json();

    // First device should be macbook-pro (most recently seen)
    const mbp = body.devices.find((d: any) => d.id === "dev-01");
    expect(mbp).toBeDefined();
    expect(mbp.name).toBe("macbook-pro");
    expect(mbp.type).toBe("local");
    expect(mbp.status).toBe("online");
  });

  test("returns empty array when no devices", async () => {
    const emptyHandler = () => [] as unknown[];
    const sql = buildMockSql(emptyHandler);
    const app = express();
    app.use(express.json());
    app.use("/api", createAuthMiddleware(TEST_API_KEY));
    app.use("/api", createDevicesRouter({ sql: sql as any, logger }));
    app.use(errorHandler);

    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const addr = srv.address();
    const url = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";

    try {
      const res = await fetch(`${url}/api/devices`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.devices).toEqual([]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:id (detail)
// ---------------------------------------------------------------------------

describe("GET /api/devices/:id", () => {
  test("returns device detail for existing device", async () => {
    const res = await get("/api/devices/dev-01");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.device).toBeDefined();
    expect(body.device.id).toBe("dev-01");
    expect(body.device.name).toBe("macbook-pro");
  });

  test("returns 404 for non-existent device", async () => {
    const res = await get("/api/devices/nonexistent-device");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Device not found");
  });

  test("includes workspace associations", async () => {
    const res = await get("/api/devices/dev-01");
    const body = await res.json();

    expect(body.workspaces).toBeDefined();
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces.length).toBe(2);

    const ws = body.workspaces[0];
    expect(ws).toHaveProperty("id");
    expect(ws).toHaveProperty("canonical_id");
    expect(ws).toHaveProperty("display_name");
    expect(ws).toHaveProperty("local_path");
    expect(ws).toHaveProperty("hooks_installed");
    expect(ws).toHaveProperty("last_active_at");
  });

  test("includes recent sessions with workspace names", async () => {
    const res = await get("/api/devices/dev-01");
    const body = await res.json();

    expect(body.recent_sessions).toBeDefined();
    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(body.recent_sessions.length).toBe(2);

    const session = body.recent_sessions[0];
    expect(session).toHaveProperty("id");
    expect(session).toHaveProperty("workspace_id");
    expect(session).toHaveProperty("lifecycle");
    expect(session).toHaveProperty("workspace_name");
    expect(session.workspace_name).toBe("user/repo-alpha");
  });

  test("includes aggregate stats", async () => {
    const res = await get("/api/devices/dev-01");
    const body = await res.json();

    expect(body.stats).toBeDefined();
    expect(body.stats).toHaveProperty("total_sessions");
    expect(body.stats).toHaveProperty("active_sessions");
    expect(body.stats).toHaveProperty("total_duration_ms");
    expect(body.stats).toHaveProperty("total_cost_usd");
    expect(body.stats).toHaveProperty("total_messages");
    expect(body.stats).toHaveProperty("first_session_at");
    expect(body.stats).toHaveProperty("last_session_at");
  });

  test("response has all expected sections", async () => {
    const res = await get("/api/devices/dev-01");
    const body = await res.json();

    expect(body).toHaveProperty("device");
    expect(body).toHaveProperty("workspaces");
    expect(body).toHaveProperty("recent_sessions");
    expect(body).toHaveProperty("stats");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("GET /api/devices — auth", () => {
  test("returns 401 without Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/devices`, {
      method: "GET",
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  test("returns 401 with wrong Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/devices`, {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });
});
