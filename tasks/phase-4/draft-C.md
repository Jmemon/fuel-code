# Phase 4: CLI + TUI — Task Dependency DAG (Draft C: Minimal-Dependency)

## Overview

Phase 4 builds the primary user interface: CLI query commands and an interactive TUI dashboard. After Phase 4, users can list sessions, view timelines, inspect workspace activity, and monitor live sessions — all from the terminal. The TUI connects to the backend via WebSocket for real-time updates.

**Design philosophy (Draft C)**: Minimize total tasks and dependency depth. Group aggressively. CLI (non-interactive, stdout) and TUI (interactive, Ink) are cleanly separated. Server-side additions are batched into a single task. The result is 7 tasks across 4 parallel groups with a critical path of 4 stages.

## What Already Exists (from Phases 1-3)

### Server
- `POST /api/events/ingest` — batch event ingestion
- `GET /api/sessions` — list sessions (paginated, filterable by workspace_id, device_id, lifecycle, after, before, tag, cursor)
- `GET /api/sessions/:id` — session detail with stats
- `GET /api/sessions/:id/transcript` — parsed transcript (messages + content blocks)
- `GET /api/sessions/:id/events` — events within a session
- `GET /api/sessions/:id/git` — git activity during a session
- `PATCH /api/sessions/:id` — update tags, manual summary override
- `POST /api/sessions/:id/reparse` — re-trigger transcript parsing
- `GET /api/timeline` — unified activity feed (session-grouped, filterable)
- Express app with auth middleware, error handling, pino logging
- Redis Stream consumer, event processor, handler registry
- Postgres pool (postgres.js), migrations runner
- S3 client for transcript upload/download

### CLI
- `fuel-code init` — device setup, config generation
- `fuel-code emit` — event emission with local queue fallback (supports `--data` and `--data-stdin`)
- `fuel-code hooks install` — CC hooks + git hooks installation
- `fuel-code hooks status` — hook installation status
- `fuel-code backfill` — historical session scan + ingestion
- `fuel-code queue status|drain|dead-letter` — queue management
- `fuel-code status` — basic status (device info, backend connectivity) **Note: exists but minimal; Phase 4 enriches it**
- Config management (`~/.fuel-code/config.yaml` read/write)
- Local event queue with drainer
- Commander-based CLI entry point (`packages/cli/src/index.ts`)
- Error hierarchy (FuelCodeError subclasses)
- Pino logger

### Shared
- All types: Event, Session, Workspace, Device, TranscriptMessage, ContentBlock, GitActivity
- All Zod schemas for event payloads
- `normalizeGitRemote()` canonical ID computation
- ULID generation utility

### NOT yet built (Phase 4 must create)
- `GET /api/workspaces` — list workspaces
- `GET /api/workspaces/:id` — workspace detail (recent sessions, git summary, devices)
- `GET /api/devices` — list devices
- `GET /api/devices/:id` — device detail
- `WS /api/ws` — WebSocket server with subscription management
- `cli/src/lib/api-client.ts` — general-purpose HTTP client for backend API
- `cli/src/lib/ws-client.ts` — WebSocket client for live updates
- CLI query commands: `sessions`, `session <id>`, `timeline`, `workspaces`, `workspace <name>`, enriched `status`
- TUI: Ink dashboard, session detail view, components

## Technology Decisions (locked in)

- CLI framework: commander (already in use)
- TUI: Ink (React for terminals)
- WebSocket: ws library (server + client)
- Testing: bun:test
- Runtime: bun
- ULID: ulidx

## Task List

| Task | Name | Group | Dependencies | Estimated Scope |
|------|------|-------|-------------|-----------------|
| 1 | Server: Missing API Endpoints + WebSocket | A | — | Large |
| 2 | CLI: API Client + WebSocket Client Libraries | A | — | Medium |
| 3 | CLI: All Query Commands (sessions, timeline, workspaces, status) | B | 1, 2 | Large |
| 4 | CLI: Session Detail Command (all flags) | B | 1, 2 | Medium |
| 5 | TUI: Dashboard (sessions by workspace, live updates) | C | 1, 2 | Large |
| 6 | TUI: Session Detail View (transcript viewer, git sidebar) | C | 1, 2, 4 | Large |
| 7 | Phase 4 E2E Tests | D | 3, 4, 5, 6 | Medium |

## Dependency Graph

```
Group A ─── Task 1: Server endpoints + WS     Task 2: API + WS client libs
               │                                  │
        ┌──────┴──────────────────────────────────┤
        │                                         │
        ▼                                         ▼
Group B ─── Task 3: CLI query commands     Task 4: CLI session detail
               │                              │
               │                   ┌──────────┤
               │                   │          │
               ▼                   ▼          ▼
Group C ─── ─── ─── ───     Task 5: TUI    Task 6: TUI
                             Dashboard      Session Detail
               │                │              │
               └────────────────┼──────────────┘
                                ▼
Group D ─── Task 7: E2E integration tests
```

## Parallel Groups

- **A**: Tasks 1, 2 (fully independent: server-side endpoints vs. client-side libraries)
- **B**: Tasks 3, 4 (independent of each other: list commands vs. detail command; both need A)
- **C**: Tasks 5, 6 (TUI dashboard is independent; TUI session detail reuses patterns from Task 4)
- **D**: Task 7 (final verification of everything)

## Critical Path

Task 1 → Task 3 → Task 5 → Task 7 (or Task 1 → Task 4 → Task 6 → Task 7)

**4 sequential stages.** Both paths have the same depth.

## Key Design Decisions

### 1. Single API Client, Not Per-Command Fetch
All CLI commands and TUI components share one `ApiClient` class in `cli/src/lib/api-client.ts`. It handles auth headers, base URL, error mapping, pagination cursors, and response typing. No raw `fetch()` calls outside this module.

### 2. CLI Output as Plain Text Tables (No Ink for Non-Interactive)
CLI query commands (`sessions`, `timeline`, `workspaces`, `status`) write directly to stdout using a simple table formatter. No Ink dependency. This keeps CLI output pipeable, scriptable, and fast (no React overhead). The TUI is a separate code path entered via `fuel-code` (no args) or `fuel-code tui`.

### 3. WebSocket Server: Thin Wrapper Over Event Processor
The WebSocket server hooks into the existing event processor. When the processor handles an event, it also broadcasts to subscribed WS clients. No separate event flow. The WS server manages subscriptions (per-workspace, per-session, all) and handles auth on connection.

### 4. TUI Reuses API Client, Not Direct DB
The TUI is a pure API consumer. It uses the same `ApiClient` as CLI commands, plus `WsClient` for live updates. This upholds invariant 8: "The server API is the sole interface for data access."

### 5. Session Detail: CLI Command First, TUI View Second
Task 4 (CLI `session <id>`) defines all the data fetching, flag handling, and formatting logic. Task 6 (TUI session detail) reuses the same API calls but renders in Ink. This avoids duplicating fetch/format logic.

### 6. Aggressive Grouping Rationale
- **All missing server endpoints + WebSocket in one task**: These are all additive routes/handlers with no interdependencies. A single agent can scaffold 4 route files and one WS module in a session.
- **All list-style CLI commands in one task**: `sessions`, `timeline`, `workspaces`, `status` share the same pattern (fetch → format → print table). Different data, same shape.
- **TUI dashboard as one task**: The dashboard is one Ink component tree. Splitting it into sub-tasks would create artificial dependencies.

