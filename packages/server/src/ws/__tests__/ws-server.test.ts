/**
 * Tests for the WebSocket server: connection lifecycle, auth, subscriptions,
 * broadcasting, ping/pong keepalive, error handling, and graceful shutdown.
 *
 * Each test spins up a real HTTP + WS server on a random port and connects
 * real WebSocket clients. This is an integration-level test — no mocks for
 * the WS transport itself.
 *
 * NOTE: Bun has a known quirk where `ws.once("message")` doesn't reliably
 * fire after a prior `once` was consumed. All tests use a persistent
 * `on("message")` handler with a message queue instead.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createServer, type Server as HttpServer } from "node:http";
import WebSocket from "ws";
import type { Event } from "@fuel-code/shared";
import { createWsServer, type WsServerHandle } from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const API_KEY = "test-api-key-1234";

/** No-op Pino-like logger with mock spy methods for assertions */
function createMockLogger() {
  const logger: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
    fatal: mock(() => {}),
    child: mock(() => logger),
  };
  return logger;
}

/** Build a minimal mock Event for broadcast tests */
function makeMockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    type: "session.start",
    timestamp: "2025-01-01T00:00:00.000Z",
    device_id: "device-1",
    workspace_id: "ws-1",
    session_id: "session-1",
    data: { cwd: "/test" },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/** Start a real HTTP server on a random port, return its address */
function startHttpServer(): Promise<{ httpServer: HttpServer; port: number }> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ httpServer, port });
    });
  });
}

/**
 * Wraps a ws WebSocket with a persistent message queue.
 * Bun's ws implementation has issues with repeated `once("message")` calls,
 * so we use a single persistent `on("message")` handler and queue messages.
 */
interface QueuedClient {
  ws: WebSocket;
  /** Wait for the next message, with optional timeout */
  nextMessage<T = any>(timeoutMs?: number): Promise<T>;
  /** Collect all messages received within a time window */
  collectMessages(durationMs: number): Promise<any[]>;
  /** Drain all queued messages without waiting */
  drain(): any[];
}

/**
 * Options for wrapClient. When autoPong is true, ping messages are
 * automatically responded to with pong and not queued.
 */
interface WrapOptions {
  autoPong?: boolean;
}

function wrapClient(ws: WebSocket, opts: WrapOptions = {}): QueuedClient {
  const queue: any[] = [];
  let waiter: { resolve: (msg: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // Optionally auto-respond to server pings so keepalive works transparently
    if (opts.autoPong && msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (waiter) {
      const w = waiter;
      waiter = null;
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    ws,

    nextMessage<T = any>(timeoutMs = 2000): Promise<T> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift() as T);
      }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = null;
          reject(new Error("Timed out waiting for message"));
        }, timeoutMs);
        waiter = { resolve: resolve as (msg: any) => void, reject, timer };
      });
    },

    collectMessages(durationMs: number): Promise<any[]> {
      return new Promise((resolve) => {
        const collected: any[] = [];
        const handler = (data: WebSocket.RawData) => {
          collected.push(JSON.parse(data.toString()));
        };
        ws.on("message", handler);
        setTimeout(() => {
          ws.off("message", handler);
          resolve(collected);
        }, durationMs);
      });
    },

    drain(): any[] {
      const msgs = [...queue];
      queue.length = 0;
      return msgs;
    },
  };
}

/** Connect a WebSocket client with auth token, returning a QueuedClient */
function connectClient(port: number, token?: string, wrapOpts?: WrapOptions): Promise<QueuedClient> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `ws://127.0.0.1:${port}/api/ws?token=${token}`
      : `ws://127.0.0.1:${port}/api/ws`;
    const ws = new WebSocket(url);
    ws.on("open", () => resolve(wrapClient(ws, wrapOpts)));
    ws.on("error", reject);
  });
}

