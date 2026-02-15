# Phase 4: CLI + TUI — Task Dependency DAG (Draft A: Infrastructure-First)

## Overview

Phase 4 builds the primary user interface for fuel-code: query commands for sessions, workspaces, timeline, and status, plus a rich TUI dashboard with live updates via WebSocket. The infrastructure-first approach structures the work so that shared infrastructure (API client, WebSocket server/client, output formatting) is built first, then individual CLI commands layer on top, and finally the TUI composes everything together.

After Phase 4, the user can:
- Query sessions, workspaces, and timeline from the command line with table/detail output
- See current system status (active sessions, queue depth, connectivity)
- Launch an interactive TUI dashboard with live-updating session lists grouped by workspace
- Drill into session detail with transcript viewer and git sidebar
- Receive real-time updates as sessions start, end, get parsed, and summarized

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Server-Side Workspace + Device API Endpoints | A | -- |
| 2 | WebSocket Server: Connection, Auth, Subscriptions, Broadcast | A | -- |
| 3 | API Client Library (packages/cli/src/lib/api-client.ts) | B | 1 |
| 4 | Output Formatting Utilities (tables, detail views, colors, time) | B | -- |
| 5 | WebSocket Client Library (packages/cli/src/lib/ws-client.ts) | C | 2 |
| 6 | `fuel-code status` Command | C | 3, 4 |
| 7 | `fuel-code sessions` Command (list with filters) | C | 3, 4 |
| 8 | `fuel-code session <id>` Command (detail + flags) | D | 3, 4 |
| 9 | `fuel-code timeline` Command | D | 3, 4 |
| 10 | `fuel-code workspaces` + `fuel-code workspace <name>` Commands | D | 3, 4 |
| 11 | TUI Shared Components + Layout Shell | E | 4, 5 |
| 12 | TUI Dashboard View (sessions by workspace, live updates) | F | 7, 10, 11 |
| 13 | TUI Session Detail View (transcript viewer, git sidebar) | F | 8, 11 |
| 14 | Phase 4 Integration Tests | G | 6, 7, 8, 9, 10, 12, 13 |

## Dependency Graph

```
Group A ─── Task 1: Workspace + Device      Task 2: WebSocket Server
            API endpoints                    connection, auth, broadcast
               │                                │
               ▼                                │
Group B ─── Task 3: API Client       Task 4: Output formatting
            library                   utilities
               │         │              │       │
        ┌──────┘    ┌────┤──────────────┤       │
        │           │    │              │       │
        ▼           ▼    ▼              ▼       │
Group C ─── Task 6  Task 7          Task 5     │
            status   sessions       WS client   │
            cmd      cmd               │        │
               │        │              │        │
               │        │         ┌────┘        │
               │        │         ▼             │
               │        │    Task 11: TUI       │
               │        │    shared + shell ◄───┘
               │        │         │
               │   ┌────┼─────────┤
               │   │    │         │
               ▼   ▼    ▼         ▼
Group D ─── Task 8  Task 9  Task 10
            session  timeline workspaces
            detail   cmd      cmds
               │        │         │
               │        │    ┌────┘
               ▼        │    ▼
Group E ───────────────────────────── (Task 11 also here)
                              │
               ┌──────────────┤
               ▼              ▼
Group F ─── Task 12       Task 13
            TUI dashboard  TUI session detail
               │              │
               └──────┬───────┘
                      ▼
Group G ─── Task 14: Integration tests
```

## Parallel Groups

- **A**: Tasks 1, 2 (independent: server-side endpoints and WebSocket server)
- **B**: Tasks 3, 4 (independent: API client needs endpoints from Task 1; output formatting is standalone)
- **C**: Tasks 5, 6, 7 (independent: WS client needs WS server; status/sessions commands need API client + formatting)
- **D**: Tasks 8, 9, 10 (independent: each command needs only API client + formatting from Group B)
- **E**: Task 11 (TUI foundation needs formatting + WS client)
- **F**: Tasks 12, 13 (independent: dashboard needs sessions+workspaces+TUI shell; detail needs session detail+TUI shell)
- **G**: Task 14 (final verification)

## Critical Path

Task 1 -> Task 3 -> Task 7 -> Task 12 -> Task 14

(5 sequential stages, with Task 2 -> Task 5 -> Task 11 as a parallel critical path feeding into Task 12)

## Dependency Edges (precise)

- Task 1 -> Task 3 (API client needs workspace/device endpoints to exist)
- Task 2 -> Task 5 (WS client needs WS server)
- Task 3 -> Tasks 6, 7, 8, 9, 10 (all CLI commands use the API client)
- Task 4 -> Tasks 6, 7, 8, 9, 10, 11 (all output uses formatting utilities)
- Task 5 -> Task 11 (TUI shell uses WS client for live updates)
- Task 7 -> Task 12 (TUI dashboard reuses sessions data-fetching logic)
- Task 8 -> Task 13 (TUI session detail reuses detail data-fetching logic)
- Task 10 -> Task 12 (TUI dashboard reuses workspaces data-fetching logic)
- Task 11 -> Tasks 12, 13 (TUI views need the shell and shared components)
- Tasks 6, 7, 8, 9, 10, 12, 13 -> Task 14 (integration tests verify everything)

## Key Design Decisions

### API Client as Single HTTP Abstraction

All CLI commands and TUI views use the same `ApiClient` class. This avoids duplicated HTTP logic, ensures consistent error handling, and makes it easy to add features like request retries or response caching.

```typescript
// packages/cli/src/lib/api-client.ts
class ApiClient {
  constructor(config: { baseUrl: string; apiKey: string; timeout?: number })

  // Sessions
  listSessions(params?: SessionListParams): Promise<PaginatedResponse<SessionSummary>>
  getSession(id: string): Promise<SessionDetail>
  getTranscript(sessionId: string): Promise<TranscriptMessage[]>
  getSessionEvents(sessionId: string): Promise<Event[]>
  getSessionGit(sessionId: string): Promise<GitActivity[]>
  updateSession(id: string, patch: SessionPatch): Promise<SessionDetail>
  reparseSession(id: string): Promise<void>

  // Workspaces
  listWorkspaces(): Promise<Workspace[]>
  getWorkspace(id: string): Promise<WorkspaceDetail>

  // Devices
  listDevices(): Promise<Device[]>
  getDevice(id: string): Promise<DeviceDetail>

  // Timeline
  getTimeline(params?: TimelineParams): Promise<TimelineEntry[]>

  // System
  getHealth(): Promise<HealthStatus>
}
```

The existing HTTP code in `emit.ts` and `backfill.ts` is ad-hoc (raw fetch calls). The API client replaces those patterns for query operations. Write operations (emit, backfill) can remain as-is since they have specialized needs (streaming uploads, timeout constraints).

### Output Formatting as Shared Layer

All CLI commands produce output through shared formatting utilities. This ensures visual consistency and makes it easy to support `--json` output mode across all commands.

```typescript
// packages/cli/src/lib/format.ts
formatTable(rows: Record<string, unknown>[], columns: ColumnDef[]): string
formatSessionRow(session: SessionSummary): string[]
formatDetail(fields: Array<{ label: string; value: string }>): string
formatTimestamp(iso: string): string           // "2h ago", "yesterday 3:45pm"
formatDuration(ms: number): string             // "47m", "1h22m"
formatCost(usd: number): string                // "$0.42"
formatLifecycle(status: string): string        // colored status indicator
truncate(text: string, maxLen: number): string
```

### WebSocket Server Architecture

The WebSocket server runs alongside Express on the same Railway deployment. It authenticates via query parameter (`?token=<api_key>`), manages subscriptions per client, and broadcasts from the event processor pipeline.

The broadcast is triggered by the event processor after successfully handling an event. This means the WS server needs a reference to the broadcast function injected into the pipeline, or a shared event emitter.

### TUI as Ink React App

The TUI is a React application rendered in the terminal via Ink. It connects to the backend via WebSocket for live updates and uses the API client for initial data fetches. The TUI reuses the same data-fetching logic from CLI commands but renders through React components instead of stdout tables.

### CLI Commands Export Data-Fetching Logic

Each CLI command is structured as:
1. **Data layer** (exported): fetch + transform functions that return typed data
2. **Presentation layer** (command handler): format data and print to stdout

The TUI imports the data layer directly, bypassing the stdout presentation. This avoids duplication.

```typescript
// Example: packages/cli/src/commands/sessions.ts
export async function fetchSessions(api: ApiClient, params: SessionListParams): Promise<SessionSummary[]>
export async function formatSessionsTable(sessions: SessionSummary[]): string

// The command handler calls both:
async function sessionsCommand(opts) {
  const sessions = await fetchSessions(api, opts)
  if (opts.json) { console.log(JSON.stringify(sessions)) }
  else { console.log(formatSessionsTable(sessions)) }
}
```

### `--json` Flag on All Query Commands

Every query command supports `--json` for machine-readable output. This is trivial with the data/presentation split: just `JSON.stringify` the data layer output.

### Workspace Resolution by Name

The API uses ULID workspace IDs, but users think in terms of display names (`fuel-code`, `api-service`). CLI commands accept names and resolve to IDs:
1. `GET /api/workspaces` to list all
2. Find by display_name (case-insensitive prefix match)
3. If ambiguous, show choices and exit 1

### WebSocket Reconnection

The WS client auto-reconnects on disconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s). It resubscribes to previous subscriptions on reconnect. The TUI shows connection status in the status bar.

## What Already Exists (from Phases 1-3)

### Server-Side (packages/server/)
- Express app with middleware (auth, error handling, logging) at `packages/server/src/app.ts`
- `POST /api/events/ingest` endpoint
- `GET /api/sessions` with filtering and cursor pagination
- `GET /api/sessions/:id` with full detail
- `GET /api/sessions/:id/transcript` with parsed messages + content blocks
- `GET /api/sessions/:id/transcript/raw` with S3 presigned URL redirect
- `GET /api/sessions/:id/events`
- `GET /api/sessions/:id/git`
- `PATCH /api/sessions/:id` (tags, summary)
- `POST /api/sessions/:id/reparse`
- `POST /api/sessions/:id/transcript/upload`
- `GET /api/timeline` endpoint (from Phase 3)
- `GET /api/health` endpoint
- Redis Stream consumer + event processor pipeline
- Postgres connection pool (`packages/server/src/db/postgres.ts`)
- Auth middleware checking `Authorization: Bearer <api_key>`
- `packages/server/src/ws/` directory exists but is empty (placeholder)

### CLI-Side (packages/cli/)
- `fuel-code init` command with config generation
- `fuel-code emit` command with HTTP POST + local queue fallback
- `fuel-code hooks install` command (CC hooks + git hooks)
- `fuel-code hooks status` command
- `fuel-code backfill` command (historical session scanner)
- Config management at `packages/cli/src/lib/config.ts` (reads `~/.fuel-code/config.yaml`)
- Local queue at `packages/cli/src/lib/queue.ts`
- Error hierarchy (`FuelCodeError` subclasses)
- pino logger setup
- commander-based CLI entry point at `packages/cli/src/index.ts`
- Ad-hoc HTTP fetch calls in emit and backfill (NOT a reusable API client)

### Shared (packages/shared/)
- All types: Event, Session, Workspace, Device, TranscriptMessage, ContentBlock, GitActivity
- Zod schemas for all event payloads
- Zod schemas for session list query params, session patch
- ULID generation utility
- Git remote URL normalization (`canonical.ts`)

### NOT yet built (this phase creates them)
- `GET /api/workspaces`, `GET /api/workspaces/:id` endpoints
- `GET /api/devices`, `GET /api/devices/:id` endpoints
- WebSocket server (`packages/server/src/ws/`)
- `packages/cli/src/lib/api-client.ts`
- `packages/cli/src/lib/ws-client.ts`
- `packages/cli/src/lib/format.ts`
- Any CLI query commands (sessions, session detail, timeline, workspaces, status)
- TUI components (`packages/cli/src/tui/`)

---

# Task Details

---

## Task 1: Server-Side Workspace + Device API Endpoints

### Parallel Group: A

### Description

Build the missing REST API endpoints for workspaces and devices. These are needed before the CLI can query workspaces by name or list devices. The session and timeline endpoints already exist from Phases 2-3.

#### `packages/server/src/routes/workspaces.ts`