---

## Task Details

---

### Task 1: Server — Missing API Endpoints + WebSocket Server

**Parallel Group: A**

**Description**

Add the 4 missing REST endpoints (workspaces list, workspace detail, devices list, device detail) and the WebSocket server for real-time client updates. The WebSocket server integrates with the existing event processor to broadcast events to subscribed clients.

#### REST Endpoints

**`packages/server/src/routes/workspaces.ts`**:

```typescript
// GET /api/workspaces
// Lists all known workspaces, ordered by most recently active.
// Query params: ?limit=50&cursor=...
// Response: { workspaces: WorkspaceSummary[], cursor?: string }
//
// WorkspaceSummary: {
//   id, canonical_id, display_name, default_branch,
//   session_count: number,       -- total sessions
//   active_sessions: number,     -- sessions with lifecycle = 'capturing'
//   last_session_at: string,     -- most recent session start
//   device_count: number,        -- distinct devices
//   metadata
// }

// GET /api/workspaces/:id
// Workspace detail with recent sessions, git summary, and device list.
// Response: {
//   workspace: Workspace,
//   recent_sessions: Session[],          -- last 10 sessions
//   git_summary: {
//     total_commits: number,
//     recent_commits: GitActivity[],     -- last 10 commits
//     active_branches: string[]
//   },
//   devices: Device[],                   -- all devices tracking this workspace
//   stats: {
//     total_sessions: number,
//     total_duration_ms: number,
//     total_cost_usd: number
//   }
// }
```

The workspaces list query:
```sql
-- Workspaces with session counts and last activity
SELECT w.*,
  COUNT(s.id) AS session_count,
  COUNT(s.id) FILTER (WHERE s.lifecycle = 'capturing') AS active_sessions,
  MAX(s.started_at) AS last_session_at,
  COUNT(DISTINCT s.device_id) AS device_count
FROM workspaces w
LEFT JOIN sessions s ON s.workspace_id = w.id
GROUP BY w.id
ORDER BY last_session_at DESC NULLS LAST
LIMIT $1 OFFSET $2;
```

**`packages/server/src/routes/devices.ts`**:

```typescript
// GET /api/devices
// Lists all known devices.
// Response: { devices: DeviceSummary[] }
//
// DeviceSummary: {
//   id, name, type, hostname, os, arch, status,
//   session_count: number,
//   last_seen_at: string,
//   workspace_count: number     -- distinct workspaces this device has sessions for
// }

// GET /api/devices/:id
// Device detail with recent sessions and workspace associations.
// Response: {
//   device: Device,
//   recent_sessions: Session[],
//   workspaces: { workspace_id, workspace_name, local_path, last_active_at }[]
// }
```

#### WebSocket Server

**`packages/server/src/ws/index.ts`**:

WebSocket server using the `ws` library, mounted on the Express HTTP server at `/api/ws`.

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';

// Subscription model:
// Each connected client can subscribe to:
//   - "all": receives every event and session update
//   - workspace_id: receives events/updates for that workspace
//   - session_id: receives events/updates for that session (for live transcript)

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>;  // "all" | workspace_id | session_id
  authenticatedAt: number;
}

// Server → Client message types (from CORE.md WebSocket Protocol):
// { type: "event", event: Event }
// { type: "session.update", session_id, lifecycle, summary?, stats? }
// { type: "remote.update", remote_env_id, status, public_ip? }
// { type: "ping" }

// Client → Server message types:
// { type: "subscribe", workspace_id?: string, session_id?: string, scope?: "all" }
// { type: "unsubscribe", workspace_id?: string, session_id?: string }
// { type: "pong" }

export function createWsServer(httpServer: Server): WsBroadcaster
```

**`packages/server/src/ws/broadcaster.ts`**:

```typescript
// The broadcaster is called by the event processor after handling each event.
// It filters connected clients by their subscriptions and sends relevant messages.

export interface WsBroadcaster {
  // Called by event processor when a new event is ingested
  broadcastEvent(event: Event): void;

  // Called by session manager when session lifecycle changes
  broadcastSessionUpdate(sessionId: string, lifecycle: string, summary?: string, stats?: SessionStats): void;

  // Called for keepalive (every 30 seconds)
  startPingInterval(): void;

  // Graceful shutdown
  close(): void;
}
```

Integration point: Modify `packages/server/src/index.ts` to mount the WebSocket server on the HTTP server. Modify the event processor (or its handler dispatch) to call `broadcaster.broadcastEvent()` after successful event processing. Modify the session manager (or its lifecycle transition function) to call `broadcaster.broadcastSessionUpdate()` after state transitions.

**Auth**: Validate `?token=<api_key>` query parameter on WebSocket upgrade. Reject connections with invalid tokens.

**Ping/pong**: Server sends `{ type: "ping" }` every 30 seconds. If no `{ type: "pong" }` within 10 seconds, close the connection.

#### Tests

**`packages/server/src/routes/__tests__/workspaces.test.ts`**:
1. `GET /api/workspaces` returns workspaces sorted by last session activity.
2. `GET /api/workspaces` returns correct session_count and active_sessions counts.
3. `GET /api/workspaces` cursor-based pagination works.
4. `GET /api/workspaces/:id` returns workspace with recent sessions, git summary, devices.
5. `GET /api/workspaces/:id` returns 404 for unknown workspace.
6. Workspaces with no sessions still appear (session_count = 0).

**`packages/server/src/routes/__tests__/devices.test.ts`**:
1. `GET /api/devices` returns all devices with session/workspace counts.
2. `GET /api/devices/:id` returns device with recent sessions and workspace associations.
3. `GET /api/devices/:id` returns 404 for unknown device.

**`packages/server/src/ws/__tests__/ws-server.test.ts`**:
1. WebSocket connection succeeds with valid token.
2. WebSocket connection rejected with invalid/missing token.
3. Subscribe to "all" receives all broadcast events.
4. Subscribe to workspace_id receives only events for that workspace.
5. Subscribe to session_id receives only updates for that session.
6. Unsubscribe stops receiving events.
7. Ping/pong keepalive works.
8. Multiple clients with different subscriptions receive correct filtered events.
9. Graceful close on server shutdown.

**Relevant Files**:
- `packages/server/src/routes/workspaces.ts` (create)
- `packages/server/src/routes/devices.ts` (create)
- `packages/server/src/ws/index.ts` (create)
- `packages/server/src/ws/broadcaster.ts` (create)
- `packages/server/src/index.ts` (modify — mount WS server, register new routes)
- `packages/server/src/pipeline/handlers/` (modify — call broadcaster after event processing)
- `packages/server/src/routes/__tests__/workspaces.test.ts` (create)
- `packages/server/src/routes/__tests__/devices.test.ts` (create)
- `packages/server/src/ws/__tests__/ws-server.test.ts` (create)

**Success Criteria**:
1. `GET /api/workspaces` returns workspace list with session counts, device counts, last activity, sorted by recency.
2. `GET /api/workspaces/:id` returns workspace detail with recent sessions, git summary, device list, and aggregate stats.
3. `GET /api/devices` returns device list with session/workspace counts.
4. `GET /api/devices/:id` returns device detail with recent sessions and workspace associations.
5. WebSocket server accepts connections at `/api/ws?token=<api_key>` and rejects invalid tokens.
6. Clients can subscribe to "all", a workspace_id, or a session_id.
7. `broadcastEvent()` sends events only to clients subscribed to the relevant workspace/session/all.
8. `broadcastSessionUpdate()` sends session lifecycle changes to relevant subscribers.
9. Ping/pong keepalive closes unresponsive connections after 10s timeout.
10. All routes require auth (Bearer token).
11. All endpoints return proper error responses (404, 400, 401).
12. All tests pass (`bun test`).

---

### Task 2: CLI — API Client + WebSocket Client Libraries

**Parallel Group: A**

**Description**

Build the two foundational client libraries that all CLI commands and TUI components depend on: an HTTP API client and a WebSocket client. These are shared infrastructure, not user-facing commands.

#### API Client

**`packages/cli/src/lib/api-client.ts`**:

A typed HTTP client wrapping `fetch()`. Handles auth, base URL, error mapping, pagination, and response types.

```typescript
import { loadConfig } from './config';