/** Wait for close event on a WebSocket, return { code, reason } */
function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Small delay helper */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WebSocket Server", () => {
  let httpServer: HttpServer;
  let wsHandle: WsServerHandle;
  let port: number;
  let logger: any;
  /** Track clients opened during a test so afterEach can close them */
  let openClients: WebSocket[];

  beforeEach(async () => {
    logger = createMockLogger();
    openClients = [];
    const result = await startHttpServer();
    httpServer = result.httpServer;
    port = result.port;
  });

  afterEach(async () => {
    // Close any clients that are still open
    for (const c of openClients) {
      if (c.readyState === WebSocket.OPEN || c.readyState === WebSocket.CONNECTING) {
        c.close();
      }
    }
    // Close HTTP server first — this allows wss.close() to complete immediately
    // since ws's WebSocketServer waits for the underlying HTTP server to close.
    // Wrap in try/catch since some tests may have already closed these.
    try { httpServer.close(); } catch {}
    if (wsHandle) {
      try { await wsHandle.shutdown(); } catch {}
    }
  });

  /** Create the WS server with optional config overrides */
  function createWs(overrides: { pingIntervalMs?: number; pongTimeoutMs?: number } = {}) {
    wsHandle = createWsServer({
      httpServer,
      logger,
      apiKey: API_KEY,
      ...overrides,
    });
    return wsHandle;
  }

  /** Connect and track a client */
  async function connect(token?: string, wrapOpts?: WrapOptions): Promise<QueuedClient> {
    const client = await connectClient(port, token, wrapOpts);
    openClients.push(client.ws);
    return client;
  }

  // -------------------------------------------------------------------------
  // 1. Connection with valid token succeeds
  // -------------------------------------------------------------------------
  test("1. connection with valid token succeeds", async () => {
    createWs();
    const client = await connect(API_KEY);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  // -------------------------------------------------------------------------
  // 2. Connection with invalid token: close code 4001 "Unauthorized"
  // -------------------------------------------------------------------------
  test("2. connection with invalid token closes with 4001", async () => {
    createWs();
    const url = `ws://127.0.0.1:${port}/api/ws?token=wrong-key`;
    const ws = new WebSocket(url);
    openClients.push(ws);
    const { code, reason } = await waitForClose(ws);
    expect(code).toBe(4001);
    expect(reason).toBe("Unauthorized");
  });

  // -------------------------------------------------------------------------
  // 3. Connection without token: close code 4001
  // -------------------------------------------------------------------------
  test("3. connection without token closes with 4001", async () => {
    createWs();
    const url = `ws://127.0.0.1:${port}/api/ws`;
    const ws = new WebSocket(url);
    openClients.push(ws);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  // -------------------------------------------------------------------------
  // 4. Subscribe to scope "all": receives ack
  // -------------------------------------------------------------------------
  test("4. subscribe to scope all receives ack", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", scope: "all" }));
    const msg = await client.nextMessage();
    expect(msg).toEqual({ type: "subscribed", subscription: "all" });
  });

  // -------------------------------------------------------------------------
  // 5. Subscribe to workspace: receives ack
  // -------------------------------------------------------------------------
  test("5. subscribe to workspace receives ack", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-123" }));
    const msg = await client.nextMessage();
    expect(msg).toEqual({ type: "subscribed", subscription: "workspace:ws-123" });
  });

  // -------------------------------------------------------------------------
  // 6. Subscribe to session: receives ack
  // -------------------------------------------------------------------------
  test("6. subscribe to session receives ack", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", session_id: "sess-456" }));
    const msg = await client.nextMessage();
    expect(msg).toEqual({ type: "subscribed", subscription: "session:sess-456" });
  });

  // -------------------------------------------------------------------------
  // 7. Broadcast matching: "all" gets everything
  // -------------------------------------------------------------------------
  test("7. client subscribed to all receives broadcast events", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", scope: "all" }));
    await client.nextMessage(); // ack

    const event = makeMockEvent();
    wsHandle.broadcaster.broadcastEvent(event);

    const msg = await client.nextMessage();
    expect(msg.type).toBe("event");
    expect(msg.event.id).toBe(event.id);
  });

  // -------------------------------------------------------------------------
  // 8. Broadcast matching: workspace filter works
  // -------------------------------------------------------------------------
  test("8. workspace subscription filters broadcasts correctly", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-1" }));
    await client.nextMessage(); // ack

    // Should receive: event with matching workspace_id
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ workspace_id: "ws-1" }));
    const msg = await client.nextMessage();
    expect(msg.type).toBe("event");

    // Should NOT receive: event with different workspace_id
    const collector = client.collectMessages(200);
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ workspace_id: "ws-other", session_id: null }));
    const missed = await collector;
    expect(missed.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 9. Broadcast matching: session filter works
  // -------------------------------------------------------------------------
  test("9. session subscription filters broadcasts correctly", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", session_id: "session-1" }));
    await client.nextMessage(); // ack

    // Should receive: event with matching session_id
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ session_id: "session-1" }));
    const msg = await client.nextMessage();
    expect(msg.type).toBe("event");

    // Should NOT receive: event with different session_id
    const collector = client.collectMessages(200);
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ session_id: "session-other", workspace_id: "ws-other" }));
    const missed = await collector;
    expect(missed.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 10. Unsubscribe works (specific)
  // -------------------------------------------------------------------------
  test("10. unsubscribe from specific workspace stops broadcasts", async () => {
    createWs();
    const client = await connect(API_KEY);

    // Subscribe
    client.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-1" }));
    await client.nextMessage(); // ack

    // Unsubscribe
    client.ws.send(JSON.stringify({ type: "unsubscribe", workspace_id: "ws-1" }));
    const unsubMsg = await client.nextMessage();
    expect(unsubMsg).toEqual({ type: "unsubscribed", subscription: "workspace:ws-1" });

    // Should NOT receive broadcasts anymore
    const collector = client.collectMessages(200);
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ workspace_id: "ws-1" }));
    const missed = await collector;
    expect(missed.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. Unsubscribe works (clear all)
  // -------------------------------------------------------------------------
  test("11. unsubscribe without args clears all subscriptions", async () => {
    createWs();
    const client = await connect(API_KEY);

    // Subscribe to multiple scopes
    client.ws.send(JSON.stringify({ type: "subscribe", scope: "all" }));
    await client.nextMessage();
    client.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-1" }));
    await client.nextMessage();

    // Unsubscribe all — should get a single ack with subscription: "all"
    client.ws.send(JSON.stringify({ type: "unsubscribe" }));
    const unsub = await client.nextMessage();
    expect(unsub).toEqual({ type: "unsubscribed", subscription: "all" });

    // Should NOT receive broadcasts
    const collector = client.collectMessages(200);
    wsHandle.broadcaster.broadcastEvent(makeMockEvent());
    const missed = await collector;
    expect(missed.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 12. Multiple clients with different subscriptions
  // -------------------------------------------------------------------------
  test("12. multiple clients with different subscriptions receive correct broadcasts", async () => {
    createWs();
    const c1 = await connect(API_KEY);
    const c2 = await connect(API_KEY);

    // Client 1: subscribe to workspace ws-1
    c1.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-1" }));
    await c1.nextMessage();

    // Client 2: subscribe to workspace ws-2
    c2.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-2" }));
    await c2.nextMessage();

    // Broadcast to ws-1 — only client 1 should receive
    const missed2 = c2.collectMessages(300);
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ workspace_id: "ws-1", session_id: null }));
    const msg1 = await c1.nextMessage();
    expect(msg1.type).toBe("event");
    expect((await missed2).length).toBe(0);

    // Broadcast to ws-2 — only client 2 should receive
    const missed1 = c1.collectMessages(300);
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({ workspace_id: "ws-2", session_id: null }));
    const msg2 = await c2.nextMessage();
    expect(msg2.type).toBe("event");
    expect((await missed1).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 13. broadcastEvent with both workspace_id and session_id
  // -------------------------------------------------------------------------
  test("13. broadcastEvent matches on both workspace_id and session_id", async () => {
    createWs();
    const cWs = await connect(API_KEY);
    const cSess = await connect(API_KEY);

    // Client 1: subscribe to workspace
    cWs.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-1" }));
    await cWs.nextMessage();

    // Client 2: subscribe to session
    cSess.ws.send(JSON.stringify({ type: "subscribe", session_id: "session-1" }));
    await cSess.nextMessage();

    // Event with both workspace_id and session_id — both clients should receive
    wsHandle.broadcaster.broadcastEvent(makeMockEvent({
      workspace_id: "ws-1",
      session_id: "session-1",
    }));

    const msg1 = await cWs.nextMessage();
    const msg2 = await cSess.nextMessage();
    expect(msg1.type).toBe("event");
    expect(msg2.type).toBe("event");
  });

  // -------------------------------------------------------------------------
  // 14. Ping/pong keepalive works
  // -------------------------------------------------------------------------
  test("14. ping/pong keepalive: client responding stays alive", async () => {
    // pongTimeoutMs must be shorter than pingIntervalMs to avoid a race where
    // the next ping's isAlive=false reset overlaps with the previous pong check.
    // This mirrors the production config (30s ping, 10s pong timeout).
    createWs({ pingIntervalMs: 500, pongTimeoutMs: 200 });
    const client = await connect(API_KEY, { autoPong: true });

    // Wait for at least 2 ping cycles — client should remain connected
    await delay(1500);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(wsHandle.getClientCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 15. Stale client termination
  // -------------------------------------------------------------------------
  test("15. stale client that does not respond to ping is terminated", async () => {
    createWs({ pingIntervalMs: 500, pongTimeoutMs: 200 });
    const client = await connect(API_KEY);

    // Do NOT respond to ping — client should be terminated
    const closePromise = waitForClose(client.ws, 3000);
    const { code } = await closePromise;
    // Terminated connections get code 1006 (abnormal closure from terminate())
    expect(code).toBe(1006);
  });

  // -------------------------------------------------------------------------
  // 16. Client disconnect during broadcast: no crash
  // -------------------------------------------------------------------------
  test("16. broadcasting to disconnected client does not crash", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", scope: "all" }));
    await client.nextMessage(); // ack

    // Close client, then broadcast — should not throw
    client.ws.close();
    await delay(50);

    // This should not throw or crash the server
    expect(() => {
      wsHandle.broadcaster.broadcastEvent(makeMockEvent());
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // 17. Invalid JSON error response
  // -------------------------------------------------------------------------
  test("17. invalid JSON message returns error", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send("this is not json{{{");
    const msg = await client.nextMessage();
    expect(msg.type).toBe("error");
    expect(msg.message).toBe("Invalid JSON");
  });

  // -------------------------------------------------------------------------
  // 18. Unknown message type error response
  // -------------------------------------------------------------------------
  test("18. unknown message type returns error", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "banana" }));
    const msg = await client.nextMessage();
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("Unknown message type");
  });

  // -------------------------------------------------------------------------
  // 19. getClientCount accuracy
  // -------------------------------------------------------------------------
  test("19. getClientCount reflects connected clients", async () => {
    createWs();
    expect(wsHandle.getClientCount()).toBe(0);

    const c1 = await connect(API_KEY);
    await delay(20);
    expect(wsHandle.getClientCount()).toBe(1);

    const c2 = await connect(API_KEY);
    await delay(20);
    expect(wsHandle.getClientCount()).toBe(2);

    c1.ws.close();
    await delay(50);
    expect(wsHandle.getClientCount()).toBe(1);

    c2.ws.close();
    await delay(50);
    expect(wsHandle.getClientCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 20. shutdown closes all connections
  // -------------------------------------------------------------------------
  test("20. shutdown closes all client connections", async () => {
    createWs();
    const c1 = await connect(API_KEY);
    const c2 = await connect(API_KEY);
    await delay(20);
    expect(wsHandle.getClientCount()).toBe(2);

    const close1 = waitForClose(c1.ws);
    const close2 = waitForClose(c2.ws);

    // Shutdown sends close(1001) to all clients, clears the map, then closes WSS.
    // We need httpServer closed first so wss.close() doesn't block.
    httpServer.close();
    await wsHandle.shutdown();

    const result1 = await close1;
    const result2 = await close2;
    // After shutdown, all connections should be closed and map cleared
    expect(wsHandle.getClientCount()).toBe(0);
    // The close code should be 1001 (going away) from ws.close(1001, ...)
    // but some environments may report 1000; just verify the connection closed
    expect([1000, 1001]).toContain(result1.code);
    expect([1000, 1001]).toContain(result2.code);
  });

  // -------------------------------------------------------------------------
  // 21. broadcastSessionUpdate with optional fields
  // -------------------------------------------------------------------------
  test("21. broadcastSessionUpdate sends session.update with all fields", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", session_id: "sess-1" }));
    await client.nextMessage(); // ack

    wsHandle.broadcaster.broadcastSessionUpdate(
      "sess-1",
      "ws-1",
      "ended",
      "Session summary text",
      { total_messages: 10, total_cost_usd: 0.42, duration_ms: 5000 },
    );

    const msg = await client.nextMessage();
    expect(msg.type).toBe("session.update");
    expect(msg.session_id).toBe("sess-1");
    expect(msg.lifecycle).toBe("ended");
    expect(msg.summary).toBe("Session summary text");
    expect(msg.stats).toEqual({ total_messages: 10, total_cost_usd: 0.42, duration_ms: 5000 });
  });

  // -------------------------------------------------------------------------
  // 22. broadcastSessionUpdate without optional fields
  // -------------------------------------------------------------------------
  test("22. broadcastSessionUpdate without optional fields omits them", async () => {
    createWs();
    const client = await connect(API_KEY);
    client.ws.send(JSON.stringify({ type: "subscribe", workspace_id: "ws-1" }));
    await client.nextMessage(); // ack

    wsHandle.broadcaster.broadcastSessionUpdate("sess-1", "ws-1", "detected");

    const msg = await client.nextMessage();
    expect(msg.type).toBe("session.update");
    expect(msg.session_id).toBe("sess-1");
    expect(msg.lifecycle).toBe("detected");
    expect(msg.summary).toBeUndefined();
    expect(msg.stats).toBeUndefined();
  });
});
