# Phase 4: CLI + TUI — Task Dependency DAG (Draft B: Feature-Vertical)

## Overview

Phase 4 delivers the primary user interface for fuel-code. After Phase 4, every query command works (`sessions`, `session <id>`, `timeline`, `workspaces`, `workspace <name>`, `status`), the Ink-based TUI dashboard renders sessions by workspace with live updates, and the TUI session detail view shows transcripts with a git sidebar. The WebSocket server broadcasts events in real-time, and the CLI's WebSocket client consumes them.

This draft is structured as **feature-vertical slices**: each major feature (sessions list, session detail, timeline, workspaces, status) is a self-contained task including the CLI command, data formatting, and any missing server endpoint. Cross-cutting infrastructure (API client, WebSocket, TUI shell) are separate foundational tasks. The TUI views are layered on top, organized by what they display.

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | API Client + Output Formatting Utilities | A | — |
| 2 | Server: Workspace + Device API Endpoints | A | — |
| 3 | `fuel-code sessions` Command | B | 1 |
| 4 | `fuel-code session <id>` Command (Detail + Flags) | B | 1 |
| 5 | `fuel-code timeline` Command | B | 1 |
| 6 | `fuel-code workspaces` + `fuel-code workspace <name>` Commands | B | 1, 2 |
| 7 | `fuel-code status` Command | B | 1 |
| 8 | WebSocket Server (Broadcast + Subscriptions) | C | — |
| 9 | WebSocket Client + CLI Live Mode | D | 1, 8 |
| 10 | TUI Shell + Dashboard View | E | 1, 2, 9 |
| 11 | TUI Session Detail View | E | 1, 9 |
| 12 | Phase 4 E2E Integration Tests | F | 3, 4, 5, 6, 7, 10, 11 |

## Dependency Graph

```
Group A ─── Task 1: API client + formatting    Task 2: Workspace/Device endpoints
               │                                   │
        ┌──────┼──────────┬──────────┐             │
        ▼      ▼          ▼          ▼             │
Group B ─── Task 3     Task 4     Task 5    Task 7 │
            sessions   session    timeline  status  │
                       detail                       │
        │      │          │          │         │    │
        │      └──────────┴──────────┘         │    │
        │              │                       │    │
        │              ▼                       │    │
        │         Task 6: workspaces  ◄────────┼────┘
        │              │                       │
        └──────────────┼───────────────────────┘
                       │
                       │          ┌──────────────────┐
                       │          │                  │
Group C ───            │    Task 8: WebSocket server │
                       │          │                  │
                       │          └────────┬─────────┘
                       │                   │
                       ▼                   ▼
Group D ───                  Task 9: WebSocket client + live mode
                                    │
                       ┌────────────┤
                       ▼            ▼
Group E ─── Task 10: TUI dashboard    Task 11: TUI session detail
                       │                       │
                       └───────────┬───────────┘
                                   ▼
Group F ─── Task 12: E2E integration tests
```

## Parallel Groups

- **A**: Tasks 1, 2 (independent: CLI-side HTTP client vs server-side new endpoints)
- **B**: Tasks 3, 4, 5, 6, 7 (all CLI query commands; 3/4/5/7 need only Task 1; Task 6 also needs Task 2)
- **C**: Task 8 (WebSocket server, independent of CLI work)
- **D**: Task 9 (WebSocket client, needs API client + WS server)
- **E**: Tasks 10, 11 (TUI views, need API client, workspace endpoints, WS client)
- **F**: Task 12 (final verification)

## Critical Path

Task 1 → Task 3 → Task 9 (needs Task 8 in parallel) → Task 10 → Task 12

(5 sequential stages, with Task 8 running in parallel with Group B)

## Dependency Edges (precise)

- Task 1 → Tasks 3, 4, 5, 6, 7, 9, 10, 11 (API client used by all query commands and TUI)
- Task 2 → Tasks 6, 10 (workspace/device endpoints needed for workspace commands and dashboard)
- Task 8 → Task 9 (WS server must exist before client can connect)
- Task 9 → Tasks 10, 11 (TUI views use WS client for live updates)
- Tasks 3, 4, 5, 6, 7, 10, 11 → Task 12 (E2E tests verify everything)

## Key Design Decisions

### 1. API Client as Foundation
All CLI commands and TUI views share one `ApiClient` class (`packages/cli/src/lib/api-client.ts`). It wraps `fetch()` with auth headers, base URL from config, error handling, and typed response parsing. This is the single point of contact with the server. No command duplicates HTTP logic.

### 2. Output Formatting Separated from Data Fetching
Each command fetches data via `ApiClient`, then formats it for display. Formatting utilities (`packages/cli/src/lib/formatters.ts`) handle table rendering, duration formatting, cost formatting, relative time, and color coding. The TUI reuses the same data types but renders via Ink components instead of string tables.

### 3. CLI Commands as Thin Wrappers
Each command file registers with commander, parses flags, calls `ApiClient`, formats output, and prints. No business logic. The server API is the source of truth.

### 4. WebSocket as Additive Enhancement
The `--live` flag on `fuel-code sessions` and the TUI dashboard both use WebSocket, but all commands work without it. If the WebSocket connection fails, the TUI falls back to polling. The WS client is a separate module that emits typed events.

### 5. TUI is Ink (React for Terminals)
The TUI uses `ink` (React renderer for terminals). Components are `.tsx` files. State management uses React hooks + the WS client event emitter. The TUI shell handles keyboard navigation, view switching, and layout. Individual views (Dashboard, SessionDetail) are separate components.

### 6. Feature Verticals
Tasks 3-7 each deliver a complete user-visible feature. After Task 3, `fuel-code sessions` works end-to-end. After Task 4, `fuel-code session <id>` works with all flags. No task produces only backend or only frontend pieces (except Tasks 1, 2, 8 which are explicit infrastructure).

## What Already Exists (from Phases 1-3)

### Server Endpoints (already built)
- `POST /api/events/ingest` — event ingestion
- `GET /api/sessions` — list sessions (paginated, filterable by workspace_id, device_id, lifecycle, date range, tag)
- `GET /api/sessions/:id` — session detail with stats
- `GET /api/sessions/:id/transcript` — parsed transcript (messages + content blocks)
- `GET /api/sessions/:id/events` — events within session
- `GET /api/sessions/:id/git` — git activity during session
- `PATCH /api/sessions/:id` — update tags, manual summary override
- `POST /api/sessions/:id/reparse` — re-trigger transcript parsing
- `GET /api/timeline` — unified activity feed (session-grouped)
- `GET /api/health` — health check

### Server Endpoints (NOT yet built, needed for Phase 4)
- `GET /api/workspaces` — list workspaces
- `GET /api/workspaces/:id` — workspace detail (recent sessions, git, devices)
- `GET /api/devices` — list devices
- `GET /api/devices/:id` — device detail
- `WS /api/ws` — WebSocket endpoint

### CLI (already built)
- `fuel-code init` — device initialization
- `fuel-code emit` — event emission (HTTP POST with queue fallback)
- `fuel-code hooks install` — CC hooks + git hooks
- `fuel-code hooks status` — hook installation status
- `fuel-code backfill` — historical session scanner
- `fuel-code queue status/drain/dead-letter` — queue management
- `packages/cli/src/lib/config.ts` — config file management
- `packages/cli/src/lib/queue.ts` — local event queue
- `packages/cli/src/index.ts` — commander entry point
- Error hierarchy (FuelCodeError subclasses)
- pino logger

### CLI (NOT yet built, needed for Phase 4)
- `packages/cli/src/lib/api-client.ts` — general-purpose HTTP client for querying
- `packages/cli/src/lib/ws-client.ts` — WebSocket client
- All query commands (sessions, session, timeline, workspaces, workspace, status)
- All TUI components

### Shared Types (already built)
- Event, Session, Workspace, Device types in `packages/shared/src/types/`
- Zod schemas for all event payloads in `packages/shared/src/schemas/`
- ULID utility, canonical ID normalization

---

## Task Details

---

### Task 1: API Client + Output Formatting Utilities

**Parallel Group: A**

**Description**

Create the general-purpose API client for CLI query commands and the shared output formatting utilities. The API client wraps `fetch()` with configuration (base URL, API key from `~/.fuel-code/config.yaml`), typed responses, pagination support, and structured error handling. The formatting utilities provide consistent terminal output across all commands: table rendering, duration/cost/time formatting, and color coding.

**API Client: `packages/cli/src/lib/api-client.ts`**

```typescript
import { loadConfig } from './config';

// Typed API client for all server queries
// Reads base URL and API key from ~/.fuel-code/config.yaml
// All methods return typed responses or throw FuelCodeError subclasses

export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null;  // null if no more pages
  total: number;
}

export interface ApiClientOptions {
  baseUrl?: string;     // override config
  apiKey?: string;      // override config
  timeout?: number;     // default 10000ms
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(opts?: ApiClientOptions);

  // Sessions
  async getSessions(params?: {
    workspace_id?: string;
    device_id?: string;
    lifecycle?: string;
    after?: string;       // ISO-8601
    before?: string;
    tag?: string;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResponse<Session>>;

  async getSession(id: string): Promise<Session>;
  async getSessionTranscript(id: string): Promise<TranscriptResponse>;
  async getSessionEvents(id: string): Promise<Event[]>;
  async getSessionGit(id: string): Promise<GitActivity[]>;
  async updateSession(id: string, update: { tags?: string[]; summary?: string }): Promise<Session>;
  async reparseSession(id: string): Promise<{ status: string }>;

  // Timeline
  async getTimeline(params?: {
    workspace_id?: string;
    after?: string;
    before?: string;
    types?: string[];
  }): Promise<TimelineResponse>;

  // Workspaces
  async getWorkspaces(): Promise<Workspace[]>;
  async getWorkspace(id: string): Promise<WorkspaceDetail>;

  // Devices
  async getDevices(): Promise<Device[]>;
  async getDevice(id: string): Promise<Device>;

  // Status
  async getHealth(): Promise<{ status: string; version: string }>;

  // Internal
  private async request<T>(method: string, path: string, opts?: {
    params?: Record<string, string | number | undefined>;
    body?: unknown;
  }): Promise<T>;
}
```