```typescript
function createWorkspacesRouter(deps: {
  sql: postgres.Sql;
  logger: pino.Logger;
}): Router
```

**`GET /api/workspaces`** -- List all workspaces with session counts and last activity.

Query parameters (all optional):
- `limit` -- max results, default 50, max 250
- `cursor` -- opaque pagination cursor (base64-encoded `{ u: updated_at, i: id }`)

Query:
```sql
SELECT w.*,
  COUNT(s.id) AS session_count,
  MAX(s.started_at) AS last_session_at,
  COUNT(DISTINCT s.device_id) AS device_count,
  SUM(s.cost_estimate_usd) AS total_cost_usd,
  SUM(s.duration_ms) AS total_duration_ms
FROM workspaces w
LEFT JOIN sessions s ON s.workspace_id = w.id
GROUP BY w.id
ORDER BY COALESCE(MAX(s.started_at), w.first_seen_at) DESC, w.id DESC
LIMIT $limit + 1
```

Response:
```json
{
  "workspaces": [{
    "id": "01JMF3...",
    "canonical_id": "github.com/user/repo",
    "display_name": "repo",
    "default_branch": "main",
    "session_count": 12,
    "last_session_at": "2026-02-14T...",
    "device_count": 2,
    "total_cost_usd": 4.27,
    "total_duration_ms": 180000,
    "first_seen_at": "...",
    "updated_at": "..."
  }],
  "next_cursor": "..." | null,
  "has_more": true | false
}
```

**`GET /api/workspaces/:id`** -- Workspace detail with recent sessions, devices, and git activity summary.

Accepts both ULID (`01JMF3...`) and display_name (`fuel-code`). Resolution logic:
1. If `id` looks like a ULID (26 chars, alphanumeric): query by `w.id`.
2. Otherwise: `SELECT * FROM workspaces WHERE LOWER(display_name) = LOWER($1)`. If multiple matches, return 400 `{ error: "Ambiguous workspace name", matches: [...] }`.

Response includes:
```json
{
  "workspace": { ...workspace fields... },
  "recent_sessions": [ ...last 10 sessions... ],
  "devices": [ ...devices that have tracked this workspace... ],
  "git_summary": {
    "total_commits": 47,
    "total_pushes": 12,
    "recent_branches": ["main", "feature/auth"],
    "last_commit_at": "..."
  }
}
```

Git summary query:
```sql
SELECT
  COUNT(*) FILTER (WHERE type = 'commit') AS total_commits,
  COUNT(*) FILTER (WHERE type = 'push') AS total_pushes,
  array_agg(DISTINCT branch) FILTER (WHERE branch IS NOT NULL) AS recent_branches,
  MAX(timestamp) AS last_commit_at
FROM git_activity
WHERE workspace_id = $1
```

Recent sessions query:
```sql
SELECT s.*, d.name AS device_name
FROM sessions s
JOIN devices d ON s.device_id = d.id
WHERE s.workspace_id = $1
ORDER BY s.started_at DESC
LIMIT 10
```

Devices query:
```sql
SELECT d.*, wd.local_path, wd.hooks_installed, wd.git_hooks_installed, wd.last_active_at
FROM devices d
JOIN workspace_devices wd ON wd.device_id = d.id
WHERE wd.workspace_id = $1
ORDER BY wd.last_active_at DESC
```

---

#### `packages/server/src/routes/devices.ts`

```typescript
function createDevicesRouter(deps: {
  sql: postgres.Sql;
  logger: pino.Logger;
}): Router
```

**`GET /api/devices`** -- List all devices.

```sql
SELECT d.*,
  COUNT(DISTINCT wd.workspace_id) AS workspace_count,
  COUNT(s.id) AS session_count,
  MAX(s.started_at) AS last_session_at
FROM devices d
LEFT JOIN workspace_devices wd ON wd.device_id = d.id
LEFT JOIN sessions s ON s.device_id = d.id
GROUP BY d.id
ORDER BY d.last_seen_at DESC
```

Response:
```json
{
  "devices": [{
    "id": "01JMF3...",
    "name": "macbook-pro",
    "type": "local",
    "hostname": "Johns-MBP",
    "os": "darwin",
    "arch": "arm64",
    "status": "online",
    "workspace_count": 3,
    "session_count": 47,
    "last_session_at": "...",
    "last_seen_at": "...",
    "metadata": {}
  }]
}
```

**`GET /api/devices/:id`** -- Device detail with workspaces and recent sessions.

Response:
```json
{
  "device": { ...device fields... },
  "workspaces": [ ...workspaces tracked on this device... ],
  "recent_sessions": [ ...last 10 sessions on this device... ]
}
```

#### Mount in `packages/server/src/app.ts`

Add workspace and device routers alongside existing session and timeline routers.

#### Tests

**`packages/server/src/routes/__tests__/workspaces.test.ts`**:
1. `GET /api/workspaces` returns empty list initially.
2. After creating workspace via event pipeline, returns it with session count 0.
3. After creating sessions, `session_count` and `total_cost_usd` aggregate correctly.
4. `GET /api/workspaces/:id` by ULID returns workspace detail.
5. `GET /api/workspaces/:id` by display_name (case-insensitive) resolves correctly.
6. `GET /api/workspaces/:id` with non-existent name: 404.
7. Workspace detail includes `recent_sessions` (limited to 10), `devices`, `git_summary`.
8. Auth required: 401 without Bearer token.

**`packages/server/src/routes/__tests__/devices.test.ts`**:
1. `GET /api/devices` returns devices created during event processing.
2. Device includes `workspace_count` and `session_count` aggregates.
3. `GET /api/devices/:id` returns device detail with workspaces and recent sessions.
4. `GET /api/devices/:id` with non-existent ID: 404.
5. Auth required: 401 without Bearer token.

### Relevant Files
- `packages/server/src/routes/workspaces.ts` (create)
- `packages/server/src/routes/devices.ts` (create)
- `packages/server/src/app.ts` (modify -- mount new routers)
- `packages/server/src/routes/__tests__/workspaces.test.ts` (create)
- `packages/server/src/routes/__tests__/devices.test.ts` (create)

### Success Criteria
1. `GET /api/workspaces` returns paginated workspace list with aggregated session counts, cost, duration.
2. `GET /api/workspaces/:id` resolves by ULID or display_name (case-insensitive).
3. `GET /api/workspaces/:id` returns recent sessions (10), devices, and git summary.
4. `GET /api/devices` returns device list with workspace and session counts.
5. `GET /api/devices/:id` returns device detail with tracked workspaces and recent sessions.
6. All endpoints return 404 for non-existent resources.
7. Auth enforced on all endpoints.
8. Pagination cursor works for workspaces list.

---

## Task 2: WebSocket Server — Connection, Auth, Subscriptions, Broadcast

### Parallel Group: A

### Description

Build the WebSocket server that runs alongside Express on the same HTTP server. It handles authenticated connections, manages subscription state per client, broadcasts events and session updates to subscribed clients, and implements ping/pong keepalive. This is the server-side half of real-time updates; the client-side is Task 5.

#### `packages/server/src/ws/index.ts`

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HTTPServer } from 'http';
import type postgres from 'postgres';
import type pino from 'pino';

interface WsServerDeps {
  httpServer: HTTPServer;
  sql: postgres.Sql;
  logger: pino.Logger;
  apiKey: string;       // single-user auth: check token matches this key
}

interface ConnectedClient {
  id: string;           // ULID
  ws: WebSocket;
  subscriptions: Set<string>;  // "all" | "workspace:<id>" | "session:<id>"
  connectedAt: Date;
  lastPongAt: Date;
}

function createWsServer(deps: WsServerDeps): {
  broadcast: BroadcastFn;
  getClientCount: () => number;
  shutdown: () => Promise<void>;
}
```

**Connection lifecycle**:
1. Client connects to `wss://<host>/api/ws?token=<api_key>`.
2. Server validates `token` query parameter against configured API key.
3. If invalid: close with code 4001 and reason `"Unauthorized"`.
4. If valid: add to client map, assign ULID client ID, log connection.
5. On message: parse JSON, dispatch to subscription manager.
6. On close: remove from client map, clean up subscriptions, log disconnection.
7. On error: log, close connection.

**Subscription management** (`packages/server/src/ws/subscriptions.ts`):

```typescript
// Client -> Server messages
type ClientMessage =
  | { type: "subscribe"; scope: "all" }
  | { type: "subscribe"; workspace_id: string }
  | { type: "subscribe"; session_id: string }
  | { type: "unsubscribe"; workspace_id?: string; session_id?: string }
  | { type: "pong" }

// Server -> Client messages
type ServerMessage =
  | { type: "event"; event: Event }
  | { type: "session.update"; session_id: string; lifecycle: string; summary?: string; stats?: SessionStats }
  | { type: "remote.update"; remote_env_id: string; status: string; public_ip?: string }
  | { type: "ping" }
  | { type: "error"; message: string }
  | { type: "subscribed"; subscription: string }    // ack
  | { type: "unsubscribed"; subscription: string }  // ack
```

Subscription rules:
- `{ type: "subscribe", scope: "all" }` -- receive all events and session updates.
- `{ type: "subscribe", workspace_id: "..." }` -- receive events and session updates for that workspace only.
- `{ type: "subscribe", session_id: "..." }` -- receive updates for that specific session (live transcript progress).
- Multiple subscriptions stack (union). Subscribing to "all" supersedes workspace/session subs.
- `unsubscribe` with no workspace/session clears all subscriptions.

**Broadcast function** (`packages/server/src/ws/broadcast.ts`):

```typescript
type BroadcastFn = (message: ServerMessage, filter?: {
  workspace_id?: string;
  session_id?: string;
}) => void;
```

The broadcast function iterates over all connected clients and sends the message to those whose subscriptions match the filter. A client with `scope: "all"` receives everything. A client subscribed to `workspace:<id>` receives messages with matching `workspace_id`. A client subscribed to `session:<id>` receives messages with matching `session_id`.

Broadcast MUST be non-blocking. If a `ws.send()` fails (client disconnected), catch the error, remove the client, and continue.

**Keepalive** (`packages/server/src/ws/keepalive.ts`):

- Server sends `{ type: "ping" }` every 30 seconds.
- Client responds with `{ type: "pong" }`.
- If no pong received within 60 seconds, terminate the connection (stale client).
- Use `setInterval` for ping; track `lastPongAt` per client.

**Integration with event processor**:

Modify `packages/server/src/pipeline/consumer.ts` (or the relevant handler dispatch point) to call `broadcast()` after processing each event:

```typescript
// After event is processed and written to Postgres:
broadcast({ type: "event", event: processedEvent }, {
  workspace_id: event.workspace_id,
  session_id: event.session_id
});

// After session lifecycle transitions:
broadcast({
  type: "session.update",
  session_id,
  lifecycle: newLifecycle,
  summary: session.summary,
  stats: computedStats
}, { workspace_id: session.workspace_id, session_id });
```

**Wiring in `packages/server/src/index.ts`**:

The Express app creates an HTTP server. The WS server upgrades connections on the same server:

```typescript
import { createServer } from 'http';
const httpServer = createServer(app);
const { broadcast, shutdown } = createWsServer({
  httpServer, sql, logger, apiKey
});
// Pass broadcast to pipeline consumer
httpServer.listen(PORT);
```

#### Tests

**`packages/server/src/ws/__tests__/ws-server.test.ts`**:

Use the `ws` library as a test client.

1. Connect with valid token: connection accepted, no error.
2. Connect with invalid token: connection closed with code 4001.
3. Connect without token: connection closed with code 4001.
4. Subscribe to `scope: "all"`: receives ack `{ type: "subscribed", subscription: "all" }`.
5. Subscribe to `workspace_id`: receives ack with `subscription: "workspace:<id>"`.
6. After subscribing to all, broadcast with workspace filter: client receives message.
7. After subscribing to workspace A, broadcast for workspace B: client does NOT receive.
8. After subscribing to workspace A, broadcast for workspace A: client receives.
9. Unsubscribe from workspace: subsequent broadcasts not received.
10. Ping/pong: server sends ping, client responds with pong. No termination.
11. Stale client: client does not pong. After 60s (mock timers), connection terminated.
12. Multiple clients: broadcast reaches all matching clients.
13. Client disconnect during broadcast: no crash, client removed.
14. Invalid JSON message from client: server sends `{ type: "error", message: "..." }`.
15. `getClientCount()` reflects connected clients.
16. `shutdown()` closes all connections gracefully.

