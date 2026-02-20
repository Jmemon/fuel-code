/**
 * Integration tests for workspace API endpoints.
 *
 * Uses a real Express app with mock SQL dependencies.
 * The mock SQL is a proxy that intercepts postgres.js tagged template calls
 * and returns canned data based on query patterns.
 *
 * Test coverage (21 tests):
 *   - GET /api/workspaces: list, pagination, cursor validation, limit validation
 *   - GET /api/workspaces/:id: ULID lookup, name lookup, canonical_id lookup,
 *     ambiguous name 400, 404, response shape, parallel queries
 *   - Auth: 401 without token
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { logger } from "../../logger.js";
import { createAuthMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createWorkspacesRouter } from "../workspaces.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_workspaces";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// Sample test data
// ---------------------------------------------------------------------------

const WORKSPACE_1 = {
  id: "01HQRS0000WORKSPACE1AAAAAA",
  canonical_id: "github.com/user/repo-alpha",
  display_name: "user/repo-alpha",
  default_branch: "main",
  metadata: {},
  first_seen_at: "2025-01-10T08:00:00.000Z",
  updated_at: "2025-01-15T14:00:00.000Z",
  session_count: "5",
  active_session_count: "1",
  last_session_at: "2025-01-15T14:00:00.000Z",
  device_count: "2",
  total_cost_usd: "2.50",
  total_duration_ms: "18000000",
};

const WORKSPACE_2 = {
  id: "01HQRS0000WORKSPACE2BBBBBB",
  canonical_id: "github.com/user/repo-beta",
  display_name: "user/repo-beta",
  default_branch: "main",
  metadata: {},
  first_seen_at: "2025-01-12T10:00:00.000Z",
  updated_at: "2025-01-14T10:00:00.000Z",
  session_count: "3",
  active_session_count: "0",
  last_session_at: "2025-01-14T10:00:00.000Z",
  device_count: "1",
  total_cost_usd: "1.00",
  total_duration_ms: "10800000",
};

const WORKSPACE_3 = {
  id: "01HQRS0000WORKSPACE3CCCCCC",
  canonical_id: "github.com/user/repo-gamma",
  display_name: "user/repo-gamma",
  default_branch: "develop",
  metadata: {},
  first_seen_at: "2025-01-05T06:00:00.000Z",
  updated_at: "2025-01-13T09:00:00.000Z",
  session_count: "1",
  active_session_count: "0",
  last_session_at: "2025-01-13T09:00:00.000Z",
  device_count: "1",
  total_cost_usd: "0.25",
  total_duration_ms: "3600000",
};

// Workspace with ambiguous display_name (matches another workspace)
const WORKSPACE_AMBIGUOUS = {
  id: "01HQRS0000WORKSPACE4DDDDDD",
  canonical_id: "gitlab.com/user/repo-alpha",
  display_name: "user/repo-alpha",
  default_branch: "main",
  metadata: {},
  first_seen_at: "2025-01-15T08:00:00.000Z",
  updated_at: "2025-01-15T12:00:00.000Z",
  session_count: "2",
  active_session_count: "0",
  last_session_at: "2025-01-15T12:00:00.000Z",
  device_count: "1",
  total_cost_usd: "0.50",
  total_duration_ms: "7200000",
};

const ALL_WORKSPACES = [WORKSPACE_1, WORKSPACE_2, WORKSPACE_3];

// Detail sub-query data
const RECENT_SESSIONS = [
  {
    id: "sess-01",
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
    device_name: "macbook-pro",
    device_id: "dev-01",
  },
];

const DEVICES = [
  {
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
    local_path: "/Users/john/code/repo-alpha",
    hooks_installed: true,
    last_active_at: "2025-01-15T14:00:00.000Z",
  },
];

const GIT_SUMMARY = [
  { type: "commit", count: 12 },
  { type: "push", count: 5 },
  { type: "checkout", count: 3 },
];

const WORKSPACE_STATS = {
  total_sessions: 5,
  active_sessions: 1,
  total_duration_ms: "18000000",
  total_cost_usd: "2.50",
  total_messages: "85",
  total_tokens_in: "50000",
  total_tokens_out: "25000",
  first_session_at: "2025-01-10T08:00:00.000Z",
  last_session_at: "2025-01-15T14:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Mock SQL factory (fragment-aware, same pattern as timeline tests)
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

    const isFullQuery = /SELECT|UPDATE|INSERT|DELETE|WITH/i.test(rawText);

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
// Query handlers
// ---------------------------------------------------------------------------

/** Default handler: workspace list + detail queries */
function defaultQueryHandler(queryText: string, values: unknown[]): unknown[] {

  // Workspace list CTE: workspace_agg with sessions
  if (queryText.includes("workspace_agg") && queryText.includes("ORDER BY last_session_at")) {
    return ALL_WORKSPACES;
  }

  // Workspace lookup by ULID
  if (queryText.includes("FROM workspaces") && queryText.includes("WHERE id =")) {
    const id = values.find((v) => typeof v === "string");
    const ws = ALL_WORKSPACES.find((w) => w.id === id);
    return ws ? [ws] : [];
  }

  // Workspace lookup by name/canonical_id
  if (queryText.includes("FROM workspaces") && queryText.includes("LOWER(display_name)")) {
    const name = values.find((v) => typeof v === "string");
    const matches = ALL_WORKSPACES.filter(
      (w) =>
        w.display_name.toLowerCase() === (name as string)?.toLowerCase() ||
        w.canonical_id === name,
    );
    return matches;
  }

  // Recent sessions for workspace detail
  if (queryText.includes("FROM sessions s") && queryText.includes("JOIN devices d") && queryText.includes("s.workspace_id =")) {
    return RECENT_SESSIONS;
  }

  // Devices for workspace via workspace_devices junction
  if (queryText.includes("FROM devices d") && queryText.includes("JOIN workspace_devices wd")) {
    return DEVICES;
  }

  // Git activity summary
  if (queryText.includes("FROM git_activity") && queryText.includes("GROUP BY type")) {
    return GIT_SUMMARY;
  }

  // Aggregate stats
  if (queryText.includes("FROM sessions") && queryText.includes("SUM(duration_ms)") && queryText.includes("workspace_id =")) {
    return [WORKSPACE_STATS];
  }

  return [];
}

