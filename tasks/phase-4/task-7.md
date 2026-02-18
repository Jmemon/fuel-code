# Task 7: CLI: WebSocket Client Library

## Parallel Group: B

**Dependencies**: Task 2 (Server: WebSocket Server), Task 3 (API Client + Output Formatting Utilities)

## Description

Build the WebSocket client library that CLI commands and TUI views use for real-time updates. It connects to the backend WS endpoint built in Task 2, handles authentication, manages subscriptions, auto-reconnects on disconnect with exponential backoff, and exposes a typed EventEmitter API for receiving messages. This library is foundational for the TUI dashboard (Task 8) and TUI session detail (Task 9).

### `packages/cli/src/lib/ws-client.ts`

```typescript
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { FuelCodeConfig } from './config';

// ─── Message Types (from CORE.md WebSocket Protocol) ───────────────

// Messages the server sends to the client.
export type ServerMessage =
  | { type: 'event'; event: Event }
  | { type: 'session.update'; session_id: string; lifecycle: string; summary?: string; stats?: SessionStats }
  | { type: 'remote.update'; remote_env_id: string; status: string; public_ip?: string }
  | { type: 'ping' }
  | { type: 'error'; message: string }
  | { type: 'subscribed'; subscription: string }
  | { type: 'unsubscribed'; subscription: string };

// Messages the client sends to the server.
export type ClientMessage =
  | { type: 'subscribe'; scope: 'all' }
  | { type: 'subscribe'; workspace_id: string }
  | { type: 'subscribe'; session_id: string }
  | { type: 'unsubscribe'; workspace_id?: string; session_id?: string }
  | { type: 'pong' };

// ─── Configuration ─────────────────────────────────────────────────

export interface WsClientOptions {
  baseUrl: string;              // HTTP base URL (e.g., "https://fuel-code.up.railway.app")
  apiKey: string;               // API key for authentication
  reconnect?: boolean;          // auto-reconnect on disconnect, default true
  maxReconnectAttempts?: number; // max reconnect attempts, default 10
  maxReconnectDelay?: number;   // max backoff delay in ms, default 30_000
}

// ─── Connection States ─────────────────────────────────────────────

export type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ─── Typed Event Map ───────────────────────────────────────────────
//
// The WsClient emits these typed events:
//   'event'          → (event: Event) => void
//   'session.update' → (update: { session_id, lifecycle, summary?, stats? }) => void
//   'remote.update'  → (update: { remote_env_id, status, public_ip? }) => void
//   'connected'      → () => void
//   'disconnected'   → (reason: string) => void
//   'reconnecting'   → (attempt: number, delay: number) => void
//   'error'          → (error: Error) => void

// ─── WsClient Class ───────────────────────────────────────────────

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private _state: WsConnectionState = 'disconnected';
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Map<string, ClientMessage> = new Map();
  // Map key is a deterministic string: "all", "workspace:<id>", "session:<id>"
  // Map value is the original subscribe message (for re-sending on reconnect)
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

  // Factory: create from CLI config file.
  // Reads baseUrl and apiKey from the config.
  static fromConfig(config: FuelCodeConfig): WsClient {
    return new WsClient({
      baseUrl: config.backend.url,
      apiKey: config.backend.api_key,
    });
  }

  // ─── Connection Management ─────────────────────────────────────

  // Connect to the WebSocket server.
  // Resolves when the connection is open and authenticated.
  // Rejects if the connection fails or auth is rejected (close code 4001).
  async connect(): Promise<void>

  // Disconnect gracefully. No auto-reconnect after this.
  // Safe to call multiple times.
  disconnect(): void

  // Current connection state.
  get connected(): boolean   // true only when state === 'connected'
  get state(): WsConnectionState

  // ─── Subscription Management ───────────────────────────────────

  // Subscribe to all events (scope: "all").
  // Stored locally and re-sent on reconnect.
  subscribe(opts: { scope: 'all' }): void
  subscribe(opts: { workspace_id: string }): void
  subscribe(opts: { session_id: string }): void

  // Unsubscribe from a specific scope.
  // If no opts provided, unsubscribes from everything.
  unsubscribe(opts?: { workspace_id?: string; session_id?: string }): void

  // ─── Internal Methods ──────────────────────────────────────────

  // Convert HTTP base URL to WebSocket URL.
  // "https://host.com" → "wss://host.com/api/ws"
  // "http://host.com" → "ws://host.com/api/ws"
  // Appends ?token=<apiKey> as query parameter.
  private buildWsUrl(): string

  // Handle incoming WebSocket message.
  // Parse JSON, validate type field, dispatch to the appropriate event.
  // On { type: "ping" }: auto-respond with { type: "pong" }.
  // On { type: "event" }: emit 'event' with the event payload.
  // On { type: "session.update" }: emit 'session.update' with the update payload.
  // On { type: "remote.update" }: emit 'remote.update' with the update payload.
  // On { type: "error" }: emit 'error' with an Error wrapping the message.
  // On { type: "subscribed" }: acknowledgment, can emit for debugging.
  // On { type: "unsubscribed" }: acknowledgment, can emit for debugging.
  private handleMessage(data: WebSocket.Data): void

  // Schedule a reconnect attempt with exponential backoff.
  // Delay: min(1000 * 2^attempt, maxReconnectDelay) + random jitter (0-500ms).
  // If attempt >= maxReconnectAttempts, emit 'error' with max retries message and stop.
  // Emits 'reconnecting' with attempt number and delay before each attempt.
  private scheduleReconnect(): void

  // Re-send all stored subscriptions after reconnect.
  // Called after the WebSocket 'open' event during a reconnect.
  private resubscribe(): void

  // Send a message to the server (JSON.stringify + ws.send).
  // No-op if not connected.
  private send(message: ClientMessage): void
}
```