The `request()` method:
1. Reads `baseUrl` and `apiKey` from config (cached on construction).
2. Builds URL with query params (omits undefined values).
3. Sets `Authorization: Bearer <apiKey>` header.
4. Sets `Content-Type: application/json` for POST/PATCH.
5. Uses `AbortSignal.timeout(this.timeout)` for timeouts.
6. On non-2xx: parses error body, throws `NetworkError` (connection issues) or `ApiError` (server returned error).
7. On success: returns parsed JSON cast to `T`.

**Output Formatters: `packages/cli/src/lib/formatters.ts`**

```typescript
// Shared formatting utilities for consistent terminal output
// Used by all CLI commands; TUI components use their own Ink rendering

// Duration formatting: 45000 → "45s", 120000 → "2m", 5400000 → "1h30m"
export function formatDuration(ms: number): string;

// Cost formatting: 0.42 → "$0.42", 1.234 → "$1.23"
export function formatCost(usd: number | null): string;

// Relative time: ISO string → "12m ago", "2h ago", "yesterday", "Feb 10"
export function formatRelativeTime(iso: string): string;

// Session lifecycle badge: "capturing" → green "● LIVE", "summarized" → "✓ DONE", "failed" → red "✗ FAIL"
export function formatLifecycle(lifecycle: string): string;

// Table renderer: takes headers + rows, auto-sizes columns, respects terminal width
export function renderTable(opts: {
  headers: string[];
  rows: string[][];
  maxWidth?: number;       // default: process.stdout.columns || 120
  truncate?: boolean;      // truncate long values, default true
}): string;

// Session row for sessions list command
export function formatSessionRow(session: Session): string[];

// Workspace row for workspaces list command
export function formatWorkspaceRow(workspace: Workspace): string[];

// Color helpers (using chalk or picocolors)
export const colors: {
  dim: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  bold: (s: string) => string;
};
```

**Files to Create**
- `packages/cli/src/lib/api-client.ts`
- `packages/cli/src/lib/formatters.ts`
- `packages/cli/src/lib/__tests__/api-client.test.ts`
- `packages/cli/src/lib/__tests__/formatters.test.ts`

**Files to Modify**
- `packages/cli/package.json` — add `picocolors` dependency (lightweight terminal colors, 3.5KB, no deps)

**Tests**

`api-client.test.ts`:
1. Constructs URL with query params correctly (omits undefined).
2. Sets Authorization header from config.
3. Handles 200 response with typed parsing.
4. Handles 401 → throws `AuthError`.
5. Handles 404 → throws `NotFoundError`.
6. Handles 500 → throws `ApiError` with server message.
7. Handles network timeout → throws `NetworkError`.
8. Handles connection refused → throws `NetworkError`.
9. Paginated responses return cursor and total.
10. Params with arrays (e.g., `types`) are serialized correctly.

Use `Bun.serve()` to create a local mock server in tests. No external mocking library needed.

`formatters.test.ts`:
1. `formatDuration`: 0 → "0s", 999 → "0s", 1000 → "1s", 60000 → "1m", 3661000 → "1h1m".
2. `formatCost`: null → "—", 0 → "$0.00", 0.005 → "$0.01", 1.999 → "$2.00".
3. `formatRelativeTime`: now → "just now", 30 seconds ago → "30s ago", 5 min ago → "5m ago", 2 hours ago → "2h ago", yesterday → "yesterday", 5 days ago → "Feb 9" (date formatted).
4. `formatLifecycle`: "detected" → dim, "capturing" → green LIVE, "ended" → yellow, "parsed" → yellow, "summarized" → green DONE, "failed" → red FAIL.
5. `renderTable`: auto-sizes columns, truncates to terminal width, handles empty rows.
6. `formatSessionRow`: returns array matching table headers.

**Success Criteria**
1. `ApiClient` reads config from `~/.fuel-code/config.yaml` on construction.
2. All typed methods call correct endpoints with correct HTTP methods.
3. Query parameters are correctly serialized (undefined values omitted).
4. Error responses are classified into specific error types (AuthError, NotFoundError, ApiError, NetworkError).
5. Timeout is configurable and defaults to 10 seconds.
6. `formatDuration` handles edge cases (0, sub-second, hours+minutes).
7. `formatCost` rounds to 2 decimal places, handles null.
8. `renderTable` respects terminal width and truncates gracefully.
9. `formatLifecycle` color-codes all 7 lifecycle states.
10. All formatters are pure functions with no side effects.
11. `picocolors` is used for terminal colors (not chalk — chalk is ESM-only and heavier).

---

### Task 2: Server: Workspace + Device API Endpoints

**Parallel Group: A**

**Description**

Add the four missing REST endpoints to the server: `GET /api/workspaces`, `GET /api/workspaces/:id`, `GET /api/devices`, `GET /api/devices/:id`. These are needed for the `fuel-code workspaces` command and the TUI dashboard's workspace sidebar.

**Route File: `packages/server/src/routes/workspaces.ts`**

```typescript
import { Router } from 'express';
import postgres from '../db/postgres';

const router = Router();

// GET /api/workspaces
// Returns all workspaces with session counts and last activity
// Query params: none (small dataset, no pagination needed for single-user)
router.get('/', async (req, res) => {
  // Query: SELECT w.*,
  //   COUNT(s.id) as session_count,
  //   COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) as active_session_count,
  //   MAX(s.started_at) as last_session_at,
  //   COALESCE(SUM(s.cost_estimate_usd), 0) as total_cost_usd,
  //   COALESCE(SUM(s.duration_ms), 0) as total_duration_ms
  //   FROM workspaces w
  //   LEFT JOIN sessions s ON w.id = s.workspace_id
  //   GROUP BY w.id
  //   ORDER BY last_session_at DESC NULLS LAST
  //
  // Response: { data: WorkspaceListItem[] }
});

// GET /api/workspaces/:id
// Returns workspace detail with recent sessions, device list, git summary
router.get('/:id', async (req, res) => {
  // 1. Fetch workspace by id (could be ULID id or canonical_id)
  //    SELECT * FROM workspaces WHERE id = $1 OR canonical_id = $1
  //
  // 2. Recent sessions (last 20):
  //    SELECT * FROM sessions WHERE workspace_id = $1 ORDER BY started_at DESC LIMIT 20
  //
  // 3. Devices tracking this workspace:
  //    SELECT d.*, wd.local_path, wd.hooks_installed, wd.git_hooks_installed, wd.last_active_at
  //    FROM devices d JOIN workspace_devices wd ON d.id = wd.device_id
  //    WHERE wd.workspace_id = $1
  //
  // 4. Recent git activity (last 20):
  //    SELECT * FROM git_activity WHERE workspace_id = $1 ORDER BY timestamp DESC LIMIT 20
  //
  // 5. Aggregate stats:
  //    Total sessions, total cost, total duration, total commits, date range
  //
  // Response: { workspace, sessions, devices, git_activity, stats }
  // 404 if workspace not found
});

export default router;
```

**Route File: `packages/server/src/routes/devices.ts`**

```typescript
import { Router } from 'express';
import postgres from '../db/postgres';

const router = Router();

// GET /api/devices
// Returns all devices with status and last seen info
router.get('/', async (req, res) => {
  // SELECT d.*,
  //   COUNT(DISTINCT wd.workspace_id) as workspace_count,
  //   COUNT(DISTINCT CASE WHEN s.lifecycle = 'capturing' THEN s.id END) as active_session_count,
  //   MAX(s.started_at) as last_session_at
  //   FROM devices d
  //   LEFT JOIN workspace_devices wd ON d.id = wd.device_id
  //   LEFT JOIN sessions s ON d.id = s.device_id
  //   GROUP BY d.id
  //   ORDER BY d.last_seen_at DESC
  //
  // Response: { data: DeviceListItem[] }
});

// GET /api/devices/:id
// Returns device detail with workspaces it tracks and recent sessions
router.get('/:id', async (req, res) => {
  // 1. Fetch device: SELECT * FROM devices WHERE id = $1
  //
  // 2. Workspaces tracked:
  //    SELECT w.*, wd.local_path, wd.hooks_installed, wd.git_hooks_installed
  //    FROM workspaces w JOIN workspace_devices wd ON w.id = wd.workspace_id
  //    WHERE wd.device_id = $1
  //
  // 3. Recent sessions (last 20):
  //    SELECT * FROM sessions WHERE device_id = $1 ORDER BY started_at DESC LIMIT 20
  //
  // Response: { device, workspaces, sessions }
  // 404 if device not found
});

export default router;
```

**Modify: `packages/server/src/index.ts`**

