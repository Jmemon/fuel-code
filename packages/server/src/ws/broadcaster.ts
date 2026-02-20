/**
 * WebSocket broadcaster — dispatches real-time updates to subscribed clients.
 *
 * The broadcaster is the outbound half of the WS system. It receives domain
 * events (new events, session updates, remote updates) and fans them out to
 * connected clients whose subscriptions match.
 *
 * Broadcast is non-blocking: ws.send() is fire-and-forget with an error
 * callback that logs failures rather than throwing. This ensures a slow or
 * disconnecting client never blocks the event pipeline.
 *
 * Subscription matching:
 *   - "all" — client receives everything
 *   - "workspace:<id>" — client receives events/updates for that workspace
 *   - "session:<id>" — client receives events/updates for that session
 */

import { WebSocket } from "ws";
import type { Logger } from "pino";
import type { Event } from "@fuel-code/shared";
import type { ConnectedClient, ServerMessage, SessionStats } from "./types.js";

// ---------------------------------------------------------------------------
// Filter types — describe which clients should receive a broadcast
// ---------------------------------------------------------------------------

/** Filter criteria for matching clients to a broadcast */
export interface BroadcastFilter {
  workspace_id?: string;
  session_id?: string;
}

// ---------------------------------------------------------------------------
// Broadcaster interface — used by the consumer and other server modules
// ---------------------------------------------------------------------------

/** Public interface for broadcasting updates to WebSocket clients */
export interface WsBroadcaster {
  /** Broadcast a new event to clients subscribed to its workspace or session */
  broadcastEvent(event: Event): void;
  /** Broadcast a session lifecycle change with optional summary and stats */
  broadcastSessionUpdate(
    sessionId: string,
    workspaceId: string,
    lifecycle: string,
    summary?: string,
    stats?: SessionStats,
  ): void;
  /** Broadcast a remote environment status change (future use) */
  broadcastRemoteUpdate(
    remoteEnvId: string,
    workspaceId: string,
    status: string,
    publicIp?: string,
  ): void;
}

// ---------------------------------------------------------------------------
// Broadcaster implementation
// ---------------------------------------------------------------------------

/**
 * Create a broadcaster that dispatches messages to matching connected clients.
 *
 * @param clients - Live reference to the connected clients map (mutated by WS server)
 * @param logger  - Pino logger for error/debug logging
 */
export function createBroadcaster(
  clients: Map<string, ConnectedClient>,
  logger: Logger,
): WsBroadcaster {
  /**
   * Check if a client's subscriptions match a broadcast filter.
   *
   * A client matches if any of:
   *   - It has the "all" subscription
   *   - It subscribes to the specific workspace_id
   *   - It subscribes to the specific session_id
   */
  function clientMatchesFilter(
    client: ConnectedClient,
    filter: BroadcastFilter,
  ): boolean {
    if (client.subscriptions.has("all")) return true;
    if (filter.workspace_id && client.subscriptions.has(`workspace:${filter.workspace_id}`)) return true;
    if (filter.session_id && client.subscriptions.has(`session:${filter.session_id}`)) return true;
    return false;
  }

  /**
   * Core dispatch: send a message to all clients matching the filter.
   * Non-blocking — errors are logged, not thrown.
   */
  function broadcastToMatching(msg: ServerMessage, filter: BroadcastFilter): void {
    const payload = JSON.stringify(msg);

    for (const client of clients.values()) {
      if (!clientMatchesFilter(client, filter)) continue;
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      try {
        client.ws.send(payload, (err) => {
          if (err) {
            logger.warn(
              { clientId: client.id, error: err.message },
              "Failed to send WebSocket message — removing client",
            );
            clients.delete(client.id);
          }
        });
      } catch (err) {
        // ws.send can throw if the connection is already closed — remove the client
        logger.warn(
          { clientId: client.id, error: err instanceof Error ? err.message : String(err) },
          "WebSocket send threw synchronously — removing client",
        );
        clients.delete(client.id);
      }
    }
  }

  return {
    broadcastEvent(event: Event): void {
      const msg: ServerMessage = { type: "event", event };
      broadcastToMatching(msg, {
        workspace_id: event.workspace_id,
        session_id: event.session_id ?? undefined,
      });
    },

    broadcastSessionUpdate(
      sessionId: string,
      workspaceId: string,
      lifecycle: string,
      summary?: string,
      stats?: SessionStats,
    ): void {
      const msg: ServerMessage = {
        type: "session.update",
        session_id: sessionId,
        lifecycle,
        ...(summary !== undefined ? { summary } : {}),
        ...(stats !== undefined ? { stats } : {}),
      };
      broadcastToMatching(msg, {
        workspace_id: workspaceId,
        session_id: sessionId,
      });
    },

    broadcastRemoteUpdate(
      remoteEnvId: string,
      workspaceId: string,
      status: string,
      publicIp?: string,
    ): void {
      const msg: ServerMessage = {
        type: "remote.update",
        remote_env_id: remoteEnvId,
        status,
        ...(publicIp !== undefined ? { public_ip: publicIp } : {}),
      };
      broadcastToMatching(msg, { workspace_id: workspaceId });
    },
  };
}