// The single entry point for all server communication.
// Every CLI command and TUI component uses this instead of raw fetch().

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config?: { baseUrl: string; apiKey: string }) {
    // If no config passed, load from ~/.fuel-code/config.yaml
  }

  // Generic typed request method
  async request<T>(method: string, path: string, options?: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<T>

  // Convenience methods matching server endpoints

  // Sessions
  async listSessions(params?: {
    workspace_id?: string;
    device_id?: string;
    lifecycle?: string;
    after?: string;
    before?: string;
    tag?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ sessions: Session[]; cursor?: string }>

  async getSession(id: string): Promise<Session>
  async getSessionTranscript(id: string): Promise<TranscriptData>
  async getSessionEvents(id: string): Promise<{ events: Event[] }>
  async getSessionGit(id: string): Promise<{ git_activity: GitActivity[] }>
  async updateSession(id: string, updates: { tags?: string[]; summary?: string }): Promise<Session>
  async reparseSession(id: string): Promise<void>

  // Timeline
  async getTimeline(params?: {
    workspace_id?: string;
    after?: string;
    before?: string;
    types?: string;
  }): Promise<TimelineResponse>

  // Workspaces
  async listWorkspaces(params?: { limit?: number; cursor?: string }): Promise<{ workspaces: WorkspaceSummary[]; cursor?: string }>
  async getWorkspace(id: string): Promise<WorkspaceDetail>

  // Devices
  async listDevices(): Promise<{ devices: DeviceSummary[] }>
  async getDevice(id: string): Promise<DeviceDetail>

  // Health
  async health(): Promise<{ status: string }>
}

// Error classes for API responses
export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: unknown,
  ) { super(`API ${status}: ${statusText}`); }
}

export class ApiConnectionError extends Error {
  constructor(public cause: Error) { super('Cannot connect to backend'); }
}
```

Key behaviors:
- Query params with `undefined` values are omitted (not sent as "undefined").
- Non-2xx responses throw `ApiError` with status and parsed body.
- Network failures throw `ApiConnectionError`.
- Auth header: `Authorization: Bearer <api_key>` on every request.
- Content-Type: `application/json` for bodies.
- Pagination: callers pass `cursor`, get back `cursor` in response for next page.

#### WebSocket Client

**`packages/cli/src/lib/ws-client.ts`**:

A reconnecting WebSocket client for TUI live updates. Built on the `ws` library.

```typescript
import WebSocket from 'ws';

// Reconnecting WebSocket client for live updates in the TUI.
// Handles: auth, auto-reconnect with backoff, subscription management,
// ping/pong, and typed event dispatching.

export type WsMessageHandler = (msg: WsServerMessage) => void;

export type WsServerMessage =
  | { type: 'event'; event: Event }
  | { type: 'session.update'; session_id: string; lifecycle: string; summary?: string; stats?: SessionStats }
  | { type: 'remote.update'; remote_env_id: string; status: string; public_ip?: string }
  | { type: 'ping' };

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers: Set<WsMessageHandler> = new Set();
  private subscriptions: Set<string> = new Set();  // tracks active subscriptions for resubscribe on reconnect
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private closed: boolean = false;

  constructor(private config: { url: string; apiKey: string }) {}

  // Connect to WebSocket server. Resolves when connected.
  async connect(): Promise<void>

  // Subscribe to updates. Resubscribed automatically on reconnect.
  subscribe(opts: { workspace_id?: string; session_id?: string; scope?: 'all' }): void

  // Unsubscribe
  unsubscribe(opts: { workspace_id?: string; session_id?: string }): void

  // Register message handler. Returns unsubscribe function.
  onMessage(handler: WsMessageHandler): () => void

  // Gracefully close. No reconnect.
  close(): void
}
```

Key behaviors:
- Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s... up to 30s cap).
- On reconnect, re-sends all active subscriptions.
- Responds to `{ type: "ping" }` with `{ type: "pong" }`.
- `closed` flag prevents reconnect after explicit `close()`.
- Connection URL: `ws(s)://<backend>/api/ws?token=<api_key>`.

#### Shared Output Formatter

**`packages/cli/src/lib/formatter.ts`**:

Simple table and detail formatting utilities for CLI stdout output. No Ink dependency.

```typescript
// Formats data as aligned text tables for CLI stdout.
// Used by all CLI query commands. NOT used by TUI (TUI uses Ink components).

export function formatTable(options: {
  columns: { key: string; header: string; width?: number; align?: 'left' | 'right' }[];
  rows: Record<string, unknown>[];
  maxWidth?: number;  // defaults to terminal width
}): string

// Formats a key-value detail view (like session detail header)
export function formatDetail(pairs: [string, string | number | null][]): string

// Relative time formatting: "2m ago", "3h ago", "yesterday"
export function relativeTime(iso: string): string

// Duration formatting: "47m", "1h22m", "2h05m"
export function formatDuration(ms: number): string

// Cost formatting: "$0.42", "$1.87"
export function formatCost(usd: number | null): string

// Lifecycle status with symbol: "● LIVE", "✓ DONE", "✗ FAILED", "◌ PARSING"
export function formatLifecycle(lifecycle: string): string

// Truncate string with ellipsis
export function truncate(str: string, maxLen: number): string
```

#### Tests

**`packages/cli/src/lib/__tests__/api-client.test.ts`**:
1. Constructs correct URL with query params (omits undefined).
2. Sends auth header on every request.
3. Parses JSON response body.
4. Throws `ApiError` on 4xx/5xx with status and body.
5. Throws `ApiConnectionError` on network failure.
6. `listSessions()` passes filter params correctly.
7. `getSession()` fetches correct path.
8. Pagination cursor passed and returned correctly.

**`packages/cli/src/lib/__tests__/ws-client.test.ts`**:
1. Connects to WebSocket server with auth token in URL.
2. Dispatches received messages to registered handlers.
3. Responds to ping with pong.
4. Auto-reconnects on unexpected close (with backoff).
5. Re-subscribes on reconnect.
6. Does not reconnect after explicit `close()`.
7. `onMessage()` returns working unsubscribe function.

**`packages/cli/src/lib/__tests__/formatter.test.ts`**:
1. `formatTable()` aligns columns, respects width, handles empty rows.
2. `relativeTime()`: "just now", "2m ago", "3h ago", "yesterday", "3 days ago".
3. `formatDuration()`: 0 → "0s", 60000 → "1m", 3720000 → "1h02m".
4. `formatCost()`: 0.42 → "$0.42", null → "—".
5. `formatLifecycle()`: "capturing" → "● LIVE", "summarized" → "✓ DONE", "failed" → "✗ FAILED".
6. `truncate()` adds ellipsis at correct position.