Register new routes:
```typescript
import workspacesRouter from './routes/workspaces';
import devicesRouter from './routes/devices';

app.use('/api/workspaces', authMiddleware, workspacesRouter);
app.use('/api/devices', authMiddleware, devicesRouter);
```

**Files to Create**
- `packages/server/src/routes/workspaces.ts`
- `packages/server/src/routes/devices.ts`
- `packages/server/src/routes/__tests__/workspaces.test.ts`
- `packages/server/src/routes/__tests__/devices.test.ts`

**Files to Modify**
- `packages/server/src/index.ts` — register new routes

**Tests**

`workspaces.test.ts` (use supertest against Express app with test DB):
1. `GET /api/workspaces` returns empty array when no workspaces exist.
2. `GET /api/workspaces` returns workspaces sorted by last session time.
3. `GET /api/workspaces` includes session_count and active_session_count per workspace.
4. `GET /api/workspaces` includes total_cost_usd and total_duration_ms.
5. `GET /api/workspaces/:id` returns workspace detail by ULID id.
6. `GET /api/workspaces/:id` returns workspace detail by canonical_id (e.g., "github.com/user/repo").
7. `GET /api/workspaces/:id` includes recent sessions, devices, and git activity.
8. `GET /api/workspaces/:id` returns 404 for unknown workspace.
9. `GET /api/workspaces` requires auth (401 without token).

`devices.test.ts`:
1. `GET /api/devices` returns all devices.
2. `GET /api/devices` includes workspace_count and active_session_count.
3. `GET /api/devices/:id` returns device with workspaces and recent sessions.
4. `GET /api/devices/:id` returns 404 for unknown device.
5. `GET /api/devices` requires auth.

**Success Criteria**
1. `GET /api/workspaces` returns all workspaces with accurate session counts, cost totals, and last activity timestamps.
2. `GET /api/workspaces/:id` accepts both ULID and canonical_id as the `:id` parameter.
3. Workspace detail includes recent sessions (last 20), device list, recent git activity (last 20), and aggregate stats.
4. `GET /api/devices` returns all devices with workspace counts and active session counts.
5. Device detail includes workspaces tracked and recent sessions.
6. All endpoints require auth and return 401 without a valid token.
7. All endpoints return 404 with a clear message for unknown IDs.
8. Response shapes match the types expected by `ApiClient` from Task 1.

---

### Task 3: `fuel-code sessions` Command

**Parallel Group: B**

**Description**

Implement the `fuel-code sessions` command — the primary query command for listing recent sessions. This command calls `GET /api/sessions` via `ApiClient`, formats the results as a table, and prints to stdout. Supports filtering by workspace, device, date range, and lifecycle state.

**Command File: `packages/cli/src/commands/sessions.ts`**

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import { renderTable, formatSessionRow, formatDuration, formatCost, formatRelativeTime, formatLifecycle, colors } from '../lib/formatters';

// Register the "sessions" command on the parent program
export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List recent sessions across all workspaces')
    .option('--workspace <name>', 'Filter by workspace name or canonical ID')
    .option('--device <name>', 'Filter by device name or ID')
    .option('--today', 'Show only today\'s sessions')
    .option('--lifecycle <state>', 'Filter by lifecycle state (capturing, summarized, failed, etc.)')
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <n>', 'Max results (default 20)', '20')
    .option('--json', 'Output as JSON instead of table')
    .option('--live', 'Live-updating feed (requires WebSocket)')
    .action(async (opts) => {
      // 1. Build query params from flags
      //    --today: set after to start of today (local timezone), before to now
      //    --workspace: if it looks like a canonical ID (contains /), use as workspace_id
      //                 otherwise, resolve by name via GET /api/workspaces then use the ID
      //
      // 2. Call api.getSessions(params)
      //
      // 3. If --json: print JSON.stringify(result.data, null, 2)
      //
      // 4. If --live: delegate to live mode (Task 9 adds this; here just print a message
      //    "Live mode requires WebSocket. Install with Task 9." and fall through to table)
      //
      // 5. Otherwise: format and print table
      //    Headers: STATUS | WORKSPACE | DEVICE | DURATION | COST | STARTED | SUMMARY
      //    Each row uses formatSessionRow()
      //
      // 6. Print footer: "Showing N of M sessions"
      //
      // 7. Handle errors: NetworkError → "Cannot connect to backend. Is it running?"
      //                   AuthError → "Invalid API key. Run `fuel-code init` to reconfigure."
    });
}
```

**Table output format**:
```
STATUS    WORKSPACE         DEVICE        DURATION   COST    STARTED     SUMMARY
● LIVE    fuel-code         macbook-pro   12m        $0.18   12m ago     Redesigning the event pipeline
✓ DONE    fuel-code         macbook-pro   47m        $0.42   2h ago      Refactored auth middleware to use JWT
✓ DONE    api-service       remote-abc    1h22m      $1.87   3h ago      Implemented cursor-based pagination
✗ FAIL    dotfiles          macbook-pro   23m        $0.31   5h ago      (parse failed)

Showing 4 of 4 sessions
```

**Workspace name resolution**: The `--workspace` flag accepts either a canonical ID (`github.com/user/repo`) or a display name (`fuel-code`). If the value contains a `/`, treat it as a canonical ID and pass directly as `workspace_id` param. Otherwise, call `GET /api/workspaces`, find the matching display_name (case-insensitive), and use its ID. If no match, print an error listing available workspaces.

**Modify: `packages/cli/src/index.ts`**

Import and register the sessions command:
```typescript
import { registerSessionsCommand } from './commands/sessions';
registerSessionsCommand(program);
```

**Files to Create**
- `packages/cli/src/commands/sessions.ts`
- `packages/cli/src/commands/__tests__/sessions.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` — register command

**Tests**

`sessions.test.ts`:
1. Default (no flags): calls `GET /api/sessions?limit=20` and renders table.
2. `--workspace fuel-code`: resolves workspace name to ID, passes as query param.
3. `--workspace github.com/user/repo`: passes canonical ID directly as workspace_id.
4. `--workspace unknown-name`: prints error with available workspace names.
5. `--today`: sets `after` to start of today in ISO-8601.
6. `--device macbook-pro`: passes device name to device_id filter.
7. `--lifecycle capturing`: passes lifecycle filter.
8. `--tag important`: passes tag filter.
9. `--limit 5`: passes limit=5.
10. `--json`: outputs raw JSON array.
11. Empty result: prints "No sessions found" message.
12. Network error: prints user-friendly connection error.
13. Table output respects terminal width.

Test approach: Mock `ApiClient` by injecting a test instance that returns canned responses. Capture stdout to assert output format.

**Success Criteria**
1. `fuel-code sessions` lists recent sessions in a formatted table.
2. `--workspace` accepts both display names and canonical IDs.
3. `--today` filters to today's sessions using local timezone.
4. `--device`, `--lifecycle`, `--tag` filters work correctly.
5. `--limit` controls result count.
6. `--json` outputs valid JSON array.
7. Table columns auto-size to terminal width.
8. Live sessions show green "LIVE" status, completed show "DONE", failed show "FAIL".
9. Summary column is truncated if too long for terminal width.
10. Footer shows "Showing N of M" count.
11. Error messages are user-friendly (no stack traces in normal mode).
12. Command is registered and shows in `fuel-code --help`.

---

### Task 4: `fuel-code session <id>` Command (Detail + Flags)

**Parallel Group: B**

**Description**

Implement the `fuel-code session <id>` command — the detailed view for a single session. Without flags, it prints a summary header followed by key stats. With flags, it shows specific data: `--transcript` for the parsed transcript, `--events` for raw events, `--git` for git activity, `--export json|md` for data export, `--tag <tag>` to add a tag, `--reparse` to re-trigger parsing.

**Command File: `packages/cli/src/commands/session-detail.ts`**

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';

export function registerSessionDetailCommand(program: Command): void {
  program
    .command('session <id>')
    .description('View session details')
    .option('--transcript', 'Show parsed transcript')
    .option('--events', 'Show raw events for this session')
    .option('--git', 'Show git activity during this session')
    .option('--export <format>', 'Export session data (json or md)')
    .option('--tag <tag>', 'Add a tag to this session')
    .option('--reparse', 'Re-trigger transcript parsing')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      // Route to appropriate sub-handler based on flags
    });
}
```

**Default view (no flags)**: Print a summary card:
```
Session: abc123def456
Workspace: fuel-code (github.com/user/fuel-code)
Device:    macbook-pro (local)
Status:    ✓ Summarized
Started:   2h ago (2026-02-14T10:23:00Z)
Duration:  47m
Cost:      $0.42
Model:     claude-sonnet-4-5-20250929
Branch:    main

Summary:
  Refactored authentication middleware to replace session-based auth with
  JWT tokens. Updated middleware, added token verification, wrote tests.

Stats:
  Messages: 42 total (12 user, 30 assistant)
  Tools:    Edit(12) Read(15) Bash(8) Grep(4) Write(3)
  Tokens:   125K in / 48K out / 890K cache
  Commits:  2

Tags: refactoring, auth
```

**`--transcript` flag**: Print the parsed transcript in a readable format:
```
[1] Human:
  Fix the auth bug in the login endpoint. The session cookie isn't being
  set correctly after the OAuth callback.

[2] Assistant:
  I'll investigate the auth flow. Let me start by reading the relevant files.
  ├─ Read: src/auth/middleware.ts
  ├─ Read: src/auth/oauth.ts
  ├─ Read: src/routes/login.ts
  I can see the issue. The cookie options are missing the `secure` flag...
  ├─ Edit: src/auth/middleware.ts (+12 -3)
  └─ Bash: bun test src/auth/ (exit 0)

[3] Human:
  Now add tests for the JWT validation edge cases.

[4] Assistant:
  I'll add comprehensive tests for JWT validation.
  ├─ Read: src/auth/__tests__/jwt.test.ts
  ├─ Write: src/auth/__tests__/jwt.test.ts
  └─ Bash: bun test src/auth/__tests__/jwt.test.ts (exit 0)
```

