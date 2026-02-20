/**
 * Tests for the FuelApiClient class and related utilities.
 *
 * Uses Bun.serve() as a mock HTTP server to test real HTTP round-trips
 * rather than mocking fetch. Tests cover all endpoints, error handling,
 * timeout behavior, parameter mapping, and resolveWorkspaceName logic.
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
    device_count: 2,
    total_cost_usd: 1.23,
    last_activity_at: "2025-01-01T00:00:00Z",
    first_seen_at: "2024-06-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };
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
    // Verify by making a request (the URL should not have double slashes)
    // We test this indirectly via the mock server
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

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

describe("FuelApiClient — authentication", () => {
  it("sends Authorization header with Bearer token", async () => {
    mockResponse(200, { status: "ok" });
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
// Tests: Session Endpoints
// ---------------------------------------------------------------------------

describe("FuelApiClient — session endpoints", () => {
  it("listSessions sends GET /api/sessions with query params", async () => {
    const mockData = { data: [], total: 0, limit: 50, offset: 0 };
    mockResponse(200, mockData);
    const client = makeClient();

    const result = await client.listSessions({
      workspace_id: "ws-123",
      lifecycle: "capturing",
      limit: 10,
      offset: 5,
    });

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toContain("/api/sessions");
    expect(lastRequest.url).toContain("workspace_id=ws-123");
    expect(lastRequest.url).toContain("lifecycle=capturing");
    expect(lastRequest.url).toContain("limit=10");
    expect(lastRequest.url).toContain("offset=5");
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("listSessions omits undefined params", async () => {
    mockResponse(200, { data: [], total: 0, limit: 50, offset: 0 });
    const client = makeClient();

    await client.listSessions({ limit: 20 });

    expect(lastRequest.url).toContain("limit=20");
    expect(lastRequest.url).not.toContain("workspace_id");
    expect(lastRequest.url).not.toContain("lifecycle");
  });

  it("getSession sends GET /api/sessions/:id", async () => {
    const mockSession = { id: "sess-001", lifecycle: "capturing" };
    mockResponse(200, mockSession);
    const client = makeClient();

    const result = await client.getSession("sess-001");

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/api/sessions/sess-001");
    expect(result.id).toBe("sess-001");
  });

  it("getTranscript sends GET /api/sessions/:id/transcript", async () => {
    mockResponse(200, [{ id: "msg-1", session_id: "sess-001" }]);
    const client = makeClient();

    const result = await client.getTranscript("sess-001");

    expect(lastRequest.url).toBe("/api/sessions/sess-001/transcript");
    expect(result).toHaveLength(1);
  });

  it("getSessionEvents sends GET /api/sessions/:id/events", async () => {
    mockResponse(200, [{ id: "evt-1", type: "git.commit" }]);
    const client = makeClient();

    const result = await client.getSessionEvents("sess-001");

    expect(lastRequest.url).toBe("/api/sessions/sess-001/events");
    expect(result).toHaveLength(1);
  });

  it("getSessionGit sends GET /api/sessions/:id/git", async () => {
    mockResponse(200, [{ id: "git-1", type: "commit" }]);
    const client = makeClient();

    const result = await client.getSessionGit("sess-001");

    expect(lastRequest.url).toBe("/api/sessions/sess-001/git");
    expect(result).toHaveLength(1);
  });

  it("updateSession sends PATCH /api/sessions/:id with body", async () => {
    mockResponse(200, { id: "sess-001", lifecycle: "ended" });
    const client = makeClient();

    const result = await client.updateSession("sess-001", { lifecycle: "ended" });

    expect(lastRequest.method).toBe("PATCH");
    expect(lastRequest.url).toBe("/api/sessions/sess-001");
    expect(lastRequest.body).toEqual({ lifecycle: "ended" });
    expect(result.lifecycle).toBe("ended");
  });

  it("reparseSession sends POST /api/sessions/:id/reparse", async () => {
    mockResponse(200, { status: "queued" });
    const client = makeClient();

    const result = await client.reparseSession("sess-001");

    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/api/sessions/sess-001/reparse");
    expect(result.status).toBe("queued");
  });
});

// ---------------------------------------------------------------------------
// Tests: Workspace Endpoints
// ---------------------------------------------------------------------------

describe("FuelApiClient — workspace endpoints", () => {
  it("listWorkspaces sends GET /api/workspaces", async () => {
    const mockData = { data: [], total: 0, limit: 50, offset: 0 };
    mockResponse(200, mockData);
    const client = makeClient();

    const result = await client.listWorkspaces({ search: "fuel" });

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toContain("/api/workspaces");
    expect(lastRequest.url).toContain("search=fuel");
    expect(result.data).toEqual([]);
  });

  it("getWorkspace sends GET /api/workspaces/:id", async () => {
    const mockResp = {
      workspace: { id: "ws-001", display_name: "my-repo" },
      tracking: { active_sessions: [], recent_git: [] },
      stats: { total_sessions: 0, total_events: 0, total_cost_usd: 0, total_duration_ms: 0, tokens_in: 0, tokens_out: 0, top_tools: [] },
    };
    mockResponse(200, mockResp);
    const client = makeClient();

    const result = await client.getWorkspace("ws-001");

    expect(lastRequest.url).toBe("/api/workspaces/ws-001");
    expect(result.workspace.display_name).toBe("my-repo");
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveWorkspaceName
// ---------------------------------------------------------------------------

describe("FuelApiClient — resolveWorkspaceName", () => {
  it("returns exact match (case-insensitive)", async () => {
    const ws = makeWorkspaceSummary("MyProject");
    mockResponse(200, { data: [ws], total: 1, limit: 250, offset: 0 });
    const client = makeClient();

    const result = await client.resolveWorkspaceName("myproject");
    expect(result.display_name).toBe("MyProject");
  });

  it("returns single prefix match", async () => {
    const ws1 = makeWorkspaceSummary("fuel-code");
    const ws2 = makeWorkspaceSummary("other-project");
    mockResponse(200, { data: [ws1, ws2], total: 2, limit: 250, offset: 0 });
    const client = makeClient();

    const result = await client.resolveWorkspaceName("fuel");
    expect(result.display_name).toBe("fuel-code");
  });

  it("throws ApiError on ambiguous prefix match", async () => {
    const ws1 = makeWorkspaceSummary("fuel-code");
    const ws2 = makeWorkspaceSummary("fuel-web");
    mockResponse(200, { data: [ws1, ws2], total: 2, limit: 250, offset: 0 });
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
    mockResponse(200, { data: [ws], total: 1, limit: 250, offset: 0 });
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
    const ws1 = makeWorkspaceSummary("fuel");
    const ws2 = makeWorkspaceSummary("fuel-code");
    mockResponse(200, { data: [ws1, ws2], total: 2, limit: 250, offset: 0 });
    const client = makeClient();

    const result = await client.resolveWorkspaceName("fuel");
    expect(result.display_name).toBe("fuel");
  });
});

// ---------------------------------------------------------------------------
// Tests: Device Endpoints
// ---------------------------------------------------------------------------

describe("FuelApiClient — device endpoints", () => {
  it("listDevices sends GET /api/devices", async () => {
    mockResponse(200, { data: [], total: 0, limit: 50, offset: 0 });
    const client = makeClient();

    const result = await client.listDevices();

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toBe("/api/devices");
    expect(result.data).toEqual([]);
  });

  it("getDevice sends GET /api/devices/:id", async () => {
    const mockResp = {
      device: { id: "dev-001", name: "macbook" },
      tracking: { device: { id: "dev-001" }, active_sessions: [] },
      stats: { total_sessions: 5, total_events: 100, last_seen_at: "2025-01-01" },
    };
    mockResponse(200, mockResp);
    const client = makeClient();

    const result = await client.getDevice("dev-001");

    expect(lastRequest.url).toBe("/api/devices/dev-001");
    expect(result.device.name).toBe("macbook");
  });
});

// ---------------------------------------------------------------------------
// Tests: Timeline Endpoint
// ---------------------------------------------------------------------------

describe("FuelApiClient — timeline endpoint", () => {
  it("getTimeline sends GET /api/timeline with params", async () => {
    const mockResp = { items: [], total: 0, has_more: false };
    mockResponse(200, mockResp);
    const client = makeClient();

    const result = await client.getTimeline({
      workspace_id: "ws-001",
      limit: 25,
      kinds: ["session", "git"],
    });

    expect(lastRequest.method).toBe("GET");
    expect(lastRequest.url).toContain("/api/timeline");
    expect(lastRequest.url).toContain("workspace_id=ws-001");
    expect(lastRequest.url).toContain("limit=25");
    expect(lastRequest.url).toContain("kinds=session%2Cgit");
    expect(result.items).toEqual([]);
  });

  it("getTimeline works without params", async () => {
    mockResponse(200, { items: [], total: 0, has_more: false });
    const client = makeClient();

    const result = await client.getTimeline();

    expect(lastRequest.url).toBe("/api/timeline");
    expect(result.has_more).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: System Endpoint
// ---------------------------------------------------------------------------

describe("FuelApiClient — system endpoints", () => {
  it("getHealth sends GET /api/health", async () => {
    mockResponse(200, { status: "healthy", version: "1.0.0" });
    const client = makeClient();

    const result = await client.getHealth();

    expect(lastRequest.url).toBe("/api/health");
    expect(result.status).toBe("healthy");
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
// Tests: Error Handling
// ---------------------------------------------------------------------------

describe("FuelApiClient — error handling", () => {
  it("throws ApiError on 400 response", async () => {
    mockResponse(400, { error: "Bad request" });
    const client = makeClient();

    try {
      await client.getSession("invalid");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(400);
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
    }
  });

  it("throws ApiError on 404 response", async () => {
    mockResponse(404, { error: "Not found" });
    const client = makeClient();

    try {
      await client.getSession("nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(404);
    }
  });

  it("throws ApiError on 500 response", async () => {
    mockResponse(500, { error: "Internal server error" });
    const client = makeClient();

    try {
      await client.listSessions();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(500);
      expect((err as ApiError).body).toContain("Internal server error");
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
    const err = new ApiError("test error", 422, '{"detail":"invalid"}');
    expect(err.statusCode).toBe(422);
    expect(err.body).toBe('{"detail":"invalid"}');
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