**Relevant Files**:
- `packages/cli/src/lib/api-client.ts` (create)
- `packages/cli/src/lib/ws-client.ts` (create)
- `packages/cli/src/lib/formatter.ts` (create)
- `packages/cli/src/lib/__tests__/api-client.test.ts` (create)
- `packages/cli/src/lib/__tests__/ws-client.test.ts` (create)
- `packages/cli/src/lib/__tests__/formatter.test.ts` (create)
- `packages/cli/package.json` (modify — add `ws`, `ink`, `react` dependencies)

**Success Criteria**:
1. `ApiClient` sends correctly authenticated requests with proper query params and JSON bodies.
2. `ApiClient` throws typed errors (`ApiError`, `ApiConnectionError`) on failure.
3. `ApiClient` has typed methods for all existing + new API endpoints (sessions, timeline, workspaces, devices).
4. `WsClient` connects, subscribes, receives typed messages, and dispatches to handlers.
5. `WsClient` auto-reconnects with exponential backoff and resubscribes.
6. `WsClient` responds to server pings with pongs.
7. `WsClient` stops reconnecting after explicit `close()`.
8. `formatTable()` produces aligned stdout-ready table strings.
9. Formatter utilities handle edge cases (null cost, zero duration, future timestamps).
10. All tests pass (`bun test`).

---

### Task 3: CLI — All Query Commands (sessions, timeline, workspaces, status)

**Parallel Group: B**

**Dependencies: Tasks 1, 2**

**Description**

Implement all list/overview CLI commands in one pass. These commands share the pattern: parse args → call ApiClient → format response → print to stdout. Non-interactive, pipeable output.

#### `fuel-code sessions`

**`packages/cli/src/commands/sessions.ts`**:

```typescript
// fuel-code sessions
// Lists recent sessions across all workspaces.
//
// Flags:
//   --workspace <name>    Filter by workspace display name or canonical ID
//   --device <name>       Filter by device name or ID
//   --today               Shorthand for --after=<start of today>
//   --live                Only show sessions with lifecycle = 'capturing'
//   --limit <n>           Max results (default 20)
//   --json                Output raw JSON instead of table
//
// Table columns:
//   STATUS | WORKSPACE | DEVICE | DURATION | COST | COMMITS | SUMMARY
//
// Example output:
//   STATUS   WORKSPACE      DEVICE       DURATION  COST    COMMITS  SUMMARY
//   ● LIVE   fuel-code      macbook-pro  12m       $0.18   0        Redesigning the event pipeline
//   ✓ DONE   fuel-code      macbook-pro  47m       $0.42   2        Refactored auth middleware to use JWT
//   ✓ DONE   fuel-code      remote-abc   1h22m     $1.87   5        Implemented cursor-based pagination
//   ✓ DONE   api-service    macbook-pro  23m       $0.31   1        Fixed timezone handling
```

Workspace name resolution: If `--workspace` is a display name (not a canonical ID or ULID), first call `listWorkspaces()` to find the matching workspace_id, then pass it to `listSessions()`. Cache workspace list for the duration of the command.

#### `fuel-code timeline`

**`packages/cli/src/commands/timeline.ts`**:

```typescript
// fuel-code timeline
// Unified activity feed: sessions + git events, chronologically.
//
// Flags:
//   --workspace <name>    Filter by workspace
//   --today               Today only (default)
//   --week                This week
//   --after <date>        Custom start date (ISO-8601)
//   --before <date>       Custom end date (ISO-8601)
//   --json                Output raw JSON
//
// Output format: Grouped by session, with standalone git events between sessions.
//
// Example output:
//   ── Today, Feb 14 ──────────────────────────────────────
//
//   14:30  ● fuel-code · macbook-pro                  12m  $0.18
//          Redesigning the event pipeline
//          Edit(3) Bash(2) Read(5)
//
//   12:15  ✓ fuel-code · macbook-pro                  47m  $0.42
//          Refactored auth middleware to use JWT
//          ↑ abc123 refactor: JWT auth middleware
//          ↑ def456 test: add JWT validation tests
//
//   11:50  ↑ fuel-code · git push main → origin (3 commits)
//
//   09:30  ✓ api-service · macbook-pro                23m  $0.31
//          Fixed timezone handling in event timestamps
```

Default time range: today (midnight to now). `--week` expands to Monday 00:00 through now.

#### `fuel-code workspaces`

**`packages/cli/src/commands/workspaces.ts`**:

```typescript
// fuel-code workspaces
// Lists all known workspaces.
//
// Flags:
//   --json                Output raw JSON
//
// Table columns:
//   WORKSPACE | SESSIONS | ACTIVE | DEVICES | LAST ACTIVITY
//
// Example output:
//   WORKSPACE        SESSIONS  ACTIVE  DEVICES  LAST ACTIVITY
//   fuel-code        47        1       2        12m ago
//   api-service      23        0       1        3h ago
//   dotfiles         5         0       1        2 days ago
//   _unassociated    2         0       1        1 week ago

// fuel-code workspace <name>
// Workspace detail view.
//
// Shows: workspace metadata, recent sessions, git summary, connected devices, aggregate stats.
//
// Example output:
//   Workspace: fuel-code
//   Canonical: github.com/johnmemon/fuel-code
//   Branch: main
//   Devices: macbook-pro (local), remote-abc (remote, terminated)
//
//   Stats: 47 sessions · 38h total · $42.18 total cost · 156 commits
//
//   Recent Sessions:
//   STATUS   DEVICE       DURATION  COST    SUMMARY
//   ● LIVE   macbook-pro  12m       $0.18   Redesigning the event pipeline
//   ✓ DONE   macbook-pro  47m       $0.42   Refactored auth middleware
//   ✓ DONE   remote-abc   1h22m     $1.87   Cursor-based pagination
//
//   Recent Git Activity:
//   abc123  refactor: JWT auth middleware          macbook-pro  2h ago
//   def456  test: add JWT validation tests         macbook-pro  2h ago
//   789012  feat: cursor-based pagination           remote-abc  5h ago
```

The `workspace <name>` subcommand resolves workspace by display name or canonical ID (partial match allowed — if unique prefix match, use it; if ambiguous, list matches and ask user to be specific).

#### `fuel-code status` (enriched)

**Modify `packages/cli/src/commands/status.ts`**:

Enrich the existing basic status command with session and connectivity information.

```typescript
// fuel-code status
// Quick status overview: active sessions, queue depth, backend connectivity.
//
// Example output:
//   Device: macbook-pro (01JMF3...)
//   Backend: connected (https://fuel-code.up.railway.app)
//   WebSocket: connected
//
//   Active Sessions:
//     ● fuel-code · 12m · $0.18 · Redesigning the event pipeline
//
//   Queue: 0 pending · 0 dead-letter
//   Today: 4 sessions · 2h50m · $2.78 · 8 commits
```

Calls: `health()` for backend status, `listSessions({ lifecycle: 'capturing' })` for active sessions, reads queue directory for pending count, `listSessions({ after: todayStart })` for today's summary.

#### Command Registration

**Modify `packages/cli/src/index.ts`**:

Register all new commands with commander. The `fuel-code` command with no arguments should launch the TUI (Task 5), but if TUI is not yet built, print a message pointing to `fuel-code sessions`.

#### Tests

**`packages/cli/src/commands/__tests__/sessions.test.ts`**:
1. Lists sessions with default params (no filters).
2. `--workspace` filters by workspace name (resolves name to ID).
3. `--device` filters by device name.
4. `--today` sets `after` to start of today.
5. `--live` filters to lifecycle = 'capturing'.
6. `--json` outputs raw JSON.
7. `--limit` controls result count.
8. Handles empty results gracefully ("No sessions found.").
9. Handles backend connection failure with helpful error.

**`packages/cli/src/commands/__tests__/timeline.test.ts`**:
1. Default (no flags) fetches today's timeline.
2. `--week` fetches this week.
3. `--workspace` filters by workspace.
4. Sessions are grouped with their git activity.
5. Standalone git events appear between sessions.
6. `--json` outputs raw JSON.

**`packages/cli/src/commands/__tests__/workspaces.test.ts`**:
1. `workspaces` lists all workspaces with counts.
2. `workspace <name>` shows detail for matching workspace.
3. Partial name match resolves if unambiguous.
4. Ambiguous name match shows error with candidates.
5. Unknown workspace returns helpful error.

**`packages/cli/src/commands/__tests__/status.test.ts`**:
1. Shows device info, backend connectivity, active sessions, queue depth, today's summary.
2. Handles backend unreachable gracefully (shows "disconnected" not crash).

**Relevant Files**:
- `packages/cli/src/commands/sessions.ts` (create)
- `packages/cli/src/commands/timeline.ts` (create)
- `packages/cli/src/commands/workspaces.ts` (create)
- `packages/cli/src/commands/status.ts` (modify — enrich existing)
- `packages/cli/src/index.ts` (modify — register new commands)
- `packages/cli/src/commands/__tests__/sessions.test.ts` (create)
- `packages/cli/src/commands/__tests__/timeline.test.ts` (create)
- `packages/cli/src/commands/__tests__/workspaces.test.ts` (create)
- `packages/cli/src/commands/__tests__/status.test.ts` (create)

**Success Criteria**:
1. `fuel-code sessions` outputs a formatted table of recent sessions.
2. `fuel-code sessions --workspace <name>` filters by workspace (resolves display name to ID).
3. `fuel-code sessions --today` shows only today's sessions.
4. `fuel-code sessions --live` shows only active (capturing) sessions.
5. `fuel-code sessions --json` outputs parseable JSON.
6. `fuel-code timeline` shows today's activity grouped by session with git events.
7. `fuel-code timeline --week` shows this week's timeline.
8. `fuel-code workspaces` lists workspaces with session counts and last activity.
9. `fuel-code workspace <name>` shows workspace detail (sessions, git, devices, stats).
10. `fuel-code status` shows device, backend connectivity, active sessions, queue depth, today summary.
11. All commands handle empty results and connection errors gracefully (no stack traces).
12. All commands support `--json` flag for machine-readable output.
13. All tests pass (`bun test`).

---

### Task 4: CLI — Session Detail Command (all flags)

**Parallel Group: B**

**Dependencies: Tasks 1, 2**

**Description**

Implement `fuel-code session <id>` with all its flags. This is the most feature-rich CLI command — it needs to handle transcript display, event listing, git activity, export, tagging, and reparse triggering. Separated from Task 3 because of its complexity and distinct flag surface.

**`packages/cli/src/commands/session-detail.ts`**:

```typescript
// fuel-code session <id>
// Session detail view. Without flags, shows a summary header.
//
// Flags:
//   --transcript          Show parsed transcript (conversation turns)
//   --events              Show raw events for this session
//   --git                 Show git activity during this session
//   --export json         Export session data as JSON file
//   --export md           Export session as Markdown document
//   --tag <tag>           Add a tag to this session
//   --reparse             Re-trigger transcript parsing
//
// Default output (no flags):
//   Session: abc123...
//   Workspace: fuel-code     Device: macbook-pro (local)
//   Started: 2h ago          Duration: 47m         Cost: $0.42
//   Status: summarized       Branch: main
//   Tokens: 125K in / 48K out / 890K cache read
//   Tags: refactoring, auth
//   Summary: Refactored authentication middleware to use JWT tokens.
//            Added comprehensive test coverage for token validation.
//
//   Tools: Edit(12) Read(15) Bash(8) Grep(4) Write(3)
//   Files: 3 modified · 1 created
//   Git: 2 commits
//
//   Use --transcript, --events, or --git for detailed views.
```

#### --transcript flag

```typescript
// Displays the parsed transcript as a readable conversation.
// Fetches from GET /api/sessions/:id/transcript
//
// Format:
//   [1] Human (14:30):
//     Fix the auth bug in the login middleware...
//
//   [2] Assistant (14:31) · claude-sonnet-4-5 · $0.03:
//     I'll investigate the authentication middleware.
//     ├ Read: src/auth/middleware.ts
//     ├ Read: src/auth/jwt.ts
//     ├ Edit: src/auth/middleware.ts (+15 -8)
//     └ Bash: bun test (exit 0)
//
//   [3] Human (14:35):
//     Now add tests for the JWT validation...

// Tool results are shown as one-line summaries (tool name + primary arg).
// Thinking blocks shown as "[thinking...]" unless --verbose.
// Long text content truncated to terminal width.
```

#### --events flag

```typescript
// Shows raw events within this session's timespan.
// Fetches from GET /api/sessions/:id/events
//
// Format:
//   TIME       TYPE             DATA
//   14:30:01   session.start    branch=main model=claude-sonnet-4-5
//   14:31:15   git.commit       abc123 "refactor: JWT auth middleware"
//   14:34:22   git.commit       def456 "test: add JWT validation tests"
//   14:45:00   session.end      duration=47m reason=exit
```

#### --git flag

```typescript
// Shows git activity associated with this session.
// Fetches from GET /api/sessions/:id/git
//
// Format:
//   COMMIT   MESSAGE                              BRANCH  FILES  +/-
//   abc123   refactor: JWT auth middleware         main    3      +15 -8
//   def456   test: add JWT validation tests        main    2      +45 -0
```

#### --export json

Writes complete session data (metadata + transcript + events + git) to `session-<id>.json` in the current directory.

```typescript
// Export structure:
// {
//   session: Session,
//   transcript: { messages: TranscriptMessage[], content_blocks: ContentBlock[] },
//   events: Event[],
//   git_activity: GitActivity[]
// }
```

#### --export md

Writes a Markdown document with session header, summary, transcript, and git activity to `session-<id>.md`.

#### --tag <tag>

Calls `PATCH /api/sessions/:id` with updated tags. Prints confirmation: `Added tag "refactoring" to session abc123`.

#### --reparse

Calls `POST /api/sessions/:id/reparse`. Prints confirmation: `Re-parse triggered for session abc123. Status will update to 'parsed' when complete.`

#### Session ID resolution

Accept full session ID or unambiguous prefix (first 8+ characters). If prefix is ambiguous, list matching sessions and ask for full ID.

#### Tests

