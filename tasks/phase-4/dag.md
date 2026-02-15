# Phase 4: CLI + TUI — Task Dependency DAG

## Overview

Phase 4 builds the primary user interface for fuel-code: CLI query commands and an interactive TUI dashboard with live updates. After Phase 4, users can list sessions, view timelines, inspect workspaces, check system status, and launch a rich terminal dashboard — all from the command line. WebSocket broadcasts enable real-time updates as sessions start, end, get parsed, and summarized.

**What Phase 4 delivers**:
- `fuel-code sessions` — list sessions with filters, pagination, and `--json` output
- `fuel-code session <id>` — session detail with `--transcript`, `--events`, `--git`, `--export`, `--tag`, `--reparse` flags
- `fuel-code timeline` — unified activity feed
- `fuel-code workspaces` / `fuel-code workspace <name>` — workspace listing and detail
- `fuel-code status` — enriched system status
- `fuel-code` (no args) — TUI dashboard: sessions by workspace, live updates, keyboard navigation
- TUI session detail view: transcript viewer, git sidebar, tool/file summaries

## Task List

| Task | Name | Group | Dependencies |
|------|------|-------|-------------|
| 1 | Server: Workspace + Device REST Endpoints | A | — |
| 2 | Server: WebSocket Server (Connection, Auth, Subscriptions, Broadcast) | A | — |
| 3 | CLI: API Client + Output Formatting Utilities | A | — |
| 4 | CLI: `fuel-code sessions` + `fuel-code timeline` Commands | B | 3 |
| 5 | CLI: `fuel-code session <id>` Command (Detail + All Flags) | B | 3 |
| 6 | CLI: `fuel-code workspaces` + `fuel-code workspace <name>` + `fuel-code status` Commands | B | 1, 3 |
| 7 | CLI: WebSocket Client Library | B | 2, 3 |
| 8 | TUI: Shell + Dashboard View (Sessions by Workspace, Live Updates) | C | 4, 6, 7 |
| 9 | TUI: Session Detail View (Transcript Viewer, Git Sidebar) | C | 5, 7 |
| 10 | Phase 4 E2E Integration Tests | D | 4, 5, 6, 8, 9 |

## Dependency Graph

```
Group A ─── Task 1: Workspace +    Task 2: WebSocket     Task 3: API client
            Device endpoints       server                + formatting
               │                      │                      │
               │                      │         ┌────────────┼────────────┐
               │                      │         │            │            │
               │                      │         ▼            ▼            │
               │                      │     Task 4       Task 5          │
               │                      │     sessions +   session <id>    │
               │                      │     timeline     detail          │
               │                      │         │            │            │
               │              ┌───────┘         │            │            │
               │              │                 │            │            │
               ▼              ▼                 │            │            │
Group B ─── Task 6         Task 7              │            │            │
            workspaces +   WS client           │            │            │
            status         library             │            │            │
               │              │                │            │            │
               │         ┌────┤────────────────┘            │            │
               │         │    │                             │            │
               ▼         ▼    ▼                             │            │
Group C ─── Task 8: TUI Dashboard                          │            │
               │    (sessions by workspace)                 │            │
               │                                            │            │
               │              ┌─────────────────────────────┘            │
               │              │    │                                     │
               │              ▼    ▼                                     │
               │         Task 9: TUI Session Detail                     │
               │              │    (transcript viewer)                   │
               │              │                                         │
               └──────────────┴─────────────────────────────────────────┘
                              │
                              ▼
Group D ─── Task 10: Phase 4 E2E Integration Tests
```

## Parallel Groups

- **A**: Tasks 1, 2, 3 (fully independent: server REST, server WS, CLI client libraries)
- **B**: Tasks 4, 5, 6, 7 (CLI commands + WS client; 4/5 need only Task 3; Task 6 also needs Task 1; Task 7 also needs Task 2)
- **C**: Tasks 8, 9 (TUI views; dashboard needs 4+6+7; detail needs 5+7)
- **D**: Task 10 (final verification)

## Critical Path

Task 3 → Task 4 → Task 8 → Task 10

(4 sequential stages. Parallel paths: Task 1 → Task 6 → Task 8, and Task 2 → Task 7 → Task 8)

## Dependency Edges (precise)

- Task 1 → Task 6 (workspace/device endpoints needed for workspace CLI commands)
- Task 2 → Task 7 (WS server needed for WS client to connect)
- Task 3 → Tasks 4, 5, 6, 7 (all CLI commands and WS client use the API client)
- Task 4 → Task 8 (dashboard reuses sessions/timeline data-fetching patterns)
- Task 5 → Task 9 (session detail TUI reuses session detail data-fetching)
- Task 6 → Task 8 (dashboard needs workspaces data for sidebar)
- Task 7 → Tasks 8, 9 (TUI uses WS client for live updates)
- Tasks 4, 5, 6, 8, 9 → Task 10 (E2E tests verify everything)

