/**
 * WebSocket server for fuel-code real-time updates.
 *
 * Runs on the same HTTP server as Express (via ws library's `server` option).
 * Handles authenticated connections, subscription management, and ping/pong
 * keepalive. Paired with the broadcaster module for outbound message dispatch.
 *
 * Connection lifecycle:
 *   1. Client connects to /api/ws?token=<api_key>
 *   2. Server validates token — rejects with 4001 if invalid
 *   3. On valid auth: assigns ULID client ID, adds to clients map
 *   4. Client sends subscribe/unsubscribe/pong messages
 *   5. Server sends event/session.update/remote.update/ping/error messages
 *   6. Ping/pong keepalive: 30s interval, 10s pong timeout (40s total)
 *   7. On close: removes from clients map, cleans up subscriptions
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { Logger } from "pino";
import { generateId } from "@fuel-code/shared";

import type { ConnectedClient, ClientMessage, ServerMessage } from "./types.js";
import { createBroadcaster, type WsBroadcaster } from "./broadcaster.js";

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Interval between server-initiated ping messages (ms) */
const PING_INTERVAL_MS = 30_000;

/** Time after ping before a non-responsive client is terminated (ms) */
const PONG_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Options for creating the WebSocket server */
export interface WsServerOptions {
  /** The HTTP server to attach to (shared with Express) */
  httpServer: HttpServer;
  /** Pino logger instance */
  logger: Logger;
  /** API key for authenticating WebSocket connections */
  apiKey: string;
  /** Override ping interval for testing (ms) */
  pingIntervalMs?: number;
  /** Override pong timeout for testing (ms) */
  pongTimeoutMs?: number;
}

/** Handle returned by createWsServer for integration and shutdown */
export interface WsServerHandle {
  /** Broadcaster for dispatching events to subscribed clients */
  broadcaster: WsBroadcaster;
  /** Current number of connected clients */
  getClientCount(): number;
  /** Graceful shutdown: close all connections, clear intervals, close WSS */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// WS server implementation
// ---------------------------------------------------------------------------

/**
 * Create and start the WebSocket server on the given HTTP server.
 *
 * The WSS handles the upgrade request for /api/ws, validates the token query
 * parameter, and manages the full client lifecycle. Returns a handle with
 * the broadcaster (for the consumer to call), client count (for health), and
 * shutdown (for graceful teardown).
 */
export function createWsServer(options: WsServerOptions): WsServerHandle {
  const { httpServer, logger: log, apiKey } = options;
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const pongTimeoutMs = options.pongTimeoutMs ?? PONG_TIMEOUT_MS;

  /** All currently connected, authenticated clients */
  const clients = new Map<string, ConnectedClient>();

  /** The ws WebSocketServer instance */
  const wss = new WebSocketServer({ server: httpServer, path: "/api/ws" });

  /** The broadcaster that dispatches messages to matching clients */
  const broadcaster = createBroadcaster(clients, log);

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  wss.on("connection", (ws: WebSocket, req) => {
    // --- Auth: validate token query param ---
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const token = url.searchParams.get("token");

    if (!token || token !== apiKey) {
      ws.close(4001, "Unauthorized");
      return;
    }

    // --- Authenticated: set up client state ---
    const clientId = generateId();
    const client: ConnectedClient = {
      id: clientId,
      ws,
      subscriptions: new Set(),
      isAlive: true,
    };

    clients.set(clientId, client);
    log.info({ clientId }, "WebSocket client connected");

    // --- Message handling ---
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        sendMessage(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      handleClientMessage(client, msg);
    });

    // --- Close handling ---
    ws.on("close", () => {
      clients.delete(clientId);
      log.info({ clientId }, "WebSocket client disconnected");
    });

    // --- Error handling ---
    ws.on("error", (err) => {
      log.error({ clientId, error: err.message }, "WebSocket client error");
      ws.close();
    });
  });

  // -------------------------------------------------------------------------
  // Client message dispatch
  // -------------------------------------------------------------------------