### Relevant Files
- `packages/server/src/ws/index.ts` (create)
- `packages/server/src/ws/subscriptions.ts` (create)
- `packages/server/src/ws/broadcast.ts` (create)
- `packages/server/src/ws/keepalive.ts` (create)
- `packages/server/src/ws/types.ts` (create -- ClientMessage, ServerMessage types)
- `packages/server/src/index.ts` (modify -- wire WS server to HTTP server)
- `packages/server/src/pipeline/consumer.ts` (modify -- inject broadcast calls)
- `packages/server/package.json` (modify -- add `ws` dependency: `bun add ws @types/ws`)
- `packages/shared/src/types/ws.ts` (create -- shared WS message types used by both server and client)
- `packages/server/src/ws/__tests__/ws-server.test.ts` (create)

### Success Criteria
1. WebSocket server accepts connections at `/api/ws?token=<api_key>`.
2. Invalid/missing token results in immediate close with code 4001.
3. Subscription messages are acknowledged with typed responses.
4. Broadcast correctly filters by workspace_id and session_id subscriptions.
5. `scope: "all"` subscription receives all broadcasts.
6. Ping every 30 seconds; stale clients (no pong within 60s) terminated.
7. Event processor calls broadcast after processing events.
8. Session lifecycle transitions broadcast `session.update` messages.
9. Client disconnects during broadcast do not crash the server.
10. `getClientCount()` accurately reflects connected clients.
11. `shutdown()` gracefully closes all connections.
12. WS message types are shared between server and client packages via `packages/shared/`.

---

## Task 3: API Client Library

### Parallel Group: B

### Description

Build the general-purpose API client that all CLI commands and TUI views use to query the backend. It wraps all `GET` endpoints, handles auth, pagination traversal, error mapping, and timeout. It reads config from `~/.fuel-code/config.yaml` for backend URL and API key.

#### `packages/cli/src/lib/api-client.ts`

```typescript
import type { FuelCodeConfig } from './config';
import type {
  Session, Workspace, Device, Event, GitActivity,
  TranscriptMessage
} from '@fuel-code/shared';

// Error types for API responses
export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body?: unknown
  ) { super(message); }
}

export class ApiConnectionError extends Error {
  constructor(message: string, public cause?: Error) { super(message); }
}

// Pagination
export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Query parameter types
export interface SessionListParams {
  workspaceId?: string;
  deviceId?: string;
  lifecycle?: string[];
  after?: string;        // ISO-8601
  before?: string;       // ISO-8601
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface TimelineParams {
  workspaceId?: string;
  after?: string;
  before?: string;
  types?: string[];
}

// Health check response
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  postgres: boolean;
  redis: boolean;
  uptime: number;
  version: string;
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: { baseUrl: string; apiKey: string; timeout?: number }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout ?? 10_000;
  }

  // Factory: create from CLI config file
  static fromConfig(config: FuelCodeConfig): ApiClient {
    return new ApiClient({
      baseUrl: config.backend.url,
      apiKey: config.backend.api_key,
    });
  }

  // --- Sessions ---
  async listSessions(params?: SessionListParams): Promise<PaginatedResponse<SessionSummary>>
  async getSession(id: string): Promise<SessionDetail>
  async getTranscript(sessionId: string): Promise<TranscriptMessage[]>
  async getSessionEvents(sessionId: string): Promise<Event[]>
  async getSessionGit(sessionId: string): Promise<GitActivity[]>
  async updateSession(id: string, patch: SessionPatch): Promise<SessionDetail>
  async reparseSession(id: string): Promise<void>
  async exportSession(id: string, format: 'json' | 'md'): Promise<string>

  // --- Workspaces ---
  async listWorkspaces(): Promise<PaginatedResponse<WorkspaceSummary>>
  async getWorkspace(idOrName: string): Promise<WorkspaceDetail>
  async resolveWorkspaceName(name: string): Promise<string>
    // Fetches workspace list, finds by name (case-insensitive prefix match).
    // Returns ULID. Throws if ambiguous or not found.

  // --- Devices ---
  async listDevices(): Promise<Device[]>
  async getDevice(id: string): Promise<DeviceDetail>

  // --- Timeline ---
  async getTimeline(params?: TimelineParams): Promise<TimelineEntry[]>

  // --- System ---
  async getHealth(): Promise<HealthStatus>

  // --- Helpers ---
  // Fetch all pages (auto-paginate). Use with caution on large result sets.
  async listAllSessions(params?: Omit<SessionListParams, 'cursor' | 'limit'>): Promise<SessionSummary[]>

  // Internal request helper
  private async request<T>(method: string, path: string, options?: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    timeout?: number;
  }): Promise<T>
}
```

**`request()` implementation details**:
- Constructs URL from `baseUrl + path + query params`.
- Sets `Authorization: Bearer <apiKey>` header.
- Sets `Content-Type: application/json` for bodies.
- Uses `AbortController` with `setTimeout` for request timeout.
- On network error (fetch throws): throw `ApiConnectionError`.
- On 4xx/5xx: throw `ApiError` with status code and response body.
- On 200-299: parse JSON and return.

**`exportSession` implementation**:
- For `json`: fetch session detail + transcript + events + git, combine into single JSON document.
- For `md`: fetch same data, render as markdown:
  ```markdown
  # Session: <workspace_name>
  **Device**: macbook-pro | **Duration**: 47m | **Cost**: $0.42
  **Summary**: Refactored auth middleware...

  ## Transcript
  ### [1] Human
  Fix the auth bug...

  ### [2] Assistant
  I'll investigate...
  - Read: src/auth/middleware.ts
  - Edit: src/auth/middleware.ts

  ## Git Activity
  - abc123: refactor: JWT auth middleware (+47/-12, 3 files)
  ```

**`resolveWorkspaceName` implementation**:
- `GET /api/workspaces` (fetch all).
- Filter by `display_name` case-insensitive. If exact match, use it.
- If no exact match, try prefix match. If single match, use it.
- If no match: throw `ApiError(404, "Workspace not found: <name>")`.
- If multiple prefix matches: throw `ApiError(400, "Ambiguous workspace name: <name>. Did you mean: <list>?")`.

#### Tests

**`packages/cli/src/lib/__tests__/api-client.test.ts`**:

Use a mock HTTP server (Bun.serve) to simulate the backend.

1. `listSessions()` with no params: sends GET /api/sessions, returns parsed response.
2. `listSessions({ workspaceId, lifecycle: ['parsed'] })`: query params encoded correctly.
3. `getSession(id)`: sends GET /api/sessions/:id, returns session detail.
4. `getTranscript(id)`: returns transcript messages array.
5. `getSessionEvents(id)`: returns events array.
6. `getSessionGit(id)`: returns git activity array.
7. `updateSession(id, { add_tags: ['test'] })`: sends PATCH with body.
8. `reparseSession(id)`: sends POST /api/sessions/:id/reparse.
9. `listWorkspaces()`: returns workspace list with aggregates.
10. `getWorkspace(id)` by ULID: returns workspace detail.
11. `getWorkspace(name)` by display name: returns workspace detail.
12. `resolveWorkspaceName("fuel")`: finds "fuel-code" by prefix, returns ULID.
13. `resolveWorkspaceName("nonexistent")`: throws ApiError 404.
14. `listDevices()`: returns device list.
15. `getTimeline()`: returns timeline entries.
16. `getHealth()`: returns health status.
17. Network error: throws ApiConnectionError.
18. 401 response: throws ApiError with statusCode 401.
19. 404 response: throws ApiError with statusCode 404.
20. Request timeout: throws ApiConnectionError after configured timeout.
21. `listAllSessions()`: auto-paginates, follows cursors until `has_more = false`.
22. `exportSession(id, 'json')`: returns combined JSON.
23. `exportSession(id, 'md')`: returns rendered markdown.
24. `fromConfig()`: reads config and creates client.

### Relevant Files
- `packages/cli/src/lib/api-client.ts` (create)
- `packages/cli/src/lib/__tests__/api-client.test.ts` (create)

### Success Criteria
1. All session endpoints wrapped: list, detail, transcript, events, git, update, reparse, export.
2. All workspace endpoints wrapped: list, detail, resolve by name.
3. All device endpoints wrapped: list, detail.
4. Timeline and health endpoints wrapped.
5. Auth header sent on every request.
6. Request timeout enforced via AbortController.
7. Network errors mapped to ApiConnectionError.
8. HTTP errors mapped to ApiError with status code.
9. Query parameters correctly serialized (arrays joined by comma, undefined values omitted).
10. Cursor-based pagination: single-page methods return `PaginatedResponse`, `listAll` auto-paginates.
11. `resolveWorkspaceName` resolves by exact match then prefix match.
12. `exportSession('json')` combines all session data into single document.
13. `exportSession('md')` renders readable markdown.
14. `fromConfig()` factory reads `~/.fuel-code/config.yaml`.

---

## Task 4: Output Formatting Utilities

### Parallel Group: B

### Description

Build the shared output formatting layer used by all CLI commands. This includes table rendering, detail views, timestamp formatting, color/styling, and a `--json` output mode helper. All CLI commands delegate formatting through these utilities for visual consistency.

#### `packages/cli/src/lib/format.ts`

```typescript
import chalk from 'chalk';

// --- Column definition for table output ---
export interface ColumnDef {
  key: string;             // property name in data object
  header: string;          // column header text
  width?: number;          // fixed width (truncates/pads)
  align?: 'left' | 'right';
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

// --- Table rendering ---
// Renders an array of objects as an aligned table with headers.
// Respects terminal width (process.stdout.columns).
// Truncates columns to fit.
export function formatTable(
  rows: Record<string, unknown>[],
  columns: ColumnDef[],
  options?: {
    maxWidth?: number;        // override terminal width
    noHeader?: boolean;       // skip header row
    separator?: string;       // column separator, default '  ' (2 spaces)
  }
): string

// --- Pre-configured table formats for common views ---
export function formatSessionsTable(sessions: SessionSummary[]): string
// Columns: STATUS, WORKSPACE, DEVICE, DURATION, COST, SUMMARY
// STATUS: colored lifecycle indicator (green circle for live, checkmark for done, etc.)
// WORKSPACE: display_name
// DEVICE: device_name
// DURATION: formatted duration
// COST: formatted cost
// SUMMARY: truncated summary or initial_prompt

export function formatWorkspacesTable(workspaces: WorkspaceSummary[]): string
// Columns: NAME, SESSIONS, DURATION, COST, LAST ACTIVE, DEVICES

export function formatDevicesTable(devices: DeviceSummary[]): string
// Columns: NAME, TYPE, STATUS, WORKSPACES, SESSIONS, LAST SEEN

export function formatTimelineTable(entries: TimelineEntry[]): string
// Columns: TIME, TYPE, WORKSPACE, DETAIL
// TYPE: colored event type badge
// DETAIL: event-type-specific summary (commit message, session summary, etc.)

export function formatGitTable(activities: GitActivity[]): string
// Columns: TIME, TYPE, BRANCH, DETAIL
// DETAIL: commit hash + message, push count, checkout from->to, merge info

// --- Detail view rendering ---
export function formatDetail(fields: Array<{
  label: string;
  value: string;
  color?: (s: string) => string;
}>): string
// Renders label: value pairs with aligned labels
// Example:
//   Workspace:  fuel-code
//   Device:     macbook-pro (local)
//   Started:    2h ago
//   Duration:   47m
//   Cost:       $0.42

export function formatSessionDetail(session: SessionDetail): string
// Renders full session detail block with all stats

// --- Value formatters ---
export function formatTimestamp(iso: string): string
// Smart relative formatting:
// - Last minute: "just now"
// - Last hour: "12m ago"
// - Today: "2h ago" or "today 3:45pm"
// - Yesterday: "yesterday 3:45pm"
// - This week: "Monday 3:45pm"
// - Older: "Feb 10 3:45pm"
// - >1 year: "Feb 10, 2025"

export function formatDuration(ms: number | null): string
// - null/0: "-"
// - <60s: "<1m"
// - <60m: "12m"
// - <24h: "1h22m"
// - >=24h: "1d 3h"

export function formatCost(usd: number | null): string
// - null: "-"
// - <0.01: "<$0.01"
// - <10: "$0.42"
// - >=10: "$12.34"

export function formatLifecycle(lifecycle: string): string
// Returns colored status with icon:
// - "capturing": chalk.green("● LIVE")
// - "detected": chalk.yellow("○ DETECTED")
// - "ended": chalk.blue("◐ ENDED")
// - "parsed": chalk.blue("◑ PARSED")
// - "summarized": chalk.green("✓ DONE")
// - "archived": chalk.dim("▪ ARCHIVED")
// - "failed": chalk.red("✗ FAILED")

export function formatTokens(tokensIn: number, tokensOut: number, cacheRead?: number): string
// "125K in / 48K out / 890K cache"

export function formatNumber(n: number): string
// Thousands abbreviation: 125000 → "125K", 1500 → "1.5K", 500 → "500"

export function truncate(text: string, maxLen: number): string
// Truncates with ellipsis: "Long text that..." (maxLen includes ellipsis)

// --- Empty state messages ---
export function formatEmpty(entity: string): string
// "No sessions found." / "No workspaces found." etc.

// --- Error formatting ---
export function formatError(error: unknown): string
// ApiError → "Error: <message> (HTTP <code>)"
// ApiConnectionError → "Connection error: Could not reach backend at <url>"
// Other → "Error: <message>"

// --- JSON output helper ---
export function outputResult(data: unknown, options: { json?: boolean; format?: () => string }): void
// If json: console.log(JSON.stringify(data, null, 2))
// Otherwise: console.log(format())
```

