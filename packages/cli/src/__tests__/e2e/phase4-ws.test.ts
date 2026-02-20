/**
 * Phase 4 E2E integration tests — WebSocket tests.
 *
 * Tests 15-18: Verify WS connect, subscribe, broadcast, and session
 * lifecycle events against a real WebSocket server attached to the
 * test Express instance.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { generateId } from "@fuel-code/shared";

import { setupTestServer, type TestServerContext } from "./setup.js";
import { WsClient } from "../../lib/ws-client.js";
import { wait } from "./helpers.js";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let ctx: TestServerContext;
let clients: WsClient[] = [];

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await setupTestServer();
}, 30_000);

afterEach(() => {
  // Disconnect all clients created during a test
  for (const client of clients) {
    try {
      client.destroy();
    } catch {}
  }
  clients = [];
});

afterAll(async () => {
  if (ctx?.cleanup) {
    await ctx.cleanup();
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Helper: create a WsClient for tests (tracked for cleanup)
// ---------------------------------------------------------------------------

function createWsClient(opts?: { apiKey?: string; reconnect?: boolean }): WsClient {
  const client = new WsClient({
    baseUrl: ctx.baseUrl,
    apiKey: opts?.apiKey ?? ctx.apiKey,
    reconnect: opts?.reconnect ?? false,
  });
  clients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// Tests 15-18
// ---------------------------------------------------------------------------

describe("WebSocket connectivity", () => {
  test("Test 15: WS connect with valid token succeeds", async () => {
    const client = createWsClient();

    let connectedFired = false;
    client.on("connected", () => {
      connectedFired = true;
    });

    await client.connect();

    expect(client.connected).toBe(true);
    expect(client.state).toBe("connected");
    expect(connectedFired).toBe(true);
  }, 15_000);

  test("Test 16: Subscribe 'all' + receive broadcast event via WS", async () => {
    const client = createWsClient();
    await client.connect();

    // Subscribe to all events
    client.subscribe({ scope: "all" });
    await wait(200);

    // Set up event listener BEFORE broadcast so we don't miss it
    const received = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5_000);
      client.on("event", (event: any) => {
        if (event.type === "session.start") {
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });

    // Broadcast a test event directly via the broadcaster.
    // This tests WS client subscription + delivery without relying on
    // consumer pipeline timing (the full pipeline is exercised by CLI tests).
    ctx.broadcaster.broadcastEvent({
      id: generateId(),
      type: "session.start",
      timestamp: new Date().toISOString(),
      device_id: ctx.fixtures.dev_macbook,
      workspace_id: ctx.fixtures.ws_fuel_code,
      session_id: null,
      data: { cc_session_id: generateId(), cwd: "/tmp/test" },
      blob_refs: [],
    } as any);

    expect(await received).toBe(true);
  }, 15_000);

  test("Test 17: Subscribe workspace -> only receive events for that workspace", async () => {
    const client = createWsClient();
    await client.connect();

    // Subscribe to a specific workspace
    client.subscribe({ workspace_id: ctx.fixtures.ws_api_service });
    await wait(200);

    const receivedEvents: any[] = [];
    client.on("event", (event: any) => {
      receivedEvents.push(event);
    });

    // Broadcast event for the SUBSCRIBED workspace (api-service)
    ctx.broadcaster.broadcastEvent({
      id: generateId(),
      type: "session.start",
      timestamp: new Date().toISOString(),
      device_id: ctx.fixtures.dev_macbook,
      workspace_id: ctx.fixtures.ws_api_service,
      session_id: null,
      data: { cc_session_id: generateId(), cwd: "/tmp/api" },
      blob_refs: [],
    } as any);

    // Broadcast event for a DIFFERENT workspace (fuel-code)
    ctx.broadcaster.broadcastEvent({
      id: generateId(),
      type: "session.start",
      timestamp: new Date().toISOString(),
      device_id: ctx.fixtures.dev_macbook,
      workspace_id: ctx.fixtures.ws_fuel_code,
      session_id: null,
      data: { cc_session_id: generateId(), cwd: "/tmp/fuel" },
      blob_refs: [],
    } as any);

    // Wait for messages to be delivered
    await wait(500);

    // Should receive event for api-service but NOT for fuel-code
    const apiServiceEvents = receivedEvents.filter(
      (e: any) => e.workspace_id === ctx.fixtures.ws_api_service,
    );
    const fuelCodeEvents = receivedEvents.filter(
      (e: any) => e.workspace_id === ctx.fixtures.ws_fuel_code,
    );

    expect(apiServiceEvents.length).toBeGreaterThanOrEqual(1);
    expect(fuelCodeEvents.length).toBe(0);
  }, 15_000);

  test("Test 18: Session lifecycle change -> session.update received", async () => {
    const client = createWsClient();
    await client.connect();

    // Subscribe to the live session specifically
    const sessionId = ctx.fixtures.sess_1_capturing;
    client.subscribe({ session_id: sessionId });
    await wait(200);

    // Set up listener BEFORE broadcast to avoid missing the message
    const received = new Promise<{ session_id: string; lifecycle: string }>((resolve) => {
      const timeout = setTimeout(() => resolve({ session_id: "", lifecycle: "" }), 5_000);
      client.on("session.update", (update: any) => {
        clearTimeout(timeout);
        resolve(update);
      });
    });

    // Broadcast a session lifecycle change directly via the broadcaster.
    // This mirrors what the consumer pipeline does when a session ends.
    ctx.broadcaster.broadcastSessionUpdate(
      sessionId,
      ctx.fixtures.ws_fuel_code,
      "ended",
    );

    const update = await received;

    // Assert the WsClient received the session.update with the correct data
    expect(update.session_id).toBe(sessionId);
    expect(update.lifecycle).toBe("ended");
  }, 15_000);
});
