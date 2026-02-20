/**
 * Phase 4 E2E integration tests — Error handling tests.
 *
 * Tests 22-24: Verify graceful error handling for backend unreachable,
 * invalid workspace name, and invalid API key scenarios.
 *
 * These tests do NOT require a running test server for all cases —
 * Test 22 intentionally points at an unreachable address, Test 24
 * uses a bad API key. Only Test 23 uses the real test server.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { setupTestServer, type TestServerContext } from "./setup.js";
import { createTestClient, stripAnsi } from "./helpers.js";
import {
  FuelApiClient,
  ApiError,
  ApiConnectionError,
} from "../../lib/api-client.js";
import { fetchSessions, formatSessionsTable } from "../../commands/sessions.js";
import { resolveWorkspaceName } from "../../lib/resolvers.js";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: TestServerContext;

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await setupTestServer();
}, 30_000);

afterAll(async () => {
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Tests 22-24
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  test("Test 22: Backend unreachable -> graceful error", async () => {
    // Point the client at an address that will refuse connections
    const badClient = new FuelApiClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "doesnt-matter",
      timeout: 2_000,
    });

    try {
      await fetchSessions(badClient, { limit: 10 });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      // Should be an ApiConnectionError (network failure)
      expect(err instanceof ApiConnectionError).toBe(true);
      expect((err as Error).message).toBeTruthy();
    }
  }, 15_000);

  test("Test 23: Invalid workspace name -> 'not found' error", async () => {
    const api = createTestClient(ctx.baseUrl, ctx.apiKey);

    try {
      await resolveWorkspaceName(api, "nonexistent-workspace-xyz");
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      // resolveWorkspaceName throws ApiError(404) when no match
      expect(err instanceof ApiError).toBe(true);
      expect((err as ApiError).statusCode).toBe(404);
      expect((err as Error).message).toContain("not found");
    }
  }, 15_000);

  test("Test 24: Invalid API key -> unauthorized error", async () => {
    const badKeyClient = new FuelApiClient({
      baseUrl: ctx.baseUrl,
      apiKey: "wrong-api-key-totally-invalid",
      timeout: 5_000,
    });

    try {
      await fetchSessions(badKeyClient, { limit: 10 });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      // Should be an ApiError with 401 status
      expect(err instanceof ApiError).toBe(true);
      expect((err as ApiError).statusCode).toBe(401);
    }
  }, 15_000);
});