### URL Conversion

The `buildWsUrl()` method converts the HTTP base URL from config to a WebSocket URL:

| Input | Output |
|-------|--------|
| `https://fuel-code.up.railway.app` | `wss://fuel-code.up.railway.app/api/ws?token=<key>` |
| `http://localhost:3000` | `ws://localhost:3000/api/ws?token=<key>` |
| `https://host.com/` | `wss://host.com/api/ws?token=<key>` (trailing slash stripped) |

Logic:
1. Strip trailing slash from base URL.
2. Replace `https://` with `wss://`, `http://` with `ws://`.
3. Append `/api/ws`.
4. Append `?token=<apiKey>` as URL query parameter.

### Connection Lifecycle

1. **`connect()`**: Creates a `new WebSocket(buildWsUrl())`. Returns a promise that:
   - Resolves when the `open` event fires. Sets state to `connected`, resets reconnect counter, emits `connected`, and calls `resubscribe()` if there are stored subscriptions.
   - Rejects if the `close` event fires with code `4001` (unauthorized) before `open`.
   - Rejects if the `error` event fires before `open`.
2. **On `message`**: Calls `handleMessage()` to parse and dispatch.
3. **On `close`**: Sets state to `disconnected`, emits `disconnected` with close reason. If `intentionalClose` is false and `reconnect` is true, calls `scheduleReconnect()`.
4. **On `error`**: Emits `error` event. The `close` event will follow, triggering reconnect logic.
5. **`disconnect()`**: Sets `intentionalClose = true`, clears any pending reconnect timer, calls `ws.close()` if open. Sets state to `disconnected`.

### Reconnection Strategy

- **Exponential backoff**: `delay = Math.min(1000 * Math.pow(2, attempt), maxReconnectDelay)`.
- **Jitter**: `delay += Math.random() * 500` (0-500ms random addition to prevent thundering herd).
- **Max attempts**: After `maxReconnectAttempts` (default 10) failures, emit `error` with message `"Max reconnection attempts (10) reached"` and stop retrying.
- **State transitions**: `disconnected` -> `reconnecting` (emit event) -> `connecting` -> `connected` (success) or back to `reconnecting` (failure).
- **On successful reconnect**: Reset `reconnectAttempt` to 0, call `resubscribe()`.

### Subscription Persistence

- `subscribe()` stores the subscription in `this.subscriptions` (keyed by scope string: `"all"`, `"workspace:<id>"`, `"session:<id>"`).
- If currently connected, immediately sends the subscribe message via `send()`.
- If not connected, the subscription is stored and will be sent on next successful connect.
- `unsubscribe()` removes from `this.subscriptions` and sends unsubscribe to server if connected.
- `unsubscribe()` with no arguments clears all subscriptions (sends unsubscribe with no workspace_id/session_id).
- On reconnect: `resubscribe()` iterates `this.subscriptions.values()` and sends each one.

### Ping/Pong

- The server sends `{ type: "ping" }` periodically (every 30 seconds).
- The client MUST respond with `{ type: "pong" }`.
- `handleMessage()` detects `{ type: "ping" }` and immediately sends `{ type: "pong" }` via `send()`.
- No client-side ping timer needed (the server drives keepalive).

### Error Handling

- Invalid JSON from server: log warning (via `emit('error', ...)`), skip message.
- Unknown message type from server: ignore silently (forward-compatible).
- `send()` when not connected: no-op (log debug-level warning).
- WebSocket `error` event: emit `error` on the EventEmitter.
- Auth rejection (close code 4001): do NOT reconnect. Set `intentionalClose = true` and reject the `connect()` promise with an auth error.

### Dependencies

Add `ws` and its types to the CLI package:
```bash
cd packages/cli && bun add ws && bun add -d @types/ws
```

## Relevant Files

- `packages/cli/src/lib/ws-client.ts` (create)
- `packages/cli/src/lib/__tests__/ws-client.test.ts` (create)
- `packages/cli/package.json` (modify -- add `ws` dependency and `@types/ws` dev dependency)

## Tests

### `packages/cli/src/lib/__tests__/ws-client.test.ts`

Test approach: Create a local `ws.Server` (from the `ws` package) in each test as a mock WebSocket server. The test server validates auth tokens, handles subscriptions, and sends test messages. Use `async/await` with event listeners for timing.

