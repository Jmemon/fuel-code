/**
 * Server-internal WebSocket types.
 *
 * ConnectedClient tracks the state of a single authenticated WebSocket connection:
 * its unique ID, subscription set, and keepalive status. The WS server module
 * manages a Map<string, ConnectedClient> for all active connections.
 */

import type WebSocket from "ws";

// Re-export shared WS types so server code can import from one place
export type {
  ClientMessage,
  ServerMessage,
  SessionStats,
  ClientSubscribeMessage,
  ClientUnsubscribeMessage,
  ClientPongMessage,
  ServerEventMessage,
  ServerSessionUpdateMessage,
  ServerRemoteUpdateMessage,
  ServerPingMessage,
  ServerErrorMessage,
  ServerSubscribedMessage,
  ServerUnsubscribedMessage,
} from "@fuel-code/shared";

/**
 * Server-side representation of a connected WebSocket client.
 *
 * Each authenticated connection gets a ULID client ID and maintains its own
 * set of subscriptions. The keepalive flag tracks ping/pong health — if
 * a client doesn't respond to ping within the timeout, it's terminated.
 */
export interface ConnectedClient {
  /** ULID assigned on connection — used for logging and subscription management */
  id: string;
  /** The underlying WebSocket connection */
  ws: WebSocket;
  /** Set of active subscriptions: "all", "workspace:<id>", "session:<id>" */
  subscriptions: Set<string>;
  /** Tracks whether the client has responded to the latest ping */
  isAlive: boolean;
}