**`packages/cli/src/commands/__tests__/session-detail.test.ts`**:
1. Default view shows session header with all metadata fields.
2. `--transcript` displays formatted conversation turns with tool usage.
3. `--transcript` truncates long content blocks.
4. `--events` displays chronological event table.
5. `--git` displays git activity table with commit details.
6. `--export json` writes valid JSON file to disk.
7. `--export md` writes readable Markdown to disk.
8. `--tag` adds tag and shows confirmation.
9. `--reparse` triggers reparse and shows confirmation.
10. Unknown session ID returns helpful error.
11. Ambiguous session prefix lists candidates.
12. Session with no transcript (state = 'detected') shows appropriate message.
13. Session with no git activity shows "No git activity during this session."

**Relevant Files**:
- `packages/cli/src/commands/session-detail.ts` (create)
- `packages/cli/src/index.ts` (modify — register session command)
- `packages/cli/src/commands/__tests__/session-detail.test.ts` (create)

**Success Criteria**:
1. `fuel-code session <id>` shows session header with workspace, device, duration, cost, status, summary, tool/file/git counts.
2. `--transcript` displays parsed transcript as readable conversation with tool usage inline.
3. `--events` displays chronological event list for the session.
4. `--git` displays git activity (commits, pushes, etc.) associated with the session.
5. `--export json` writes complete session data to `session-<id>.json`.
6. `--export md` writes readable Markdown document to `session-<id>.md`.
7. `--tag <tag>` adds the tag via API and confirms.
8. `--reparse` triggers re-parsing via API and confirms.
9. Session ID prefix resolution works (8+ chars, unambiguous).
10. Graceful error handling for unknown sessions, empty transcripts, API failures.
11. All tests pass (`bun test`).

---

### Task 5: TUI — Dashboard (Sessions by Workspace, Live Updates)

**Parallel Group: C**

**Dependencies: Tasks 1, 2**

**Description**

Build the Ink-based TUI dashboard — the main view when the user runs `fuel-code` with no arguments. This is the session-by-workspace split-pane view from the CORE.md mockup, with live updates via WebSocket.

#### Component Tree

```
<App>                                   -- Top-level, manages routing between views
  <Dashboard>                           -- Main view (default)
    <WorkspaceList>                     -- Left pane: workspace list + remote panel
      <WorkspaceItem workspace active>  -- Individual workspace row
      <RemotePanel>                     -- Bottom-left: active remote envs
    <SessionList>                       -- Right pane: sessions for selected workspace
      <SessionRow session>              -- Individual session row
    <StatusBar>                         -- Bottom bar: today stats + queue + WS status + keybindings
```

**`packages/cli/src/tui/App.tsx`**:

```typescript
// Top-level TUI application component.
// Manages view routing: Dashboard (default) → SessionDetail (on enter).
// Owns the ApiClient and WsClient instances, passed down via context.

import React, { useState, useEffect } from 'react';
import { render, useApp, useInput } from 'ink';
import { ApiClient } from '../lib/api-client';
import { WsClient } from '../lib/ws-client';

export function App() {
  // State: current view ('dashboard' | 'session-detail'), selected session ID
  // On mount: create ApiClient, connect WsClient, subscribe to "all"
  // On unmount: close WsClient
  // Keybinding 'q': exit app via useApp().exit()
}
```

**`packages/cli/src/tui/Dashboard.tsx`**:

```typescript
// Main dashboard view matching the CORE.md mockup.
// Two-column layout: workspaces (left), sessions (right).
//
// Data flow:
// 1. On mount: fetch workspaces via ApiClient, fetch sessions for first workspace
// 2. On workspace selection: fetch sessions for that workspace
// 3. On WsClient message:
//    - "event" with type session.start/end → refresh sessions list
//    - "session.update" → update specific session in-place (no full refetch)

// Keybindings:
//   j/k or arrows: navigate workspace list / session list
//   tab: switch focus between workspace pane and session pane
//   enter: open session detail view
//   f: filter sessions (opens filter prompt)
//   r: refresh data manually
//   /: search sessions (opens search prompt)
//   q: quit
```

**`packages/cli/src/tui/components/WorkspaceList.tsx`**:

```typescript
// Left pane: list of workspaces with session counts.
// Each row: "► workspace-name (N)" where N is session count.
// Selected workspace highlighted. Active sessions indicated with ● marker.
// Bottom section: active remote environments (if any).
```

**`packages/cli/src/tui/components/SessionList.tsx`**:

```typescript
// Right pane: sessions for the selected workspace.
// Each session row shows:
//   STATUS  DEVICE           DURATION  COST  · COMMITS
//   Summary text (truncated to one line)
//   [If LIVE] Tool usage: Edit(3) Bash(2) Read(5)
//   [If DONE + has commits] First 2 commit messages, "... N more" if >2
//
// Live sessions update in real-time via WebSocket.
```

**`packages/cli/src/tui/components/StatusBar.tsx`**:

```typescript
// Bottom status bar showing:
//   Today: N sessions · Xh Ym · $X.XX · N commits
//   Queue: N pending · Backend: connected (ws) | disconnected
//   Keybinding hints: j/k:navigate  enter:detail  f:filter  r:refresh  /:search  q:quit
```

**`packages/cli/src/tui/hooks/useWorkspaces.ts`**:

```typescript
// Custom hook: fetches workspace list, refreshes on WS events.
// Returns: { workspaces, loading, error, refresh }
```

**`packages/cli/src/tui/hooks/useSessions.ts`**:

```typescript
// Custom hook: fetches sessions for a workspace, updates on WS events.
// Returns: { sessions, loading, error, refresh }
// Handles: optimistic updates from session.update WS messages.
```

**`packages/cli/src/tui/hooks/useWsConnection.ts`**:

```typescript
// Custom hook: manages WsClient lifecycle.
// Returns: { connected, client }
// Connects on mount, disconnects on unmount.
```

#### Entry Point

**Modify `packages/cli/src/index.ts`**:

When `fuel-code` is run with no arguments (or `fuel-code tui`), render the TUI:

```typescript
import { render } from 'ink';
import { App } from './tui/App';

// Default command (no subcommand) → launch TUI
program.action(() => {
  render(<App />);
});
```

#### Tests

**`packages/cli/src/tui/__tests__/Dashboard.test.tsx`**:
1. Dashboard renders workspace list and session list.
2. Selecting a workspace updates the session list.
3. Session row displays correct status, device, duration, cost, summary.
4. Live session shows tool usage counts.
5. Completed session with commits shows commit messages.
6. Status bar shows today's aggregates.
7. Status bar shows WebSocket connection status.
8. Keybinding 'q' triggers app exit.
9. Empty workspace list shows "No workspaces found" message.
10. API error shows error message in UI (not crash).

**`packages/cli/src/tui/__tests__/hooks.test.ts`**:
1. `useWorkspaces` fetches on mount and returns workspace list.
2. `useSessions` fetches sessions for given workspace_id.
3. `useSessions` updates session in-place on WS session.update message.
4. `useWsConnection` connects on mount and reports `connected: true`.

Test approach: Use `ink-testing-library` (`render` from `ink-testing-library`) for component tests. Mock `ApiClient` and `WsClient`.