Transcript rendering logic:
1. Fetch `GET /api/sessions/:id/transcript` → array of `TranscriptMessage` with nested `ContentBlock[]`.
2. For each message: print ordinal, role, content.
3. For assistant messages: show text content inline, then tool uses as a tree (├─ / └─).
4. Tool use: show `ToolName: input_summary`. For Read/Edit/Write: show file path. For Bash: show command (truncated). For Grep/Glob: show pattern.
5. Thinking blocks: show as dimmed `[thinking]` prefix (don't dump full thinking text unless `--verbose`).
6. Paginate output if transcript is very long (show first 50 messages, "... N more messages. Use --limit to see all").

**`--events` flag**: Print raw events in a timeline format:
```
TIMESTAMP           TYPE              DATA
10:23:00            session.start     branch=main, model=claude-sonnet-4-5
10:35:12            git.commit        abc123 "fix auth bug" (+12 -3, 2 files)
10:41:30            git.commit        def456 "add JWT tests" (+45 -0, 1 file)
11:10:00            session.end       duration=47m, reason=exit
```

**`--git` flag**: Print git activity during the session:
```
Git Activity (2 commits, +57 -3)

● abc123  fix auth bug                    10:35   +12 -3   2 files
  src/auth/middleware.ts (M)
  src/auth/oauth.ts (M)

● def456  add JWT validation tests        10:41   +45 -0   1 file
  src/auth/__tests__/jwt.test.ts (A)
```

**`--export json`**: Output the full session object (detail + transcript + events + git) as JSON to stdout.

**`--export md`**: Output a Markdown document:
```markdown
# Session: fuel-code — Refactored auth middleware

- **Workspace**: fuel-code
- **Device**: macbook-pro
- **Duration**: 47m
- **Cost**: $0.42
- **Date**: Feb 14, 2026 10:23 AM

## Summary
Refactored authentication middleware to replace session-based auth with JWT tokens...

## Transcript
[1] **Human**: Fix the auth bug in the login endpoint...
[2] **Assistant**: I'll investigate the auth flow...

## Git Activity
- `abc123` fix auth bug (+12 -3)
- `def456` add JWT validation tests (+45 -0)
```

**`--tag <tag>`**: Add a tag to the session via `PATCH /api/sessions/:id` with `{ tags: [...existingTags, newTag] }`. Print confirmation: `Tag "refactoring" added to session abc123`.

**`--reparse`**: Trigger reparse via `POST /api/sessions/:id/reparse`. Print: `Reparse triggered for session abc123. Current parse status: parsing`.

**Files to Create**
- `packages/cli/src/commands/session-detail.ts`
- `packages/cli/src/lib/transcript-renderer.ts` — transcript formatting logic (reused by TUI)
- `packages/cli/src/commands/__tests__/session-detail.test.ts`
- `packages/cli/src/lib/__tests__/transcript-renderer.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` — register command

**Tests**

`session-detail.test.ts`:
1. Default view: prints summary card with all fields.
2. `--transcript`: renders transcript with tool use tree.
3. `--events`: renders event timeline.
4. `--git`: renders git activity with file lists.
5. `--export json`: outputs valid JSON with all sub-resources.
6. `--export md`: outputs valid Markdown.
7. `--tag`: calls PATCH and prints confirmation.
8. `--reparse`: calls POST and prints status.
9. Session not found: prints "Session not found" with the ID.
10. Session with no transcript (detected/capturing lifecycle): shows "Transcript not yet available" instead of empty.
11. Session with no git activity: shows "No git activity" section.

`transcript-renderer.test.ts`:
1. Renders user message with text content.
2. Renders assistant message with text + tool uses as tree.
3. Tool use tree: uses ├─ for middle items, └─ for last item.
4. Read/Edit/Write tools: shows file path from input.
5. Bash tool: shows command, truncated to 80 chars.
6. Thinking blocks: dimmed, collapsed by default.
7. Handles messages with no content blocks gracefully.
8. Long transcripts: truncates with "N more messages" hint.

**Success Criteria**
1. `fuel-code session <id>` prints a formatted summary card by default.
2. `--transcript` renders the full parsed transcript with tool use tree formatting.
3. `--events` shows raw events in a timeline table.
4. `--git` shows git activity with commit details and file lists.
5. `--export json` outputs a complete JSON object (session + transcript + events + git).
6. `--export md` outputs a well-formatted Markdown document.
7. `--tag` adds a tag and confirms.
8. `--reparse` triggers reparse and shows status.
9. Unknown session ID returns a clear error.
10. Sessions in early lifecycle states (detected, capturing) show appropriate messages for missing data.
11. Transcript renderer is extracted as a reusable module for TUI reuse.
12. `--json` flag works with default view (outputs session detail as JSON).

---

### Task 5: `fuel-code timeline` Command

**Parallel Group: B**

**Description**

Implement the `fuel-code timeline` command — a unified activity feed showing sessions and events in chronological order, grouped by session. Calls the existing `GET /api/timeline` endpoint.

**Command File: `packages/cli/src/commands/timeline.ts`**

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';

export function registerTimelineCommand(program: Command): void {
  program
    .command('timeline')
    .description('Unified activity feed across all workspaces')
    .option('--workspace <name>', 'Filter by workspace')
    .option('--today', 'Today\'s activity (default)')
    .option('--week', 'This week\'s activity')
    .option('--after <date>', 'Activity after date (ISO-8601 or relative: -1d, -7d)')
    .option('--before <date>', 'Activity before date')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      // 1. Default range: today (start of day local time → now)
      //    --week: start of this week (Monday) → now
      //    --after/-before: explicit range
      //
      // 2. Resolve --workspace if provided (same logic as sessions command)
      //
      // 3. Call api.getTimeline(params)
      //
      // 4. Render timeline
    });
}
```

**Timeline output format** (session-grouped, as specified in CORE.md):
```
Timeline: Today (Feb 14, 2026)

10:23  ┌─ SESSION  fuel-code · macbook-pro · 47m · $0.42
       │  Refactored authentication middleware to use JWT tokens
10:35  │  ● git.commit  abc123 "fix auth bug" (+12 -3)
10:41  │  ● git.commit  def456 "add JWT tests" (+45 -0)
11:10  └─ SESSION END

11:30  ┌─ SESSION  api-service · remote-abc · 1h22m · $1.87
       │  Implemented cursor-based pagination for all list endpoints
11:45  │  ● git.commit  7890ab "feat: cursor pagination" (+89 -12)
12:15  │  ● git.push  main → origin (3 commits)
12:52  └─ SESSION END

13:05  ● git.push  fuel-code · macbook-pro · main → origin (2 commits)
       (outside session)

Today: 2 sessions · 2h9m · $2.29 · 5 commits · 1 push
```

Rendering logic:
1. The timeline API returns session-grouped data. Each group has a session (or null for orphan events) and highlight events within.
2. Sessions render as a box (┌─ ... └─) with summary, duration, cost.
3. Events within sessions render as indented bullet points with timestamp, type, and key payload data.
4. Orphan events (outside sessions) render as standalone bullet points with "(outside session)" annotation.
5. Footer summarizes the day: session count, total duration, total cost, commit count, push count.
6. `--week` view groups by day with day headers.

**Relative date parsing**: `--after -1d` means 1 day ago. `--after -7d` means 7 days ago. Parse with simple regex: `/^-(\d+)([dhm])$/` → subtract N days/hours/minutes from now.

**Files to Create**
- `packages/cli/src/commands/timeline.ts`
- `packages/cli/src/commands/__tests__/timeline.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` — register command

**Tests**

`timeline.test.ts`:
1. Default (no flags): requests today's timeline (after=start-of-today).
2. `--week`: requests from start of week.
3. `--after -3d`: parses relative date correctly.
4. `--workspace fuel-code`: resolves and filters.
5. Renders session groups with box drawing characters.
6. Renders events within sessions with proper indentation.
7. Renders orphan events with "(outside session)" label.
8. Renders day headers for multi-day view (--week).
9. Footer stats are accurate.
10. `--json`: outputs raw timeline JSON.
11. Empty timeline: prints "No activity found" with date range.

**Success Criteria**
1. `fuel-code timeline` shows today's activity by default.
2. `--week` shows this week's activity grouped by day.
3. `--after` and `--before` accept ISO-8601 dates and relative formats (-1d, -7d).
4. `--workspace` filters to a single workspace.
5. Sessions display as box-enclosed groups with summary and stats.
6. Events within sessions are indented and timestamped.
7. Orphan events (outside sessions) are clearly labeled.
8. Footer summarizes total sessions, duration, cost, commits, pushes.
9. `--json` outputs the raw API response.
10. Output uses box-drawing characters (┌─ │ └─) for visual structure.

---

### Task 6: `fuel-code workspaces` + `fuel-code workspace <name>` Commands

**Parallel Group: B**

**Description**

Implement two commands: `fuel-code workspaces` (list all workspaces) and `fuel-code workspace <name>` (workspace detail view). These call the endpoints built in Task 2.

**Command: `fuel-code workspaces`**

List all known workspaces with session counts, active status, and cost totals.

```
WORKSPACE              SESSIONS   ACTIVE   LAST ACTIVITY   TOTAL COST   TOTAL TIME
fuel-code              42         1        12m ago         $18.42       24h30m
api-service            15         0        2d ago          $8.91        12h15m
dotfiles               3          0        1w ago          $0.42        45m
_unassociated          8          0        3d ago          $1.20        2h10m
```

**Command: `fuel-code workspace <name>`**

Detailed view for a single workspace. Accepts display name or canonical ID.

```
Workspace: fuel-code
Canonical: github.com/user/fuel-code
Branch:    main
First seen: Jan 15, 2026
Sessions:  42 total (1 active)
Total time: 24h30m
Total cost: $18.42

