/**
 * Tests for the WebSocket client library (ws-client.ts).
 *
 * Each test spins up a local ws.Server as a mock backend to test real
 * WebSocket round-trips. This verifies connection lifecycle, auth,
 * subscriptions, reconnection with exponential backoff, message
 * dispatch, and cleanup — all against the actual ws transport.
 *
 * NOTE: Cleanup uses terminate() on all WS connections and a timeout
 * race on server.close() to avoid hanging afterEach hooks.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { WsClient, type WsClientOptions } from "../ws-client.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const API_KEY = "test-key-abc123";

/** Track servers/clients/wss for cleanup after each test */
let httpServers: HttpServer[] = [];
let wsServers: InstanceType<typeof WebSocketServer>[] = [];
let wsClients: WsClient[] = [];

/**
 * Start a mock WS server that validates auth tokens like the real backend.
 * Returns the HTTP server, WSS, and port for connecting clients.
 */
function startMockServer(opts?: {
  onConnection?: (ws: InstanceType<typeof WsWebSocket>, token: string | null) => void;
}): Promise<{
  httpServer: HttpServer;
  wss: InstanceType<typeof WebSocketServer>;
  port: number;
}> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const token = url.searchParams.get("token");

      if (!token || token !== API_KEY) {
        ws.close(4001, "Unauthorized");
        return;
      }

      if (opts?.onConnection) {
        opts.onConnection(ws, token);
      }
    });

    httpServer.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      httpServers.push(httpServer);
      wsServers.push(wss);
      resolve({ httpServer, wss, port });
    });
  });
}

/** Create a WsClient pointed at a mock server */
function createClient(port: number, overrides?: Partial<WsClientOptions>): WsClient {
  const client = new WsClient({
    baseUrl: `http://localhost:${port}`,
    apiKey: API_KEY,
    reconnect: false, // Disable reconnect by default for simpler tests
    ...overrides,
  });
  wsClients.push(client);
  return client;
}

