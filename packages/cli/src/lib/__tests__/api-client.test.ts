/**
 * Tests for the FuelApiClient class and related utilities.
 *
 * Uses Bun.serve() as a mock HTTP server to test real HTTP round-trips
 * rather than mocking fetch. Tests cover all endpoints, error handling,
 * timeout behavior, parameter mapping, envelope unwrapping, and
 * resolveWorkspaceName logic.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import {
  FuelApiClient,
  ApiError,
  ApiConnectionError,
  createApiClient,
  type WorkspaceSummary,
  type PaginatedResponse,
} from "../api-client.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server
// ---------------------------------------------------------------------------

/** Captured request data for assertions */
interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let server: Server;
let serverPort: number;
let lastRequest: CapturedRequest;
let nextResponse: { status: number; body: unknown; headers?: Record<string, string> } = {
  status: 200,
  body: { ok: true },
};

/** Set the next response the mock server will return */
function mockResponse(status: number, body: unknown, headers?: Record<string, string>) {
  nextResponse = { status, body, headers };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0, // Let OS pick an available port
    async fetch(req) {
      const url = new URL(req.url);
      let body: unknown = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try {
          body = await req.json();
        } catch {
          body = null;
        }
      }

      lastRequest = {
        method: req.method,
        url: url.pathname + url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };

      const respHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...(nextResponse.headers ?? {}),
      };

      return new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: respHeaders,
      });
    },
  });
  serverPort = server.port;
});

afterAll(() => {
  server.stop();
});

/** Create a FuelApiClient pointing at the mock server */
function makeClient(timeout?: number): FuelApiClient {
  return new FuelApiClient({
    baseUrl: `http://localhost:${serverPort}`,
    apiKey: "test-api-key-123",
    timeout: timeout ?? 5000,
  });
}

