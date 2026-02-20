/**
 * Tests for workspace and device name resolution helpers.
 *
 * Uses Bun.serve() as a mock HTTP server to test real HTTP round-trips
 * through FuelApiClient. Tests cover exact match, prefix match, ambiguous
 * match, not-found, canonical ID match, and ULID passthrough.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "bun";
import { FuelApiClient, ApiError } from "../api-client.js";
import { resolveWorkspaceName, resolveDeviceName } from "../resolvers.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server
// ---------------------------------------------------------------------------

let server: Server;
let serverPort: number;
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
// resolveWorkspaceName tests
// ---------------------------------------------------------------------------

describe("resolveWorkspaceName", () => {
  it("returns ULID directly if input is 26-char uppercase alphanumeric", async () => {
    const ulid = "01HZAAAAAAAAAAAAAAAAAAAAAA";
    const result = await resolveWorkspaceName(makeClient(), ulid);
    expect(result).toBe(ulid);
  });

  it("resolves exact display_name match (case-insensitive)", async () => {
    mockResponse(200, {
      workspaces: [
        { id: "ulid-fc", display_name: "fuel-code", canonical_id: "github.com/user/fuel-code" },
        { id: "ulid-other", display_name: "other", canonical_id: "github.com/user/other" },
      ],
      next_cursor: null,
      has_more: false,
    });

    const result = await resolveWorkspaceName(makeClient(), "Fuel-Code");
    expect(result).toBe("ulid-fc");
  });

  it("resolves exact canonical_id match (case-insensitive)", async () => {
    mockResponse(200, {
      workspaces: [
        { id: "ulid-fc", display_name: "fuel-code", canonical_id: "github.com/user/fuel-code" },
      ],
      next_cursor: null,
      has_more: false,
    });

    const result = await resolveWorkspaceName(makeClient(), "github.com/user/fuel-code");
    expect(result).toBe("ulid-fc");
  });

  it("resolves single prefix match on display_name", async () => {
    mockResponse(200, {
      workspaces: [
        { id: "ulid-fc", display_name: "fuel-code", canonical_id: "github.com/user/fuel-code" },
        { id: "ulid-other", display_name: "other-project", canonical_id: "github.com/user/other" },
      ],
      next_cursor: null,
      has_more: false,
    });

    const result = await resolveWorkspaceName(makeClient(), "fuel");
    expect(result).toBe("ulid-fc");
  });

  it("throws ApiError 400 on ambiguous prefix match with candidate names", async () => {
    mockResponse(200, {
      workspaces: [
        { id: "ulid-fc", display_name: "fuel-code", canonical_id: "c1" },
        { id: "ulid-fw", display_name: "fuel-web", canonical_id: "c2" },
      ],
      next_cursor: null,
      has_more: false,
    });

    try {
      await resolveWorkspaceName(makeClient(), "fuel");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as ApiError).message).toContain("Ambiguous");
      expect((err as ApiError).message).toContain("fuel-code");
      expect((err as ApiError).message).toContain("fuel-web");
    }
  });

  it("throws ApiError 404 on no match and lists available workspaces", async () => {
    mockResponse(200, {
      workspaces: [
        { id: "ulid-other", display_name: "other-project", canonical_id: "c1" },
      ],
      next_cursor: null,
      has_more: false,
    });

    try {
      await resolveWorkspaceName(makeClient(), "nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(404);
      expect((err as ApiError).message).toContain("not found");
      expect((err as ApiError).message).toContain("other-project");
    }
  });

  it("prefers exact match over prefix match", async () => {
    mockResponse(200, {
      workspaces: [
        { id: "ulid-fuel", display_name: "fuel", canonical_id: "c1" },
        { id: "ulid-fuel-code", display_name: "fuel-code", canonical_id: "c2" },
      ],
      next_cursor: null,
      has_more: false,
    });

    const result = await resolveWorkspaceName(makeClient(), "fuel");
    expect(result).toBe("ulid-fuel");
  });
});

// ---------------------------------------------------------------------------
// resolveDeviceName tests
// ---------------------------------------------------------------------------

describe("resolveDeviceName", () => {
  it("returns ULID directly if input is 26-char uppercase alphanumeric", async () => {
    const ulid = "01HZBBBBBBBBBBBBBBBBBBBBBB";
    const result = await resolveDeviceName(makeClient(), ulid);
    expect(result).toBe(ulid);
  });

  it("resolves exact device name match (case-insensitive)", async () => {
    mockResponse(200, {
      devices: [
        { id: "dev-1", name: "macbook-pro" },
        { id: "dev-2", name: "linux-box" },
      ],
    });

    const result = await resolveDeviceName(makeClient(), "MacBook-Pro");
    expect(result).toBe("dev-1");
  });

  it("resolves single prefix match", async () => {
    mockResponse(200, {
      devices: [
        { id: "dev-1", name: "macbook-pro" },
        { id: "dev-2", name: "linux-box" },
      ],
    });

    const result = await resolveDeviceName(makeClient(), "mac");
    expect(result).toBe("dev-1");
  });

  it("throws ApiError 400 on ambiguous prefix match", async () => {
    mockResponse(200, {
      devices: [
        { id: "dev-1", name: "macbook-pro" },
        { id: "dev-2", name: "macbook-air" },
      ],
    });

    try {
      await resolveDeviceName(makeClient(), "mac");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(400);
      expect((err as ApiError).message).toContain("Ambiguous");
      expect((err as ApiError).message).toContain("macbook-pro");
      expect((err as ApiError).message).toContain("macbook-air");
    }
  });

  it("throws ApiError 404 on no match and lists available devices", async () => {
    mockResponse(200, {
      devices: [{ id: "dev-1", name: "macbook-pro" }],
    });

    try {
      await resolveDeviceName(makeClient(), "nonexistent");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).statusCode).toBe(404);
      expect((err as ApiError).message).toContain("not found");
      expect((err as ApiError).message).toContain("macbook-pro");
    }
  });
});