**Relevant Files**:
- `packages/cli/src/tui/App.tsx` (create)
- `packages/cli/src/tui/Dashboard.tsx` (create)
- `packages/cli/src/tui/components/WorkspaceList.tsx` (create)
- `packages/cli/src/tui/components/SessionList.tsx` (create)
- `packages/cli/src/tui/components/SessionRow.tsx` (create)
- `packages/cli/src/tui/components/RemotePanel.tsx` (create)
- `packages/cli/src/tui/components/StatusBar.tsx` (create)
- `packages/cli/src/tui/hooks/useWorkspaces.ts` (create)
- `packages/cli/src/tui/hooks/useSessions.ts` (create)
- `packages/cli/src/tui/hooks/useWsConnection.ts` (create)
- `packages/cli/src/index.ts` (modify — default action renders TUI)
- `packages/cli/src/tui/__tests__/Dashboard.test.tsx` (create)
- `packages/cli/src/tui/__tests__/hooks.test.ts` (create)
- `packages/cli/package.json` (modify — add ink, react, @types/react, ink-testing-library)

**Success Criteria**:
1. `fuel-code` (no args) launches the Ink TUI dashboard.
2. Left pane shows workspaces with session counts, sorted by recency.
3. Selecting a workspace in the left pane populates the right pane with its sessions.
4. Session rows show status icon, device, duration, cost, commits, and truncated summary.
5. Live (capturing) sessions show real-time tool usage counts via WebSocket.
6. Session lifecycle changes (ended, parsed, summarized) update in-place via WebSocket.
7. Status bar shows today's aggregates, queue depth, and WebSocket connection status.
8. Keyboard navigation works: j/k for up/down, tab to switch panes, enter for detail, q to quit.
9. Remote environments panel shows active remotes (if any).
10. Handles API errors and WS disconnects gracefully (shows status, no crash).
11. All tests pass (`bun test`).

---

### Task 6: TUI — Session Detail View (Transcript Viewer, Git Sidebar)

**Parallel Group: C**

**Dependencies: Tasks 1, 2, 4**

**Description**

Build the TUI session detail view — the second screen of the TUI, reached by pressing Enter on a session in the dashboard. This is the split-pane transcript + sidebar view from the CORE.md mockup.

#### Component Tree

```
<SessionDetailView sessionId>
  <SessionHeader>                       -- Top: workspace, device, duration, cost, summary
  <SplitPane>
    <TranscriptViewer>                  -- Left: scrollable parsed transcript
      <MessageBlock message>            -- Individual conversation turn
        <ToolUsageLine tool_use>        -- Inline tool usage (Read, Edit, Bash, etc.)
    <Sidebar>                           -- Right: git, tools, files
      <GitActivityPanel>               -- Commits associated with session
      <ToolsUsedPanel>                 -- Tool usage summary (name → count)
      <FilesModifiedPanel>             -- Files touched during session
```

**`packages/cli/src/tui/SessionDetailView.tsx`**:

```typescript
// Session detail view matching the CORE.md mockup.
// Fetches session detail, transcript, and git activity from API.
// Subscribes to session_id via WebSocket for live updates (if session is active).
//
// Layout:
// - Top: session metadata header (2-3 lines)
// - Middle: split pane (transcript left ~65%, sidebar right ~35%)
// - Bottom: keybinding hints
//
// Keybindings:
//   b: back to dashboard
//   j/k or arrows: scroll transcript
//   t: toggle transcript visibility (show/hide, for focusing on sidebar)
//   g: focus git panel in sidebar
//   e: show events view (replaces transcript pane temporarily)
//   x: export session (json or md, prompted)
//   q: quit app entirely

// Data fetching:
// 1. getSession(id) for metadata
// 2. getSessionTranscript(id) for parsed transcript
// 3. getSessionGit(id) for git activity
// All fetched in parallel on mount.
```

**`packages/cli/src/tui/components/TranscriptViewer.tsx`**:

```typescript
// Scrollable transcript viewer.
// Renders conversation as sequential message blocks.
//
// Each message block:
//   [N] Role (timestamp):
//     Content text (word-wrapped to pane width)
//     ├ ToolName: primary_arg
//     ├ ToolName: primary_arg
//     └ ToolName: primary_arg (last tool)
//
// Thinking blocks: shown as "[thinking... N chars]" by default.
// Tool results: shown as one-line summary (tool name + truncated result).
// Scrolling: j/k moves one message at a time. Page up/down for fast scroll.
// Current position indicator in sidebar or status bar.

// For live sessions:
// New messages appear at bottom. Auto-scroll if user was at bottom.
// New messages received via WebSocket session.update with updated transcript data.
// (Alternatively, poll transcript endpoint every few seconds for live sessions.)
```

**`packages/cli/src/tui/components/Sidebar.tsx`**:

```typescript
// Right sidebar with three panels stacked vertically.
//
// Git Activity:
//   ● abc123 refactor: JWT auth middleware
//   ● def456 test: JWT validation tests
//   (If no git activity: "No git activity")
//
// Tools Used:
//   Edit     12
//   Read     15
//   Bash      8
//   Grep      4
//   Write     3
//   (Sorted by count, descending)
//
// Files Modified:
//   src/auth/middleware.ts
//   src/auth/jwt.ts
//   src/auth/__tests__/jwt.test.ts
//   (Extracted from content_blocks where tool_name = Edit/Write)

// Data sources:
// - Git Activity: from getSessionGit() response
// - Tools Used: computed from transcript content_blocks (group by tool_name, count)
// - Files Modified: extracted from content_blocks where tool_name in (Edit, Write, Read)
//   with deduplication, showing only modified (Edit/Write) files
```

**`packages/cli/src/tui/components/MessageBlock.tsx`**:

```typescript
// Renders a single conversation turn (one transcript_message + its content_blocks).
//
// Props: message: TranscriptMessage, contentBlocks: ContentBlock[], paneWidth: number
//
// Rendering logic:
// 1. Header line: [ordinal] Role (time) · model · cost
// 2. For each content_block in order:
//    - text: word-wrap to paneWidth, display
//    - thinking: "[thinking... N chars]"
//    - tool_use: "├ ToolName: primary_input" (file path for Read/Edit/Write, command for Bash)
//    - tool_result: skip (info already shown in tool_use line)
// 3. Tree-draw characters: ├ for middle items, └ for last item in a tool sequence
```

**`packages/cli/src/tui/hooks/useSessionDetail.ts`**:

```typescript
// Custom hook: fetches all session detail data in parallel.
// Returns: { session, transcript, gitActivity, loading, error }
// Fetches: getSession + getSessionTranscript + getSessionGit in Promise.all
// For live sessions: subscribes to session_id via WsClient for updates.
```

#### Tests

**`packages/cli/src/tui/__tests__/SessionDetailView.test.tsx`**:
1. Session header shows correct metadata (workspace, device, duration, cost, summary).
2. Transcript renders messages in order with correct roles.
3. Tool usage shown inline with tree-draw characters.
4. Thinking blocks shown as collapsed summaries.
5. Sidebar shows git commits.
6. Sidebar shows tool usage counts sorted by frequency.
7. Sidebar shows modified files (deduplicated).
8. Keybinding 'b' navigates back to dashboard.
9. Scroll j/k moves through messages.
10. Session with no transcript shows "Transcript not yet available" or parsing status.
11. Session with no git activity shows "No git activity" in sidebar.
12. Live session auto-scrolls on new messages.
13. Export keybinding 'x' triggers export flow.

**`packages/cli/src/tui/__tests__/MessageBlock.test.tsx`**:
1. Human message renders with correct header.
2. Assistant message with text content renders word-wrapped.
3. Tool use blocks render with tree-draw characters (├ and └).
4. Primary input extraction: Read/Edit/Write → file path, Bash → command, Grep → pattern.
5. Long content truncated to pane width.

