# Task 2: Server: WebSocket Server (Connection, Auth, Subscriptions, Broadcast)

## Parallel Group: A

## Dependencies: None

## Description

Build the WebSocket server that runs alongside Express on the same HTTP server. It handles authenticated connections, manages subscription state per client, broadcasts events and session updates to subscribed clients, and implements ping/pong keepalive. This is the server-side half of real-time updates; the CLI WebSocket client is built separately in Task 7 (Group B).

The `packages/server/src/ws/` directory already exists as an empty placeholder. This task populates it with the full WebSocket implementation.

### Connection Lifecycle

1. Client connects to `wss://<backend>/api/ws?token=<api_key>`.
2. Server validates `token` query parameter against the configured API key (same key used for REST auth).
3. If invalid or missing: close with code `4001` and reason `"Unauthorized"`.
4. If valid: add client to the connected clients map, assign a ULID client ID, log connection.
5. On message: parse JSON, validate message type, dispatch to handler.
6. On close: remove from clients map, clean up subscriptions, log disconnection.
7. On error: log error via pino, close connection.

### File: `packages/server/src/ws/types.ts`

Shared WebSocket message types. These match the CORE.md WebSocket Protocol section exactly.

```typescript
import type { Event } from '@fuel-code/shared';

// --- Client → Server messages ---

export type ClientMessage =
  | { type: 'subscribe'; scope: 'all' }
  | { type: 'subscribe'; workspace_id: string }
  | { type: 'subscribe'; session_id: string }
  | { type: 'unsubscribe'; workspace_id?: string; session_id?: string }
  | { type: 'pong' };

// --- Server → Client messages ---

export type ServerMessage =
  | { type: 'event'; event: Event }
  | { type: 'session.update'; session_id: string; lifecycle: string; summary?: string; stats?: SessionStats }
  | { type: 'remote.update'; remote_env_id: string; status: string; public_ip?: string }
  | { type: 'ping' }
  | { type: 'error'; message: string }
  | { type: 'subscribed'; subscription: string }
  | { type: 'unsubscribed'; subscription: string };

// Stats shape embedded in session.update messages
export interface SessionStats {
  total_messages?: number;
  total_cost_usd?: number;
  duration_ms?: number;
}

// Internal client tracking structure
export interface ConnectedClient {
  id: string;                    // ULID
  ws: WebSocket;
  subscriptions: Set<string>;    // "all" | "workspace:<id>" | "session:<id>"
  connectedAt: Date;
  lastPongAt: Date;
}
```

Also add these types to `packages/shared/src/types/ws.ts` so the CLI WebSocket client (Task 7) can import them without depending on the server package. Export `ClientMessage` and `ServerMessage` from shared. The server imports them from shared rather than defining its own copies.

### File: `packages/server/src/ws/index.ts`

The main WebSocket server module. Exports a factory function.

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HTTPServer } from 'http';
import type postgres from 'postgres';
import type pino from 'pino';
import { ulid } from 'ulidx';
import type { ConnectedClient, ClientMessage, ServerMessage } from './types';

interface WsServerDeps {
  httpServer: HTTPServer;
  logger: pino.Logger;
  apiKey: string;
}

interface WsServerHandle {
  broadcaster: WsBroadcaster;
  getClientCount: () => number;
  shutdown: () => Promise<void>;
}