#### Dependency

Add chalk for terminal colors:
```bash
cd packages/cli && bun add chalk
```

Note: Ink already depends on chalk, so it may already be available. Check before adding.

#### Tests

**`packages/cli/src/lib/__tests__/format.test.ts`**:

1. `formatTable`: renders aligned columns with headers.
2. `formatTable`: respects `maxWidth` by truncating columns.
3. `formatTable`: right-aligns numeric columns.
4. `formatTable`: handles empty rows array (just header).
5. `formatSessionsTable`: renders session list with colored lifecycle icons.
6. `formatWorkspacesTable`: renders workspace list with aggregates.
7. `formatTimestamp`: "just now" for <1 minute ago.
8. `formatTimestamp`: "12m ago" for 12 minutes ago.
9. `formatTimestamp`: "2h ago" for 2 hours ago.
10. `formatTimestamp`: "yesterday 3:45pm" for yesterday.
11. `formatTimestamp`: "Feb 10 3:45pm" for older dates.
12. `formatDuration`: null returns "-".
13. `formatDuration`: 30000 returns "<1m".
14. `formatDuration`: 720000 returns "12m".
15. `formatDuration`: 4920000 returns "1h22m".
16. `formatCost`: null returns "-".
17. `formatCost`: 0.005 returns "<$0.01".
18. `formatCost`: 0.42 returns "$0.42".
19. `formatLifecycle`: each status returns correct icon and color.
20. `formatTokens`: formats with K abbreviation.
21. `truncate`: truncates with ellipsis at maxLen.
22. `truncate`: returns full string if shorter than maxLen.
23. `formatDetail`: renders aligned label:value pairs.
24. `formatEmpty`: returns entity-specific message.
25. `formatError`: formats ApiError, ApiConnectionError, and generic errors.
26. `outputResult`: with `json: true` outputs JSON.
27. `outputResult`: with `json: false` calls format function.

### Relevant Files
- `packages/cli/src/lib/format.ts` (create)
- `packages/cli/src/lib/__tests__/format.test.ts` (create)
- `packages/cli/package.json` (modify -- add chalk if not already a dependency)

### Success Criteria
1. `formatTable` renders aligned columns that respect terminal width.
2. Pre-configured table functions (`formatSessionsTable`, etc.) produce consistent, readable output.
3. `formatTimestamp` produces smart relative times.
4. `formatDuration` handles null, sub-minute, minutes, hours, and days.
5. `formatCost` handles null, sub-cent, and normal values.
6. `formatLifecycle` produces colored icons for each lifecycle state.
7. `formatDetail` renders aligned label:value pairs for detail views.
8. `formatError` maps API errors to user-friendly messages.
9. `outputResult` supports `--json` mode across all commands.
10. `truncate` adds ellipsis and respects maxLen.

---

## Task 5: WebSocket Client Library

### Parallel Group: C

### Description

Build the WebSocket client that CLI commands and TUI use for live updates. It connects to the backend WS endpoint, handles auth, manages subscriptions, auto-reconnects on disconnect, and exposes an event-emitter-style API for receiving messages.

#### `packages/cli/src/lib/ws-client.ts`

```typescript
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { FuelCodeConfig } from './config';
import type { ServerMessage, ClientMessage } from '@fuel-code/shared/types/ws';

export interface WsClientOptions {
  url: string;              // wss://host/api/ws
  apiKey: string;
  reconnect?: boolean;      // default true
  maxReconnectDelay?: number; // default 30_000 ms
  pingInterval?: number;    // default 30_000 ms (respond to server pings)
}

export type WsConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: WsConnectionState = 'disconnected';
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Set<string> = new Set();
  private options: Required<WsClientOptions>;

  constructor(options: WsClientOptions)

  // Factory: create from CLI config
  static fromConfig(config: FuelCodeConfig): WsClient

  // Connection management
  connect(): Promise<void>       // Resolves when connected (or rejects on auth failure)
  disconnect(): void             // Close connection, stop reconnecting
  getState(): WsConnectionState

  // Subscriptions (stored locally + sent to server)
  subscribeAll(): void                         // Subscribe to all events
  subscribeWorkspace(workspaceId: string): void
  subscribeSession(sessionId: string): void
  unsubscribe(options?: { workspaceId?: string; sessionId?: string }): void
  unsubscribeAll(): void

  // Events emitted:
  // 'event'          - (event: Event) => void
  // 'session.update' - (update: SessionUpdate) => void
  // 'remote.update'  - (update: RemoteUpdate) => void
  // 'connected'      - () => void
  // 'disconnected'   - (reason: string) => void
  // 'reconnecting'   - (attempt: number) => void
  // 'error'          - (error: Error) => void
}
```

**Connection flow**:
1. `connect()` creates a `new WebSocket(url + '?token=' + apiKey)`.
2. On `open`: set state to `connected`, reset reconnect attempt counter, emit `connected`, re-send any stored subscriptions.
3. On `message`: parse JSON, validate type field, emit typed event (`event`, `session.update`, `remote.update`). On `ping` message: respond with `pong`.
4. On `close`: set state to `disconnected`, emit `disconnected`. If `reconnect` is true and not intentionally closed, schedule reconnect.
5. On `error`: emit `error`.

**Reconnection strategy**:
- Exponential backoff: `min(1000 * 2^attempt, maxReconnectDelay)`.
- Jitter: add random 0-500ms to avoid thundering herd.
- On reconnect success: re-send all stored subscriptions.
- State transitions: `disconnected` -> `reconnecting` -> `connecting` -> `connected`.
- `disconnect()` sets a flag that suppresses reconnection.

**Subscription persistence**:
- `subscribeAll()`, `subscribeWorkspace()`, `subscribeSession()` add to `this.subscriptions` AND send to server if connected.
- On reconnect: iterate `this.subscriptions` and re-send each.
- `unsubscribe()` removes from local set and sends unsubscribe to server.

#### Tests

**`packages/cli/src/lib/__tests__/ws-client.test.ts`**:

Use a local WS server (from `ws` package) as test fixture.

1. `connect()` with valid token: resolves, state is `connected`.
2. `connect()` with invalid token: rejects with auth error, state is `disconnected`.
3. `subscribeAll()`: sends `{ type: "subscribe", scope: "all" }` to server.
4. `subscribeWorkspace(id)`: sends `{ type: "subscribe", workspace_id: id }` to server.
5. Server sends event message: client emits `event` with parsed data.
6. Server sends session.update: client emits `session.update`.
7. Server sends ping: client auto-responds with pong.
8. Server closes connection: client emits `disconnected`, starts reconnecting.
9. Reconnection: after disconnect, client reconnects with exponential backoff.
10. Reconnection re-subscribes: after reconnect, stored subscriptions are re-sent.
11. `disconnect()`: closes connection, does NOT reconnect.
12. Multiple subscriptions: all stored and re-sent on reconnect.
13. `unsubscribeAll()`: clears local set, sends unsubscribe.
14. `getState()`: returns current connection state accurately.
15. Connection error: emits `error` event.

### Relevant Files
- `packages/cli/src/lib/ws-client.ts` (create)
- `packages/cli/src/lib/__tests__/ws-client.test.ts` (create)
- `packages/cli/package.json` (modify -- add `ws` dependency if not already present: `bun add ws @types/ws`)

### Success Criteria
1. Connects to WS endpoint with token-based auth.
2. Auth failure results in rejected promise and `disconnected` state.
3. Subscription messages sent to server; subscriptions persisted locally.
4. Server messages parsed and emitted as typed events.
5. Auto-responds to server pings with pong.
6. Auto-reconnects on disconnect with exponential backoff + jitter.
7. Re-subscribes on reconnect.
8. `disconnect()` suppresses reconnection.
9. `getState()` accurately reflects connection state.
10. `fromConfig()` factory reads config for URL and API key.

---

## Task 6: `fuel-code status` Command

### Parallel Group: C

### Description

Build the `fuel-code status` command that shows a quick system overview: active sessions, queue depth, backend connectivity, and device info. This is the "am I set up correctly?" and "what's happening right now?" command.

#### `packages/cli/src/commands/status.ts`

```typescript
import { Command } from 'commander';
import { ApiClient, ApiConnectionError } from '../lib/api-client';
import { loadConfig } from '../lib/config';
import { getQueueDepth, getDeadLetterCount } from '../lib/queue';
import {
  formatDetail, formatSessionsTable, formatError, outputResult
} from '../lib/format';

export function registerStatusCommand(program: Command): void
```

**`fuel-code status [--json]`**:

Gathers data from multiple sources:
1. **Config**: Read `~/.fuel-code/config.yaml`. If not found: print "Not initialized. Run `fuel-code init` first." and exit 1.
2. **Device info**: From config (`device.id`, `device.name`).
3. **Backend connectivity**: `api.getHealth()`. If unreachable, note it but continue (show "Backend: unreachable").
4. **Active sessions**: `api.listSessions({ lifecycle: ['detected', 'capturing'] })`. Show count and list (max 5).
5. **Queue depth**: Read `~/.fuel-code/queue/` directory. Count `.json` files.
6. **Dead letter count**: Read `~/.fuel-code/dead-letter/` directory. Count files.
7. **WebSocket status**: Quick connect attempt. If succeeds, show "WebSocket: connected". If fails, show "WebSocket: unavailable". Disconnect immediately after check.

**Output format** (non-JSON):

```
fuel-code status

  Device:     macbook-pro (01JMF3...)
  Backend:    https://fuel-code.up.railway.app — connected
  WebSocket:  connected
  Queue:      0 pending · 0 dead-letter

  Active Sessions:
    ● fuel-code  macbook-pro  12m  $0.18  "Redesigning the event pipeline"
    ● api-service  remote-abc  3m  $0.04  "Load testing"

  Today: 4 sessions · 2h50m · $2.78
```

If no active sessions:
```
  Active Sessions: none

  Today: 0 sessions
```

If backend unreachable:
```
  Backend:    https://fuel-code.up.railway.app — unreachable
  WebSocket:  unavailable
  Queue:      3 pending · 0 dead-letter

  (Backend unreachable — showing local status only)
```

**`--json` output**:
```json
{
  "device": { "id": "...", "name": "macbook-pro" },
  "backend": { "url": "...", "status": "connected", "health": { ... } },
  "websocket": { "status": "connected" },
  "queue": { "pending": 0, "dead_letter": 0 },
  "active_sessions": [ ... ],
  "today": { "session_count": 4, "total_duration_ms": 10200000, "total_cost_usd": 2.78 }
}
```

**Error handling**:
- Config missing: exit 1 with init prompt.
- Backend unreachable: show local-only status, don't exit 1.
- Queue directory doesn't exist: show 0 pending.

#### Tests

**`packages/cli/src/commands/__tests__/status.test.ts`**:

1. With valid config and reachable backend: shows device, backend connected, active sessions.
2. With valid config and unreachable backend: shows "unreachable" and local-only status.
3. No active sessions: shows "none".
4. Queue has pending events: shows count.
5. `--json` flag: outputs valid JSON with all fields.
6. No config file: prints init prompt, exits 1.
7. Today's summary shows session count, duration, cost.
8. Active sessions truncated to max 5 with "and N more" if applicable.

### Relevant Files
- `packages/cli/src/commands/status.ts` (create)
- `packages/cli/src/index.ts` (modify -- register status command)
- `packages/cli/src/commands/__tests__/status.test.ts` (create)

### Success Criteria
1. Shows device info from config.
2. Shows backend connectivity status (connected or unreachable).
3. Shows WebSocket connectivity status.
4. Shows queue depth (pending and dead-letter counts).
5. Shows active sessions (lifecycle = detected or capturing).
6. Shows today's summary (session count, total duration, total cost).
7. `--json` outputs machine-readable JSON.
8. Gracefully handles unreachable backend (shows local-only info).
9. Exits 1 with init prompt if not initialized.

---

## Task 7: `fuel-code sessions` Command

### Parallel Group: C

### Description

Build the `fuel-code sessions` command that lists recent sessions across all workspaces with filtering options. This is the most commonly used query command.

#### `packages/cli/src/commands/sessions.ts`

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import { loadConfig } from '../lib/config';
import {
  formatSessionsTable, formatEmpty, formatError, outputResult
} from '../lib/format';

// Exported for TUI reuse
export interface SessionsCommandOptions {
  workspace?: string;     // workspace display name
  device?: string;        // device name
  today?: boolean;
  live?: boolean;         // live-updating feed (uses WS)
  lifecycle?: string;     // comma-separated lifecycle values
  tag?: string;
  limit?: number;
  json?: boolean;
}

// Data-fetching layer (exported for TUI reuse)
export async function fetchSessions(
  api: ApiClient,
  options: SessionsCommandOptions
): Promise<{ sessions: SessionSummary[]; hasMore: boolean }>

export function registerSessionsCommand(program: Command): void
```

**`fuel-code sessions [options]`**:

Options:
- `--workspace <name>` / `-w <name>`: Filter by workspace display name. Resolves name to ID via `api.resolveWorkspaceName()`.
- `--device <name>` / `-d <name>`: Filter by device name. Resolve similarly to workspace.
- `--today` / `-t`: Shortcut for `--after <start-of-today>`.
- `--live` / `-l`: Live-updating session feed. Uses WebSocket client to show new sessions as they arrive. Runs until Ctrl-C.
- `--lifecycle <states>`: Comma-separated lifecycle filter (e.g., "parsed,summarized").
- `--tag <tag>`: Filter by tag.
- `--limit <n>`: Max results (default 20 for interactive use, not the API default of 50).
- `--json`: Output as JSON array.

**Filter resolution**:
1. If `--workspace` provided: resolve name to ID via `api.resolveWorkspaceName(name)`. If not found, print error and exit 1.
2. If `--device` provided: `api.listDevices()`, find by name (case-insensitive). If not found, exit 1.
3. If `--today`: set `after` to start of today in local timezone (ISO-8601).
4. Build `SessionListParams` and call `api.listSessions(params)`.

**Table output**:
```
fuel-code sessions

  STATUS    WORKSPACE      DEVICE        STARTED      DURATION  COST   SUMMARY
  ● LIVE    fuel-code      macbook-pro   12m ago      12m       $0.18  Redesigning the event pipeline
  ✓ DONE    fuel-code      macbook-pro   2h ago       47m       $0.42  Refactored auth middleware
  ✓ DONE    fuel-code      remote-abc    4h ago       1h22m     $1.87  Cursor-based pagination
  ✓ DONE    api-service    macbook-pro   yesterday    23m       $0.31  Fixed timezone handling

  Showing 4 of 47 sessions. Use --limit to see more.
```

If `has_more` is true and results are at the limit, show the "Showing N of..." footer.

**Empty state**: "No sessions found." with filter hint if filters applied ("No sessions found for workspace 'nonexistent'.").

**`--live` mode**:
1. Print initial session list from API.
2. Connect WS client. Subscribe to all (or to specific workspace if `--workspace` given).
3. On `session.update` or `event` (session.start): re-fetch session list and re-render table (clear screen + reprint).
4. Show status line: "Live updates: connected (ws) · Press Ctrl-C to exit"
5. On Ctrl-C: disconnect WS, exit cleanly.

This mode uses raw stdout (not Ink) -- it re-renders the table in-place. For a richer experience, users should use the TUI (`fuel-code` with no command).

#### Tests

**`packages/cli/src/commands/__tests__/sessions.test.ts`**:

1. No options: fetches sessions with default params, renders table.
2. `--workspace fuel-code`: resolves name, passes `workspaceId` to API.
3. `--workspace nonexistent`: prints error, exits 1.
4. `--device macbook-pro`: resolves device name, passes `deviceId`.
5. `--today`: passes `after` as start of today.
6. `--lifecycle parsed,summarized`: passes lifecycle filter.
7. `--tag bugfix`: passes tag filter.
8. `--limit 5`: limits results to 5.
9. `--json`: outputs JSON array.
10. Empty result: prints "No sessions found."
11. Empty result with filter: prints filter-specific message.
12. `fetchSessions` correctly builds params from options (exported function).
13. Table output has correct columns and alignment.
14. `has_more` shows footer hint.

### Relevant Files
- `packages/cli/src/commands/sessions.ts` (create)
- `packages/cli/src/index.ts` (modify -- register sessions command)
- `packages/cli/src/commands/__tests__/sessions.test.ts` (create)

### Success Criteria
1. Lists sessions in table format with STATUS, WORKSPACE, DEVICE, STARTED, DURATION, COST, SUMMARY columns.
2. `--workspace` resolves display name to ID and filters.
3. `--device` resolves device name and filters.
4. `--today` filters to sessions started today.
5. `--lifecycle` accepts comma-separated lifecycle values.
6. `--tag` filters by session tag.
7. `--limit` controls result count (default 20).
8. `--json` outputs machine-readable JSON.
9. `--live` mode connects via WebSocket and updates table on new sessions.
10. Empty results show appropriate message.
11. Workspace/device name resolution errors show helpful messages.
12. `fetchSessions` is exported for TUI reuse.
13. "Showing N of M" footer when results are truncated.

---

## Task 8: `fuel-code session <id>` Command

### Parallel Group: D

### Description

Build the `fuel-code session <id>` command that shows detailed information about a single session, with subcommand flags for transcript, events, git activity, export, tagging, and reparsing.

#### `packages/cli/src/commands/session-detail.ts`

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import { loadConfig } from '../lib/config';
import {
  formatSessionDetail, formatDetail, formatTimestamp, formatDuration,
  formatCost, formatLifecycle, formatTokens, formatGitTable,
  formatError, outputResult, truncate
} from '../lib/format';

// Data-fetching layer (exported for TUI reuse)
export async function fetchSessionDetail(
  api: ApiClient,
  sessionId: string
): Promise<SessionDetail>

export async function fetchTranscript(
  api: ApiClient,
  sessionId: string
): Promise<TranscriptMessage[]>

export async function fetchSessionGit(
  api: ApiClient,
  sessionId: string
): Promise<GitActivity[]>

export function registerSessionDetailCommand(program: Command): void
```

**`fuel-code session <id> [options]`**:

The `<id>` argument is the Claude Code session ID (UUID string). It can also be a prefix -- if provided string is < 36 chars, the command fetches recent sessions and matches by prefix. If ambiguous (multiple matches), show choices and exit 1.

**Default (no flags)**: Show session overview.

```
fuel-code session abc12345-...

  Workspace:   fuel-code
  Device:      macbook-pro (local)
  Status:      ✓ DONE (summarized)
  Started:     2h ago (2026-02-14 14:30:00)
  Duration:    47m
  Cost:        $0.42
  Model:       claude-sonnet-4-20250514
  Branch:      main

  Summary:
    Refactored authentication middleware to use JWT tokens instead of session
    cookies. Added comprehensive test coverage for token validation.

  Stats:
    Messages:   30 (12 user, 18 assistant)
    Tool Uses:  42 (Edit: 12, Read: 15, Bash: 8, Grep: 4, Write: 3)
    Tokens:     125K in / 48K out / 890K cache
    Thinking:   14 blocks

  Tags: refactor, auth

  Git Activity:
    abc123  refactor: JWT auth middleware     +47/-12  3 files
    def456  test: JWT validation tests        +89/-0   2 files

  Use --transcript to view full transcript, --export json to export.
```

**`--transcript`**: Show parsed transcript (messages with content blocks).

```
fuel-code session <id> --transcript

  [1] Human (14:30:12):
    Fix the auth bug in login middleware. The session cookie isn't being
    validated correctly for API routes.

  [2] Assistant (14:30:18):
    I'll investigate the authentication middleware to understand the issue.

    > Read: src/auth/middleware.ts
    > Read: src/auth/jwt.ts
    > Read: src/routes/api.ts

    I found the issue. The middleware is checking for session cookies but
    API routes use Bearer tokens. Let me fix this.

    > Edit: src/auth/middleware.ts (lines 45-67)

    I've updated the middleware to check for both session cookies and
    Bearer tokens. Let me verify with tests.

    > Bash: bun test src/auth/__tests__/
    > 5 tests passed

  [3] Human (14:35:01):
    Now add tests for the JWT validation edge cases.

  ... (30 messages total)
```

Transcript rendering rules:
- Each message: `[ordinal] Role (timestamp):`
- User messages: plain text.
- Assistant messages: text blocks shown as-is, tool uses shown as `> ToolName: input_summary`, thinking blocks shown as `[thinking] ...` (collapsed by default, show first line).
- Tool results: shown inline after tool use if error (`> Error: ...`). Success results omitted for brevity.
- Truncate individual messages at 500 chars unless `--full` is passed.

**`--events`**: Show raw events for this session.

```
fuel-code session <id> --events

  TIME          TYPE            DATA
  14:30:00      session.start   branch: main, model: claude-sonnet-4
  14:31:23      git.commit      abc123 "refactor: JWT auth middleware"
  14:34:56      git.commit      def456 "test: JWT validation tests"
  14:47:00      session.end     duration: 47m, reason: exit
```

**`--git`**: Show git activity during this session.

Uses `formatGitTable()` from format utilities.

**`--export json`**: Export complete session data as JSON to stdout.

Calls `api.exportSession(id, 'json')`. Includes session detail, transcript, events, git activity in one document.

**`--export md`**: Export as Markdown to stdout.

Calls `api.exportSession(id, 'md')`. Renders full session as readable markdown.

**`--tag <tag>`**: Add a tag to the session.

```
fuel-code session <id> --tag refactor
Tag "refactor" added to session abc12345.
```

Calls `api.updateSession(id, { add_tags: [tag] })`.

**`--reparse`**: Re-trigger transcript parsing.

```
fuel-code session <id> --reparse
Reparse triggered for session abc12345. Current status: parsing.
```

Calls `api.reparseSession(id)`.

**Session ID prefix matching**:
If `<id>` is shorter than a full UUID, fetch recent sessions and match by prefix:
```typescript
if (id.length < 36) {
  const { sessions } = await api.listSessions({ limit: 100 });
  const matches = sessions.filter(s => s.id.startsWith(id));
  if (matches.length === 0) throw new Error(`No session found matching "${id}"`);
  if (matches.length > 1) {
    console.error(`Multiple sessions match "${id}":`);
    matches.forEach(s => console.error(`  ${s.id}  ${formatTimestamp(s.started_at)}  ${s.summary?.slice(0,50)}`));
    process.exit(1);
  }
  id = matches[0].id;
}
```

#### Tests

**`packages/cli/src/commands/__tests__/session-detail.test.ts`**:

1. Default view: shows session overview with all fields.
2. `--transcript`: renders messages with content blocks.
3. `--transcript`: tool uses shown as `> ToolName: ...`.
4. `--transcript`: thinking blocks collapsed.
5. `--events`: renders event table with time, type, data.
6. `--git`: renders git activity table.
7. `--export json`: outputs valid JSON with all session data.
8. `--export md`: outputs markdown with headers and formatting.
9. `--tag newtag`: calls updateSession with add_tags.
10. `--reparse`: calls reparseSession.
11. Session not found: prints error, exits 1.
12. Session ID prefix match: resolves to full ID.
13. Ambiguous prefix: shows choices, exits 1.
14. `--json` flag: outputs session detail as JSON.
15. `fetchSessionDetail` exported for TUI reuse.
16. `fetchTranscript` exported for TUI reuse.