Devices:
  macbook-pro (local)  — hooks: ✓ CC ✓ Git — last active: 12m ago
  remote-abc (remote)  — hooks: ✓ CC ✓ Git — last active: 2d ago (terminated)

Recent Sessions:
  STATUS    DEVICE        DURATION   COST    STARTED     SUMMARY
  ● LIVE    macbook-pro   12m        $0.18   12m ago     Redesigning the event pipeline
  ✓ DONE    macbook-pro   47m        $0.42   2h ago      Refactored auth middleware
  ✓ DONE    remote-abc    1h22m      $1.87   3h ago      Cursor-based pagination

Recent Git Activity:
  ● abc123  fix auth bug              2h ago    +12 -3    macbook-pro
  ● def456  add JWT tests             2h ago    +45 -0    macbook-pro
  ● 7890ab  cursor pagination         3h ago    +89 -12   remote-abc
```

**Name resolution**: The `<name>` argument can be:
1. A canonical ID (contains `/`): query by canonical_id directly.
2. A display name: call `GET /api/workspaces`, find match (case-insensitive). If multiple partial matches, list them and ask user to be more specific.
3. A workspace ULID: try by ID first.

Strategy: Call `GET /api/workspaces/:name` where the server (Task 2) accepts both ULID and canonical_id. If 404, fall back to display name search via `GET /api/workspaces` and fuzzy match.

**Files to Create**
- `packages/cli/src/commands/workspaces.ts` — both commands in one file
- `packages/cli/src/commands/__tests__/workspaces.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` — register both commands

**Tests**

`workspaces.test.ts`:
1. `fuel-code workspaces`: lists all workspaces in table format.
2. Workspaces sorted by last activity (most recent first).
3. Active session count shown correctly.
4. `fuel-code workspace fuel-code`: shows detail by display name.
5. `fuel-code workspace github.com/user/repo`: shows detail by canonical ID.
6. `fuel-code workspace <ulid>`: shows detail by ULID.
7. Unknown workspace: prints "Workspace not found" with suggestions.
8. Workspace detail shows devices with hook status.
9. Workspace detail shows recent sessions table.
10. Workspace detail shows recent git activity.
11. `--json` flag works on both commands.

**Success Criteria**
1. `fuel-code workspaces` lists all workspaces with accurate stats.
2. Table includes session count, active count, last activity, total cost, total time.
3. `fuel-code workspace <name>` accepts display names, canonical IDs, and ULIDs.
4. Workspace detail shows device list with hook installation status.
5. Workspace detail shows recent sessions in table format.
6. Workspace detail shows recent git activity with commit details.
7. Unknown workspace produces helpful error with available workspace names.
8. `--json` outputs raw JSON for both commands.

---

### Task 7: `fuel-code status` Command

**Parallel Group: B**

**Description**

Implement the `fuel-code status` command — a quick overview of the system's current state. Shows active sessions, queue depth, backend connectivity, device info, and hook status. This is the "at a glance" command for verifying everything works.

**Command File: `packages/cli/src/commands/status.ts`**

```typescript
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Quick status: active sessions, queue depth, connectivity')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      // 1. Load local config for device info
      // 2. Check queue depth (count files in ~/.fuel-code/queue/)
      // 3. Check dead letter count (count files in ~/.fuel-code/dead-letter/)
      // 4. Try GET /api/health to check backend connectivity (with short 3s timeout)
      // 5. If backend reachable: GET /api/sessions?lifecycle=capturing to get active sessions
      // 6. Display status card
    });
}
```

**Output format**:
```
fuel-code status