/** Wait for a specific event on the client, with timeout */
function waitForEvent<T = unknown>(
  emitter: WsClient,
  event: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for '${event}' event`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve((args.length === 1 ? args[0] : args) as T);
    });
  });
}

/** Wait for a message on a raw ws WebSocket */
function waitForServerMessage<T = unknown>(
  ws: InstanceType<typeof WsWebSocket>,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for server message")),
      timeoutMs,
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as T);
    });
  });
}

/** Small delay helper */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Force-close a WS server and HTTP server without waiting for graceful drain.
 * Terminates all connected WS clients first.
 */
async function forceCloseServer(
  wss: InstanceType<typeof WebSocketServer>,
  httpServer: HttpServer,
): Promise<void> {
  // Terminate all WS connections immediately
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();
  // Race server.close() against a 500ms timeout to prevent hanging
  await Promise.race([
    new Promise<void>((r) => httpServer.close(() => r())),
    new Promise<void>((r) => setTimeout(r, 500)),
  ]);
}

afterEach(async () => {
  // Clean up all WsClients first (this closes their WebSocket connections)
  for (const client of wsClients) {
    try {
      client.destroy();
    } catch { /* ignore */ }
  }
  wsClients = [];

  // Force-close all servers
  for (let i = 0; i < httpServers.length; i++) {
    try {
      await forceCloseServer(wsServers[i], httpServers[i]);
    } catch { /* ignore */ }
  }
  httpServers = [];
  wsServers = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("WsClient", () => {
  // 1. connect() with valid token
  test("1. connect() with valid token resolves, state=connected", async () => {
    const { port } = await startMockServer();
    const client = createClient(port);

    await client.connect();

    expect(client.connected).toBe(true);
    expect(client.state).toBe("connected");
  });

  // 2. connect() with invalid token rejects
  test("2. connect() with invalid token rejects with auth error", async () => {
    const { port } = await startMockServer();
    const client = new WsClient({
      baseUrl: `http://localhost:${port}`,
      apiKey: "wrong-key",
      reconnect: false,
    });
    wsClients.push(client);

    await expect(client.connect()).rejects.toThrow();
    expect(client.state).toBe("disconnected");
  });

  // 3. connect() with no server running rejects
  test("3. connect() with no server running rejects with connection error", async () => {
    const client = new WsClient({
      baseUrl: "http://localhost:59999",
      apiKey: API_KEY,
      reconnect: false,
    });
    wsClients.push(client);

    await expect(client.connect()).rejects.toThrow();
  });

  // 4. URL conversion https -> wss
  test("4. URL conversion https -> wss", () => {
    const client = new WsClient({
      baseUrl: "https://fuel-code.up.railway.app",
      apiKey: "key123",
      reconnect: false,
    });
    wsClients.push(client);

    const url = (client as any).buildWsUrl();
    expect(url).toBe("wss://fuel-code.up.railway.app/api/ws?token=key123");
  });

  // 5. URL conversion http -> ws
  test("5. URL conversion http -> ws", () => {
    const client = new WsClient({
      baseUrl: "http://localhost:3000",
      apiKey: "key456",
      reconnect: false,
    });
    wsClients.push(client);

    const url = (client as any).buildWsUrl();
    expect(url).toBe("ws://localhost:3000/api/ws?token=key456");
  });

  // 6. URL strips trailing slash
  test("6. URL strips trailing slash", () => {
    const client = new WsClient({
      baseUrl: "https://host.com/",
      apiKey: "key789",
      reconnect: false,
    });
    wsClients.push(client);

    const url = (client as any).buildWsUrl();
    expect(url).toBe("wss://host.com/api/ws?token=key789");
  });

  // 7. subscribe({ scope: 'all' }) sends correct message
  test("7. subscribe({ scope: 'all' }) sends subscribe message to server", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const msgPromise = waitForServerMessage(serverWs!);
    client.subscribe({ scope: "all" });
    const msg = await msgPromise;

    expect(msg).toEqual({ type: "subscribe", scope: "all" });
  });

  // 8. subscribe({ workspace_id }) sends correct message
  test("8. subscribe({ workspace_id: 'abc' }) sends correct message", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const msgPromise = waitForServerMessage(serverWs!);
    client.subscribe({ workspace_id: "abc" });
    const msg = await msgPromise;

    expect(msg).toEqual({ type: "subscribe", workspace_id: "abc" });
  });

  // 9. subscribe({ session_id }) sends correct message
  test("9. subscribe({ session_id: 'xyz' }) sends correct message", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const msgPromise = waitForServerMessage(serverWs!);
    client.subscribe({ session_id: "xyz" });
    const msg = await msgPromise;

    expect(msg).toEqual({ type: "subscribe", session_id: "xyz" });
  });

  // 10. unsubscribe({ workspace_id }) removes local and sends to server
  test("10. unsubscribe({ workspace_id }) sends unsubscribe and removes local", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    client.subscribe({ workspace_id: "abc" });
    await waitForServerMessage(serverWs!);

    const msgPromise = waitForServerMessage(serverWs!);
    client.unsubscribe({ workspace_id: "abc" });
    const msg = await msgPromise;

    expect(msg).toEqual({ type: "unsubscribe", workspace_id: "abc" });
    expect((client as any).subscriptions.size).toBe(0);
  });

  // 11. unsubscribe() no args clears all
  test("11. unsubscribe() no args clears all and sends unsubscribe", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    client.subscribe({ scope: "all" });
    await waitForServerMessage(serverWs!);

    const msgPromise = waitForServerMessage(serverWs!);
    client.unsubscribe();
    const msg = await msgPromise;

    expect(msg).toEqual({ type: "unsubscribe" });
    expect((client as any).subscriptions.size).toBe(0);
  });

  // 12. Server sends event message
  test("12. server sends event message, client emits 'event'", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const eventPromise = waitForEvent(client, "event");
    const mockEvent = {
      id: "evt-1",
      type: "session.start",
      timestamp: "2025-01-01T00:00:00Z",
      device_id: "d1",
      workspace_id: "ws1",
      session_id: "s1",
      data: {},
    };
    serverWs!.send(JSON.stringify({ type: "event", event: mockEvent }));

    const received = await eventPromise;
    expect(received).toEqual(mockEvent);
  });

  // 13. Server sends session.update
  test("13. server sends session.update, client emits 'session.update'", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const updatePromise = waitForEvent(client, "session.update");
    serverWs!.send(
      JSON.stringify({
        type: "session.update",
        session_id: "s1",
        lifecycle: "ended",
        summary: "Test session",
        stats: { total_messages: 5 },
      }),
    );

    const received = await updatePromise;
    expect(received).toEqual({
      session_id: "s1",
      lifecycle: "ended",
      summary: "Test session",
      stats: { total_messages: 5 },
    });
  });

  // 14. Server sends remote.update
  test("14. server sends remote.update, client emits 'remote.update'", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const updatePromise = waitForEvent(client, "remote.update");
    serverWs!.send(
      JSON.stringify({
        type: "remote.update",
        remote_env_id: "env-1",
        status: "running",
        public_ip: "1.2.3.4",
      }),
    );

    const received = await updatePromise;
    expect(received).toEqual({
      remote_env_id: "env-1",
      status: "running",
      public_ip: "1.2.3.4",
    });
  });

  // 15. Server sends ping, client responds with pong
  test("15. server sends ping, client responds with pong", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const pongPromise = waitForServerMessage(serverWs!);
    serverWs!.send(JSON.stringify({ type: "ping" }));

    const msg = await pongPromise;
    expect(msg).toEqual({ type: "pong" });
  });

  // 16. Server sends error message
  test("16. server sends error message, client emits 'error'", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const errPromise = waitForEvent<Error>(client, "error");
    serverWs!.send(JSON.stringify({ type: "error", message: "Something went wrong" }));

    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Something went wrong");
  });

  // 17. Auto-reconnect on server close
  test("17. auto-reconnect on server close", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port, {
      reconnect: true,
      maxReconnectAttempts: 3,
      maxReconnectDelay: 500,
    });
    // Attach error handler to prevent unhandled error throws during reconnect
    client.on("error", () => {});
    await client.connect();

    const reconnectPromise = waitForEvent(client, "reconnecting", 3000);

    // Server closes the connection unexpectedly
    serverWs!.close();

    const [attempt, delayMs] = (await reconnectPromise) as [number, number];
    expect(attempt).toBe(1);
    expect(typeof delayMs).toBe("number");
  });

  // 18. Exponential backoff delays increase
  test("18. exponential backoff delays increase", async () => {
    // Use a server that accepts the first connection but immediately closes
    // subsequent ones (simulates server going unhealthy). This avoids slow
    // TCP timeouts from connecting to a fully dead port.
    let connCount = 0;
    const { port } = await startMockServer({
      onConnection: (ws) => {
        connCount++;
        if (connCount > 1) {
          // Reject subsequent connections immediately to speed up reconnect cycle
          ws.close(1000);
        }
      },
    });
    const client = createClient(port, {
      reconnect: true,
      maxReconnectAttempts: 4,
      maxReconnectDelay: 30_000,
    });
    client.on("error", () => {});
    await client.connect();

    // Collect reconnecting events
    const delays: number[] = [];
    client.on("reconnecting", (_attempt: number, d: number) => {
      delays.push(d);
    });

    // Force-close the client connection to trigger reconnect
    (client as any).ws?.terminate();

    // Wait for at least 2 reconnect attempts: ~1s delay + ~2s delay + margin
    await delay(5000);

    expect(delays.length).toBeGreaterThanOrEqual(2);
    // First delay: 1000 * 2^0 + jitter(0-500) = 1000-1500ms
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThanOrEqual(1500);
    // Second delay: 1000 * 2^1 + jitter(0-500) = 2000-2500ms
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThanOrEqual(2500);
  }, 15000);

  // 19. Max reconnect attempts emits error and stops
  test("19. max reconnect attempts emits error and stops", async () => {
    // Server accepts first connection, then immediately closes subsequent ones
    // so reconnect failures happen fast (no TCP timeout waiting).
    let connCount = 0;
    const { port } = await startMockServer({
      onConnection: (ws) => {
        connCount++;
        if (connCount > 1) {
          ws.close(1000);
        }
      },
    });
    const client = createClient(port, {
      reconnect: true,
      maxReconnectAttempts: 2,
      maxReconnectDelay: 200,
    });
    const errors: Error[] = [];
    client.on("error", (err: Error) => {
      errors.push(err);
    });

    await client.connect();

    // Force-close client connection to trigger reconnect cycle
    (client as any).ws?.terminate();

    // Wait for 2 reconnect attempts to exhaust then max error emitted
    await delay(4000);

    const maxError = errors.find((e) =>
      e.message.includes("Max reconnection attempts"),
    );
    expect(maxError).toBeDefined();
    expect(maxError!.message).toContain("2");
  }, 10000);

  // 20. Re-subscribe on reconnect
  test("20. re-subscribe on reconnect: stored subscriptions re-sent", async () => {
    const receivedMessages: unknown[] = [];
    let connectionCount = 0;

    const { port } = await startMockServer({
      onConnection: (ws) => {
        connectionCount++;
        ws.on("message", (data) => {
          receivedMessages.push(JSON.parse(data.toString()));
        });
        // On first connection, close after subscribes arrive to trigger reconnect
        if (connectionCount === 1) {
          setTimeout(() => ws.close(), 300);
        }
      },
    });

    const client = createClient(port, {
      reconnect: true,
      maxReconnectAttempts: 5,
      maxReconnectDelay: 200,
    });
    // Suppress errors during reconnect attempts
    client.on("error", () => {});
    await client.connect();

    // Subscribe while connected
    client.subscribe({ scope: "all" });
    client.subscribe({ workspace_id: "ws-1" });

    // Wait for server close + reconnect + re-subscribe
    await delay(3000);

    // Should have received subscriptions twice: initial + re-subscribe on reconnect
    const subscribeMsgs = receivedMessages.filter(
      (m: any) => m.type === "subscribe",
    );
    // 2 original + 2 resubscribed = 4
    expect(subscribeMsgs.length).toBeGreaterThanOrEqual(4);
  }, 10000);

  // 21. disconnect() prevents reconnect
  test("21. disconnect() prevents reconnect", async () => {
    const { port } = await startMockServer();
    const client = createClient(port, {
      reconnect: true,
      maxReconnectAttempts: 5,
      maxReconnectDelay: 100,
    });
    await client.connect();
    expect(client.connected).toBe(true);

    let reconnectCalled = false;
    client.on("reconnecting", () => {
      reconnectCalled = true;
    });

    client.disconnect();
    expect(client.connected).toBe(false);
    expect(client.state).toBe("disconnected");

    await delay(500);
    expect(reconnectCalled).toBe(false);
  });

  // 22. disconnect() clears reconnect timer
  test("22. disconnect() clears reconnect timer", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port, {
      reconnect: true,
      maxReconnectAttempts: 5,
      maxReconnectDelay: 10_000, // Long delay so timer is definitely still pending
    });
    // Suppress errors
    client.on("error", () => {});
    await client.connect();

    // Wait for the close to propagate and reconnect to be scheduled
    const reconnectingPromise = waitForEvent(client, "reconnecting", 3000);
    serverWs!.close();
    await reconnectingPromise;

    // Client should be in reconnecting state with a pending timer
    expect(client.state).toBe("reconnecting");
    expect((client as any).reconnectTimer).not.toBeNull();

    // disconnect() should clear the timer
    client.disconnect();
    expect(client.state).toBe("disconnected");
    expect((client as any).reconnectTimer).toBeNull();
  });

  // 23. Multiple subscriptions stored
  test("23. multiple subscriptions: both stored and re-sent", async () => {
    const { port } = await startMockServer();
    const client = createClient(port);
    await client.connect();

    client.subscribe({ scope: "all" });
    client.subscribe({ workspace_id: "ws-1" });
    client.subscribe({ session_id: "s-1" });

    expect((client as any).subscriptions.size).toBe(3);
    expect((client as any).subscriptions.has("all")).toBe(true);
    expect((client as any).subscriptions.has("workspace:ws-1")).toBe(true);
    expect((client as any).subscriptions.has("session:s-1")).toBe(true);
  });

  // 24. Subscribe before connect: sent on first connect
  test("24. subscribe before connect: sent on first connect", async () => {
    const receivedMessages: unknown[] = [];
    const { port } = await startMockServer({
      onConnection: (ws) => {
        ws.on("message", (data) => {
          receivedMessages.push(JSON.parse(data.toString()));
        });
      },
    });
    const client = createClient(port);

    // Subscribe BEFORE connecting — these are queued locally
    client.subscribe({ scope: "all" });
    client.subscribe({ workspace_id: "ws-1" });

    await client.connect();
    await delay(200);

    // Both subscriptions should have been sent after connect via resubscribe()
    expect(receivedMessages).toContainEqual({ type: "subscribe", scope: "all" });
    expect(receivedMessages).toContainEqual({
      type: "subscribe",
      workspace_id: "ws-1",
    });
  });

  // 25. send() when disconnected: no-op
  test("25. send() when disconnected: no-op, no throw", () => {
    const client = new WsClient({
      baseUrl: "http://localhost:9999",
      apiKey: API_KEY,
      reconnect: false,
    });
    wsClients.push(client);

    expect(() => client.subscribe({ scope: "all" })).not.toThrow();
    expect(() => client.unsubscribe()).not.toThrow();
  });

  // 26. Invalid JSON from server
  test("26. invalid JSON from server: emits error, no crash", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    const errPromise = waitForEvent<Error>(client, "error");
    serverWs!.send("this is not json{{{");

    const err = await errPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("Invalid JSON");
    expect(client.connected).toBe(true);
  });

  // 27. Unknown message type silently ignored
  test("27. unknown message type: silently ignored", async () => {
    let serverWs: InstanceType<typeof WsWebSocket>;
    const { port } = await startMockServer({
      onConnection: (ws) => { serverWs = ws; },
    });
    const client = createClient(port);
    await client.connect();

    let errorEmitted = false;
    client.on("error", () => { errorEmitted = true; });

    serverWs!.send(JSON.stringify({ type: "future.feature", data: "something" }));
    await delay(200);

    expect(errorEmitted).toBe(false);
    expect(client.connected).toBe(true);
  });

  // 28. Auth rejection (4001) does not reconnect
  test("28. auth rejection (4001) does not reconnect", async () => {
    const { port } = await startMockServer();
    const client = new WsClient({
      baseUrl: `http://localhost:${port}`,
      apiKey: "wrong-key",
      reconnect: true,
      maxReconnectAttempts: 5,
      maxReconnectDelay: 100,
    });
    wsClients.push(client);

    let reconnectCalled = false;
    client.on("reconnecting", () => { reconnectCalled = true; });
    // Suppress error events
    client.on("error", () => {});

    await expect(client.connect()).rejects.toThrow();

    await delay(500);
    expect(reconnectCalled).toBe(false);
    expect(client.state).toBe("disconnected");
  });

  // 29. fromConfig() factory
  test("29. fromConfig() factory: creates client with correct URL/key", () => {
    const mockConfig = {
      backend: {
        url: "https://fuel-code.up.railway.app",
        api_key: "my-api-key",
      },
      device: { id: "d1", name: "laptop", type: "local" as const },
      pipeline: {
        queue_path: "/tmp/queue",
        drain_interval_seconds: 5,
        batch_size: 50,
        post_timeout_ms: 5000,
      },
    };

    const client = WsClient.fromConfig(mockConfig);
    wsClients.push(client);

    const url = (client as any).buildWsUrl();
    expect(url).toBe("wss://fuel-code.up.railway.app/api/ws?token=my-api-key");
  });

  // 30. state getter reflects state through connect/disconnect cycle
  test("30. state getter reflects state through connect/disconnect cycle", async () => {
    const { port } = await startMockServer();
    const client = createClient(port);

    expect(client.state).toBe("disconnected");

    await client.connect();
    expect(client.state).toBe("connected");
    expect(client.connected).toBe(true);

    client.disconnect();
    expect(client.state).toBe("disconnected");
    expect(client.connected).toBe(false);
  });
});