### Relevant Files
- `packages/cli/src/commands/session-detail.ts` (create)
- `packages/cli/src/index.ts` (modify -- register session command)
- `packages/cli/src/commands/__tests__/session-detail.test.ts` (create)

### Success Criteria
1. Default view shows complete session overview (workspace, device, status, duration, cost, summary, stats, tags, git).
2. `--transcript` renders readable transcript with messages, tool uses, and thinking blocks.
3. `--events` shows raw events in table format.
4. `--git` shows git activity table.
5. `--export json` outputs complete session data as JSON.
6. `--export md` outputs readable markdown.
7. `--tag` adds tags to sessions.
8. `--reparse` triggers reparsing.
9. Session ID prefix matching works for partial IDs.
10. Ambiguous prefix shows choices.
11. Not-found sessions show clear error.
12. Data-fetching functions exported for TUI reuse.

---

## Task 9: `fuel-code timeline` Command

### Parallel Group: D

### Description

Build the `fuel-code timeline` command that shows a unified activity feed across all workspaces, combining sessions and git events in chronological order.

#### `packages/cli/src/commands/timeline.ts`

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import { loadConfig } from '../lib/config';
import {
  formatTimelineTable, formatTimestamp, formatEmpty, formatError, outputResult
} from '../lib/format';

// Data-fetching layer (exported for TUI reuse)
export async function fetchTimeline(
  api: ApiClient,
  options: TimelineCommandOptions
): Promise<TimelineEntry[]>

export function registerTimelineCommand(program: Command): void
```

**`fuel-code timeline [options]`**:

Options:
- `--workspace <name>` / `-w <name>`: Filter by workspace display name.
- `--today` / `-t`: Today's activity (default if no time range given).
- `--week`: This week's activity.
- `--after <date>` / `--before <date>`: Custom date range (ISO-8601 or relative like "2d ago", "yesterday").
- `--types <types>`: Comma-separated event types (e.g., "session.start,git.commit").
- `--limit <n>`: Max entries (default 50).
- `--json`: Output as JSON.

**Default behavior**: Show today's activity if no time range specified.

**Output format**:

```
fuel-code timeline

  Today's Activity

  TIME        TYPE           WORKSPACE      DETAIL
  2:30pm      session.start  fuel-code      macbook-pro · "Redesigning event pipeline"
  2:31pm      git.commit     fuel-code      abc123 "refactor: JWT auth middleware" +47/-12
  2:35pm      git.commit     fuel-code      def456 "test: JWT validation" +89/-0
  2:47pm      session.end    fuel-code      macbook-pro · 47m · $0.42
  3:00pm      session.start  api-service    remote-abc · "Load testing"
  3:15pm      git.push       api-service    main → origin · 3 commits
  3:22pm      session.end    api-service    remote-abc · 22m · $0.28
  4:00pm      git.checkout   fuel-code      main → feature/ws
  4:01pm      session.start  fuel-code      macbook-pro · "WebSocket implementation"

  9 events across 2 workspaces
```

**Type-specific detail formatting**:
- `session.start`: `<device_name> · "<initial_prompt_truncated>"`
- `session.end`: `<device_name> · <duration> · <cost>`
- `git.commit`: `<hash_short> "<message_truncated>" +<ins>/-<del>`
- `git.push`: `<branch> -> <remote> · <N> commits`
- `git.checkout`: `<from_branch> -> <to_branch>`
- `git.merge`: `<merged_branch> -> <into_branch> · <files> files`

**Date parsing for --after/--before**:
- ISO-8601: pass through.
- "today": start of today.
- "yesterday": start of yesterday.
- "Nd ago" (e.g., "2d ago"): N days ago.
- "this week"/"week": start of current week (Monday).

#### Tests

**`packages/cli/src/commands/__tests__/timeline.test.ts`**:

1. No options: fetches today's timeline, renders table.
2. `--workspace fuel-code`: resolves name, passes workspace filter.
3. `--week`: passes start-of-week as `after`.
4. `--types session.start,git.commit`: passes type filter.
5. `--json`: outputs JSON array.
6. Empty result: prints "No activity found."
7. Each event type renders correctly (session.start, session.end, git.commit, git.push, git.checkout, git.merge).
8. `fetchTimeline` exported for TUI reuse.
9. Date parsing: "2d ago" converts to correct ISO-8601.
10. Footer shows event count and workspace count.

### Relevant Files
- `packages/cli/src/commands/timeline.ts` (create)
- `packages/cli/src/index.ts` (modify -- register timeline command)
- `packages/cli/src/commands/__tests__/timeline.test.ts` (create)

### Success Criteria
1. Renders unified timeline with TIME, TYPE, WORKSPACE, DETAIL columns.
2. `--workspace` filters by workspace display name.
3. `--today` (default) shows today's activity.
4. `--week` shows this week's activity.
5. `--after`/`--before` accept ISO-8601 and relative dates.
6. `--types` filters by event type.
7. `--json` outputs JSON.
8. Each event type has appropriate detail formatting.
9. Empty results show "No activity found."
10. Footer shows event count and workspace count.
11. `fetchTimeline` exported for TUI reuse.

---

## Task 10: `fuel-code workspaces` + `fuel-code workspace <name>` Commands

### Parallel Group: D

### Description

Build the workspace listing and detail commands. `fuel-code workspaces` lists all known workspaces with session counts and activity. `fuel-code workspace <name>` shows detailed info for a single workspace including recent sessions, devices, and git summary.

#### `packages/cli/src/commands/workspaces.ts`

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import { loadConfig } from '../lib/config';
import {
  formatWorkspacesTable, formatSessionsTable, formatDevicesTable,
  formatGitTable, formatDetail, formatEmpty, formatError, outputResult
} from '../lib/format';

// Data-fetching layer (exported for TUI reuse)
export async function fetchWorkspaces(
  api: ApiClient
): Promise<WorkspaceSummary[]>

export async function fetchWorkspaceDetail(
  api: ApiClient,
  nameOrId: string
): Promise<WorkspaceDetail>

export function registerWorkspacesCommand(program: Command): void
export function registerWorkspaceDetailCommand(program: Command): void
```

**`fuel-code workspaces [--json]`** -- List all workspaces.

```
fuel-code workspaces

  NAME              SESSIONS  DURATION  COST    LAST ACTIVE   DEVICES
  fuel-code         12        8h 30m    $12.47  2h ago        2
  api-service       5         3h 15m    $4.89   yesterday     1
  dotfiles          1         10m       $0.12   3d ago        1
  _unassociated     3         45m       $0.67   1w ago        1

  4 workspaces tracked
```

**`fuel-code workspace <name> [--json]`** -- Workspace detail.

The `<name>` argument is the workspace display name (case-insensitive). Also accepts ULID or canonical_id.

```
fuel-code workspace fuel-code

  Workspace:       fuel-code
  Canonical ID:    github.com/user/fuel-code
  Default Branch:  main
  First Seen:      2026-01-15

  Summary:
    12 sessions · 8h 30m total · $12.47 total cost
    2 devices (macbook-pro, remote-abc)
    47 commits · 12 pushes

  Recent Sessions:
    STATUS    DEVICE        STARTED      DURATION  COST   SUMMARY
    ● LIVE    macbook-pro   12m ago      12m       $0.18  Redesigning event pipeline
    ✓ DONE    macbook-pro   2h ago       47m       $0.42  Refactored auth middleware
    ✓ DONE    remote-abc    4h ago       1h22m     $1.87  Cursor-based pagination
    ... (10 sessions shown, use 'fuel-code sessions -w fuel-code' for all)

  Devices:
    NAME          TYPE    HOOKS   GIT HOOKS  LAST ACTIVE
    macbook-pro   local   yes     yes        12m ago
    remote-abc    remote  yes     yes        4h ago

  Recent Git Activity:
    TIME        TYPE      BRANCH   DETAIL
    2:31pm      commit    main     abc123 "refactor: JWT auth" +47/-12
    2:35pm      commit    main     def456 "test: JWT validation" +89/-0
    3:15pm      push      main     → origin · 3 commits
    ... (showing last 10)
```

**Workspace resolution order** for `<name>` argument:
1. Try ULID lookup if 26 chars.
2. Try exact display_name match (case-insensitive).
3. Try canonical_id match.
4. Try prefix match on display_name.
5. If no match: "Workspace not found: <name>"
6. If ambiguous: "Multiple workspaces match '<name>': <list>"

#### Tests

**`packages/cli/src/commands/__tests__/workspaces.test.ts`**:

1. `fuel-code workspaces`: lists all workspaces with aggregates.
2. `fuel-code workspaces --json`: outputs JSON array.
3. Empty workspace list: "No workspaces found."
4. `fuel-code workspace fuel-code`: shows detail view.
5. `fuel-code workspace FUEL-CODE`: case-insensitive match.
6. `fuel-code workspace nonexistent`: 404 error message.
7. `fuel-code workspace <id> --json`: outputs JSON detail.
8. Workspace detail includes recent sessions, devices, git activity.
9. `fetchWorkspaces` exported for TUI reuse.
10. `fetchWorkspaceDetail` exported for TUI reuse.

### Relevant Files
- `packages/cli/src/commands/workspaces.ts` (create)
- `packages/cli/src/index.ts` (modify -- register workspaces and workspace commands)
- `packages/cli/src/commands/__tests__/workspaces.test.ts` (create)

### Success Criteria
1. `fuel-code workspaces` renders table with NAME, SESSIONS, DURATION, COST, LAST ACTIVE, DEVICES.
2. `fuel-code workspace <name>` shows full workspace detail with summary, sessions, devices, git.
3. Workspace name resolution is case-insensitive and supports prefix matching.
4. Ambiguous names show choices.
5. Non-existent workspaces show clear error.
6. `--json` works on both commands.
7. Data-fetching functions exported for TUI reuse.
8. Empty states handled (no workspaces, workspace with no sessions).

---

## Task 11: TUI Shared Components + Layout Shell

### Parallel Group: E

### Description

Build the TUI foundation: Ink setup, layout shell, shared components (status bar, loading indicator, error display, key bindings), and WebSocket integration for live updates. This is the scaffold that the dashboard (Task 12) and session detail (Task 13) views mount into.

#### Package Setup

Add Ink and React dependencies:
```bash
cd packages/cli && bun add ink ink-text-input react @types/react
```

Ensure `tsconfig.json` for packages/cli has `"jsx": "react-jsx"` and `"jsxImportSource": "react"` for TSX support.

#### `packages/cli/src/tui/App.tsx`

The root TUI component. Manages navigation between views.

```tsx
import React, { useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { WsClient } from '../lib/ws-client';
import { ApiClient } from '../lib/api-client';
import { Dashboard } from './Dashboard';
import { SessionDetailView } from './SessionDetail';
import { StatusBar } from './components/StatusBar';

type View =
  | { type: 'dashboard' }
  | { type: 'session-detail'; sessionId: string };

interface AppProps {
  api: ApiClient;
  ws: WsClient;
  initialView?: View;
}

export function App({ api, ws, initialView }: AppProps): React.ReactElement {
  const [view, setView] = useState<View>(initialView ?? { type: 'dashboard' });
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'q') exit();
    if (key.escape && view.type !== 'dashboard') setView({ type: 'dashboard' });
  });

  return (
    <Box flexDirection="column" height="100%">
      <Box flexGrow={1}>
        {view.type === 'dashboard' && (
          <Dashboard
            api={api}
            ws={ws}
            onSelectSession={(id) => setView({ type: 'session-detail', sessionId: id })}
          />
        )}
        {view.type === 'session-detail' && (
          <SessionDetailView
            api={api}
            ws={ws}
            sessionId={view.sessionId}
            onBack={() => setView({ type: 'dashboard' })}
          />
        )}
      </Box>
      <StatusBar ws={ws} />
    </Box>
  );
}
```

#### `packages/cli/src/tui/components/StatusBar.tsx`

Bottom status bar showing key bindings, WebSocket status, and summary stats.

