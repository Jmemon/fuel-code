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
import { wait, waitFor } from "./helpers.js";

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

    // Set up event listener BEFORE subscribing so we don't miss anything
    const received = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5_000);
      client.on("event", (event: any) => {
        if (event.type === "session.start") {
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });

    // Subscribe to all events, then wait briefly for the server to process
    client.subscribe({ scope: "all" });
    await wait(100);

    // Broadcast a test event directly via the broadcaster.
    // This tests WS client subscription + delivery without relying on
    // consumer pipeline timing (the full pipeline is exercised separately).
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

    // Set up event listener BEFORE subscribing
    const receivedEvents: any[] = [];
    client.on("event", (event: any) => {
      receivedEvents.push(event);
    });

    // Subscribe to a specific workspace
    client.subscribe({ workspace_id: ctx.fixtures.ws_api_service });
    await wait(100);

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

    // Poll until we receive the expected api-service event
    await waitFor(() => receivedEvents.some(
      (e: any) => e.workspace_id === ctx.fixtures.ws_api_service,
    ));

    // Give a brief window for any wrongly-delivered fuel-code events
    await wait(200);

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

  test("Test 18a: Event ingested via POST -> arrives on WS through consumer pipeline", async () => {
    // This tests the FULL pipeline: POST /api/events/ingest -> Redis Stream -> consumer -> broadcaster -> WS client.
    // Earlier tests call broadcaster.broadcastEvent() directly, bypassing the consumer pipeline.
    const client = createWsClient();
    await client.connect();

    // Set up event listener BEFORE subscribing
    const receivedEvents: any[] = [];
    client.on("event", (event: any) => {
      receivedEvents.push(event);
    });

    client.subscribe({ scope: "all" });
    await wait(100);

    // POST an event through the real ingest endpoint.
    // Must include all required session.start payload fields to pass validation.
    const eventId = generateId();
    const response = await fetch(`${ctx.baseUrl}/api/events/ingest`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        events: [{
          id: eventId,
          type: "session.start",
          timestamp: new Date().toISOString(),
          device_id: ctx.fixtures.dev_macbook,
          workspace_id: ctx.fixtures.ws_fuel_code,
          session_id: null,
          data: {
            cc_session_id: generateId(),
            cwd: "/tmp/pipeline-test",
            git_branch: "main",
            git_remote: null,
            cc_version: "1.0.0-test",
            model: "claude-sonnet-4-20250514",
            source: "startup",
            transcript_path: "s3://test/pipeline-test.jsonl",
          },
          blob_refs: [],
        }],
      }),
    });

    expect(response.status).toBe(202);
    const body = await response.json() as any;
    expect(body.ingested).toBe(1);

    // Poll until the event arrives via WS (consumer processes Redis stream -> broadcasts)
    await waitFor(
      () => receivedEvents.some((e: any) => e.id === eventId),
      10_000,  // longer timeout — event must traverse Redis stream + consumer
    );

    const delivered = receivedEvents.find((e: any) => e.id === eventId);
    expect(delivered).toBeTruthy();
    expect(delivered.type).toBe("session.start");
  }, 20_000);

  test("Test 18: Session lifecycle change -> session.update received", async () => {
    const client = createWsClient();
    await client.connect();

    // Set up listener BEFORE subscribing to avoid missing the message
    const received = new Promise<{ session_id: string; lifecycle: string }>((resolve) => {
      const timeout = setTimeout(() => resolve({ session_id: "", lifecycle: "" }), 5_000);
      client.on("session.update", (update: any) => {
        clearTimeout(timeout);
        resolve(update);
      });
    });

    // Subscribe to the live session specifically
    const sessionId = ctx.fixtures.sess_1_capturing;
    client.subscribe({ session_id: sessionId });
    await wait(100);

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