  function handleClientMessage(client: ConnectedClient, msg: ClientMessage): void {
    switch (msg.type) {
      case "subscribe":
        handleSubscribe(client, msg);
        break;
      case "unsubscribe":
        handleUnsubscribe(client, msg);
        break;
      case "pong":
        client.isAlive = true;
        break;
      default:
        sendMessage(client.ws, {
          type: "error",
          message: `Unknown message type: ${(msg as Record<string, unknown>).type}`,
        });
    }
  }

  // -------------------------------------------------------------------------
  // Subscription management
  // -------------------------------------------------------------------------

  function handleSubscribe(
    client: ConnectedClient,
    msg: ClientMessage & { type: "subscribe" },
  ): void {
    let subscription: string;

    if ("scope" in msg && msg.scope === "all") {
      subscription = "all";
    } else if ("workspace_id" in msg && msg.workspace_id) {
      subscription = `workspace:${msg.workspace_id}`;
    } else if ("session_id" in msg && msg.session_id) {
      subscription = `session:${msg.session_id}`;
    } else {
      sendMessage(client.ws, { type: "error", message: "Invalid subscribe message" });
      return;
    }

    client.subscriptions.add(subscription);
    sendMessage(client.ws, { type: "subscribed", subscription });
  }

  function handleUnsubscribe(
    client: ConnectedClient,
    msg: ClientMessage & { type: "unsubscribe" },
  ): void {
    if ("workspace_id" in msg && msg.workspace_id) {
      const subscription = `workspace:${msg.workspace_id}`;
      client.subscriptions.delete(subscription);
      sendMessage(client.ws, { type: "unsubscribed", subscription });
    } else if ("session_id" in msg && msg.session_id) {
      const subscription = `session:${msg.session_id}`;
      client.subscriptions.delete(subscription);
      sendMessage(client.ws, { type: "unsubscribed", subscription });
    } else {
      // No specific target — clear all subscriptions
      const subs = [...client.subscriptions];
      client.subscriptions.clear();
      for (const sub of subs) {
        sendMessage(client.ws, { type: "unsubscribed", subscription: sub });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ping/pong keepalive
  // -------------------------------------------------------------------------

  /**
   * Ping/pong keepalive strategy:
   *   - Every PING_INTERVAL_MS, mark all clients as not-alive and send ping
   *   - After PONG_TIMEOUT_MS, check if they responded — terminate if not
   *   - Total time before stale client is removed: pingInterval + pongTimeout
   */
  const pingInterval = setInterval(() => {
    for (const client of clients.values()) {
      // Mark as not-alive before sending ping — the pong handler will flip it back
      client.isAlive = false;
      sendMessage(client.ws, { type: "ping" });
    }

    // After pongTimeout, terminate clients that haven't responded
    setTimeout(() => {
      for (const [id, client] of clients.entries()) {
        if (!client.isAlive) {
          log.info({ clientId: id }, "WebSocket client stale — terminating");
          client.ws.terminate();
          clients.delete(id);
        }
      }
    }, pongTimeoutMs);
  }, pingIntervalMs);

  // Don't let the ping interval prevent process exit during shutdown
  if (pingInterval.unref) {
    pingInterval.unref();
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /** Send a JSON message to a WebSocket, handling errors gracefully */
  function sendMessage(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          log.warn({ error: err.message }, "Failed to send WebSocket message");
        }
      });
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "WebSocket send threw synchronously",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public handle
  // -------------------------------------------------------------------------

  return {
    broadcaster,

    getClientCount(): number {
      return clients.size;
    },

    async shutdown(): Promise<void> {
      // Stop ping interval
      clearInterval(pingInterval);

      // Close all client connections
      for (const client of clients.values()) {
        client.ws.close(1001, "Server shutting down");
      }
      clients.clear();

      // Close the WebSocket server.
      // When WSS was created with the `server` option, wss.close() waits for
      // the HTTP server to close. We use a short timeout to avoid blocking
      // shutdown if the HTTP server is closed separately (e.g., in production
      // the httpServer.close() is called before wsServer.shutdown()).
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          wss.close((err) => (err ? reject(err) : resolve()));
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);

      log.info("WebSocket server shut down");
    },
  };
}

// Re-export types and broadcaster for convenience
export type { WsBroadcaster } from "./broadcaster.js";
export type { ConnectedClient } from "./types.js";
