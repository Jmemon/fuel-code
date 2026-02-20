/**
 * WebSocket client library for fuel-code CLI real-time updates.
 *
 * Connects to the backend WS endpoint (/api/ws), handles authentication,
 * manages subscriptions, and auto-reconnects on disconnect with exponential
 * backoff. CLI commands and TUI views use this for live streaming of events,
 * session updates, and remote environment status changes.
 *
 * The client extends EventEmitter and emits typed events that map 1:1 to
 * the server's outbound message types (event, session.update, remote.update),
 * plus connection lifecycle events (connected, disconnected, reconnecting, error).
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import type { FuelCodeConfig } from "./config.js";
import type {
  ClientMessage,
  ServerMessage,
  Event,
  SessionStats,
} from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ServerMessage, ClientMessage, SessionStats };

export interface WsClientOptions {
  /** HTTP base URL of the backend (e.g., https://fuel-code.up.railway.app) */
  baseUrl: string;
  /** API key for WebSocket authentication */
  apiKey: string;
  /** Whether to auto-reconnect on unexpected disconnect (default: true) */
  reconnect?: boolean;
  /** Maximum number of reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /** Maximum backoff delay in milliseconds (default: 30000) */
  maxReconnectDelay?: number;
}

export type WsConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

// ---------------------------------------------------------------------------
// Typed event map (for documentation — EventEmitter is untyped at runtime)
// ---------------------------------------------------------------------------

/**
 * Events emitted by WsClient:
 *   'event'          → (event: Event) => void
 *   'session.update' → (update: { session_id, lifecycle, summary?, stats? }) => void
 *   'remote.update'  → (update: { remote_env_id, status, public_ip? }) => void
 *   'connected'      → () => void
 *   'disconnected'   → (reason: string) => void
 *   'reconnecting'   → (attempt: number, delay: number) => void
 *   'error'          → (error: Error) => void
 */