```tsx
interface StatusBarProps {
  ws: WsClient;
  context?: {
    todaySessions?: number;
    todayDuration?: number;
    todayCost?: number;
    queuePending?: number;
  };
}

export function StatusBar({ ws, context }: StatusBarProps): React.ReactElement
// Renders:
// "Today: 4 sessions · 2h50m · $2.78  Queue: 0 pending  Backend: connected (ws)"
// "j/k:navigate  enter:detail  f:filter  r:refresh  /:search  q:quit"
```

#### `packages/cli/src/tui/components/Loading.tsx`

Loading spinner with message.

```tsx
interface LoadingProps { message?: string }
export function Loading({ message }: LoadingProps): React.ReactElement
// Renders: "⠋ Loading sessions..." (animated spinner)
```

Use Ink's `<Spinner>` component from `ink-spinner` (add dependency).

#### `packages/cli/src/tui/components/ErrorDisplay.tsx`

Error display with retry option.

```tsx
interface ErrorDisplayProps {
  error: Error;
  onRetry?: () => void;
}
export function ErrorDisplay({ error, onRetry }: ErrorDisplayProps): React.ReactElement
// Renders: "Error: Could not reach backend..."
//          "Press r to retry"
```

#### `packages/cli/src/tui/components/Table.tsx`

