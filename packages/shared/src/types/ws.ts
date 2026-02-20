/**
 * Shared WebSocket message types for the fuel-code real-time update system.
 *
 * These types define the protocol between the server WebSocket (Task 2) and
 * CLI WebSocket client (Task 7). Both sides import from here to stay in sync.
 *
 * Message flow:
 *   Client -> Server: subscribe, unsubscribe, pong
 *   Server -> Client: event, session.update, remote.update, ping, error, subscribed, unsubscribed
 */

import type { Event } from "./event.js";

// ---------------------------------------------------------------------------
// Session stats — lightweight counters sent with session.update messages
// ---------------------------------------------------------------------------

/** Compact session statistics included in session.update broadcasts */
export interface SessionStats {
  /** Total number of events in this session */
  event_count: number;
  /** Number of git commits during this session */
  commit_count: number;
  /** Session duration in milliseconds (null if still active) */
  duration_ms: number | null;
}

// ---------------------------------------------------------------------------
// Client -> Server messages
// ---------------------------------------------------------------------------

/** Subscribe to a scope: all events, a specific workspace, or a specific session */
export type ClientSubscribeMessage =
  | { type: "subscribe"; scope: "all" }
  | { type: "subscribe"; workspace_id: string }
  | { type: "subscribe"; session_id: string };

/** Unsubscribe from a specific workspace/session, or clear all subscriptions */
export interface ClientUnsubscribeMessage {
  type: "unsubscribe";
  workspace_id?: string;
  session_id?: string;
}

/** Pong response to server ping (keepalive) */
export interface ClientPongMessage {
  type: "pong";
}

/** Union of all messages a client can send to the server */
export type ClientMessage =
  | ClientSubscribeMessage
  | ClientUnsubscribeMessage
  | ClientPongMessage;

// ---------------------------------------------------------------------------
// Server -> Client messages
// ---------------------------------------------------------------------------

/** A new event was ingested that matches the client's subscription */
export interface ServerEventMessage {
  type: "event";
  event: Event;
}

/** A session's lifecycle, summary, or stats changed */
export interface ServerSessionUpdateMessage {
  type: "session.update";
  session_id: string;
  lifecycle: string;
  summary?: string;
  stats?: SessionStats;
}

/** A remote environment's status changed (future use) */
export interface ServerRemoteUpdateMessage {
  type: "remote.update";
  remote_env_id: string;
  status: string;
  public_ip?: string;
}

/** Server ping — client must respond with pong within timeout */
export interface ServerPingMessage {
  type: "ping";
}

/** Error message sent to the client */
export interface ServerErrorMessage {
  type: "error";
  message: string;
}

/** Acknowledgement that a subscription was added */
export interface ServerSubscribedMessage {
  type: "subscribed";
  subscription: string;
}

/** Acknowledgement that a subscription was removed */
export interface ServerUnsubscribedMessage {
  type: "unsubscribed";
  subscription: string;
}

/** Union of all messages the server can send to a client */
export type ServerMessage =
  | ServerEventMessage
  | ServerSessionUpdateMessage
  | ServerRemoteUpdateMessage
  | ServerPingMessage
  | ServerErrorMessage
  | ServerSubscribedMessage
  | ServerUnsubscribedMessage;
