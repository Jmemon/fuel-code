/**
 * Integration tests for session API endpoints.
 *
 * Uses a real Express app with mock SQL/Redis/S3 dependencies.
 * The mock SQL is a proxy that intercepts postgres.js tagged template calls
 * and returns canned data based on query patterns.
 *
 * Test coverage:
 *   - GET /api/sessions: list, filtering params, pagination, validation
 *   - GET /api/sessions/:id: detail, 404
 *   - GET /api/sessions/:id/transcript: parsed messages, unparsed 404
 *   - GET /api/sessions/:id/transcript/raw: presigned URL, redirect, 404
 *   - GET /api/sessions/:id/events: session events, 404
 *   - GET /api/sessions/:id/git: stub response
 *   - PATCH /api/sessions/:id: tags, add_tags, remove_tags, summary, validation
 *   - Auth: 401 without token
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { logger } from "../../logger.js";
import { createAuthMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createSessionsRouter } from "../sessions.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_sessions";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// Sample test data
// ---------------------------------------------------------------------------

const SESSION_PARSED = {
  id: "sess-01",
  workspace_id: "ws-01",
  device_id: "dev-01",
  lifecycle: "parsed",
  parse_status: "completed",
  parse_error: null,
  started_at: "2025-01-15T10:00:00.000Z",
  ended_at: "2025-01-15T11:00:00.000Z",
  transcript_s3_key: "transcripts/ws-01/sess-01/raw.jsonl",
  tags: ["bugfix", "frontend"],
  summary: "Fixed a CSS bug",
  metadata: {},
  total_messages: 10,
  user_messages: 5,
  assistant_messages: 5,
  workspace_canonical_id: "github.com/user/repo",
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

const SESSION_UNPARSED = {
  id: "sess-02",
  workspace_id: "ws-01",
  device_id: "dev-01",
  lifecycle: "ended",
  parse_status: "pending",
  parse_error: null,
  started_at: "2025-01-15T12:00:00.000Z",
  ended_at: "2025-01-15T13:00:00.000Z",
  transcript_s3_key: null,
  tags: ["refactor"],
  summary: null,
  metadata: {},
  workspace_canonical_id: "github.com/user/repo",
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

const SESSION_SUMMARIZED = {
  id: "sess-03",
  workspace_id: "ws-01",
  device_id: "dev-01",
  lifecycle: "summarized",
  parse_status: "completed",
  parse_error: null,
  started_at: "2025-01-15T14:00:00.000Z",
  ended_at: "2025-01-15T15:00:00.000Z",
  transcript_s3_key: "transcripts/ws-01/sess-03/raw.jsonl",
  tags: ["feature"],
  summary: "Added new dashboard",
  metadata: {},
  total_messages: 20,
  workspace_canonical_id: "github.com/user/repo",
  workspace_name: "user/repo",
  device_name: "macbook-pro",
};

const ALL_SESSIONS = [SESSION_PARSED, SESSION_UNPARSED, SESSION_SUMMARIZED];

const TRANSCRIPT_MESSAGES = [
  {
    id: "msg-01",
    session_id: "sess-01",
    line_number: 1,
    ordinal: 1,
    message_type: "user",
    role: "human",
    model: null,
    has_text: true,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
    content_blocks: [],
  },
  {
    id: "msg-02",
    session_id: "sess-01",
    line_number: 2,
    ordinal: 2,
    message_type: "assistant",
    role: "assistant",
    model: "claude-opus-4-20250514",
    tokens_in: 100,
    tokens_out: 200,
    has_text: true,
    has_thinking: true,
    has_tool_use: false,
    has_tool_result: false,
    content_blocks: [
      { id: "cb-01", block_order: 0, block_type: "thinking", thinking_text: "Thinking..." },
      { id: "cb-02", block_order: 1, block_type: "text", content_text: "My answer." },
    ],
  },
];

const SESSION_EVENTS = [
  {
    id: "evt-01",
    type: "session.start",
    timestamp: "2025-01-15T10:00:00.000Z",
    session_id: "sess-01",
    workspace_id: "ws-01",
    device_id: "dev-01",
    data: { cwd: "/home/user/project" },
  },
];

// ---------------------------------------------------------------------------
// Mock SQL factory
// ---------------------------------------------------------------------------

/**
 * Build a mock postgres.js sql tagged template function.
 *
 * The real postgres.js sql is a function that acts as both:
 *   1. A tagged template literal: sql`SELECT * FROM ...`
 *   2. A helper function: sql({ col: val }) for SET, sql([a,b]) for IN
 *
 * This mock collects the raw template string parts and inspects them to
 * return appropriate canned data. The helper form (sql(obj)) returns a
 * pass-through marker for composition.
 *
 * @param queryHandler - Function that receives the joined query text and values,
 *                       and returns the mock result rows.
 */