Ink-based table component (since stdout formatTable won't work in Ink React tree).

```tsx
interface TableColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'right';
  format?: (value: unknown, row: Record<string, unknown>) => React.ReactElement | string;
}

interface TableProps {
  data: Record<string, unknown>[];
  columns: TableColumn[];
  selectedIndex?: number;      // highlighted row
  onSelect?: (index: number) => void;
}

export function Table({ data, columns, selectedIndex, onSelect }: TableProps): React.ReactElement
// Renders an aligned table with optional row selection highlighting.
// Selected row shown with inverse colors or a '>' marker.
```

#### `packages/cli/src/tui/hooks/useApi.ts`

Custom hook for API data fetching with loading/error states.

```tsx
interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useApi<T>(
  fetcher: () => Promise<T>,
  deps?: unknown[]
): UseApiResult<T>
```

#### `packages/cli/src/tui/hooks/useWsSubscription.ts`

Custom hook for WebSocket subscriptions with auto-cleanup.

```tsx
export function useWsSubscription(
  ws: WsClient,
  options: {
    scope?: 'all';
    workspaceId?: string;
    sessionId?: string;
  },
  handlers: {
    onEvent?: (event: Event) => void;
    onSessionUpdate?: (update: SessionUpdate) => void;
  }
): { connected: boolean }
```

Subscribes on mount, unsubscribes on unmount. Returns connection state.

#### `packages/cli/src/tui/hooks/useKeyNavigation.ts`

Custom hook for j/k navigation in lists.

```tsx
export function useKeyNavigation(options: {
  itemCount: number;
  onSelect?: (index: number) => void;
  enabled?: boolean;
}): { selectedIndex: number; setSelectedIndex: (i: number) => void }
```

Handles j (down), k (up), Home, End, Page Up/Down.

#### TUI Entry Point

**`packages/cli/src/tui/index.tsx`**:

```tsx
import { render } from 'ink';
import React from 'react';
import { App } from './App';
import { ApiClient } from '../lib/api-client';
import { WsClient } from '../lib/ws-client';
import { loadConfig } from '../lib/config';

export async function launchTui(options?: { sessionId?: string }): Promise<void> {
  const config = loadConfig();
  const api = ApiClient.fromConfig(config);
  const ws = WsClient.fromConfig(config);

  await ws.connect();

  const initialView = options?.sessionId
    ? { type: 'session-detail' as const, sessionId: options.sessionId }
    : undefined;

  const { waitUntilExit } = render(
    <App api={api} ws={ws} initialView={initialView} />
  );

  await waitUntilExit();
  ws.disconnect();
}
```

Wire into CLI: `fuel-code` with no command launches `launchTui()`.

#### Tests

**`packages/cli/src/tui/__tests__/components.test.tsx`**:

Use `ink-testing-library` for rendering Ink components in tests.

1. `StatusBar`: renders WebSocket status and key bindings.
2. `StatusBar`: shows context stats when provided.
3. `Loading`: renders spinner with message.
4. `ErrorDisplay`: renders error message.
5. `ErrorDisplay`: with onRetry, shows retry prompt.
6. `Table`: renders headers and rows.
7. `Table`: highlights selected row.
8. `useApi`: returns loading state initially, then data.
9. `useApi`: returns error on failure.
10. `useWsSubscription`: subscribes on mount, unsubscribes on unmount.
11. `useKeyNavigation`: j moves selection down, k moves up.
12. `App`: renders dashboard by default.
13. `App`: q key exits.

### Relevant Files
- `packages/cli/src/tui/App.tsx` (create)
- `packages/cli/src/tui/index.tsx` (create)
- `packages/cli/src/tui/components/StatusBar.tsx` (create)
- `packages/cli/src/tui/components/Loading.tsx` (create)
- `packages/cli/src/tui/components/ErrorDisplay.tsx` (create)
- `packages/cli/src/tui/components/Table.tsx` (create)
- `packages/cli/src/tui/hooks/useApi.ts` (create)
- `packages/cli/src/tui/hooks/useWsSubscription.ts` (create)
- `packages/cli/src/tui/hooks/useKeyNavigation.ts` (create)
- `packages/cli/src/tui/__tests__/components.test.tsx` (create)
- `packages/cli/src/index.ts` (modify -- add default command to launch TUI)
- `packages/cli/package.json` (modify -- add ink, react, ink-spinner, ink-testing-library dependencies)
- `packages/cli/tsconfig.json` (modify -- add JSX support)

### Success Criteria
1. `launchTui()` renders Ink app with dashboard view.
2. `q` key exits the TUI.
3. `Escape` navigates back from detail to dashboard.
4. `StatusBar` shows WebSocket status, queue depth, daily stats, key bindings.
5. `Loading` shows animated spinner with message.
6. `ErrorDisplay` shows formatted error with optional retry.
7. `Table` renders aligned columns with row selection.
8. `useApi` manages loading/error/data states.
9. `useWsSubscription` subscribes/unsubscribes on mount/unmount.
10. `useKeyNavigation` handles j/k/Home/End navigation.
11. View routing works: dashboard <-> session detail.
12. TUI connects to WebSocket on launch and disconnects on exit.

---

## Task 12: TUI Dashboard View

### Parallel Group: F

### Description

Build the main TUI dashboard that shows sessions grouped by workspace with a workspace sidebar, remote environment panel, and live updates via WebSocket. This is the view from the TUI mockup in CORE.md.

#### `packages/cli/src/tui/Dashboard.tsx`

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { ApiClient } from '../lib/api-client';
import { WsClient } from '../lib/ws-client';
import { fetchWorkspaces } from '../commands/workspaces';
import { fetchSessions } from '../commands/sessions';
import { useApi } from './hooks/useApi';
import { useWsSubscription } from './hooks/useWsSubscription';
import { useKeyNavigation } from './hooks/useKeyNavigation';
import { Loading } from './components/Loading';
import { ErrorDisplay } from './components/ErrorDisplay';
import { Table } from './components/Table';

interface DashboardProps {
  api: ApiClient;
  ws: WsClient;
  onSelectSession: (sessionId: string) => void;
}

export function Dashboard({ api, ws, onSelectSession }: DashboardProps): React.ReactElement
```

**Layout** (matching CORE.md TUI mockup):

```
┌─ fuel-code ─────────────────────────────────────────────────┐
│                                                              │
│  WORKSPACES           │  SESSIONS                            │
│  ──────────           │  ────────                            │
│  ► fuel-code    (3)   │  ● LIVE  macbook-pro    12m  $0.18  │
│    api-service  (1)   │    Redesigning the event pipeline    │
│    dotfiles     (0)   │                                      │
│    _unassociated(2)   │  ✓ DONE  macbook-pro    47m  $0.42  │
│                       │    Refactored auth middleware         │
│                       │    abc123 refactor: JWT auth          │
│                       │    def456 test: JWT validation        │
│                       │                                      │
│  REMOTES              │  ✓ DONE  remote-abc   1h22m  $1.87  │
│  ───────              │    Cursor-based pagination            │
│  ● fuel-code          │    7890ab feat: cursor pagination    │
│    t3.xl $0.42        │                                      │
│    idle 12m           │                                      │
└──────────────────────────────────────────────────────────────┘
```

**Two-panel layout**:
- Left panel (~25% width): Workspace list + Remote envs panel.
- Right panel (~75% width): Session list for selected workspace (or all workspaces if none selected).

**Workspace panel** (`WorkspaceList.tsx`):
- Lists workspaces sorted by last activity.
- Each entry: `name (session_count)`.
- Selected workspace highlighted with `>` prefix.
- Navigation: j/k to move between workspaces. Enter or right-arrow to focus session panel.
- Selecting a workspace filters the session list to that workspace.
- "All" option at top to show all sessions.
- Session count shown in parentheses.

**Session panel** (`SessionList.tsx`):
- Lists sessions for the selected workspace (or all).
- Each session shows:
  - Line 1: `STATUS  DEVICE  DURATION  COST  [commit_count]`
  - Line 2: `  Summary text (truncated)`
  - Line 3 (if git activity): `  hash "commit message"` (most recent commit only)
- Live sessions (`lifecycle = capturing`) at the top with green indicator.
- Navigation: j/k to move between sessions. Enter to open session detail (calls `onSelectSession`).
- r to refresh data from API.

**Live updates**:
- Subscribe to `scope: "all"` via WebSocket.
- On `session.update`: update the matching session in the list (status change, summary added).
- On `event` (session.start): add new session to top of list.
- On `event` (session.end): update session status.
- On `event` (git.commit): add commit indicator to session.
- Updates are merged into local state without a full API re-fetch (optimistic local update). Full re-fetch on r.

**Remote panel** (simplified):
- Below workspace list in left panel.
- Shows active remote environments (from `api.listSessions({ lifecycle: ['capturing'], ... })` cross-referenced with device type).
- For Phase 4, this is informational only. Full remote management is Phase 5.
- If no remote envs, panel is hidden.

**Key bindings** (in Dashboard context):
- `j`/`k` or arrow keys: navigate workspace list / session list.
- `Tab`: switch focus between workspace panel and session panel.
- `Enter`: open session detail (when session panel focused).
- `r`: refresh all data.
- `f`: toggle filter mode (future -- for Phase 4, just log "filter not yet implemented").
- `/`: toggle search mode (future -- for Phase 4, just log).
- `q`: quit TUI.

**Data flow**:
1. On mount: fetch workspaces and sessions (all) via API client.
2. Store in state: `workspaces`, `sessions`, `selectedWorkspaceIndex`, `selectedSessionIndex`.
3. When workspace selection changes: filter sessions client-side (all sessions are fetched) or re-fetch with workspace filter for large datasets.
4. WS updates merge into state.
5. `refetch()` on `r` key does a fresh API call.

#### Tests

**`packages/cli/src/tui/__tests__/Dashboard.test.tsx`**:

Use `ink-testing-library`.

1. Dashboard renders workspace list and session list.
2. Loading state shows spinner.
3. Error state shows error display.
4. Workspace selection filters session list.
5. j/k navigates workspaces.
6. Tab switches focus between panels.
7. Enter on session opens detail (calls onSelectSession).
8. r triggers data refresh.
9. WS session.update updates session in list.
10. WS new session.start adds session to list.
11. Live sessions shown at top with green indicator.
12. Session entries show status, device, duration, cost, summary.
13. Session entries with git activity show recent commit.
14. Empty workspace shows "No sessions" message.
15. "All" workspace option shows all sessions.

### Relevant Files
- `packages/cli/src/tui/Dashboard.tsx` (create)
- `packages/cli/src/tui/components/WorkspaceList.tsx` (create)
- `packages/cli/src/tui/components/SessionList.tsx` (create)
- `packages/cli/src/tui/components/SessionCard.tsx` (create -- single session entry in list)
- `packages/cli/src/tui/components/RemotePanel.tsx` (create -- simplified remote env info)
- `packages/cli/src/tui/__tests__/Dashboard.test.tsx` (create)

### Success Criteria
1. Two-panel layout: workspace sidebar + session list.
2. Workspace list shows all workspaces with session counts, sorted by last activity.
3. Selecting a workspace filters the session list.
4. Session list shows status, device, duration, cost, summary for each session.
5. Live sessions (capturing) shown at top with green indicator.
6. Git activity shown per session (most recent commit).
7. j/k navigation in both panels.
8. Tab switches panel focus.
9. Enter opens session detail.
10. r refreshes data.
11. WebSocket updates reflected in real-time (new sessions, status changes).
12. Loading and error states handled gracefully.
13. Matches CORE.md TUI mockup layout.

---

## Task 13: TUI Session Detail View

### Parallel Group: F

### Description

Build the TUI session detail view with transcript viewer and git sidebar. This is the second view in the TUI, accessed by selecting a session from the dashboard.

#### `packages/cli/src/tui/SessionDetail.tsx`

```tsx
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { ApiClient } from '../lib/api-client';
import { WsClient } from '../lib/ws-client';
import { fetchSessionDetail, fetchTranscript, fetchSessionGit } from '../commands/session-detail';
import { useApi } from './hooks/useApi';
import { useWsSubscription } from './hooks/useWsSubscription';
import { Loading } from './components/Loading';
import { ErrorDisplay } from './components/ErrorDisplay';

interface SessionDetailViewProps {
  api: ApiClient;
  ws: WsClient;
  sessionId: string;
  onBack: () => void;
}

export function SessionDetailView({
  api, ws, sessionId, onBack
}: SessionDetailViewProps): React.ReactElement
```

**Layout** (matching CORE.md TUI mockup):

```
┌─ Session: fuel-code ─────────────────────────────────────────┐
│  Workspace: fuel-code     Device: macbook-pro (local)         │
│  Started: 47m ago         Duration: 47m         Cost: $0.42   │
│  Tokens: 125K in / 48K out / 890K cache                      │
│  Summary: Refactored authentication middleware to use JWT...  │
│                                                               │
│  TRANSCRIPT                       │  SIDEBAR                  │
│  ──────────                       │  ───────                  │
│  [1] Human:                       │  Git Activity:            │
│    Fix the auth bug in login...   │  ● abc123 refactor: JWT   │
│                                   │  ● def456 test: JWT       │
│  [2] Assistant:                   │                           │
│    I'll investigate the auth...   │  Tools Used:              │
│    ├ Read: src/auth/middleware.ts  │  Edit     12              │
│    ├ Read: src/auth/jwt.ts        │  Read     15              │
│    ├ Edit: src/auth/middleware.ts  │  Bash      8              │
│    └ Bash: bun test               │  Grep      4              │
│                                   │  Write     3              │
│  [3] Human:                       │                           │
│    Now add tests for the JWT...   │  Files Modified:          │
│                                   │  src/auth/middleware.ts    │
│                                   │  src/auth/jwt.ts          │
│                                   │  src/auth/__tests__/...   │
│                                   │                           │
│───────────────────────────────────────────────────────────────│
│  b:back  t:toggle-transcript  g:git  e:events  x:export      │
└───────────────────────────────────────────────────────────────┘
```

**Header section** (`SessionHeader.tsx`):
- Workspace name, device name (type), status indicator.
- Start time (relative + absolute), duration, cost.
- Token stats.
- Summary text (truncated to 2 lines).
- Tags (if any).

**Transcript panel** (`TranscriptViewer.tsx`, ~70% width):
- Scrollable list of transcript messages.
- Each message: `[ordinal] Role:` followed by content.
- Human messages: plain text.
- Assistant messages:
  - Text blocks: shown as-is.
  - Tool uses: `  > ToolName: input_summary` (indented with tree characters for multiple tools).
  - Thinking blocks: shown as `  [thinking] first_line...` (collapsed). Press `t` to expand/collapse.
- Scroll with j/k (line-by-line) or Page Up/Down (page-by-page).
- Scroll position indicator: "Message 3 of 30" or similar.
- If transcript not yet parsed: show "Transcript not yet available (status: parsing)".

**Sidebar panel** (`SessionSidebar.tsx`, ~30% width):
- **Git Activity**: List of commits during this session. Each: `hash_short message_truncated`.
- **Tools Used**: Frequency table of tool names. Sorted by count descending.
- **Files Modified**: Unique file paths from git activity (file_list from commits). Deduplicated.

Tool frequency is computed from transcript content blocks:
```typescript
const toolCounts = transcript
  .flatMap(m => m.content_blocks)
  .filter(b => b.block_type === 'tool_use')
  .reduce((acc, b) => { acc[b.tool_name] = (acc[b.tool_name] || 0) + 1; return acc; }, {});
```

Files modified from git activity:
```typescript
const files = gitActivities
  .filter(g => g.type === 'commit')
  .flatMap(g => g.data.file_list?.map(f => f.path) ?? [])
  .filter((v, i, a) => a.indexOf(v) === i);  // deduplicate
```

**Key bindings** (in session detail context):
- `b` or `Escape`: go back to dashboard.
- `j`/`k` or arrows: scroll transcript.
- `t`: toggle transcript panel expanded (hides sidebar for more width).
- `g`: toggle between transcript and raw git activity view.
- `e`: toggle between transcript and raw events view.
- `x`: export session (prompts for format: json or md, outputs to file).
- `Page Up`/`Page Down`: scroll transcript by page.
- `Home`/`End`: scroll to top/bottom of transcript.

**Live updates** (for active sessions):
- Subscribe to `session_id` via WebSocket.
- On `session.update`: update header (lifecycle change, summary added, stats updated).
- If session is live (capturing) and transcript is being parsed incrementally in future: this is a nice-to-have for Phase 4. For now, show a "Session is live. Transcript available after session ends." message in transcript panel.

**Data loading**:
1. Fetch session detail: `fetchSessionDetail(api, sessionId)`.
2. Fetch transcript: `fetchTranscript(api, sessionId)`. May return empty/error if not yet parsed.
3. Fetch git activity: `fetchSessionGit(api, sessionId)`.
4. All three in parallel. Show loading state until all complete.

#### Tests

**`packages/cli/src/tui/__tests__/SessionDetail.test.tsx`**:

1. Renders session header with workspace, device, status, duration, cost.
2. Renders transcript messages with ordinals and roles.
3. Tool uses shown with tree formatting.
4. Thinking blocks collapsed by default.
5. Git activity shown in sidebar.
6. Tools used frequency table in sidebar.
7. Files modified list in sidebar.
8. `b` key calls onBack.
9. `j`/`k` scrolls transcript.
10. `t` toggles transcript expanded (hides sidebar).
11. Loading state for each section.
12. Unparsed transcript shows appropriate message.
13. Session with no git activity: sidebar section hidden.
14. WS session.update updates header info.
15. Empty transcript (0 messages): shows empty state.

### Relevant Files
- `packages/cli/src/tui/SessionDetail.tsx` (create)
- `packages/cli/src/tui/components/SessionHeader.tsx` (create)
- `packages/cli/src/tui/components/TranscriptViewer.tsx` (create)
- `packages/cli/src/tui/components/SessionSidebar.tsx` (create)
- `packages/cli/src/tui/__tests__/SessionDetail.test.tsx` (create)

### Success Criteria
1. Header shows session metadata (workspace, device, status, timing, cost, tokens, summary, tags).
2. Transcript renders messages with ordinals, roles, and content.
3. Tool uses formatted with tree characters and tool name + input summary.
4. Thinking blocks collapsed by default, expandable.
5. Sidebar shows git activity, tool frequency, and files modified.
6. j/k scrolls transcript line-by-line.
7. Page Up/Down scrolls by page.
8. `b`/Escape navigates back to dashboard.
9. `t` toggles between transcript+sidebar and full-width transcript.
10. Loading states for async data.
11. Unparsed transcripts show informative message.
12. Live session shows "live" indicator and updates via WebSocket.
13. Matches CORE.md TUI session detail mockup.

---

## Task 14: Phase 4 Integration Tests

### Parallel Group: G

### Description

End-to-end integration tests that verify the complete Phase 4 functionality: CLI commands querying real (test) backend data, WebSocket live updates flowing through, and TUI rendering correctly with real data. These tests use the test Docker Compose environment with Postgres, Redis, and the server running.

#### Test Scenarios

**`packages/cli/src/__tests__/phase4-e2e.test.ts`**:

**Setup**: Before all tests:
1. Start test backend (Express + Postgres + Redis + WebSocket server).
2. Create test data: emit events to create workspaces, devices, and sessions through the normal pipeline.
3. Wait for sessions to be processed (parsed + summarized).

**CLI Command Tests**:

1. **`fuel-code status`**: Returns valid status with device info, backend connected, active session count.
2. **`fuel-code sessions`**: Lists test sessions in table format. Verify correct columns.
3. **`fuel-code sessions --workspace <name>`**: Filters by workspace. Returns only matching sessions.
4. **`fuel-code sessions --today`**: Returns only today's sessions.
5. **`fuel-code sessions --json`**: Returns valid JSON array.
6. **`fuel-code session <id>`**: Shows session detail with all fields populated.
7. **`fuel-code session <id> --transcript`**: Shows parsed transcript.
8. **`fuel-code session <id> --events`**: Shows events for the session.
9. **`fuel-code session <id> --git`**: Shows git activity.
10. **`fuel-code session <id> --export json`**: Returns valid JSON with all sections.
11. **`fuel-code session <id> --export md`**: Returns readable markdown.
12. **`fuel-code session <id> --tag test-e2e`**: Adds tag, verify via GET.
13. **`fuel-code timeline`**: Shows today's timeline with mixed event types.
14. **`fuel-code timeline --workspace <name>`**: Filters timeline by workspace.
15. **`fuel-code workspaces`**: Lists test workspaces with correct aggregates.
16. **`fuel-code workspace <name>`**: Shows workspace detail.

**WebSocket Tests**:

17. **WS connect**: Client connects with valid token. Receives connection.
18. **WS subscribe all**: After subscribing, emitting a new event triggers WS message to client.
19. **WS subscribe workspace**: Only receives events for subscribed workspace.
20. **WS session.update**: When session lifecycle changes, client receives update.
21. **WS reconnect**: After server-initiated disconnect, client reconnects and re-subscribes.

**Error Handling Tests**:

22. **Backend unreachable**: `fuel-code status` shows unreachable status, doesn't crash.
23. **Invalid session ID**: `fuel-code session nonexistent` exits 1 with error message.
24. **Invalid workspace name**: `fuel-code sessions --workspace nonexistent` exits 1 with error.

**TUI Smoke Tests** (limited -- TUI is hard to test end-to-end):

25. **TUI launch**: `launchTui()` with test data renders without crash. Verify initial render contains workspace names.
26. **TUI session detail**: Navigate to session detail view, verify it renders session header.

#### Test approach

CLI commands tested by running them as subprocesses (`Bun.spawn(['fuel-code', 'sessions', '--json'])`) and asserting on stdout/exit code. This tests the full command pipeline including config loading, API calls, and output formatting.

WebSocket tests use the `ws` client library directly against the test server.

TUI tests use `ink-testing-library` with mocked API client.

### Relevant Files
- `packages/cli/src/__tests__/phase4-e2e.test.ts` (create)
- `packages/cli/src/__tests__/phase4-ws-e2e.test.ts` (create)
- `packages/cli/src/__tests__/phase4-tui-smoke.test.tsx` (create)
- `packages/cli/src/__tests__/setup-e2e.ts` (create -- test data setup helper)

### Success Criteria
1. All 26 test scenarios pass against a real test backend.
2. CLI commands produce correct output for all query types.
3. Filters (workspace, device, today, lifecycle, tag) work correctly.
4. Session detail shows all fields, transcript, events, git activity.
5. Export produces valid JSON and markdown.
6. Tagging persists and is retrievable.
7. WebSocket connections authenticate correctly.
8. WebSocket subscriptions filter correctly.
9. WebSocket updates arrive when events are processed.
10. Error states handled gracefully (unreachable backend, invalid IDs).
11. TUI renders without crashes with real data.
12. Tests clean up after themselves (no leaked connections, processes, or data).

---

## Dependencies Added in Phase 4

```bash
# Server
cd packages/server && bun add ws @types/ws

# CLI
cd packages/cli && bun add ws @types/ws chalk ink ink-spinner ink-text-input ink-testing-library react @types/react
```

## Test Infrastructure

Extend existing test Docker Compose with no changes needed -- Postgres, Redis, and LocalStack from Phase 2 are sufficient. The WebSocket server runs as part of the Express server in tests.