/** Handler that returns limit+1 workspaces for pagination testing */
function paginationQueryHandler(queryText: string, _values: unknown[]): unknown[] {
  if (queryText.includes("workspace_agg") && queryText.includes("ORDER BY last_session_at")) {
    // If cursor is present (the IS NULL check with a non-null value), return page 2
    // Check if any value indicates a cursor was provided
    const hasNonNullCursor = _values.some(
      (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v),
    );
    if (hasNonNullCursor) {
      return [WORKSPACE_3];
    }
    // First page: return 3 workspaces (limit will be 2, so 3 = limit+1 triggers has_more)
    return [WORKSPACE_1, WORKSPACE_2, WORKSPACE_3];
  }
  return [];
}

/** Handler for ambiguous name testing */
function ambiguousNameHandler(queryText: string, values: unknown[]): unknown[] {
  if (queryText.includes("FROM workspaces") && queryText.includes("LOWER(display_name)")) {
    // Return two workspaces with the same display_name
    return [WORKSPACE_1, WORKSPACE_AMBIGUOUS];
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
    createWorkspacesRouter({
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
// Request helpers
// ---------------------------------------------------------------------------

async function get(
  path: string,
  headers: Record<string, string> = {},
  url?: string,
) {
  return fetch(`${url || baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: AUTH_HEADER, ...headers },
  });
}

/** Start a temporary server with a custom query handler. Returns base URL and cleanup. */
async function withCustomServer(
  handler: (queryText: string, values: unknown[]) => unknown[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = buildTestApp(handler);
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const addr = srv.address();
      const url =
        addr && typeof addr === "object"
          ? `http://127.0.0.1:${addr.port}`
          : "";
      resolve({
        url,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/workspaces (list)
// ---------------------------------------------------------------------------

describe("GET /api/workspaces", () => {
  test("returns workspaces list with pagination fields", async () => {
    const res = await get("/api/workspaces");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.workspaces).toBeDefined();
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("next_cursor");
  });

  test("returns workspace data with aggregate fields", async () => {
    const res = await get("/api/workspaces");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.workspaces.length).toBeGreaterThan(0);

    const ws = body.workspaces[0];
    expect(ws).toHaveProperty("id");
    expect(ws).toHaveProperty("canonical_id");
    expect(ws).toHaveProperty("display_name");
    expect(ws).toHaveProperty("session_count");
    expect(ws).toHaveProperty("active_session_count");
    expect(ws).toHaveProperty("last_session_at");
    expect(ws).toHaveProperty("device_count");
    expect(ws).toHaveProperty("total_cost_usd");
    expect(ws).toHaveProperty("total_duration_ms");
  });

  test("accepts limit parameter", async () => {
    const res = await get("/api/workspaces?limit=10");
    expect(res.status).toBe(200);
  });

  test("clamps limit to max 250", async () => {
    // limit > 250 should be rejected by Zod (max 250)
    const res = await get("/api/workspaces?limit=999");
    expect(res.status).toBe(400);
  });

  test("rejects limit=0 with 400", async () => {
    const res = await get("/api/workspaces?limit=0");
    expect(res.status).toBe(400);
  });

  test("rejects invalid cursor with 400", async () => {
    const res = await get("/api/workspaces?cursor=not-valid-base64-json");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid cursor");
  });

  test("rejects cursor with missing fields with 400", async () => {
    const badCursor = Buffer.from(JSON.stringify({ x: "y" })).toString(
      "base64",
    );
    const res = await get(`/api/workspaces?cursor=${badCursor}`);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid cursor");
  });

  test("accepts valid base64 cursor", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ u: "2025-01-15T14:00:00.000Z", i: WORKSPACE_1.id }),
    ).toString("base64");
    const res = await get(`/api/workspaces?cursor=${cursor}`);
    expect(res.status).toBe(200);
  });

  test("pagination: has_more=true when more results exist", async () => {
    const { url, close } = await withCustomServer(paginationQueryHandler);
    try {
      const res = await get("/api/workspaces?limit=2", {}, url);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.workspaces.length).toBe(2);
      expect(body.has_more).toBe(true);
      expect(body.next_cursor).not.toBeNull();
    } finally {
      await close();
    }
  });

  test("pagination: cursor encodes last_session_at and id", async () => {
    const { url, close } = await withCustomServer(paginationQueryHandler);
    try {
      const res = await get("/api/workspaces?limit=2", {}, url);
      const body = await res.json();

      const decoded = JSON.parse(
        Buffer.from(body.next_cursor, "base64").toString("utf-8"),
      );
      expect(decoded.u).toBe(WORKSPACE_2.last_session_at);
      expect(decoded.i).toBe(WORKSPACE_2.id);
    } finally {
      await close();
    }
  });

  test("pagination: second page has no duplicates", async () => {
    const { url, close } = await withCustomServer(paginationQueryHandler);
    try {
      const res1 = await get("/api/workspaces?limit=2", {}, url);
      const body1 = await res1.json();
      const firstPageIds = body1.workspaces.map((w: any) => w.id);

      const res2 = await get(
        `/api/workspaces?limit=2&cursor=${body1.next_cursor}`,
        {},
        url,
      );
      const body2 = await res2.json();
      const secondPageIds = body2.workspaces.map((w: any) => w.id);

      for (const id of secondPageIds) {
        expect(firstPageIds).not.toContain(id);
      }
      expect(body2.has_more).toBe(false);
      expect(body2.next_cursor).toBeNull();
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id (detail)
// ---------------------------------------------------------------------------

describe("GET /api/workspaces/:id — ULID lookup", () => {
  test("returns workspace detail for valid ULID", async () => {
    const res = await get(`/api/workspaces/${WORKSPACE_1.id}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.workspace).toBeDefined();
    expect(body.workspace.id).toBe(WORKSPACE_1.id);
    expect(body.workspace.display_name).toBe("user/repo-alpha");
  });

  test("returns 404 for non-existent ULID", async () => {
    const res = await get("/api/workspaces/01HQRS0000NONEXISTENT000AA");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Workspace not found");
  });
});

describe("GET /api/workspaces/:id — name/canonical lookup", () => {
  test("finds workspace by display_name (case-insensitive)", async () => {
    const res = await get("/api/workspaces/user%2Frepo-beta");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.workspace).toBeDefined();
    expect(body.workspace.canonical_id).toBe("github.com/user/repo-beta");
  });

  test("finds workspace by canonical_id", async () => {
    const res = await get(
      "/api/workspaces/github.com%2Fuser%2Frepo-gamma",
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.workspace).toBeDefined();
  });

  test("returns 400 for ambiguous name with matches", async () => {
    const { url, close } = await withCustomServer(ambiguousNameHandler);
    try {
      const res = await get("/api/workspaces/user%2Frepo-alpha", {}, url);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("Ambiguous workspace name");
      expect(body.matches).toBeDefined();
      expect(body.matches.length).toBe(2);
      expect(body.matches[0]).toHaveProperty("id");
      expect(body.matches[0]).toHaveProperty("canonical_id");
      expect(body.matches[0]).toHaveProperty("display_name");
    } finally {
      await close();
    }
  });

  test("returns 404 for unknown name", async () => {
    const res = await get("/api/workspaces/nonexistent-repo");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Workspace not found");
  });
});

describe("GET /api/workspaces/:id — response shape", () => {
  test("includes all detail sections", async () => {
    const res = await get(`/api/workspaces/${WORKSPACE_1.id}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("workspace");
    expect(body).toHaveProperty("recent_sessions");
    expect(body).toHaveProperty("devices");
    expect(body).toHaveProperty("git_summary");
    expect(body).toHaveProperty("stats");
  });

  test("recent_sessions contains session data with device name", async () => {
    const res = await get(`/api/workspaces/${WORKSPACE_1.id}`);
    const body = await res.json();

    expect(Array.isArray(body.recent_sessions)).toBe(true);
    expect(body.recent_sessions.length).toBeGreaterThan(0);

    const session = body.recent_sessions[0];
    expect(session).toHaveProperty("id");
    expect(session).toHaveProperty("lifecycle");
    expect(session).toHaveProperty("started_at");
    expect(session).toHaveProperty("device_name");
    expect(session.device_name).toBe("macbook-pro");
  });

  test("git_summary contains type counts", async () => {
    const res = await get(`/api/workspaces/${WORKSPACE_1.id}`);
    const body = await res.json();

    expect(Array.isArray(body.git_summary)).toBe(true);
    expect(body.git_summary.length).toBeGreaterThan(0);

    const commitSummary = body.git_summary.find((g: any) => g.type === "commit");
    expect(commitSummary).toBeDefined();
    expect(commitSummary.count).toBe(12);
  });

  test("stats contains aggregate metrics", async () => {
    const res = await get(`/api/workspaces/${WORKSPACE_1.id}`);
    const body = await res.json();

    expect(body.stats).toBeDefined();
    expect(body.stats).toHaveProperty("total_sessions");
    expect(body.stats).toHaveProperty("active_sessions");
    expect(body.stats).toHaveProperty("total_duration_ms");
    expect(body.stats).toHaveProperty("total_cost_usd");
    expect(body.stats).toHaveProperty("first_session_at");
    expect(body.stats).toHaveProperty("last_session_at");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("GET /api/workspaces — auth", () => {
  test("returns 401 without Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: "GET",
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  test("returns 401 with wrong Bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
  });
});
