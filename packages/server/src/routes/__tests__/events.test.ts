/**
 * Integration tests for POST /api/events/ingest.
 *
 * Creates a real Express app via createApp() with mocked sql and redis,
 * starts it on an OS-assigned port, and sends HTTP requests with fetch.
 *
 * Test coverage:
 *   - Valid single event → 202 { ingested: 1 }
 *   - Valid batch of 5 → 202 { ingested: 5 }
 *   - Empty events array → 400
 *   - 101 events (exceeds max batch size) → 400
 *   - Invalid ULID in event id → 400
 *   - session.start with valid payload → 202
 *   - session.start with missing cwd → 202 with rejected: 1
 *   - No auth header → 401
 *   - Redis total failure → 503
 *   - Mixed batch: some valid, some invalid payload → partial acceptance
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Server } from "node:http";
import { createApp } from "../../app.js";
import type { AppDeps } from "../../app.js";
import { generateId } from "@fuel-code/shared";
import type { Event } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_events";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// ---------------------------------------------------------------------------
// Helper: generate a valid Event object for tests
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: generateId(),
    type: "system.heartbeat",
    timestamp: new Date().toISOString(),
    device_id: "device-test-1",
    workspace_id: "ws-test-1",
    session_id: null,
    data: { status: "alive" },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/**
 * Generate a valid session.start event with all required payload fields.
 */