export function createWsServer(deps: WsServerDeps): WsServerHandle {
  const { httpServer, logger, apiKey } = deps;
  const clients = new Map<string, ConnectedClient>();

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/ws',
    // Auth is checked in the 'connection' handler via query param
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // 1. Extract token from query string
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    // 2. Validate token
    if (!token || token !== apiKey) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // 3. Register client
    const clientId = ulid();
    const client: ConnectedClient = {
      id: clientId,
      ws,
      subscriptions: new Set(),
      connectedAt: new Date(),
      lastPongAt: new Date(),
    };
    clients.set(clientId, client);
    logger.info({ clientId }, 'WebSocket client connected');

    // 4. Message handler
    ws.on('message', (data: Buffer) => {
      handleClientMessage(client, data);
    });

    // 5. Close handler
    ws.on('close', () => {
      clients.delete(clientId);
      logger.info({ clientId }, 'WebSocket client disconnected');
    });

    // 6. Error handler
    ws.on('error', (err: Error) => {
      logger.error({ clientId, err }, 'WebSocket client error');
      clients.delete(clientId);
    });
  });

  // Message parsing + dispatch (see handleClientMessage below)
  // Ping/pong keepalive (see keepalive section below)
  // Broadcaster (see broadcaster section below)
  // Shutdown (see shutdown section below)

  return { broadcaster, getClientCount: () => clients.size, shutdown };
}
```

### Client Message Handling

```typescript
function handleClientMessage(client: ConnectedClient, raw: Buffer): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    sendToClient(client, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  // Validate message has a type field
  if (!msg || typeof msg.type !== 'string') {
    sendToClient(client, { type: 'error', message: 'Missing message type' });
    return;
  }

  switch (msg.type) {
    case 'subscribe':
      handleSubscribe(client, msg);
      break;
    case 'unsubscribe':
      handleUnsubscribe(client, msg);
      break;
    case 'pong':
      client.lastPongAt = new Date();
      break;
    default:
      sendToClient(client, { type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}
```

### Subscription Management

Subscription rules:
- `{ type: "subscribe", scope: "all" }` -- receive all events and session updates. Stored as `"all"` in subscriptions set.
- `{ type: "subscribe", workspace_id: "01ABC..." }` -- receive events for that workspace. Stored as `"workspace:01ABC..."`.
- `{ type: "subscribe", session_id: "01DEF..." }` -- receive updates for that session. Stored as `"session:01DEF..."`.
- Multiple subscriptions stack (union). Subscribing to "all" supersedes workspace/session subs (checked at broadcast time).
- `{ type: "unsubscribe" }` with no workspace_id/session_id clears all subscriptions.
- `{ type: "unsubscribe", workspace_id: "01ABC..." }` removes only that workspace subscription.

```typescript
function handleSubscribe(client: ConnectedClient, msg: ClientMessage): void {
  let subscriptionKey: string;

  if ('scope' in msg && msg.scope === 'all') {
    subscriptionKey = 'all';
  } else if ('workspace_id' in msg && msg.workspace_id) {
    subscriptionKey = `workspace:${msg.workspace_id}`;
  } else if ('session_id' in msg && msg.session_id) {
    subscriptionKey = `session:${msg.session_id}`;
  } else {
    sendToClient(client, { type: 'error', message: 'Invalid subscribe: must provide scope, workspace_id, or session_id' });
    return;
  }

  client.subscriptions.add(subscriptionKey);
  sendToClient(client, { type: 'subscribed', subscription: subscriptionKey });
  logger.debug({ clientId: client.id, subscription: subscriptionKey }, 'Client subscribed');
}

function handleUnsubscribe(client: ConnectedClient, msg: ClientMessage): void {
  if ('workspace_id' in msg && msg.workspace_id) {
    const key = `workspace:${msg.workspace_id}`;
    client.subscriptions.delete(key);
    sendToClient(client, { type: 'unsubscribed', subscription: key });
  } else if ('session_id' in msg && msg.session_id) {
    const key = `session:${msg.session_id}`;
    client.subscriptions.delete(key);
    sendToClient(client, { type: 'unsubscribed', subscription: key });
  } else {
    // Clear all subscriptions
    client.subscriptions.clear();
    sendToClient(client, { type: 'unsubscribed', subscription: 'all' });
  }
}
```

### File: `packages/server/src/ws/broadcaster.ts`

The broadcaster interface and implementation. This is the bridge between the event processor pipeline and connected WebSocket clients.

```typescript
export interface WsBroadcaster {
  // Called by event processor after a new event is ingested and processed
  broadcastEvent(event: Event): void;

  // Called when a session lifecycle changes (e.g., capturing → ended → parsed → summarized)
  broadcastSessionUpdate(
    sessionId: string,
    workspaceId: string,
    lifecycle: string,
    summary?: string,
    stats?: SessionStats
  ): void;

  // Called for remote env status changes (future use)
  broadcastRemoteUpdate(remoteEnvId: string, workspaceId: string, status: string, publicIp?: string): void;
}
```

Implementation:

```typescript
function createBroadcaster(clients: Map<string, ConnectedClient>, logger: pino.Logger): WsBroadcaster {
  return {
    broadcastEvent(event: Event): void {
      const msg: ServerMessage = { type: 'event', event };
      broadcastToMatching(msg, {
        workspace_id: event.workspace_id,
        session_id: event.session_id ?? undefined,
      });
    },

    broadcastSessionUpdate(sessionId, workspaceId, lifecycle, summary, stats): void {
      const msg: ServerMessage = {
        type: 'session.update',
        session_id: sessionId,
        lifecycle,
        ...(summary && { summary }),
        ...(stats && { stats }),
      };
      broadcastToMatching(msg, {
        workspace_id: workspaceId,
        session_id: sessionId,
      });
    },

    broadcastRemoteUpdate(remoteEnvId, workspaceId, status, publicIp): void {
      const msg: ServerMessage = {
        type: 'remote.update',
        remote_env_id: remoteEnvId,
        status,
        ...(publicIp && { public_ip: publicIp }),
      };
      broadcastToMatching(msg, { workspace_id: workspaceId });
    },
  };
}
```

**`broadcastToMatching`** -- The core broadcast dispatch. Iterates over all connected clients, checks if their subscriptions match, and sends the message:

```typescript
function broadcastToMatching(
  msg: ServerMessage,
  filter: { workspace_id?: string; session_id?: string }
): void {
  const payload = JSON.stringify(msg);

  for (const [clientId, client] of clients) {
    if (!clientMatchesFilter(client, filter)) continue;

    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(payload);
      }
    } catch (err) {
      // Client disconnected mid-send. Remove and continue.
      logger.warn({ clientId, err }, 'Failed to send to WebSocket client, removing');
      clients.delete(clientId);
    }
  }
}

function clientMatchesFilter(
  client: ConnectedClient,
  filter: { workspace_id?: string; session_id?: string }
): boolean {
  // "all" subscription matches everything
  if (client.subscriptions.has('all')) return true;

  // Check workspace subscription
  if (filter.workspace_id && client.subscriptions.has(`workspace:${filter.workspace_id}`)) {
    return true;
  }

  // Check session subscription
  if (filter.session_id && client.subscriptions.has(`session:${filter.session_id}`)) {
    return true;
  }

  return false;
}
```

Broadcast MUST be non-blocking. No `await` on `ws.send()`. Errors are caught, logged, and the client is removed. Broadcasting continues to remaining clients.

### Ping/Pong Keepalive

Server sends `{ type: "ping" }` to every connected client every 30 seconds. Clients respond with `{ type: "pong" }`. If a client's `lastPongAt` is more than 10 seconds before the current ping, the connection is considered stale and terminated.

```typescript
// Start a 30-second interval to send pings
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

const pingInterval = setInterval(() => {
  const now = Date.now();
  const pingMsg = JSON.stringify({ type: 'ping' });

  for (const [clientId, client] of clients) {
    // Check if previous pong was received within timeout
    const timeSinceLastPong = now - client.lastPongAt.getTime();
    if (timeSinceLastPong > PING_INTERVAL_MS + PONG_TIMEOUT_MS) {
      logger.info({ clientId, timeSinceLastPong }, 'WebSocket client stale, terminating');
      client.ws.terminate();
      clients.delete(clientId);
      continue;
    }

    // Send ping
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(pingMsg);
      }
    } catch {
      clients.delete(clientId);
    }
  }
}, PING_INTERVAL_MS);
```

The staleness check uses `PING_INTERVAL_MS + PONG_TIMEOUT_MS` (40 seconds total) to allow for one full ping cycle plus the timeout window. This avoids false positives from clients that connect just before a ping cycle.

### Utility: `sendToClient`

```typescript
function sendToClient(client: ConnectedClient, msg: ServerMessage): void {
  try {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  } catch (err) {
    logger.warn({ clientId: client.id, err }, 'Failed to send to client');
  }
}
```

### Shutdown

```typescript
async function shutdown(): Promise<void> {
  clearInterval(pingInterval);

  // Close all client connections gracefully
  for (const [clientId, client] of clients) {
    try {
      client.ws.close(1001, 'Server shutting down');
    } catch {
      // Ignore close errors during shutdown
    }
  }
  clients.clear();

  // Close the WebSocket server
  await new Promise<void>((resolve, reject) => {
    wss.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
```

### Integration with Event Processor Pipeline

Modify `packages/server/src/index.ts` to wire the WebSocket server into the HTTP server and pass the broadcaster to the event processor:

```typescript
import { createServer } from 'http';
import { createWsServer } from './ws';

// Instead of app.listen(), create an HTTP server and mount Express on it
const httpServer = createServer(app);

// Create WebSocket server on the same HTTP server
const { broadcaster, getClientCount, shutdown: wsShutdown } = createWsServer({
  httpServer,
  logger,
  apiKey: config.apiKey,
});

// Pass broadcaster to the pipeline consumer so it can broadcast after processing events
const consumer = createConsumer({
  sql,
  redis,
  logger,
  broadcaster, // NEW: inject broadcaster
});

// Start listening
httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server started');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await wsShutdown();
  httpServer.close();
});
```

Modify `packages/server/src/pipeline/consumer.ts` (or the relevant handler dispatch point) to call broadcaster methods after processing:

```typescript
// After event is processed and written to Postgres:
broadcaster.broadcastEvent(processedEvent);

// After session lifecycle transitions (e.g., in session-start handler, session-end handler, etc.):
broadcaster.broadcastSessionUpdate(
  sessionId,
  workspaceId,
  newLifecycle,
  session.summary,
  computedStats
);
```

### Health Endpoint Enhancement

Modify the existing `GET /api/health` endpoint to include WebSocket client count:

```typescript
// In the health route handler, add:
{
  status: 'ok',
  postgres: true,
  redis: true,
  ws_clients: getClientCount(),  // NEW field
  uptime: process.uptime(),
  version: packageVersion,
}
```

### Dependencies

```bash
cd packages/server && bun add ws
cd packages/server && bun add -d @types/ws
```

---

### Tests

**`packages/server/src/ws/__tests__/ws-server.test.ts`**:

Use the `ws` library as a test client. Create a minimal HTTP server, mount the WS server on it, and connect test clients.

1. Connection with valid token: client connects successfully, no error received.
2. Connection with invalid token: connection closed with code 4001 and reason "Unauthorized".
3. Connection without token: connection closed with code 4001.
4. Subscribe to `{ type: "subscribe", scope: "all" }`: receives ack `{ type: "subscribed", subscription: "all" }`.
5. Subscribe to `{ type: "subscribe", workspace_id: "01ABC" }`: receives ack `{ type: "subscribed", subscription: "workspace:01ABC" }`.
6. Subscribe to `{ type: "subscribe", session_id: "01DEF" }`: receives ack `{ type: "subscribed", subscription: "session:01DEF" }`.
7. After subscribing to "all", `broadcastEvent()` delivers the event to the client.
8. After subscribing to workspace A, `broadcastEvent()` with workspace A delivers; workspace B does not.
9. After subscribing to session S, `broadcastSessionUpdate()` for session S delivers; session T does not.
10. Unsubscribe from workspace: subsequent broadcasts for that workspace are not received.
11. Unsubscribe with no params: clears all subscriptions, no broadcasts received.
12. Multiple clients with different subscriptions: each receives only matching messages.
13. `broadcastEvent()` with both workspace_id and session_id: client subscribed to either receives the message.
14. Ping/pong: server sends `{ type: "ping" }`, client responds with `{ type: "pong" }`, connection stays alive.
15. Stale client: client does NOT respond to ping. After timeout period (use fake timers), connection is terminated.
16. Client disconnect during broadcast: no crash, client is removed from map, other clients still receive.
17. Invalid JSON message from client: server sends `{ type: "error", message: "Invalid JSON" }`.
18. Unknown message type from client: server sends `{ type: "error", message: "Unknown message type: ..." }`.
19. `getClientCount()` returns 0 initially, increments on connect, decrements on disconnect.
20. `shutdown()` closes all connections gracefully (clients receive close event).
21. `broadcastSessionUpdate()` includes optional summary and stats fields when provided.
22. `broadcastSessionUpdate()` omits summary and stats fields when not provided.

**Test approach**: Start a real HTTP server on a random port. Connect test `ws` clients. Use `bun:test`'s `beforeEach`/`afterEach` to set up and tear down. For ping/pong timeout tests, use fake timers (`jest.useFakeTimers()` equivalent in bun:test) to advance time without waiting.

## Relevant Files

- `packages/shared/src/types/ws.ts` (create -- shared ClientMessage, ServerMessage types)
- `packages/shared/src/types/index.ts` (modify -- re-export ws types)
- `packages/server/src/ws/types.ts` (create -- ConnectedClient + re-export from shared)
- `packages/server/src/ws/index.ts` (create -- WebSocket server factory)
- `packages/server/src/ws/broadcaster.ts` (create -- WsBroadcaster interface and implementation)
- `packages/server/src/index.ts` (modify -- wire WS server to HTTP server, pass broadcaster to consumer)
- `packages/server/src/pipeline/consumer.ts` (modify -- accept broadcaster dep, call broadcast after processing)
- `packages/server/src/routes/health.ts` (modify -- add ws_clients count to health response)
- `packages/server/package.json` (modify -- add `ws` and `@types/ws` dependencies)
- `packages/server/src/ws/__tests__/ws-server.test.ts` (create)

## Success Criteria

1. WebSocket server accepts connections at `/api/ws?token=<api_key>`.
2. Invalid or missing token results in immediate close with code 4001 and reason "Unauthorized".
3. Valid connections are assigned a ULID client ID and tracked in the clients map.
4. Subscribe messages (`scope: "all"`, `workspace_id`, `session_id`) are acknowledged with typed `subscribed` responses.
5. Unsubscribe messages remove the specified subscription (or all subscriptions if no filter given).
6. `broadcastEvent()` sends events only to clients subscribed to "all", the matching workspace, or the matching session.
7. `broadcastSessionUpdate()` sends lifecycle changes to clients subscribed to the relevant workspace or session.
8. Clients subscribed to "all" receive every broadcast regardless of workspace/session filter.
9. Broadcast is non-blocking: a failed `ws.send()` catches the error, removes the client, and continues to other clients.
10. Ping interval of 30 seconds sends `{ type: "ping" }` to all connected clients.
11. Client pong responses update `lastPongAt` timestamp.
12. Stale clients (no pong within PING_INTERVAL + PONG_TIMEOUT) are terminated automatically.
13. Invalid JSON messages from clients receive `{ type: "error" }` response.
14. Unknown message types receive `{ type: "error" }` response.
15. `getClientCount()` accurately reflects the number of connected, authenticated clients.
16. `shutdown()` closes all connections, clears the ping interval, and closes the WSS.
17. Event processor calls `broadcaster.broadcastEvent()` after processing each event.
18. Session lifecycle transitions call `broadcaster.broadcastSessionUpdate()`.
19. `GET /api/health` includes `ws_clients` count in response.
20. WS message types (`ClientMessage`, `ServerMessage`) are shared via `packages/shared/` for use by both server and CLI client.
21. `ws` and `@types/ws` added to server package.json.
22. All 22 tests pass (`bun test`).