function buildMockSql(
  queryHandler: (queryText: string, values: unknown[]) => unknown[],
) {
  // Helper form: sql({...}) or sql([...]) for composing fragments
  function sqlHelper(...args: unknown[]): unknown {
    // When called with an object (SET helper) or array (IN helper),
    // return a marker. These get composed into the template string.
    return args[0];
  }

  // Tagged template form: sql`SELECT ...`
  function sqlTaggedTemplate(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> {
    const queryText = strings.join("$");
    return Promise.resolve(queryHandler(queryText, values));
  }

  // The proxy makes the same function work as both tagged template and regular call
  const proxy = new Proxy(sqlTaggedTemplate, {
    apply(_target, _thisArg, args) {
      // If first arg is a TemplateStringsArray (has .raw property), it's a tagged template
      if (args[0] && Array.isArray(args[0]) && "raw" in args[0]) {
        return sqlTaggedTemplate(
          args[0] as TemplateStringsArray,
          ...args.slice(1),
        );
      }
      // Otherwise it's the helper form: sql({...}) or sql([...])
      return sqlHelper(...args);
    },
  });

  return proxy;
}

// ---------------------------------------------------------------------------
// Mock S3 factory
// ---------------------------------------------------------------------------

function createMockS3() {
  return {
    presignedUrl: mock(
      async (key: string) => `https://s3.example.com/${key}?signed=true`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Test app factory — builds a minimal Express app with just auth + sessions
// ---------------------------------------------------------------------------

function buildTestApp(
  queryHandler: (queryText: string, values: unknown[]) => unknown[],
  s3?: ReturnType<typeof createMockS3>,
) {
  const sql = buildMockSql(queryHandler);
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createAuthMiddleware(TEST_API_KEY));
  app.use(
    "/api",
    createSessionsRouter({
      sql: sql as any,
      s3: s3 as any,
      logger,
    }),
  );
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// Default query handler — routes SQL patterns to canned data
// ---------------------------------------------------------------------------

function defaultQueryHandler(queryText: string, values: unknown[]): unknown[] {
  // Session list query: SELECT s.* ... FROM sessions s ... ORDER BY
  if (
    queryText.includes("FROM sessions s") &&
    queryText.includes("JOIN workspaces w") &&
    queryText.includes("ORDER BY")
  ) {
    return ALL_SESSIONS;
  }

  // Session detail: SELECT s.* ... WHERE s.id =
  if (
    queryText.includes("FROM sessions s") &&
    queryText.includes("JOIN workspaces w") &&
    queryText.includes("WHERE s.id =")
  ) {
    const id = values.find((v) => typeof v === "string");
    const session = ALL_SESSIONS.find((s) => s.id === id);
    return session ? [session] : [];
  }

  // Batch status: SELECT id, lifecycle, parse_status FROM sessions WHERE id IN (...)
  // Matches parse_status + WHERE id IN (no workspace join, no single-id WHERE =)
  if (
    queryText.includes("parse_status") &&
    queryText.includes("WHERE id IN")
  ) {
    // values[0] is the array of session IDs passed via sql(session_ids)
    const ids = values[0] as string[] | undefined;
    if (Array.isArray(ids)) {
      return ALL_SESSIONS.filter((s) => ids.includes(s.id));
    }
    return [];
  }

  // Session parse_status check: SELECT id, parse_status ... FROM sessions WHERE id =
  if (queryText.includes("parse_status") && queryText.includes("FROM sessions")) {
    const id = values.find((v) => typeof v === "string");
    const session = ALL_SESSIONS.find((s) => s.id === id);
    return session ? [session] : [];
  }

  // Session transcript_s3_key check
  if (queryText.includes("transcript_s3_key") && queryText.includes("FROM sessions")) {
    const id = values.find((v) => typeof v === "string");
    const session = ALL_SESSIONS.find((s) => s.id === id);
    return session ? [session] : [];
  }

  // Session existence check: SELECT id FROM sessions WHERE id =
  if (queryText.includes("FROM sessions") && queryText.includes("WHERE id =")) {
    const id = values.find((v) => typeof v === "string");
    const session = ALL_SESSIONS.find((s) => s.id === id);
    return session ? [session] : [];
  }

  // Transcript messages: FROM transcript_messages
  if (queryText.includes("FROM transcript_messages")) {
    const sessionId = values.find((v) => typeof v === "string");
    return TRANSCRIPT_MESSAGES.filter((m) => m.session_id === sessionId);
  }

  // Events: FROM events
  if (queryText.includes("FROM events")) {
    const sessionId = values.find((v) => typeof v === "string");
    return SESSION_EVENTS.filter((e) => e.session_id === sessionId);
  }

  // UPDATE sessions
  if (queryText.includes("UPDATE sessions")) {
    // Find the session id from values — it's the last string value in the update
    const id = values[values.length - 1];
    const session = ALL_SESSIONS.find((s) => s.id === id);
    return session ? [session] : [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let mockS3: ReturnType<typeof createMockS3>;

beforeAll(async () => {
  mockS3 = createMockS3();
  const app = buildTestApp(defaultQueryHandler, mockS3);

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

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: AUTH_HEADER, ...headers },
  });
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function patch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/sessions (list)
// ---------------------------------------------------------------------------

describe("GET /api/sessions", () => {
  test("returns sessions list with has_more and next_cursor fields", async () => {
    const res = await get("/api/sessions");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.sessions).toBeDefined();
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("next_cursor");
  });

  test("accepts workspace_id filter", async () => {
    const res = await get("/api/sessions?workspace_id=ws-01");
    expect(res.status).toBe(200);
  });

  test("accepts device_id filter", async () => {
    const res = await get("/api/sessions?device_id=dev-01");
    expect(res.status).toBe(200);
  });

  test("accepts valid lifecycle filter", async () => {
    const res = await get("/api/sessions?lifecycle=parsed,summarized");
    expect(res.status).toBe(200);
  });

  test("rejects invalid lifecycle value with 400", async () => {
    const res = await get("/api/sessions?lifecycle=invalid_state");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid lifecycle value");
  });

  test("accepts tag filter", async () => {
    const res = await get("/api/sessions?tag=bugfix");
    expect(res.status).toBe(200);
  });

  test("accepts time range filters", async () => {
    const res = await get(
      "/api/sessions?after=2025-01-01T00:00:00.000Z&before=2025-12-31T23:59:59.000Z",
    );
    expect(res.status).toBe(200);
  });

  test("accepts limit parameter", async () => {
    const res = await get("/api/sessions?limit=10");
    expect(res.status).toBe(200);
  });

  test("rejects limit=0 with 400 (min is 1)", async () => {
    const res = await get("/api/sessions?limit=0");
    expect(res.status).toBe(400);
  });

  test("rejects limit=999 with 400 (max is 250)", async () => {
    const res = await get("/api/sessions?limit=999");
    expect(res.status).toBe(400);
  });

  test("rejects invalid cursor with 400", async () => {
    const res = await get("/api/sessions?cursor=not-valid-json");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid cursor");
  });

  test("accepts valid base64 cursor", async () => {
    // Encode a valid cursor: { s: "2025-01-15T10:00:00.000Z", i: "sess-01" }
    const cursor = Buffer.from(
      JSON.stringify({ s: "2025-01-15T10:00:00.000Z", i: "sess-01" }),
    ).toString("base64");
    const res = await get(`/api/sessions?cursor=${cursor}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id (detail)
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id", () => {
  test("returns session detail for existing session", async () => {
    const res = await get("/api/sessions/sess-01");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.session).toBeDefined();
    expect(body.session.id).toBe("sess-01");
    expect(body.session.workspace_name).toBe("user/repo");
    expect(body.session.device_name).toBe("macbook-pro");
  });

  test("returns 404 for non-existent session", async () => {
    const res = await get("/api/sessions/nonexistent-id");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/transcript
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/transcript", () => {
  test("returns parsed messages for completed session", async () => {
    const res = await get("/api/sessions/sess-01/transcript");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.messages).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2);
  });

  test("returns 404 with parse info for unparsed session", async () => {
    const res = await get("/api/sessions/sess-02/transcript");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Transcript not yet available");
    expect(body.parse_status).toBe("pending");
    expect(body.lifecycle).toBe("ended");
  });

  test("returns 404 for non-existent session", async () => {
    const res = await get("/api/sessions/nonexistent-id/transcript");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/transcript/raw
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/transcript/raw", () => {
  test("returns presigned URL as JSON when redirect=false", async () => {
    const res = await get("/api/sessions/sess-01/transcript/raw?redirect=false");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.url).toBeDefined();
    expect(body.url).toContain("s3.example.com");
    expect(body.url).toContain("signed=true");
  });

  test("returns 302 redirect by default", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/sess-01/transcript/raw`,
      {
        method: "GET",
        headers: { Authorization: AUTH_HEADER },
        redirect: "manual",
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("s3.example.com");
  });

  test("returns 404 when session has no transcript_s3_key", async () => {
    const res = await get(
      "/api/sessions/sess-02/transcript/raw?redirect=false",
    );
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Raw transcript not available");
  });

  test("returns 404 for non-existent session", async () => {
    const res = await get(
      "/api/sessions/nonexistent-id/transcript/raw?redirect=false",
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/events
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/events", () => {
  test("returns events for existing session", async () => {
    const res = await get("/api/sessions/sess-01/events");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toBeDefined();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(1);
    expect(body.events[0].type).toBe("session.start");
  });

  test("returns 404 for non-existent session", async () => {
    const res = await get("/api/sessions/nonexistent-id/events");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:id/git
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:id/git", () => {
  test("returns empty git_activity array (Phase 3 stub)", async () => {
    const res = await get("/api/sessions/sess-01/git");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.git_activity).toEqual([]);
  });

  test("returns 404 for non-existent session", async () => {
    const res = await get("/api/sessions/nonexistent-id/git");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/sessions/:id (tags and summary)
// ---------------------------------------------------------------------------

describe("PATCH /api/sessions/:id", () => {
  test("updates summary", async () => {
    const res = await patch("/api/sessions/sess-01", {
      summary: "Updated summary text",
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.session).toBeDefined();
    expect(body.session.id).toBe("sess-01");
  });

  test("replaces tags with tags field", async () => {
    const res = await patch("/api/sessions/sess-01", {
      tags: ["new-tag-1", "new-tag-2"],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.session).toBeDefined();
  });

  test("adds tags with add_tags field", async () => {
    const res = await patch("/api/sessions/sess-01", {
      add_tags: ["extra-tag"],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.session).toBeDefined();
  });

  test("removes tags with remove_tags field", async () => {
    const res = await patch("/api/sessions/sess-01", {
      remove_tags: ["bugfix"],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.session).toBeDefined();
  });

  test("rejects multiple tag mutation modes with 400", async () => {
    const res = await patch("/api/sessions/sess-01", {
      tags: ["a"],
      add_tags: ["b"],
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid tag operation");
  });

  test("rejects all three tag modes with 400", async () => {
    const res = await patch("/api/sessions/sess-01", {
      tags: ["a"],
      add_tags: ["b"],
      remove_tags: ["c"],
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid tag operation");
  });

  test("returns 404 for non-existent session", async () => {
    const res = await patch("/api/sessions/nonexistent-id", {
      summary: "test",
    });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  test("rejects invalid body (tags must be array) with 400", async () => {
    const res = await patch("/api/sessions/sess-01", {
      tags: "not-an-array",
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid request body");
  });

  test("allows both summary and tags in same request", async () => {
    const res = await patch("/api/sessions/sess-01", {
      summary: "New summary",
      tags: ["tag-1"],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.session).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("Auth", () => {
  test("returns 401 without auth token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "GET",
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  test("returns 401 with wrong auth token", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "GET",
      headers: { Authorization: "Bearer wrong-key-here" },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/sessions/batch-status
// ---------------------------------------------------------------------------

describe("POST /api/sessions/batch-status", () => {
  test("returns lifecycle and parse_status for requested session IDs", async () => {
    const res = await post("/api/sessions/batch-status", {
      session_ids: ["sess-01", "sess-02", "sess-03"],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.statuses).toBeDefined();
    expect(body.not_found).toEqual([]);

    // Verify each session's status fields
    expect(body.statuses["sess-01"]).toEqual({
      lifecycle: "parsed",
      parse_status: "completed",
    });
    expect(body.statuses["sess-02"]).toEqual({
      lifecycle: "ended",
      parse_status: "pending",
    });
    expect(body.statuses["sess-03"]).toEqual({
      lifecycle: "summarized",
      parse_status: "completed",
    });
  });

  test("reports not_found for missing session IDs", async () => {
    const res = await post("/api/sessions/batch-status", {
      session_ids: ["sess-01", "nonexistent-a", "nonexistent-b"],
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.statuses["sess-01"]).toBeDefined();
    expect(body.not_found).toEqual(
      expect.arrayContaining(["nonexistent-a", "nonexistent-b"]),
    );
    expect(body.not_found.length).toBe(2);
  });

  test("returns 400 for empty session_ids array", async () => {
    const res = await post("/api/sessions/batch-status", {
      session_ids: [],
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid request body");
  });

  test("returns 400 for missing body", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: AUTH_HEADER,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Invalid request body");
  });

  test("returns 401 without auth", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/batch-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: ["sess-01"] }),
    });
    expect(res.status).toBe(401);
  });
});