**Relevant Files**:
- `packages/cli/src/tui/SessionDetailView.tsx` (create)
- `packages/cli/src/tui/components/TranscriptViewer.tsx` (create)
- `packages/cli/src/tui/components/Sidebar.tsx` (create)
- `packages/cli/src/tui/components/GitActivityPanel.tsx` (create)
- `packages/cli/src/tui/components/ToolsUsedPanel.tsx` (create)
- `packages/cli/src/tui/components/FilesModifiedPanel.tsx` (create)
- `packages/cli/src/tui/components/MessageBlock.tsx` (create)
- `packages/cli/src/tui/components/SessionHeader.tsx` (create)
- `packages/cli/src/tui/hooks/useSessionDetail.ts` (create)
- `packages/cli/src/tui/App.tsx` (modify — add session detail route)
- `packages/cli/src/tui/__tests__/SessionDetailView.test.tsx` (create)
- `packages/cli/src/tui/__tests__/MessageBlock.test.tsx` (create)

**Success Criteria**:
1. Pressing Enter on a session in the dashboard opens the session detail view.
2. Session header shows workspace, device, duration, cost, status, and summary.
3. Transcript pane shows conversation turns with role, timestamp, content, and inline tool usage.
4. Tool usage lines show tree-draw characters (├/└) with tool name and primary argument.
5. Thinking blocks shown as collapsed "[thinking... N chars]" summaries.
6. Sidebar shows git activity (commits with hash and message).
7. Sidebar shows tool usage summary (tool name → count, sorted descending).
8. Sidebar shows files modified (deduplicated, from Edit/Write content blocks).
9. Transcript is scrollable with j/k keys.
10. Keybinding 'b' returns to the dashboard view.
11. Live sessions show updates via WebSocket (new messages, lifecycle changes).
12. Handles edge cases: no transcript yet (parsing), no git activity, empty session.
13. All tests pass (`bun test`).

---

### Task 7: Phase 4 E2E Integration Tests

**Parallel Group: D**

**Dependencies: Tasks 3, 4, 5, 6**

**Description**

End-to-end tests that verify the complete Phase 4 user experience: CLI commands hit real (test) API endpoints and return correct output, and the TUI renders correctly with real data. These tests complement the per-task unit tests by exercising the full stack.

**`packages/cli/src/__tests__/e2e/`**:

#### Test Setup

```typescript
// Shared test setup for E2E tests.
// 1. Start test Express server (in-process or child process)
// 2. Seed Postgres with fixture data:
//    - 3 workspaces (fuel-code, api-service, _unassociated)
//    - 2 devices (macbook-pro: local, remote-abc: remote)
//    - 8 sessions across workspaces and devices (mix of lifecycles)
//    - 20+ events (session.start, session.end, git.commit, git.push)
//    - Parsed transcripts for 3 sessions (messages + content_blocks)
//    - Git activity records for 5 commits
// 3. Start WebSocket server on test HTTP server
// 4. Create ApiClient pointed at test server
```

#### CLI E2E Tests

**`packages/cli/src/__tests__/e2e/cli-commands.test.ts`**:

```typescript
// Run CLI commands via Bun.spawn and assert stdout output.
// Uses test server URL in config.

// Tests:
// 1. `fuel-code sessions` returns table with all sessions from seed data.
// 2. `fuel-code sessions --workspace fuel-code` filters correctly.
// 3. `fuel-code sessions --live` shows only capturing sessions.
// 4. `fuel-code sessions --json` returns valid JSON matching API response.
// 5. `fuel-code session <id>` shows session header.
// 6. `fuel-code session <id> --transcript` shows conversation turns.
// 7. `fuel-code session <id> --git` shows commit list.
// 8. `fuel-code session <id> --events` shows event list.
// 9. `fuel-code session <id> --export json` writes file, content matches API.
// 10. `fuel-code session <id> --tag test-tag` adds tag (verified via API).
// 11. `fuel-code timeline` shows today's activity feed.
// 12. `fuel-code timeline --workspace fuel-code` filters correctly.
// 13. `fuel-code workspaces` lists all 3 workspaces with counts.
// 14. `fuel-code workspace fuel-code` shows detail view.
// 15. `fuel-code status` shows device, backend, active sessions, queue.
// 16. Unknown session ID gives helpful error message.
// 17. Backend down gives connection error message (not stack trace).
```

#### WebSocket E2E Tests

**`packages/cli/src/__tests__/e2e/ws-live.test.ts`**:

```typescript
// Tests WebSocket live update flow.
// 1. Connect WsClient to test server.
// 2. Subscribe to "all".
// 3. POST a new event to /api/events/ingest.
// 4. Assert WsClient receives the broadcast.
// 5. Subscribe to specific workspace_id.
// 6. POST event for that workspace → received.
// 7. POST event for different workspace → NOT received.
// 8. Subscribe to specific session_id.
// 9. Trigger session lifecycle change → session.update message received.
```

#### TUI E2E Tests

**`packages/cli/src/__tests__/e2e/tui-render.test.ts`**:

```typescript
// Uses ink-testing-library to render TUI components with real ApiClient
// pointed at test server (or mock server).
//
// 1. Dashboard renders workspace list from seeded data.
// 2. Dashboard renders session list for first workspace.
// 3. Navigating to second workspace updates session list.
// 4. Pressing enter on a session renders SessionDetailView.
// 5. SessionDetailView shows transcript content from seeded data.
// 6. Pressing 'b' returns to dashboard.
// 7. Status bar shows correct today's aggregates from seed data.
```

#### Server Endpoint E2E Tests

**`packages/server/src/__tests__/e2e/phase4-endpoints.test.ts`**:

```typescript
// Verify new endpoints return correct data with seeded fixtures.
// 1. GET /api/workspaces returns all 3 workspaces with correct counts.
// 2. GET /api/workspaces/:id returns detail with sessions, git, devices.
// 3. GET /api/devices returns both devices with counts.
// 4. GET /api/devices/:id returns detail with sessions and workspaces.
// 5. All new endpoints require auth (401 without token).
// 6. Unknown IDs return 404 with structured error.
```

**Relevant Files**:
- `packages/cli/src/__tests__/e2e/cli-commands.test.ts` (create)
- `packages/cli/src/__tests__/e2e/ws-live.test.ts` (create)
- `packages/cli/src/__tests__/e2e/tui-render.test.ts` (create)
- `packages/server/src/__tests__/e2e/phase4-endpoints.test.ts` (create)
- `packages/cli/src/__tests__/e2e/setup.ts` (create — shared fixtures and test server)

**Success Criteria**:
1. All CLI query commands produce correct output against seeded test data.
2. Session detail command with all flags (--transcript, --git, --events, --export, --tag) works end-to-end.
3. WebSocket broadcasts reach subscribed clients correctly.
4. WebSocket subscription filtering works (workspace, session, all scopes).
5. TUI dashboard renders correctly with real API data.
6. TUI session detail view renders transcript and sidebar correctly.
7. New server endpoints (workspaces, devices) return correct data with proper auth.
8. All error paths produce user-friendly messages (not stack traces).
9. All E2E tests pass (`bun test`).
10. Tests clean up after themselves (no leftover state in test DB).