function makeSessionStartEvent(
  dataOverrides: Record<string, unknown> = {},
): Event {
  return makeEvent({
    type: "session.start",
    session_id: "session-test-1",
    data: {
      cc_session_id: "cc-sess-123",
      cwd: "/home/user/project",
      git_branch: "main",
      git_remote: "https://github.com/user/repo.git",
      cc_version: "1.0.0",
      model: "claude-opus-4-20250514",
      source: "startup",
      transcript_path: "s3://bucket/transcripts/123.json",
      ...dataOverrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

/**
 * Create a mock Redis that succeeds by default.
 * The pipeline mock simulates successful XADD for every event.
 */
function createMockRedis() {
  const mockPipeline = {
    xadd: mock(function (this: typeof mockPipeline) {
      return this;
    }),
    exec: mock(() => Promise.resolve([] as Array<[null, string]>)),
  };

  return {
    pipeline: mock(() => mockPipeline),
    // Health check support (used by /api/health)
    ping: mock(() => Promise.resolve("PONG")),
    // Allow tests to override exec behavior
    _mockPipeline: mockPipeline,
  };
}

/**
 * Set the pipeline exec mock to simulate successful publish for N events.
 */
function mockSuccessfulPublish(
  mockRedis: ReturnType<typeof createMockRedis>,
  count: number,
) {
  mockRedis._mockPipeline.exec.mockImplementation(() =>
    Promise.resolve(
      Array.from({ length: count }, (_, i) => [null, `${Date.now()}-${i}`]),
    ),
  );
}

/**
 * Create a mock sql object (postgres.js) that satisfies health checks.
 */
function createMockSql() {
  // The health check runs `sql\`SELECT 1\`` — mock as a tagged template function
  const sqlFn = () => Promise.resolve([{ "?column?": 1 }]);
  // Tagged template literal call: sql`SELECT 1` invokes the function with template parts
  return new Proxy(sqlFn, {
    apply: () => Promise.resolve([{ "?column?": 1 }]),
  });
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let mockRedis: ReturnType<typeof createMockRedis>;

beforeAll(async () => {
  mockRedis = createMockRedis();
  const mockSql = createMockSql();

  const app = createApp({
    sql: mockSql as unknown as AppDeps["sql"],
    redis: mockRedis as unknown as AppDeps["redis"],
    apiKey: TEST_API_KEY,
  });

  // Start on port 0 to get an OS-assigned free port
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
// Helper: send a POST to /api/events/ingest
// ---------------------------------------------------------------------------

async function ingest(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/events/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_HEADER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/events/ingest", () => {
  test("valid single event → 202 with ingested: 1", async () => {
    const event = makeEvent();
    mockSuccessfulPublish(mockRedis, 1);

    const res = await ingest({ events: [event] });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.rejected).toBe(0);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({ index: 0, status: "accepted" });
  });

  test("valid batch of 5 → 202 with ingested: 5", async () => {
    const events = Array.from({ length: 5 }, () => makeEvent());
    mockSuccessfulPublish(mockRedis, 5);

    const res = await ingest({ events });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBe(5);
    expect(body.rejected).toBe(0);
    expect(body.results).toHaveLength(5);
  });

  test("empty events array → 400", async () => {
    const res = await ingest({ events: [] });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details).toBeDefined();
  });

  test("101 events (exceeds max batch of 100) → 400", async () => {
    const events = Array.from({ length: 101 }, () => makeEvent());

    const res = await ingest({ events });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  test("event with invalid ULID id → 400", async () => {
    const event = makeEvent({ id: "not-a-valid-ulid!!!" });

    const res = await ingest({ events: [event] });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    // Zod should report the ULID format issue
    expect(body.details).toBeDefined();
    expect(body.details.length).toBeGreaterThan(0);
  });

  test("session.start with valid payload → 202", async () => {
    const event = makeSessionStartEvent();
    mockSuccessfulPublish(mockRedis, 1);

    const res = await ingest({ events: [event] });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(body.rejected).toBe(0);
  });

  test("session.start with missing cwd → 202 with rejected: 1", async () => {
    // Create a session.start event but remove the required 'cwd' field
    const event = makeEvent({
      type: "session.start",
      session_id: "session-test-2",
      data: {
        cc_session_id: "cc-sess-456",
        // cwd is missing — this should cause payload validation to fail
        git_branch: "main",
        git_remote: null,
        cc_version: "1.0.0",
        model: null,
        source: "startup",
        transcript_path: "s3://bucket/t/456.json",
      },
    });

    const res = await ingest({ events: [event] });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual({ index: 0, status: "rejected" });
    expect(body.errors).toBeDefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].index).toBe(0);
    expect(body.errors[0].error).toContain("session.start");
  });

  test("no auth header → 401", async () => {
    const event = makeEvent();

    const res = await fetch(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [event] }),
    });

    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  test("Redis total failure → 503 with retry_after_seconds", async () => {
    const event = makeEvent();

    // Make the pipeline throw entirely (simulates Redis connection failure)
    mockRedis._mockPipeline.exec.mockImplementation(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    const res = await ingest({ events: [event] });
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.error).toBe("Event pipeline temporarily unavailable");
    expect(body.retry_after_seconds).toBe(30);
  });

  test("mixed batch: valid + invalid payload → partial acceptance", async () => {
    // Event 0: valid git.commit (no payload schema registered → accepted)
    const validEvent = makeEvent();

    // Event 1: valid session.start → accepted
    const validSessionEvent = makeSessionStartEvent();

    // Event 2: session.start missing cwd → rejected
    const invalidSessionEvent = makeEvent({
      type: "session.start",
      session_id: "session-test-3",
      data: {
        cc_session_id: "cc-sess-789",
        // cwd missing
        git_branch: null,
        git_remote: null,
        cc_version: "1.0.0",
        model: null,
        source: "startup",
        transcript_path: "s3://bucket/t/789.json",
      },
    });

    // 2 valid events will be published
    mockSuccessfulPublish(mockRedis, 2);

    const res = await ingest({
      events: [validEvent, validSessionEvent, invalidSessionEvent],
    });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBe(2);
    expect(body.rejected).toBe(1);
    expect(body.results).toHaveLength(3);
    expect(body.results[0].status).toBe("accepted");
    expect(body.results[1].status).toBe("accepted");
    expect(body.results[2].status).toBe("rejected");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].index).toBe(2);
  });

  test("event with unregistered type (no schema) → accepted (forward-compatible)", async () => {
    // system.heartbeat has no registered payload schema — should pass through
    const event = makeEvent({
      type: "system.heartbeat",
      data: { remote: "origin", branch: "main", arbitrary_field: true },
    });
    mockSuccessfulPublish(mockRedis, 1);

    const res = await ingest({ events: [event] });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBe(1);
    expect(body.rejected).toBe(0);
  });
});