/** Helper to create a mock WorkspaceSummary */
function makeWorkspaceSummary(name: string, id?: string): WorkspaceSummary {
  return {
    id: id ?? `ws-${name}`,
    canonical_id: `github.com/user/${name}`,
    display_name: name,
    default_branch: "main",
    session_count: 5,
    active_session_count: 1,
    last_session_at: "2025-01-01T00:00:00Z",
    device_count: 2,
    total_cost_usd: 1.23,
    total_duration_ms: 3600000,
    first_seen_at: "2024-06-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  } as WorkspaceSummary;
}

// ---------------------------------------------------------------------------
// Tests: Constructor and Configuration
// ---------------------------------------------------------------------------

describe("FuelApiClient — constructor", () => {
  it("strips trailing slashes from baseUrl", () => {
    const client = new FuelApiClient({
      baseUrl: "http://example.com///",
      apiKey: "key",
    });
    expect(client).toBeDefined();
  });

  it("defaults timeout to 10s", () => {
    const client = new FuelApiClient({
      baseUrl: "http://example.com",
      apiKey: "key",
    });
    expect(client).toBeDefined();
  });

  it("accepts custom timeout", () => {
    const client = new FuelApiClient({
      baseUrl: "http://example.com",
      apiKey: "key",
      timeout: 3000,
    });
    expect(client).toBeDefined();
  });
});

describe("FuelApiClient — fromConfig", () => {
  it("creates client with baseUrl and apiKey from config", () => {
    const client = FuelApiClient.fromConfig({
      backend: { url: "http://localhost:4000", api_key: "cfg-key" },
    } as any);
    expect(client).toBeInstanceOf(FuelApiClient);
  });
});

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

describe("FuelApiClient — authentication", () => {
  it("sends Authorization header with Bearer token", async () => {
    mockResponse(200, { status: "ok", postgres: true, redis: true, ws_clients: 0, uptime: 100, version: "1.0.0" });
    const client = makeClient();
    await client.getHealth();

    expect(lastRequest.headers.authorization).toBe("Bearer test-api-key-123");
  });

  it("sends Content-Type application/json for POST requests", async () => {
    mockResponse(200, { ingested: 1, duplicates: 0 });
    const client = makeClient();
    await client.ingest([]);

    expect(lastRequest.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Tests: Session Endpoints (with envelope unwrapping)
// ---------------------------------------------------------------------------

describe("FuelApiClient — session endpoints", () => {
  it("listSessions sends GET /api/sessions with camelCase mapped to snake_case params", async () => {
    mockResponse(200, { sessions: [], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.listSessions({
      workspaceId: "ws-123",
      lifecycle: "capturing",
      limit: 10,
      cursor: "abc",
    });

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toContain("/api/sessions");
    expect(lastRequest.url).toContain("workspace_id=ws-123");
    expect(lastRequest.url).toContain("lifecycle=capturing");
    expect(lastRequest.url).toContain("limit=10");
    expect(lastRequest.url).toContain("cursor=abc");
    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("listSessions omits undefined params", async () => {
    mockResponse(200, { sessions: [], next_cursor: null, has_more: false });
    const client = makeClient();

    await client.listSessions({ limit: 20 });

    expect(lastRequest.url).toContain("limit=20");
    expect(lastRequest.url).not.toContain("workspace_id");
    expect(lastRequest.url).not.toContain("lifecycle");
  });

  it("listSessions returns PaginatedResponse with data, nextCursor, hasMore", async () => {
    const session = { id: "sess-001", lifecycle: "capturing" };
    mockResponse(200, { sessions: [session], next_cursor: "cursor-abc", has_more: true });
    const client = makeClient();

    const result = await client.listSessions();

    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("sess-001");
    expect(result.nextCursor).toBe("cursor-abc");
    expect(result.hasMore).toBe(true);
  });

  it("getSession sends GET /api/sessions/:id and unwraps { session } envelope", async () => {
    const mockSession = { id: "sess-001", lifecycle: "capturing" };
    mockResponse(200, { session: mockSession });
    const client = makeClient();

    const result = await client.getSession("sess-001");

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/api/sessions/sess-001");
    expect(result.id).toBe("sess-001");
  });

  it("getTranscript sends GET /api/sessions/:id/transcript and unwraps { messages }", async () => {
    mockResponse(200, { messages: [{ id: "msg-1", session_id: "sess-001" }] });
    const client = makeClient();

    const result = await client.getTranscript("sess-001");

    expect(lastRequest.url).toBe("/api/sessions/sess-001/transcript");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-1");
  });

  it("getSessionEvents sends GET /api/sessions/:id/events and unwraps { events }", async () => {
    mockResponse(200, { events: [{ id: "evt-1", type: "git.commit" }] });
    const client = makeClient();

    const result = await client.getSessionEvents("sess-001");

    expect(lastRequest.url).toBe("/api/sessions/sess-001/events");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("evt-1");
  });

  it("getSessionGit sends GET /api/sessions/:id/git and unwraps { git_activity }", async () => {
    mockResponse(200, { git_activity: [{ id: "git-1", type: "commit" }] });
    const client = makeClient();

    const result = await client.getSessionGit("sess-001");

    expect(lastRequest.url).toBe("/api/sessions/sess-001/git");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("git-1");
  });

  it("updateSession sends PATCH /api/sessions/:id and unwraps { session }", async () => {
    mockResponse(200, { session: { id: "sess-001", tags: ["test"] } });
    const client = makeClient();

    const result = await client.updateSession("sess-001", { tags: ["test"] });

    expect(lastRequest.method).toBe("PATCH");
    expect(lastRequest.url).toBe("/api/sessions/sess-001");
    expect(lastRequest.body).toEqual({ tags: ["test"] });
    expect(result.id).toBe("sess-001");
  });

  it("reparseSession sends POST /api/sessions/:id/reparse", async () => {
    mockResponse(200, { status: "queued" });
    const client = makeClient();

    await client.reparseSession("sess-001");

    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/api/sessions/sess-001/reparse");
  });
});

// ---------------------------------------------------------------------------
// Tests: Workspace Endpoints (with envelope unwrapping)
// ---------------------------------------------------------------------------

describe("FuelApiClient — workspace endpoints", () => {
  it("listWorkspaces sends GET /api/workspaces with cursor param", async () => {
    mockResponse(200, { workspaces: [], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.listWorkspaces({ cursor: "abc", limit: 25 });

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toContain("/api/workspaces");
    expect(lastRequest.url).toContain("cursor=abc");
    expect(lastRequest.url).toContain("limit=25");
    expect(result.data).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("listWorkspaces returns PaginatedResponse with data, nextCursor, hasMore", async () => {
    const ws = makeWorkspaceSummary("my-repo");
    mockResponse(200, { workspaces: [ws], next_cursor: "next-cursor", has_more: true });
    const client = makeClient();

    const result = await client.listWorkspaces();

    expect(result.data).toHaveLength(1);
    expect(result.data[0].display_name).toBe("my-repo");
    expect(result.nextCursor).toBe("next-cursor");
    expect(result.hasMore).toBe(true);
  });

  it("getWorkspace sends GET /api/workspaces/:id and returns full detail", async () => {
    const mockResp = {
      workspace: { id: "ws-001", display_name: "my-repo" },
      recent_sessions: [],
      devices: [],
      git_summary: { total_commits: 0, total_pushes: 0, active_branches: [], last_commit_at: null },
      stats: { total_sessions: 0, total_duration_ms: 0, total_cost_usd: 0, first_session_at: null, last_session_at: null },
    };
    mockResponse(200, mockResp);
    const client = makeClient();

    const result = await client.getWorkspace("ws-001");

    expect(lastRequest.url).toBe("/api/workspaces/ws-001");
    expect(result.workspace.display_name).toBe("my-repo");
    expect(result.stats).toBeDefined();
    expect(result.git_summary).toBeDefined();
  });

  it("getWorkspace URL-encodes the path segment for canonical_id", async () => {
    const mockResp = {
      workspace: { id: "ws-001", display_name: "my-repo" },
      recent_sessions: [],
      devices: [],
      git_summary: { total_commits: 0, total_pushes: 0, active_branches: [], last_commit_at: null },
      stats: { total_sessions: 0, total_duration_ms: 0, total_cost_usd: 0, first_session_at: null, last_session_at: null },
    };
    mockResponse(200, mockResp);
    const client = makeClient();

    await client.getWorkspace("canonical/id");

    // Should URL-encode the slash
    expect(lastRequest.url).toBe("/api/workspaces/canonical%2Fid");
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveWorkspaceName (returns ULID string, not WorkspaceSummary)
// ---------------------------------------------------------------------------

describe("FuelApiClient — resolveWorkspaceName", () => {
  it("returns exact match ULID (case-insensitive)", async () => {
    const ws = makeWorkspaceSummary("MyProject", "ulid-myproject");
    mockResponse(200, { workspaces: [ws], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.resolveWorkspaceName("myproject");
    expect(result).toBe("ulid-myproject");
  });

  it("returns single prefix match ULID", async () => {
    const ws1 = makeWorkspaceSummary("fuel-code", "ulid-fuel-code");
    const ws2 = makeWorkspaceSummary("other-project", "ulid-other");
    mockResponse(200, { workspaces: [ws1, ws2], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.resolveWorkspaceName("fuel");
    expect(result).toBe("ulid-fuel-code");
  });

  it("throws ApiError on ambiguous prefix match", async () => {
    const ws1 = makeWorkspaceSummary("fuel-code");
    const ws2 = makeWorkspaceSummary("fuel-web");
    mockResponse(200, { workspaces: [ws1, ws2], next_cursor: null, has_more: false });
    const client = makeClient();

    try {
      await client.resolveWorkspaceName("fuel");
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as ApiError).message).toContain("Ambiguous");
      expect((err as ApiError).message).toContain("fuel-code");
      expect((err as ApiError).message).toContain("fuel-web");
    }
  });

  it("throws ApiError 404 when no match found", async () => {
    const ws = makeWorkspaceSummary("other-project");
    mockResponse(200, { workspaces: [ws], next_cursor: null, has_more: false });
    const client = makeClient();

    try {
      await client.resolveWorkspaceName("nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(404);
      expect((err as ApiError).message).toContain("not found");
    }
  });

  it("prefers exact match over prefix match", async () => {
    const ws1 = makeWorkspaceSummary("fuel", "ulid-fuel");
    const ws2 = makeWorkspaceSummary("fuel-code", "ulid-fuel-code");
    mockResponse(200, { workspaces: [ws1, ws2], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.resolveWorkspaceName("fuel");
    expect(result).toBe("ulid-fuel");
  });
});

// ---------------------------------------------------------------------------
// Tests: Device Endpoints (bare array, not paginated)
// ---------------------------------------------------------------------------

describe("FuelApiClient — device endpoints", () => {
  it("listDevices sends GET /api/devices and returns bare array", async () => {
    const devices = [{ id: "dev-1", name: "macbook" }, { id: "dev-2", name: "linux-box" }];
    mockResponse(200, { devices });
    const client = makeClient();

    const result = await client.listDevices();

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/api/devices");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("dev-1");
  });

  it("getDevice sends GET /api/devices/:id and returns full detail", async () => {
    const mockResp = {
      device: { id: "dev-001", name: "macbook" },
      workspaces: [],
      recent_sessions: [],
    };
    mockResponse(200, mockResp);
    const client = makeClient();

    const result = await client.getDevice("dev-001");

    expect(lastRequest.url).toBe("/api/devices/dev-001");
    expect(result.device.name).toBe("macbook");
    expect(result.workspaces).toEqual([]);
    expect(result.recent_sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: Timeline Endpoint (discriminated union: type not kind)
// ---------------------------------------------------------------------------

describe("FuelApiClient — timeline endpoint", () => {
  it("getTimeline sends GET /api/timeline with camelCase mapped to snake_case params", async () => {
    mockResponse(200, { items: [], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.getTimeline({
      workspaceId: "ws-001",
      after: "2025-01-01",
      before: "2025-12-31",
      types: "session,git_activity",
    });

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toContain("/api/timeline");
    expect(lastRequest.url).toContain("workspace_id=ws-001");
    expect(lastRequest.url).toContain("after=2025-01-01");
    expect(lastRequest.url).toContain("before=2025-12-31");
    expect(lastRequest.url).toContain("types=session%2Cgit_activity");
    expect(result.items).toEqual([]);
    expect(result.next_cursor).toBeNull();
    expect(result.has_more).toBe(false);
  });

  it("getTimeline works without params", async () => {
    mockResponse(200, { items: [], next_cursor: null, has_more: false });
    const client = makeClient();

    const result = await client.getTimeline();

    expect(lastRequest.url).toBe("/api/timeline");
    expect(result.has_more).toBe(false);
  });

  it("getTimeline returns items as discriminated union with type field", async () => {
    const sessionItem = {
      type: "session",
      session: {
        id: "sess-1",
        workspace_id: "ws-1",
        workspace_name: "my-repo",
        device_id: "dev-1",
        device_name: "macbook",
        lifecycle: "summarized",
        started_at: "2025-01-01T00:00:00Z",
        ended_at: "2025-01-01T01:00:00Z",
        duration_ms: 3600000,
        summary: "Worked on feature",
        cost_estimate_usd: 0.50,
        total_messages: 20,
        tags: ["feature"],
      },
      git_activity: [],
    };
    const orphanItem = {
      type: "git_activity",
      workspace_id: "ws-1",
      workspace_name: "my-repo",
      device_id: "dev-1",
      device_name: "macbook",
      git_activity: [{ id: "g-1", type: "commit", branch: "main", commit_sha: "abc", message: "fix", files_changed: 1, timestamp: "2025-01-01T00:00:00Z", data: {} }],
      started_at: "2025-01-01T00:00:00Z",
    };
    mockResponse(200, { items: [sessionItem, orphanItem], next_cursor: "next", has_more: true });
    const client = makeClient();

    const result = await client.getTimeline();

    expect(result.items).toHaveLength(2);
    expect(result.items[0].type).toBe("session");
    expect(result.items[1].type).toBe("git_activity");
    expect(result.next_cursor).toBe("next");
    expect(result.has_more).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: System Endpoint (HealthStatus with full fields)
// ---------------------------------------------------------------------------

describe("FuelApiClient — system endpoints", () => {
  it("getHealth sends GET /api/health and returns HealthStatus", async () => {
    mockResponse(200, { status: "ok", postgres: true, redis: true, ws_clients: 5, uptime: 12345, version: "1.0.0" });
    const client = makeClient();

    const result = await client.getHealth();

    expect(lastRequest.url).toBe("/api/health");
    expect(result.status).toBe("ok");
    expect(result.postgres).toBe(true);
    expect(result.redis).toBe(true);
    expect(result.ws_clients).toBe(5);
    expect(result.uptime).toBe(12345);
    expect(result.version).toBe("1.0.0");
  });

  it("health() returns true on 2xx", async () => {
    mockResponse(200, { status: "ok" });
    const client = makeClient();

    const result = await client.health();
    expect(result).toBe(true);
  });

  it("health() returns false on non-2xx", async () => {
    mockResponse(503, { error: "down" });
    const client = makeClient();

    const result = await client.health();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Ingest Endpoint
// ---------------------------------------------------------------------------

describe("FuelApiClient — ingest endpoint", () => {
  it("ingest sends POST /api/events/ingest with events body", async () => {
    mockResponse(200, { ingested: 2, duplicates: 0 });
    const client = makeClient();

    const events = [
      { id: "evt-1", type: "git.commit", timestamp: "2025-01-01", device_id: "d1", workspace_id: "w1", session_id: null, data: {}, ingested_at: null, blob_refs: [] },
      { id: "evt-2", type: "git.push", timestamp: "2025-01-01", device_id: "d1", workspace_id: "w1", session_id: null, data: {}, ingested_at: null, blob_refs: [] },
    ];

    const result = await client.ingest(events as any);

    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/api/events/ingest");
    expect((lastRequest.body as any).events).toHaveLength(2);
    expect(result.ingested).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Error Handling (with JSON body parsing for .error field)
// ---------------------------------------------------------------------------

describe("FuelApiClient — error handling", () => {
  it("throws ApiError on 400 response with server error message", async () => {
    mockResponse(400, { error: "Bad request" });
    const client = makeClient();

    try {
      await client.getSession("invalid");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as ApiError).message).toBe("Bad request");
    }
  });

  it("throws ApiError on 401 response", async () => {
    mockResponse(401, { error: "Unauthorized" });
    const client = makeClient();

    try {
      await client.getHealth();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(401);
      expect((err as ApiError).message).toBe("Unauthorized");
    }
  });

  it("throws ApiError on 404 response with server error message", async () => {
    mockResponse(404, { error: "Not found" });
    const client = makeClient();

    try {
      await client.getSession("nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(404);
      expect((err as ApiError).message).toBe("Not found");
    }
  });

  it("throws ApiError on 500 response with server error message in body", async () => {
    mockResponse(500, { error: "Internal server error" });
    const client = makeClient();

    try {
      await client.listSessions();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(500);
      expect((err as ApiError).message).toBe("Internal server error");
      // Body should be the parsed JSON object
      expect((err as ApiError).body).toEqual({ error: "Internal server error" });
    }
  });

  it("throws ApiConnectionError on network failure", async () => {
    // Point to a port that nothing is listening on
    const client = new FuelApiClient({
      baseUrl: "http://localhost:1",
      apiKey: "key",
      timeout: 1000,
    });

    try {
      await client.getHealth();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiConnectionError);
      expect((err as ApiConnectionError).message).toContain("Failed to GET /api/health");
    }
  });

  it("throws ApiConnectionError on timeout", async () => {
    // Create a server that delays response
    const slowServer = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return new Response("too late");
      },
    });

    const client = new FuelApiClient({
      baseUrl: `http://localhost:${slowServer.port}`,
      apiKey: "key",
      timeout: 100, // Very short timeout
    });

    try {
      await client.getHealth();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiConnectionError);
    } finally {
      slowServer.stop();
    }
  });

  it("ApiError includes status code and body", () => {
    const err = new ApiError("test error", 422, { detail: "invalid" });
    expect(err.statusCode).toBe(422);
    expect(err.body).toEqual({ detail: "invalid" });
    expect(err.name).toBe("ApiError");
    expect(err.message).toBe("test error");
  });

  it("ApiConnectionError includes cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new ApiConnectionError("connection failed", cause);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("ApiConnectionError");
    expect(err.message).toBe("connection failed");
  });
});

// ---------------------------------------------------------------------------
// Tests: createApiClient backward compatibility
// ---------------------------------------------------------------------------

describe("createApiClient — backward compatibility", () => {
  it("returns an object with ingest() and health() methods", () => {
    const config = {
      backend: { url: `http://localhost:${serverPort}`, api_key: "test-key" },
      device: { id: "dev-1", name: "test", type: "local" as const },
      pipeline: { queue_path: "/tmp/q", drain_interval_seconds: 30, batch_size: 50, post_timeout_ms: 2000 },
    };

    const client = createApiClient(config);
    expect(typeof client.ingest).toBe("function");
    expect(typeof client.health).toBe("function");
  });

  it("ingest() sends correct headers and body", async () => {
    mockResponse(200, { ingested: 1, duplicates: 0 });
    const config = {
      backend: { url: `http://localhost:${serverPort}`, api_key: "legacy-key" },
      device: { id: "dev-1", name: "test", type: "local" as const },
      pipeline: { queue_path: "/tmp/q", drain_interval_seconds: 30, batch_size: 50, post_timeout_ms: 2000 },
    };

    const client = createApiClient(config);
    const result = await client.ingest([]);

    expect(lastRequest.headers.authorization).toBe("Bearer legacy-key");
    expect(result.ingested).toBe(1);
  });

  it("health() returns true on 2xx", async () => {
    mockResponse(200, { status: "ok" });
    const config = {
      backend: { url: `http://localhost:${serverPort}`, api_key: "key" },
      device: { id: "dev-1", name: "test", type: "local" as const },
      pipeline: { queue_path: "/tmp/q", drain_interval_seconds: 30, batch_size: 50, post_timeout_ms: 2000 },
    };

    const client = createApiClient(config);
    expect(await client.health()).toBe(true);
  });

  it("health() returns false on error", async () => {
    mockResponse(503, { error: "down" });
    const config = {
      backend: { url: `http://localhost:${serverPort}`, api_key: "key" },
      device: { id: "dev-1", name: "test", type: "local" as const },
      pipeline: { queue_path: "/tmp/q", drain_interval_seconds: 30, batch_size: 50, post_timeout_ms: 2000 },
    };

    const client = createApiClient(config);
    expect(await client.health()).toBe(false);
  });
});