1. **`connect()` with valid token**: resolves successfully, `state` is `connected`, `connected` getter returns `true`.
2. **`connect()` with invalid token**: rejects with auth error, `state` is `disconnected`, `connected` returns `false`.
3. **`connect()` with no server running**: rejects with connection error.
4. **URL conversion https→wss**: `buildWsUrl()` converts `https://host.com` to `wss://host.com/api/ws?token=<key>`.
5. **URL conversion http→ws**: `buildWsUrl()` converts `http://localhost:3000` to `ws://localhost:3000/api/ws?token=<key>`.
6. **URL strips trailing slash**: `https://host.com/` produces `wss://host.com/api/ws?token=<key>`.
7. **`subscribe({ scope: 'all' })`**: sends `{ type: "subscribe", scope: "all" }` to server.
8. **`subscribe({ workspace_id: 'abc' })`**: sends `{ type: "subscribe", workspace_id: "abc" }` to server.
9. **`subscribe({ session_id: 'xyz' })`**: sends `{ type: "subscribe", session_id: "xyz" }` to server.
10. **`unsubscribe({ workspace_id: 'abc' })`**: sends unsubscribe message and removes from local set.
11. **`unsubscribe()` (no args)**: clears all subscriptions and sends unsubscribe.
12. **Server sends `{ type: "event" }`**: client emits `event` with the event payload.
13. **Server sends `{ type: "session.update" }`**: client emits `session.update` with update data.
14. **Server sends `{ type: "remote.update" }`**: client emits `remote.update` with update data.
15. **Server sends `{ type: "ping" }`**: client auto-responds with `{ type: "pong" }` (verify server receives it).
16. **Server sends `{ type: "error" }`**: client emits `error` event with wrapped Error.
17. **Auto-reconnect on server close**: server closes connection, client emits `disconnected`, then `reconnecting`, then reconnects and emits `connected`.
18. **Exponential backoff**: reconnect delays increase (1s, 2s, 4s...). Verify with mock timers or by checking the `reconnecting` event `delay` parameter.
19. **Max reconnect attempts**: after 10 failed reconnects, client emits `error` with max attempts message and stops retrying.
20. **Re-subscribe on reconnect**: after reconnect, all stored subscriptions are re-sent to the server (verify server receives them).
21. **`disconnect()` prevents reconnect**: after explicit `disconnect()`, server close does NOT trigger reconnect.
22. **`disconnect()` clears reconnect timer**: if a reconnect is scheduled, `disconnect()` cancels it.
23. **Multiple subscriptions**: subscribe to workspace + session, both stored and re-sent on reconnect.
24. **Subscribe before connect**: subscriptions are stored and sent on first `connect()`.
25. **`send()` when disconnected**: no-op, does not throw.
26. **Invalid JSON from server**: client emits `error`, does not crash.
27. **Unknown message type from server**: silently ignored, no error emitted.
28. **Auth rejection (code 4001) does not reconnect**: client receives close code 4001, does NOT attempt reconnect.
29. **`fromConfig()` factory**: creates WsClient with correct URL and API key from config.
30. **`state` getter**: reflects current connection state accurately through connect/disconnect/reconnect cycle.

## Success Criteria

1. `WsClient` extends `EventEmitter` and emits typed events: `event`, `session.update`, `remote.update`, `connected`, `disconnected`, `reconnecting`, `error`.
2. `connect()` returns a promise that resolves on successful connection and rejects on auth failure or connection error.
3. HTTP base URL is correctly converted to WebSocket URL (`https→wss`, `http→ws`, trailing slash stripped, `/api/ws` path appended, `?token=` query param added).
4. `subscribe()` accepts three subscription types: `{ scope: 'all' }`, `{ workspace_id }`, `{ session_id }`.
5. Subscriptions are persisted locally and re-sent on every reconnect.
6. `unsubscribe()` removes from local persistence and sends unsubscribe to server.
7. Server `{ type: "ping" }` messages are automatically answered with `{ type: "pong" }`.
8. Server messages are parsed from JSON, validated by type, and dispatched as typed events on the EventEmitter.
9. Auto-reconnect uses exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped), with random 0-500ms jitter.
10. Max reconnect attempts (default 10) stops retrying and emits error.
11. `disconnect()` gracefully closes the connection and suppresses all reconnect attempts.
12. Auth rejection (close code 4001) does NOT trigger reconnect.
13. `connected` getter returns `true` only when state is `connected`.
14. `state` getter returns the current `WsConnectionState` (`disconnected`, `connecting`, `connected`, `reconnecting`).
15. `fromConfig()` factory correctly extracts URL and API key from the CLI config object.
16. Invalid JSON from server is handled gracefully (error emitted, no crash).
17. Unknown server message types are silently ignored (forward-compatible).
18. `send()` is a no-op when not connected (does not throw).
19. WsClient must support `.off(event, listener)` and `.destroy()` methods for proper cleanup by consumers.
20. All tests pass (`bun test`).