// ---------------------------------------------------------------------------
// WsClient implementation
// ---------------------------------------------------------------------------

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private _state: WsConnectionState = "disconnected";
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Locally persisted subscriptions for re-sending on reconnect.
   * Map key format: "all", "workspace:<id>", "session:<id>"
   * Map value: the original ClientMessage to re-send
   */
  private subscriptions: Map<string, ClientMessage> = new Map();
  private intentionalClose: boolean = false;
  private options: Required<WsClientOptions>;

  constructor(options: WsClientOptions) {
    super();
    this.options = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      reconnect: options.reconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      maxReconnectDelay: options.maxReconnectDelay ?? 30_000,
    };
  }

  /**
   * Factory: create a WsClient from the CLI config file.
   * Reads backend.url and backend.api_key from the loaded config.
   */
  static fromConfig(config: FuelCodeConfig): WsClient {
    return new WsClient({
      baseUrl: config.backend.url,
      apiKey: config.backend.api_key,
    });
  }

  /**
   * Open a WebSocket connection to the backend.
   * Resolves when the connection is open and authenticated.
   * Rejects on auth failure (close code 4001) or connection error.
   *
   * Note: The ws library fires `open` before the server's application-level
   * close (e.g., 4001 auth rejection). We defer resolution by a tick after
   * open so that an immediate auth-rejection close frame can arrive first.
   */
  async connect(): Promise<void> {
    // Guard against double-connect (TUI re-renders could trigger this)
    if (this._state === "connected") return;
    if (this._state === "connecting") {
      throw new Error("Connection already in progress");
    }

    return new Promise<void>((resolve, reject) => {
      this.intentionalClose = false;
      this._state = "connecting";

      const url = this.buildWsUrl();
      const ws = new WebSocket(url);
      this.ws = ws;

      // Track whether we've settled the promise (open or first error/close)
      let settled = false;
      // Track if open has fired (used to distinguish pre-open vs post-open close)
      let opened = false;

      ws.on("open", () => {
        opened = true;
        // Defer resolution by a tick so that an immediate server close (e.g.,
        // 4001 auth rejection) has a chance to arrive and reject first.
        setTimeout(() => {
          if (!settled) {
            settled = true;
            this._state = "connected";
            this.reconnectAttempt = 0;
            this.emit("connected");
            this.resubscribe();
            resolve();
          }
        }, 50);
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      ws.on("close", (...closeArgs: unknown[]) => {
        // Bun's ws passes (code, reason_string, wasClean) with 3 args.
        // Standard ws passes (code: number, reason: Buffer). Handle both.
        const code = typeof closeArgs[0] === "number" ? closeArgs[0] : 0;
        const reason = closeArgs[1];
        const reasonStr =
          (reason != null ? String(reason) : "") || `code ${code}`;
        this._state = "disconnected";
        this.ws = null;

        // Auth rejection (code 4001): don't reconnect, reject the promise.
        if (code === 4001) {
          this.intentionalClose = true;
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket auth rejected: ${reasonStr}`));
          }
          this.emit("disconnected", reasonStr);
          return;
        }

        // Close arrived before the connect promise settled (before open
        // resolved or before the 50ms defer completed). Reject the promise
        // so the caller knows this attempt failed.
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before open: ${reasonStr}`));
          return;
        }

        // Normal post-connect close: emit disconnected and maybe reconnect.
        // Skip emit if intentional (disconnect() already handled cleanup).
        if (this.intentionalClose) return;

        this.emit("disconnected", reasonStr);

        if (this.options.reconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on("error", (err: Error) => {
        // If the promise hasn't settled yet, reject it.
        // Otherwise just emit the error — the close handler will trigger reconnect.
        if (!settled) {
          settled = true;
          this._state = "disconnected";
          this.ws = null;
          reject(err);
          return;
        }
        this.emit("error", err);
      });
    });
  }

  /**
   * Intentionally close the connection. Suppresses auto-reconnect.
   */
  disconnect(): void {
    this.intentionalClose = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this._state = "disconnected";
  }

  /** True only when the connection is fully open */
  get connected(): boolean {
    return this._state === "connected";
  }

  /** Current connection state */
  get state(): WsConnectionState {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to real-time updates. Accepts one of:
   *   { scope: 'all' }       — all events across all workspaces
   *   { workspace_id: '...' } — events for a specific workspace
   *   { session_id: '...' }   — events for a specific session
   *
   * Subscriptions are persisted locally and automatically re-sent on reconnect.
   */
  subscribe(opts: { scope: "all" } | { workspace_id: string } | { session_id: string }): void {
    let key: string;
    let msg: ClientMessage;

    if ("scope" in opts && opts.scope === "all") {
      key = "all";
      msg = { type: "subscribe", scope: "all" };
    } else if ("workspace_id" in opts) {
      key = `workspace:${opts.workspace_id}`;
      msg = { type: "subscribe", workspace_id: opts.workspace_id };
    } else if ("session_id" in opts) {
      key = `session:${opts.session_id}`;
      msg = { type: "subscribe", session_id: opts.session_id };
    } else {
      return;
    }

    this.subscriptions.set(key, msg);
    this.send(msg);
  }

  /**
   * Unsubscribe from updates. With no args, clears all subscriptions.
   * With workspace_id or session_id, removes that specific subscription.
   */
  unsubscribe(opts?: { workspace_id?: string; session_id?: string }): void {
    if (!opts || (!opts.workspace_id && !opts.session_id)) {
      // Clear all subscriptions
      this.subscriptions.clear();
      this.send({ type: "unsubscribe" });
    } else if (opts.workspace_id) {
      this.subscriptions.delete(`workspace:${opts.workspace_id}`);
      this.send({ type: "unsubscribe", workspace_id: opts.workspace_id });
    } else if (opts.session_id) {
      this.subscriptions.delete(`session:${opts.session_id}`);
      this.send({ type: "unsubscribe", session_id: opts.session_id });
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Full cleanup: disconnect, remove all listeners, clear subscriptions.
   * Call this when the WsClient is no longer needed.
   */
  destroy(): void {
    this.disconnect();
    this.subscriptions.clear();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Convert the HTTP base URL to a WebSocket URL.
   * https → wss, http → ws, strips trailing slash, appends /api/ws?token=<key>.
   */
  private buildWsUrl(): string {
    let base = this.options.baseUrl.replace(/\/+$/, "");
    base = base.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    return `${base}/api/ws?token=${encodeURIComponent(this.options.apiKey)}`;
  }

  /**
   * Parse an incoming WebSocket message and dispatch as a typed event.
   * Auto-responds to pings with pong. Unknown types are silently ignored.
   */
  private handleMessage(data: WebSocket.Data): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.emit("error", new Error("Invalid JSON received from WebSocket server"));
      return;
    }

    // Guard: ensure message has a type field
    if (!msg || typeof (msg as Record<string, unknown>).type !== "string") {
      return;
    }

    switch (msg.type) {
      case "event":
        this.emit("event", msg.event);
        break;
      case "session.update":
        this.emit("session.update", {
          session_id: msg.session_id,
          lifecycle: msg.lifecycle,
          summary: msg.summary,
          stats: msg.stats,
        });
        break;
      case "remote.update":
        this.emit("remote.update", {
          remote_env_id: msg.remote_env_id,
          status: msg.status,
          public_ip: msg.public_ip,
        });
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "error":
        this.emit("error", new Error(msg.message));
        break;
      case "subscribed":
      case "unsubscribed":
        // Acknowledgement messages — no action needed on the client side
        break;
      default:
        // Unknown message type — silently ignored for forward compatibility
        break;
    }
  }

  /**
   * Schedule a reconnect attempt with exponential backoff and jitter.
   * Backoff formula: min(1000 * 2^attempt, maxReconnectDelay) + random(0, 500)
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.options.maxReconnectAttempts) {
      this.emit(
        "error",
        new Error(
          `Max reconnection attempts (${this.options.maxReconnectAttempts}) reached`,
        ),
      );
      return;
    }

    const delay =
      Math.min(
        1000 * Math.pow(2, this.reconnectAttempt),
        this.options.maxReconnectDelay,
      ) + Math.random() * 500;

    this._state = "reconnecting";
    this.reconnectAttempt++;
    this.emit("reconnecting", this.reconnectAttempt, delay);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // connect() rejected — server is still down or closed immediately.
        // The close handler only calls scheduleReconnect() for post-settle
        // closes. For pre-settle closes (connection refused, immediate server
        // close before the connect promise resolved), we must re-schedule here.
        // Guard against double-scheduling by checking that no timer is pending.
        if (
          !this.intentionalClose &&
          this.options.reconnect &&
          this.reconnectTimer === null
        ) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * Re-send all locally persisted subscriptions to the server.
   * Called after a successful (re)connect.
   */
  private resubscribe(): void {
    for (const msg of this.subscriptions.values()) {
      this.send(msg);
    }
  }

  /**
   * Send a JSON message to the server. No-op if not connected.
   */
  private send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      // Swallow send errors — the close handler will trigger reconnect if needed
    }
  }
}