Device:     macbook-pro (01JMF3...)
Backend:    ✓ Connected (https://fuel-code.up.railway.app)
Queue:      0 pending · 0 dead-letter

Active Sessions:
  ● fuel-code · macbook-pro · 12m · $0.18
    Redesigning the event pipeline

Hooks:
  CC hooks:  ✓ Installed (~/.claude/settings.json)
  Git hooks: ✓ Installed (core.hooksPath = ~/.fuel-code/git-hooks/)

Today: 4 sessions · 2h50m · $2.78 · 8 commits
```

**When backend is unreachable**:
```
fuel-code status

Device:     macbook-pro (01JMF3...)
Backend:    ✗ Unreachable (https://fuel-code.up.railway.app)
            Connection timed out. Events will queue locally.
Queue:      3 pending · 0 dead-letter

Hooks:
  CC hooks:  ✓ Installed
  Git hooks: ✓ Installed

(Cannot fetch session data — backend offline)
```

**When not initialized**:
```
fuel-code status

Device:     Not initialized
            Run `fuel-code init` to set up this device.
```

**Status checks** (in order, with graceful degradation):
1. **Config exists?** Read `~/.fuel-code/config.yaml`. If missing, show "Not initialized" and stop.
2. **Queue depth**: Count JSON files in `~/.fuel-code/queue/`. Count files in `~/.fuel-code/dead-letter/`.
3. **Backend reachable?** `GET /api/health` with 3-second timeout. Green check or red X.
4. **Active sessions** (only if backend reachable): `GET /api/sessions?lifecycle=capturing`.
5. **Today's stats** (only if backend reachable): `GET /api/sessions?after=<start-of-today>` → compute totals.
6. **Hook status**: Check if CC hooks are installed (parse `~/.claude/settings.json` for fuel-code references). Check git hooks (read `git config --global core.hooksPath`).

**Files to Create**
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/__tests__/status.test.ts`

**Files to Modify**
- `packages/cli/src/index.ts` — register command

**Tests**

`status.test.ts`:
1. Fully connected: shows device, backend connected, active sessions, today's stats, hook status.
2. Backend unreachable: shows red X, queue info, hooks, no session data.
3. Not initialized: shows "Not initialized" message and stops.
4. Queue with pending events: shows count.
5. Dead letter events: shows count with warning color.
6. No active sessions: shows "No active sessions" instead of empty list.
7. CC hooks not installed: shows red X for CC hooks.
8. Git hooks not installed: shows red X for git hooks.
9. `--json`: outputs structured JSON with all status fields.
10. Health check timeout does not block for more than 3 seconds.

**Success Criteria**
1. `fuel-code status` shows a complete status card with device, backend, queue, sessions, and hooks.
2. Backend connectivity check uses a short 3-second timeout.
3. Queue depth accurately counts files in the queue and dead-letter directories.
4. Active sessions are listed when backend is reachable.
5. Today's aggregate stats (sessions, duration, cost, commits) are shown.
6. Hook installation status is detected from the filesystem.
7. Graceful degradation: shows whatever info is available even if backend is offline.
8. "Not initialized" state is clearly shown when config is missing.
9. `--json` outputs all status data as structured JSON.
10. The command runs fast (3 seconds max even when backend is down).

---

### Task 8: WebSocket Server (Broadcast + Subscriptions)

**Parallel Group: C**

**Description**

Add WebSocket support to the Express server. Clients connect to `ws://<backend>/api/ws?token=<api_key>`, subscribe to scopes (all, workspace, session), and receive real-time event broadcasts. The event processor (from Phase 1) is modified to broadcast processed events to connected WebSocket clients.

**WebSocket Server: `packages/server/src/ws/`**

```typescript
// packages/server/src/ws/server.ts
// WebSocket server setup — attaches to the Express HTTP server

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { Server } from 'http';

export interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>;  // "all", "workspace:<id>", "session:<id>"
  lastPong: number;            // timestamp of last pong for keepalive
}

// Initialize WebSocket server on the existing HTTP server
// - Verifies auth token from query param on upgrade
// - Manages client subscriptions
// - Handles ping/pong keepalive
// - Provides broadcast() function for event processor to call
export function createWebSocketServer(httpServer: Server): WsBroadcaster;

export interface WsBroadcaster {
  // Broadcast an event to all clients subscribed to its scope
  broadcastEvent(event: ProcessedEvent): void;

  // Broadcast a session lifecycle update
  broadcastSessionUpdate(update: {
    session_id: string;
    workspace_id: string;
    lifecycle: string;
    summary?: string;
    stats?: SessionStats;
  }): void;

  // Get connected client count (for status/health)
  getClientCount(): number;

  // Graceful shutdown
  close(): Promise<void>;
}
```

**Connection lifecycle**:
1. Client connects to `/api/ws?token=<api_key>`.
2. Server validates token in the HTTP upgrade handler (same auth as REST).
3. On invalid token: respond with 401, close connection.
4. On valid token: add to client set, start keepalive timer.
5. Client sends subscribe/unsubscribe messages.
6. Server sends events matching client's subscriptions.
7. Server sends ping every 30 seconds. Client must respond with pong within 10 seconds or gets disconnected.
8. On disconnect: remove from client set, clean up subscriptions.

**Message handling: `packages/server/src/ws/messages.ts`**

```typescript
// Server → Client message types
export type ServerMessage =
  | { type: 'event'; event: Event }
  | { type: 'session.update'; session_id: string; workspace_id: string; lifecycle: string; summary?: string; stats?: SessionStats }
  | { type: 'remote.update'; remote_env_id: string; status: string; public_ip?: string }
  | { type: 'ping' }
  | { type: 'error'; message: string };

// Client → Server message types
export type ClientMessage =
  | { type: 'subscribe'; workspace_id?: string; session_id?: string; scope?: 'all' }
  | { type: 'unsubscribe'; workspace_id?: string; session_id?: string }
  | { type: 'pong' };

// Validate incoming client messages
export function parseClientMessage(raw: string): ClientMessage | null;
```

**Subscription matching**:
- Client subscribes to `scope: "all"` → receives all events.
- Client subscribes to `workspace_id: "abc"` → receives events where `workspace_id === "abc"`.
- Client subscribes to `session_id: "xyz"` → receives events where `session_id === "xyz"` (for live transcript view).
- A client can have multiple active subscriptions.
- Default (no subscriptions): receives nothing. The client must explicitly subscribe.

**Integration with event processor**:

Modify `packages/server/src/pipeline/consumer.ts` (or the appropriate handler dispatch point) to call `broadcaster.broadcastEvent(event)` after successful event processing. Modify session lifecycle transitions to call `broadcaster.broadcastSessionUpdate(...)` when lifecycle changes.

The broadcaster instance is created once at server startup and passed to the consumer/handlers via dependency injection (constructor parameter or module-level singleton).

**Keepalive**:
- Server sends `{ type: "ping" }` every 30 seconds.
- Client must respond with `{ type: "pong" }` within 10 seconds.
- If no pong received, server closes the connection with code 1001.
- This detects dead connections (e.g., client process crashed).

**Files to Create**
- `packages/server/src/ws/server.ts` — WebSocket server setup + client management
- `packages/server/src/ws/messages.ts` — message type definitions + validation
- `packages/server/src/ws/index.ts` — re-exports
- `packages/server/src/ws/__tests__/server.test.ts`
- `packages/server/src/ws/__tests__/messages.test.ts`

**Files to Modify**
- `packages/server/src/index.ts` — attach WS server to HTTP server
- `packages/server/src/pipeline/consumer.ts` (or equivalent) — add broadcast call after event processing
- `packages/server/package.json` — add `ws` dependency (if not already present)

**Tests**

`server.test.ts`:
1. Client connects with valid token → connection established.
2. Client connects with invalid token → 401, connection rejected.
3. Client connects without token → 401, connection rejected.
4. Client subscribes to `scope: "all"` → receives all broadcast events.
5. Client subscribes to `workspace_id` → receives only events for that workspace.
6. Client subscribes to `session_id` → receives only events for that session.
7. Client with no subscriptions → receives nothing.
8. Client unsubscribes → stops receiving matching events.
9. Multiple clients with different subscriptions → each receives only their events.
10. Ping/pong keepalive: server sends ping, client responds with pong, connection stays alive.
11. No pong response within 10 seconds → server disconnects client.
12. `broadcastSessionUpdate()` sends to clients subscribed to the session's workspace.
13. `getClientCount()` returns correct count.
14. Graceful shutdown: `close()` disconnects all clients.
15. Invalid client message → server sends `{ type: "error", message: "..." }`.
16. Client sends valid JSON but unknown type → ignored gracefully.

`messages.test.ts`:
1. `parseClientMessage` parses valid subscribe with workspace_id.
2. `parseClientMessage` parses valid subscribe with session_id.
3. `parseClientMessage` parses valid subscribe with scope "all".
4. `parseClientMessage` parses valid unsubscribe.
5. `parseClientMessage` parses valid pong.
6. `parseClientMessage` returns null for invalid JSON.
7. `parseClientMessage` returns null for unknown type.

Test approach: Use the `ws` library's client in tests to connect to the test server.

**Success Criteria**
1. WebSocket server attaches to the existing Express HTTP server (no separate port).
2. Authentication via `token` query parameter, same validation as REST API.
3. Clients can subscribe to "all", a specific workspace, or a specific session.
4. Events are broadcast only to clients whose subscriptions match.
5. Session lifecycle updates are broadcast when lifecycle state changes.
6. Ping/pong keepalive detects and disconnects dead clients.
7. Invalid messages produce error responses, not crashes.
8. `getClientCount()` works for health endpoint enhancement.
9. `close()` gracefully shuts down all connections.
10. Event processor calls `broadcastEvent()` after processing each event.
11. Session manager calls `broadcastSessionUpdate()` on lifecycle transitions.
12. Multiple concurrent clients work correctly with independent subscriptions.

---

### Task 9: WebSocket Client + CLI Live Mode

**Parallel Group: D**

**Description**

Create the WebSocket client library for the CLI (`packages/cli/src/lib/ws-client.ts`) and wire it into the `--live` flag on `fuel-code sessions`. The WS client connects to the backend, subscribes to events, and emits typed events that CLI commands and TUI components can consume.

**WebSocket Client: `packages/cli/src/lib/ws-client.ts`**

```typescript
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { loadConfig } from './config';

// Typed events emitted by the WS client
export interface WsClientEvents {
  'event': (event: Event) => void;
  'session.update': (update: SessionUpdate) => void;
  'remote.update': (update: RemoteUpdate) => void;
  'connected': () => void;
  'disconnected': (reason: string) => void;
  'error': (error: Error) => void;
}

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: Timer | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private subscriptions: Set<string> = new Set();

  constructor(opts?: {
    baseUrl?: string;     // override config (ws:// or wss://)
    apiKey?: string;      // override config
    autoReconnect?: boolean;  // default true
    maxReconnectAttempts?: number;  // default 10
  });

  // Connect to the WebSocket server
  // Converts HTTP base URL to WS URL automatically:
  //   https://foo.com → wss://foo.com/api/ws?token=...
  //   http://localhost:3000 → ws://localhost:3000/api/ws?token=...
  async connect(): Promise<void>;

  // Subscribe to a scope
  subscribe(opts: { scope?: 'all'; workspace_id?: string; session_id?: string }): void;

  // Unsubscribe
  unsubscribe(opts: { workspace_id?: string; session_id?: string }): void;

  // Graceful disconnect
  disconnect(): void;

  // Is connected?
  get connected(): boolean;
}
```

**Auto-reconnect logic**:
1. On unexpected disconnect: wait `min(1000 * 2^attempt, 30000)` ms, then reconnect.
2. On reconnect: re-send all active subscriptions.
3. After `maxReconnectAttempts`: emit `disconnected` with reason, stop retrying.
4. On explicit `disconnect()`: do not reconnect.

**Pong handling**: When server sends `{ type: "ping" }`, client automatically responds with `{ type: "pong" }`.

**Live mode for `fuel-code sessions --live`**:

Modify `packages/cli/src/commands/sessions.ts` to handle the `--live` flag:
1. First, fetch and display current sessions (same as without `--live`).
2. Then connect WS client, subscribe to `scope: "all"` (or workspace if `--workspace` is set).
3. On `session.update` event: update the displayed session in-place (re-render the line).
4. On new `event` of type `session.start`: add new row at the top.
5. On `event` of type `session.end`: update status from LIVE to DONE.
6. Use ANSI escape codes to update lines in place (cursor movement).
7. On Ctrl-C: disconnect WS, exit cleanly.

For the live mode terminal rendering:
- Clear screen and redraw the full table on each update (simpler than in-place updates).
- Show a status bar at the bottom: `Live ● Connected | Last update: 3s ago | Ctrl-C to exit`
- If WS disconnects: show `Live ○ Disconnected (reconnecting...)` in status bar.

**Files to Create**
- `packages/cli/src/lib/ws-client.ts`
- `packages/cli/src/lib/__tests__/ws-client.test.ts`

**Files to Modify**
- `packages/cli/src/commands/sessions.ts` — add `--live` implementation
- `packages/cli/package.json` — add `ws` dependency

**Tests**

`ws-client.test.ts`:
1. Connects to WS server with correct URL and token.
2. HTTP→WS URL conversion: `https://` → `wss://`, `http://` → `ws://`.
3. `subscribe()` sends subscribe message to server.
4. `unsubscribe()` sends unsubscribe message.
5. Receives and emits `event` messages.
6. Receives and emits `session.update` messages.
7. Responds to server `ping` with `pong`.
8. Auto-reconnects on unexpected disconnect.
9. Re-sends subscriptions after reconnect.
10. Stops reconnecting after max attempts.
11. `disconnect()` closes connection and does not reconnect.
12. `connected` property reflects actual state.
13. `connected` event emitted on successful connection.
14. `disconnected` event emitted with reason.
15. `error` event emitted on connection errors.
16. Invalid server messages are ignored (no crash).

Test approach: Create a local `ws.Server` in the test, connect the client to it, and verify message exchange. Use `setTimeout` / `Bun.sleep` for timing-dependent tests (reconnect).

**Success Criteria**
1. `WsClient` connects to the backend WebSocket endpoint.
2. URL conversion (HTTP→WS) is automatic from config.
3. Auth token is sent as query parameter.
4. `subscribe()` and `unsubscribe()` send proper messages.
5. Incoming events are parsed and emitted as typed events.
6. Ping/pong keepalive is handled automatically.
7. Auto-reconnect works with exponential backoff.
8. Subscriptions are re-established after reconnect.
9. `disconnect()` is clean (no reconnect, no lingering timers).
10. `fuel-code sessions --live` shows a live-updating table.
11. Live mode updates when sessions start, end, or update.
12. Live mode shows connection status in a status bar.
13. Ctrl-C exits live mode cleanly.

---

### Task 10: TUI Shell + Dashboard View

**Parallel Group: E**

**Description**

Build the Ink-based TUI that launches when the user runs `fuel-code` with no arguments (or `fuel-code tui`). The TUI shell manages view switching, keyboard input, and the WebSocket connection. The dashboard view shows sessions grouped by workspace (left sidebar: workspace list, right panel: session list for selected workspace) with live updates. This matches the "Main View: Sessions by Workspace" mockup from CORE.md.

**TUI Entry Point**

Modify `packages/cli/src/index.ts`: when commander receives no command (default action), launch the TUI:

```typescript
program.action(async () => {
  // No command specified → launch TUI
  const { launchTui } = await import('./tui/app');
  await launchTui();
});
```

**TUI App Shell: `packages/cli/src/tui/app.tsx`**

```tsx
import React, { useState, useEffect } from 'react';
import { render, useInput, useApp } from 'ink';
import { ApiClient } from '../lib/api-client';
import { WsClient } from '../lib/ws-client';
import { Dashboard } from './Dashboard';
import { SessionDetail } from './SessionDetail';

// Top-level TUI app component
// Manages: current view, API client, WS client, keyboard routing

type View =
  | { type: 'dashboard' }
  | { type: 'session-detail'; sessionId: string };

export function App() {
  const [view, setView] = useState<View>({ type: 'dashboard' });
  const [apiClient] = useState(() => new ApiClient());
  const [wsClient] = useState(() => new WsClient({ autoReconnect: true }));
  const { exit } = useApp();

  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    wsClient.connect().catch(() => {});
    wsClient.subscribe({ scope: 'all' });
    return () => wsClient.disconnect();
  }, []);

  // Global key bindings
  useInput((input, key) => {
    if (input === 'q') exit();
    if (input === 'b' && view.type !== 'dashboard') setView({ type: 'dashboard' });
  });

  // Render current view
  if (view.type === 'dashboard') {
    return <Dashboard
      apiClient={apiClient}
      wsClient={wsClient}
      onSelectSession={(id) => setView({ type: 'session-detail', sessionId: id })}
    />;
  }
  if (view.type === 'session-detail') {
    return <SessionDetail
      apiClient={apiClient}
      wsClient={wsClient}
      sessionId={view.sessionId}
      onBack={() => setView({ type: 'dashboard' })}
    />;
  }
}

export async function launchTui() {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
```

**Dashboard View: `packages/cli/src/tui/Dashboard.tsx`**

Layout matches CORE.md mockup:
- Left column (30% width): Workspace list. Each workspace shows name and session count. Selected workspace highlighted. Arrow keys to navigate.
- Right column (70% width): Session list for selected workspace. Each session shows: status badge, device name, duration, cost, commit count, summary line, (if summarized) notable commits.
- Bottom bar: Today's aggregate stats + queue status + WS connection status + key hints.

```tsx
// Dashboard state:
// - workspaces: WorkspaceListItem[] (fetched from API)
// - sessions: Session[] (fetched for selected workspace)
// - selectedWorkspaceIndex: number
// - selectedSessionIndex: number
// - wsConnected: boolean

// Key bindings:
// j/↓: move selection down
// k/↑: move selection up
// Tab: switch focus between workspace list and session list
// Enter: open selected session in detail view
// r: refresh data
// f: toggle filter panel (future, stub for now)
// /: search (future, stub for now)
// q: quit

// Live updates (via WsClient):
// - On 'session.update': find session in list, update its lifecycle/summary/stats
// - On 'event' of type 'session.start': prepend new session to list if it matches selected workspace
// - On 'event' of type 'session.end': update session status
// Debounce re-renders to max 2 per second to avoid flicker
```

**Shared TUI Components: `packages/cli/src/tui/components/`**

```
packages/cli/src/tui/components/
├── StatusBar.tsx      — bottom bar: stats, connection, key hints
├── SessionRow.tsx     — single session row in dashboard
├── WorkspaceItem.tsx  — single workspace item in sidebar
├── Spinner.tsx        — loading indicator
└── ErrorBanner.tsx    — error display (network error, auth error)
```

`StatusBar.tsx`:
```
Today: 4 sessions · 2h50m · $2.78 · 8 commits  |  Queue: 0  |  WS: ● Connected
j/k:navigate  enter:detail  r:refresh  q:quit
```

`SessionRow.tsx`: Renders one session with status badge, device, duration, cost, summary. Live sessions get green LIVE badge. Active (capturing) sessions show a spinner and elapsed time that updates every second.

**Polling fallback**: If WS connection fails, the dashboard falls back to polling via API every 10 seconds. The status bar shows `WS: ○ Polling (10s)` instead of `WS: ● Connected`.

**Files to Create**
- `packages/cli/src/tui/app.tsx`
- `packages/cli/src/tui/Dashboard.tsx`
- `packages/cli/src/tui/components/StatusBar.tsx`
- `packages/cli/src/tui/components/SessionRow.tsx`
- `packages/cli/src/tui/components/WorkspaceItem.tsx`
- `packages/cli/src/tui/components/Spinner.tsx`
- `packages/cli/src/tui/components/ErrorBanner.tsx`
- `packages/cli/src/tui/__tests__/Dashboard.test.tsx`
- `packages/cli/src/tui/__tests__/components.test.tsx`

**Files to Modify**
- `packages/cli/src/index.ts` — wire default action to TUI launch
- `packages/cli/package.json` — add `ink` and `react` dependencies
- `packages/cli/tsconfig.json` — ensure JSX support (`"jsx": "react-jsx"`)

**Dependencies to add**:
```bash
cd packages/cli && bun add ink react ink-text-input
cd packages/cli && bun add -d @types/react ink-testing-library
```

**Tests**

`Dashboard.test.tsx` (using `ink-testing-library`):
1. Renders workspace list on mount (fetches from API).
2. Renders sessions for first workspace by default.
3. j/k keys navigate workspace list (highlight moves).
4. Enter on session switches to session detail view.
5. Tab switches focus between workspace list and session list.
6. WS session.update event updates session in list.
7. WS session.start event adds new session to list.
8. Status bar shows today's stats.
9. Status bar shows WS connection status.
10. Loading state: shows spinner while fetching.
11. Error state: shows error banner on API failure.
12. r key refreshes data.
13. q key exits the app.

`components.test.tsx`:
1. `SessionRow` renders correct status badge for each lifecycle state.
2. `SessionRow` shows spinner for live sessions.
3. `WorkspaceItem` shows name and session count.
4. `WorkspaceItem` highlights when selected.
5. `StatusBar` shows stats and key hints.
6. `Spinner` renders animated dots.
7. `ErrorBanner` displays error message in red.

**Success Criteria**
1. `fuel-code` (no args) launches the TUI dashboard.
2. Dashboard shows workspace list in left sidebar with session counts.
3. Dashboard shows session list for selected workspace in right panel.
4. Arrow keys (j/k) navigate workspace and session lists.
5. Tab switches focus between workspace and session lists.
6. Enter on a session opens session detail view (Task 11).
7. Live updates via WebSocket: new sessions appear, status changes reflect immediately.
8. Polling fallback when WebSocket is unavailable.
9. Status bar shows today's aggregate stats.
10. Status bar shows WebSocket connection status.
11. Status bar shows keyboard shortcuts.
12. q exits the TUI cleanly.
13. Loading and error states are handled gracefully.
14. TUI matches the mockup from CORE.md (layout, content, key bindings).
15. Active sessions show live elapsed time.

---

### Task 11: TUI Session Detail View

**Parallel Group: E**

**Description**

Build the TUI session detail view — shown when the user presses Enter on a session in the dashboard. Layout matches the "Session Detail View" mockup from CORE.md: header with session metadata, left panel with transcript, right sidebar with git activity/tools/files. Supports scrolling, tab switching between transcript/events/git views, and live updates for active sessions.

**Session Detail View: `packages/cli/src/tui/SessionDetail.tsx`**

Layout:
```
┌─ Header ────────────────────────────────────────────────────────────────┐
│  Workspace: fuel-code     Device: macbook-pro (local)                   │
│  Started: 47m ago         Duration: 47m         Cost: $0.42             │
│  Tokens: 125K in / 48K out / 890K cache                                │
│  Summary: Refactored authentication middleware to use JWT tokens...     │
├─ Main ──────────────────────────┬─ Sidebar ─────────────────────────────┤
│  TRANSCRIPT                     │  Git Activity:                        │
│                                 │  ● abc123 refactor: JWT auth          │
│  [1] Human:                     │  ● def456 test: JWT validation        │
│    Fix the auth bug in login... │                                       │
│                                 │  Tools Used:                          │
│  [2] Assistant:                 │  Edit     12                          │
│    I'll investigate the auth... │  Read     15                          │
│    ├ Read: src/auth/middleware  │  Bash      8                          │
│    ├ Read: src/auth/jwt.ts     │  Grep      4                          │
│    ├ Edit: src/auth/middleware  │  Write     3                          │
│    └ Bash: bun test            │                                       │
│                                 │  Files Modified:                      │
│  [3] Human:                     │  src/auth/middleware.ts                │
│    Now add tests for the JWT... │  src/auth/jwt.ts                      │
│                                 │  src/auth/__tests__/jwt.test.ts       │
├─ Footer ────────────────────────┴───────────────────────────────────────┤
│  b:back  t:toggle-transcript  g:git  e:events  x:export  q:quit        │
└─────────────────────────────────────────────────────────────────────────┘
```

**Component structure**:

```tsx
interface SessionDetailProps {
  apiClient: ApiClient;
  wsClient: WsClient;
  sessionId: string;
  onBack: () => void;
}

export function SessionDetail({ apiClient, wsClient, sessionId, onBack }: SessionDetailProps) {
  // State:
  // - session: Session | null (fetched)
  // - transcript: TranscriptMessage[] | null (fetched on demand)
  // - events: Event[] | null (fetched on demand)
  // - gitActivity: GitActivity[] | null (fetched on demand)
  // - activeTab: 'transcript' | 'events' | 'git'
  // - scrollOffset: number (for transcript scrolling)
  // - loading: boolean

  // Key bindings:
  // b/Escape: go back to dashboard
  // t: switch to transcript tab
  // g: switch to git tab
  // e: switch to events tab
  // x: export (show format prompt)
  // j/↓: scroll down
  // k/↑: scroll up
  // Space/PageDown: scroll page down
  // q: quit entire TUI
}
```

**Transcript panel rendering**:
- Uses the `transcript-renderer.ts` from Task 4, but adapted for Ink components (React elements instead of strings).
- Each message is a block: ordinal, role, content text, tool uses as tree.
- Scrollable: `j/k` moves by one message, `Space`/`PageDown` moves by visible height.
- Current scroll position shown: `[3/42]` in header.

**Sidebar rendering**:
- **Git Activity**: List of commits with short hash, message (truncated), relative time.
- **Tools Used**: Aggregated from content_blocks. Table of tool names and counts, sorted by count descending.
- **Files Modified**: Unique file paths from git activity file_lists. Sorted alphabetically.
- If no git activity: sidebar shows "No git activity in this session."

**Live updates for active sessions**:
- If session lifecycle is `capturing`: subscribe to `session_id` via WS client.
- On `session.update` event: update lifecycle, summary, stats in real-time.
- On `event` within session: could add to events tab (future: live transcript streaming).
- Show elapsed time counter in header (updates every second).

**Tab switching**:
- `t`: Transcript tab (default) — fetches transcript if not loaded.
- `e`: Events tab — fetches events if not loaded.
- `g`: Git tab — shows git activity in main panel (full width) instead of sidebar.
- Each tab fetches its data lazily on first switch.

**Files to Create**
- `packages/cli/src/tui/SessionDetail.tsx`
- `packages/cli/src/tui/components/TranscriptPanel.tsx` — scrollable transcript viewer
- `packages/cli/src/tui/components/GitSidebar.tsx` — git activity + tools + files sidebar
- `packages/cli/src/tui/components/SessionHeader.tsx` — metadata header
- `packages/cli/src/tui/__tests__/SessionDetail.test.tsx`

**Files to Modify**
- `packages/cli/src/lib/transcript-renderer.ts` (from Task 4) — extract shared data structures that both CLI string output and Ink components can use. The renderer should have a data layer (parse transcript into display-ready blocks) and a string layer (render blocks to text). The Ink component uses the data layer directly.

**Tests**

`SessionDetail.test.tsx` (using `ink-testing-library`):
1. Renders session header with metadata on mount.
2. Fetches and displays transcript by default (transcript tab).
3. `j`/`k` scrolls through transcript messages.
4. `t` key switches to transcript tab.
5. `e` key switches to events tab, fetches events lazily.
6. `g` key switches to git tab, shows git activity full-width.
7. `b` key calls onBack (returns to dashboard).
8. Sidebar shows git commits.
9. Sidebar shows tool usage counts.
10. Sidebar shows modified files.
11. Session with no transcript (lifecycle=detected): shows "Transcript not available" message.
12. Session with no git activity: sidebar shows "No git activity" message.
13. Live session (capturing): shows elapsed time counter.
14. Live session: WS updates refresh session metadata.
15. Loading state: shows spinner while fetching transcript.
16. `x` key triggers export (prints JSON to temp file and shows path, or copies to clipboard).

**Success Criteria**
1. Session detail view renders with correct layout (header, transcript, sidebar, footer).
2. Header shows all session metadata: workspace, device, duration, cost, tokens, summary.
3. Transcript panel renders messages with tool use trees.
4. Transcript is scrollable with j/k and Space/PageDown.
5. Sidebar shows git activity, tool usage counts, and modified files.
6. Tab switching (t/e/g) works with lazy data fetching.
7. Back button (b/Escape) returns to dashboard.
8. Live sessions show elapsed time and receive WS updates.
9. Empty states (no transcript, no git) show informative messages.
10. Layout matches the CORE.md mockup.
11. Export (x) outputs session data.
12. Scroll position indicator shows current position.

---

### Task 12: Phase 4 E2E Integration Tests

**Parallel Group: F**

**Description**

End-to-end tests that verify the complete Phase 4 user experience. These tests run against a real (test) server with a test database, verifying that CLI commands produce correct output and the TUI renders correctly.

**Test Strategy**:
- Start a test server (Express + Postgres + Redis + WS) in a test fixture.
- Seed test data: create workspaces, devices, sessions, events, transcript messages, git activity in Postgres.
- Run CLI commands via `Bun.spawn` and capture stdout.
- For TUI tests: use `ink-testing-library` with the full app component against the test server.

**Test File: `packages/cli/src/__tests__/e2e-phase4.test.ts`**

Tests organized by feature:

**Sessions command E2E**:
1. `fuel-code sessions` against seeded data → table output with correct rows.
2. `fuel-code sessions --workspace fuel-code` → only sessions for that workspace.
3. `fuel-code sessions --today` → only today's sessions.
4. `fuel-code sessions --json` → valid JSON matching DB records.
5. `fuel-code sessions` with no sessions → "No sessions found" message.

**Session detail E2E**:
6. `fuel-code session <id>` → summary card with correct stats.
7. `fuel-code session <id> --transcript` → parsed transcript with tool trees.
8. `fuel-code session <id> --git` → git activity during session.
9. `fuel-code session <id> --events` → raw events for session.
10. `fuel-code session <id> --export json` → complete JSON export.
11. `fuel-code session <id> --export md` → valid Markdown document.
12. `fuel-code session <id> --tag important` → tag added, confirmed.
13. `fuel-code session nonexistent` → "Session not found" error.

**Timeline E2E**:
14. `fuel-code timeline` → session-grouped output for today.
15. `fuel-code timeline --workspace fuel-code` → filtered timeline.
16. `fuel-code timeline --json` → valid JSON.

**Workspaces E2E**:
17. `fuel-code workspaces` → table with all workspaces.
18. `fuel-code workspace fuel-code` → workspace detail.
19. `fuel-code workspace github.com/user/repo` → workspace detail by canonical ID.
20. `fuel-code workspace nonexistent` → error with suggestions.

**Status E2E**:
21. `fuel-code status` → status card with device, backend, queue, sessions.
22. `fuel-code status --json` → structured JSON status.

**WebSocket E2E**:
23. WS client connects and receives session.update when session lifecycle changes.
24. WS client receives new event when event is ingested.
25. WS subscription filtering: workspace-scoped client only receives matching events.

**TUI E2E** (using ink-testing-library):
26. Dashboard renders workspace list and session list.
27. Navigation: j/k moves cursor, Enter opens detail, b goes back.
28. Live update: emit event via API → WS broadcast → dashboard updates.

**Files to Create**
- `packages/cli/src/__tests__/e2e-phase4.test.ts`
- `packages/cli/src/__tests__/fixtures/seed-phase4.ts` — test data seeding helper

**Files to Modify**
- None (test infrastructure from prior phases should be reusable)

**Success Criteria**
1. All CLI commands produce correct output against seeded test data.
2. All filter flags (--workspace, --today, --device, etc.) work correctly.
3. JSON output mode produces valid, parseable JSON for all commands.
4. Error cases (not found, auth failure, network error) produce user-friendly messages.
5. WebSocket integration: events flow from ingestion → broadcast → client.
6. TUI dashboard renders and responds to keyboard input.
7. TUI session detail renders transcript, git, and events.
8. Tests run in < 60 seconds total.
9. Tests are isolated (each test seeds its own data, no test ordering dependencies).
10. Test fixtures are reusable and well-documented.

---

## Dependencies Added in Phase 4

```bash
# CLI
cd packages/cli && bun add ink react picocolors ws
cd packages/cli && bun add -d @types/react ink-testing-library @types/ws

# Server
cd packages/server && bun add ws
cd packages/server && bun add -d @types/ws
```

## Summary Statistics

- **Total tasks**: 12
- **Parallel groups**: 6 (A through F)
- **Critical path length**: 5 stages (Tasks 1 → 3 → 9 → 10 → 12)
- **Server-side work**: 2 tasks (Task 2: workspace/device endpoints, Task 8: WebSocket server)
- **CLI commands**: 5 tasks (Tasks 3, 4, 5, 6, 7)
- **TUI views**: 2 tasks (Tasks 10, 11)
- **Infrastructure**: 2 tasks (Tasks 1, 9)
- **Verification**: 1 task (Task 12)
- **New files created**: ~30
- **Existing files modified**: ~6