## Key Design Decisions

### 1. Single API Client, Not Per-Command Fetch
All CLI commands and TUI views share one `ApiClient` class (`packages/cli/src/lib/api-client.ts`). It handles auth headers, base URL from config, error mapping, pagination cursors, and typed responses. No raw `fetch()` calls outside this module.

### 2. CLI Output as Plain Text Tables (No Ink for Non-Interactive)
CLI query commands (`sessions`, `timeline`, `workspaces`, `status`) write directly to stdout using a simple table formatter with `picocolors` for color. No Ink dependency for non-interactive output. This keeps CLI output pipeable, scriptable, and fast. The TUI is a separate code path entered via `fuel-code` (no args).

### 3. Commands Export Data-Fetching Logic for TUI Reuse
Each CLI command is structured as:
1. **Data layer** (exported): fetch + transform functions returning typed data
2. **Presentation layer** (command handler): format data and print to stdout

The TUI imports the data layer directly, bypassing stdout formatting. This avoids duplicating fetch/transform logic.

### 4. `--json` Flag on All Query Commands
Every query command supports `--json` for machine-readable output. Trivial with the data/presentation split: just `JSON.stringify` the data layer output.

### 5. WebSocket as Additive Enhancement
All commands work without WebSocket. If the WS connection fails, the TUI falls back to API polling (10s interval). The `--live` flag on `sessions` and the TUI dashboard both use WS, but are not dependent on it.

### 6. WebSocket Server Hooks Into Event Processor
The WS server is called by the event processor after each event is handled. The `WsBroadcaster` interface is injected into the processor. No separate event flow — the existing Redis → Processor pipeline remains the single source of truth.

### 7. Workspace Resolution by Name
CLI commands accept display names (`fuel-code`, `api-service`) and resolve to IDs. The API client lists workspaces and does case-insensitive prefix matching. Ambiguous matches list candidates and exit 1.

### 8. TUI is Ink (React for Terminals)
The TUI uses `ink` with React components. State management via hooks + WS client event emitter. Two views: Dashboard (default) and SessionDetail (on enter). `q` exits, `b` goes back.

## What Already Exists (from Phases 1-3)

### Server (packages/server/)
- Express app with auth middleware, error handling, pino logging
- `POST /api/events/ingest` — batch event ingestion
- `GET /api/sessions` — list with cursor pagination, filtering (workspace, device, lifecycle, date range, tag)
- `GET /api/sessions/:id` — full detail with stats
- `GET /api/sessions/:id/transcript` — parsed messages + content blocks
- `GET /api/sessions/:id/transcript/raw` — S3 presigned URL redirect
- `GET /api/sessions/:id/events` — events within session
- `GET /api/sessions/:id/git` — git activity during session
- `PATCH /api/sessions/:id` — update tags, summary
- `POST /api/sessions/:id/reparse` — re-trigger parsing
- `POST /api/sessions/:id/transcript/upload` — transcript file upload
- `GET /api/timeline` — session-grouped activity feed
- `GET /api/health` — health check
- Redis Stream consumer + event processor + handler registry
- Postgres pool, migrations runner, S3 client
- `packages/server/src/ws/` directory exists (empty placeholder)

### CLI (packages/cli/)
- `fuel-code init`, `emit`, `hooks install/status`, `backfill`, `queue status/drain/dead-letter`
- Basic `fuel-code status` (device info, connectivity — Phase 4 enriches this)
- Config management (`~/.fuel-code/config.yaml`)
- Local event queue with drainer
- Commander entry point (`packages/cli/src/index.ts`)
- Error hierarchy (FuelCodeError subclasses), pino logger
- Ad-hoc fetch calls in emit/backfill (NOT a reusable API client)

### Shared (packages/shared/)
- All types: Event, Session, Workspace, Device, TranscriptMessage, ContentBlock, GitActivity
- All Zod schemas for event payloads + session query/patch schemas
- ULID generation, canonical ID normalization

### NOT yet built (Phase 4 creates)
- `GET /api/workspaces`, `GET /api/workspaces/:id`
- `GET /api/devices`, `GET /api/devices/:id`
- `WS /api/ws` — WebSocket server
- `packages/cli/src/lib/api-client.ts`
- `packages/cli/src/lib/ws-client.ts`
- `packages/cli/src/lib/formatters.ts`
- All CLI query commands (sessions, session detail, timeline, workspaces, status)
- All TUI components (`packages/cli/src/tui/`)

## Dependencies Added in Phase 4

```bash
# Server
cd packages/server && bun add ws
cd packages/server && bun add -d @types/ws

# CLI
cd packages/cli && bun add picocolors ws ink react
cd packages/cli && bun add -d @types/react @types/ws ink-testing-library
```
