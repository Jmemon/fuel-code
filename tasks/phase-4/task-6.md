# Task 6: CLI: `fuel-code workspaces` + `fuel-code workspace <name>` + `fuel-code status` Commands

## Parallel Group: B

**Dependencies**: Task 1 (Server: Workspace + Device REST Endpoints), Task 3 (API Client + Output Formatting Utilities)

## Description

Implement three commands: `fuel-code workspaces` (list all workspaces), `fuel-code workspace <name>` (workspace detail view), and an enriched `fuel-code status` (system overview with active sessions, queue depth, connectivity, and hook status). These commands depend on the workspace/device endpoints from Task 1 and the API client + formatters from Task 3.

The `status` command is a modification of the existing basic status command (which currently only shows device info and basic connectivity). This task enriches it significantly.

### `fuel-code workspaces` Command

**`packages/cli/src/commands/workspaces.ts`**:

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import {
  renderTable, formatDuration, formatCost, formatRelativeTime,
  outputResult, formatEmpty, formatError, colors
} from '../lib/formatters';

// ─── Data Layer (exported for TUI reuse) ───────────────────────────

// Fetches all workspaces with aggregated stats.
// Returns workspace summaries sorted by last activity (most recent first).
export async function fetchWorkspaces(
  api: ApiClient
): Promise<WorkspaceSummary[]>

// ─── Presentation Layer ────────────────────────────────────────────

// Formats workspace list as a table.
export function formatWorkspacesTable(workspaces: WorkspaceSummary[]): string

// Commander registration for both 'workspaces' and 'workspace' commands.
export function registerWorkspacesCommands(program: Command): void
```

**Flag definitions for `workspaces`**:

| Flag | Type | Default | Behavior |
|------|------|---------|----------|
| `--json` | boolean | false | Output raw JSON instead of formatted table. |

**Table output format**:

```
WORKSPACE          SESSIONS  ACTIVE  DEVICES  LAST ACTIVITY  TOTAL COST  TOTAL TIME
fuel-code          42        1       2        12m ago        $18.42      24h30m
api-service        15        0       1        2d ago         $8.91       12h15m
dotfiles           3         0       1        1w ago         $0.42       45m
_unassociated      8         0       1        3d ago         $1.20       2h10m
```

**Column definitions**:
- `WORKSPACE`: display_name (bold for workspace with active sessions)
- `SESSIONS`: total session count
- `ACTIVE`: count of sessions with `lifecycle = "capturing"` (green if > 0)
- `DEVICES`: distinct device count
- `LAST ACTIVITY`: relative time of most recent session (`formatRelativeTime()`)
- `TOTAL COST`: aggregate cost across all sessions (`formatCost()`)
- `TOTAL TIME`: aggregate duration across all sessions (`formatDuration()`)

**Empty state**:
```
No workspaces tracked yet.
Run 'fuel-code init' in a git repo, then start a Claude Code session to begin tracking.
```

---

### `fuel-code workspace <name>` Command

Accepts the workspace display name, canonical ID, or ULID as the `<name>` argument. Resolution logic:

1. If `<name>` is a ULID (26 alphanumeric chars): query by ID directly via `GET /api/workspaces/:id`.
2. If `<name>` contains `/` (looks like canonical ID): query by canonical ID via `GET /api/workspaces/:id`.
3. Otherwise: call `GET /api/workspaces`, find by case-insensitive prefix match on `display_name`. Exact match preferred over prefix match. If ambiguous, list candidates. If no match, list available workspaces.

This uses the same `resolveWorkspaceName()` helper from Task 4 (imported from `sessions.ts` or `resolvers.ts`).

**Data layer**:

```typescript
// Fetches workspace detail including recent sessions, git summary, and device list.
export async function fetchWorkspaceDetail(
  api: ApiClient,
  workspaceId: string
): Promise<WorkspaceDetail>
```

**Flag definitions for `workspace <name>`**:

| Flag | Type | Default | Behavior |
|------|------|---------|----------|
| `--json` | boolean | false | Output raw JSON. |

**Detail output format**:

```
Workspace: fuel-code
Canonical: github.com/user/fuel-code
Branch:    main
First seen: Jan 15, 2026
Sessions:  42 total (1 active)
Total time: 24h30m
Total cost: $18.42

Devices:
  macbook-pro (local)   — hooks: ✓ CC ✓ Git — last active: 12m ago
  remote-abc (remote)   — hooks: ✓ CC ✓ Git — last active: 2d ago (terminated)

Recent Sessions (last 5):
  STATUS   DEVICE        DURATION  COST    STARTED    SUMMARY
  ● LIVE   macbook-pro   12m       $0.18   12m ago    Redesigning the event pipeline
  ✓ DONE   macbook-pro   47m       $0.42   2h ago     Refactored auth middleware
  ✓ DONE   remote-abc    1h22m     $1.87   3h ago     Cursor-based pagination
  ✓ DONE   macbook-pro   35m       $0.28   5h ago     Fixed timezone handling
  ✓ DONE   macbook-pro   1h05m     $0.95   yesterday  Implemented event pipeline

Recent Git Activity (last 5):
  abc123  refactor: JWT auth middleware       macbook-pro   2h ago    +12 -3
  def456  test: JWT validation tests          macbook-pro   2h ago    +45 -0
  7890ab  feat: cursor-based pagination       remote-abc    3h ago    +89 -12
  cdef01  fix: timezone offset handling       macbook-pro   5h ago    +8 -3
  234567  feat: event processor pipeline      macbook-pro   yesterday +156 -24
```

**Implementation details**:
- The header section uses `formatDetail()` for aligned key-value pairs.
- Devices section shows each device with type, hook status indicators (✓ or ✗ for CC hooks and Git hooks), and last active time.
- Recent sessions are limited to 5 (using the data from the workspace detail API response, which returns up to 10 -- we display 5 to keep the output manageable).
- Recent git activity limited to 5 commits. Shows hash prefix (6 chars), message (truncated), device, relative time, and diff stats.

**Not found / ambiguous error**:
- Not found: `Workspace "nonexistent" not found. Available workspaces: fuel-code, api-service, dotfiles`
- Ambiguous: `Ambiguous workspace name "fu". Did you mean: fuel-code, fun-project?`

---

### `fuel-code status` Command (Enriched)

**Modify `packages/cli/src/commands/status.ts`**:

The existing basic `status` command shows device info and basic connectivity. This task enriches it to show a comprehensive system overview.

```typescript
import { Command } from 'commander';
import { ApiClient, ApiConnectionError } from '../lib/api-client';
import { loadConfig, FuelCodeConfig } from '../lib/config';
import { getQueueDepth, getDeadLetterCount } from '../lib/queue';
import {
  formatDetail, formatDuration, formatCost, formatRelativeTime,
  formatLifecycle, outputResult, formatError, colors
} from '../lib/formatters';

// ─── Data Layer (exported for TUI reuse) ───────────────────────────

// Aggregates all status data from multiple sources.
// Handles partial failures gracefully (backend down → local-only data).
export async function fetchStatus(
  api: ApiClient,
  config: FuelCodeConfig
): Promise<StatusData>

export interface StatusData {
  device: {
    id: string;
    name: string;
    type: string;
  };
  backend: {
    url: string;
    status: 'connected' | 'unreachable';
    latencyMs?: number;           // health check round-trip time
    health?: HealthResponse;      // from GET /api/health if reachable
  };
  activeSessions: SessionSummary[];  // lifecycle = capturing (empty if backend unreachable)
  queue: {
    pending: number;              // count of .json files in queue dir
    deadLetter: number;           // count of files in dead-letter dir
  };
  recentSessions: SessionSummary[];  // last 3 sessions (empty if backend unreachable)
  hooks: {
    ccHooksInstalled: boolean;    // check ~/.claude/settings.json for fuel-code hooks
    gitHooksInstalled: boolean;   // check git config --global core.hooksPath
  };
  today?: {                       // null if backend unreachable
    sessionCount: number;
    totalDurationMs: number;
    totalCostUsd: number;
  };
}

// ─── Presentation Layer ────────────────────────────────────────────

// Formats the full status card for terminal output.
export function formatStatus(data: StatusData): string

// Commander registration
export function registerStatusCommand(program: Command): void
```

**Flag definitions for `status`**:

| Flag | Type | Default | Behavior |
|------|------|---------|----------|
| `--json` | boolean | false | Output raw JSON with all status data. |

**Full status output** (backend reachable):

```
fuel-code status

  Device:     macbook-pro (01jmf3...)
  Type:       local
  Backend:    ✓ Connected (https://fuel-code.up.railway.app) · 45ms
  Queue:      0 pending · 0 dead-letter

  Active Sessions:
    ● fuel-code · macbook-pro · 12m · $0.18
      Redesigning the event pipeline
    ● api-service · remote-abc · 3m · $0.04
      Load testing endpoints

  Recent Sessions:
    ✓ fuel-code · macbook-pro · 47m · $0.42 · 2h ago
    ✓ api-service · macbook-pro · 23m · $0.31 · 5h ago
    ✗ dotfiles · macbook-pro · 12m · $0.08 · yesterday

  Hooks:
    CC hooks:   ✓ Installed (~/.claude/settings.json)
    Git hooks:  ✓ Installed (core.hooksPath)

  Today: 4 sessions · 2h50m · $2.78
```

**Status output (backend unreachable)**:

```
fuel-code status

  Device:     macbook-pro (01jmf3...)
  Type:       local
  Backend:    ✗ Unreachable (https://fuel-code.up.railway.app)
              Connection timed out. Events will queue locally.
  Queue:      3 pending · 0 dead-letter

  Hooks:
    CC hooks:   ✓ Installed
    Git hooks:  ✓ Installed

  (Cannot fetch session data -- backend offline)
```

**Status output (not initialized)**:

```
fuel-code status

  Device:     Not initialized
              Run 'fuel-code init' to set up this device.
```

**Status check flow** (with graceful degradation):

1. **Config check**: Read `~/.fuel-code/config.yaml`. If missing, show "Not initialized" and stop.
2. **Device info**: Extract from config (`device.id`, `device.name`, `device.type`).
3. **Backend health check**: Call `GET /api/health` with a **3-second timeout**. Measure round-trip latency. If unreachable, set `backend.status = 'unreachable'` and skip all API-dependent checks. Do NOT exit 1 -- continue with local-only data.
4. **Active sessions** (backend reachable only): `GET /api/sessions?lifecycle=capturing&limit=10`. Show up to 5.
5. **Recent sessions** (backend reachable only): `GET /api/sessions?limit=3`. Show last 3.
6. **Queue depth**: Count `.json` files in `~/.fuel-code/queue/`. If directory missing, count is 0.
7. **Dead letter count**: Count files in `~/.fuel-code/dead-letter/`. If directory missing, count is 0.
8. **Hooks status**:
   - CC hooks: Check if `~/.claude/settings.json` exists and contains a reference to `fuel-code` in the hooks configuration. Parse JSON, look for fuel-code hook paths.
   - Git hooks: Check `git config --global core.hooksPath` output. If it points to `~/.fuel-code/git-hooks/` (or similar fuel-code path), hooks are installed.
9. **Today's summary** (backend reachable only): `GET /api/sessions?after=<start-of-today>&limit=250`. Compute aggregate: count, total duration, total cost.

**Performance**: The health check has a 3-second timeout. Active session and recent session queries run in parallel (Promise.all). Total command execution should take at most 4 seconds even with a slow backend.

**`--json` output structure**:

```json
{
  "device": { "id": "01jmf3...", "name": "macbook-pro", "type": "local" },
  "backend": {
    "url": "https://fuel-code.up.railway.app",
    "status": "connected",
    "latency_ms": 45,
    "health": { "status": "ok", "postgres": true, "redis": true, "version": "0.1.0" }
  },
  "active_sessions": [ ... ],
  "recent_sessions": [ ... ],
  "queue": { "pending": 0, "dead_letter": 0 },
  "hooks": { "cc_hooks_installed": true, "git_hooks_installed": true },
  "today": { "session_count": 4, "total_duration_ms": 10200000, "total_cost_usd": 2.78 }
}
```

---

### Commander Registration

**Modify `packages/cli/src/index.ts`**:

```typescript
import { registerWorkspacesCommands } from './commands/workspaces';
import { registerStatusCommand } from './commands/status';

registerWorkspacesCommands(program);  // registers both 'workspaces' and 'workspace <name>'
registerStatusCommand(program);       // replaces/enriches existing status registration
```

Note: If a basic `status` command already exists in `index.ts`, replace its registration with the enriched version. The enriched version is a superset.

## Relevant Files

- `packages/cli/src/commands/workspaces.ts` (create -- both `workspaces` and `workspace <name>` commands)
- `packages/cli/src/commands/status.ts` (modify -- enrich existing basic status command)
- `packages/cli/src/index.ts` (modify -- register workspaces commands, update status registration)
- `packages/cli/src/commands/__tests__/workspaces.test.ts` (create)
- `packages/cli/src/commands/__tests__/status.test.ts` (create)

## Tests

### `packages/cli/src/commands/__tests__/workspaces.test.ts`

Test approach: Mock `ApiClient` with `Bun.serve()` local HTTP server. Capture stdout for assertions.

1. **`fuel-code workspaces` default**: lists all workspaces in table format with correct columns.
2. **Workspaces sorted by last activity**: most recently active workspace appears first.
3. **Active session count**: workspace with `lifecycle=capturing` sessions shows non-zero ACTIVE column (green).
4. **Workspace with zero sessions**: appears in list with 0 counts.
5. **`--json` flag**: outputs valid JSON array of workspace summaries.
6. **Empty state**: no workspaces returns "No workspaces tracked yet" message with init hint.
7. **`fuel-code workspace fuel-code`**: resolves display name, shows detail view with all sections.
8. **`fuel-code workspace github.com/user/repo`**: resolves by canonical ID.
9. **`fuel-code workspace <ulid>`**: resolves by ULID.
10. **Workspace detail -- header**: shows workspace name, canonical ID, branch, first seen, stats.
11. **Workspace detail -- devices**: shows device list with type, hook status indicators, and last active time.
12. **Workspace detail -- recent sessions**: shows last 5 sessions in mini-table format.
13. **Workspace detail -- git activity**: shows last 5 commits with hash, message, device, time, diff stats.
14. **Unknown workspace**: prints "not found" error listing available workspace names.
15. **Ambiguous workspace prefix**: prints "ambiguous" error with candidate names.
16. **Workspace detail `--json`**: outputs workspace detail as valid JSON.
17. **Network error**: prints user-friendly connection error message.

### `packages/cli/src/commands/__tests__/status.test.ts`

1. **Fully connected**: shows device info, green backend connected with latency, active sessions, recent sessions, hooks status, today's summary.
2. **Backend unreachable**: shows device info, red backend unreachable, queue info, hooks, "Cannot fetch session data" message. No crash, exit 0.
3. **Not initialized (no config)**: shows "Not initialized" message with init prompt.
4. **Active sessions present**: lists active sessions with workspace, device, duration, cost, summary.
5. **No active sessions**: shows "No active sessions" instead of empty list.
6. **Recent sessions**: shows last 3 sessions with lifecycle icon, workspace, device, duration, cost, time.
7. **Queue with pending events**: shows non-zero pending count.
8. **Queue with dead letter events**: shows non-zero dead-letter count (with warning color).
9. **Queue directory missing**: shows 0 pending, 0 dead-letter (no crash).
10. **CC hooks installed**: shows green check for CC hooks.
11. **CC hooks not installed**: shows red X for CC hooks.
12. **Git hooks installed**: shows green check for Git hooks.
13. **Git hooks not installed**: shows red X for Git hooks.
14. **Today's summary**: shows session count, total duration, total cost.
15. **`--json`**: outputs valid JSON with all status fields.
16. **Health check latency**: backend section shows round-trip latency in milliseconds.
17. **Status command completes within 4 seconds**: even when backend is slow (3s timeout).

## Success Criteria

1. `fuel-code workspaces` lists all workspaces in a formatted table with session count, active count, device count, last activity, total cost, and total time.
2. Table is sorted by last activity (most recent first).
3. Workspaces with active sessions are visually highlighted (bold name, green active count).
4. Empty state shows helpful message with init instructions.
5. `fuel-code workspace <name>` accepts display names, canonical IDs, and ULIDs.
6. Workspace name resolution uses case-insensitive prefix matching (exact match preferred).
7. Workspace detail view shows: header with metadata and stats, device list with hook status, recent sessions (5), and recent git activity (5).
8. Devices in workspace detail show hook installation status with ✓/✗ indicators.
9. Not-found and ambiguous workspace names produce helpful error messages listing candidates.
10. `fuel-code status` shows device info, backend connectivity (with latency), active sessions, recent sessions, queue depth, hook status, and today's summary.
11. Status command uses a 3-second timeout for the backend health check.
12. Status command degrades gracefully when backend is unreachable -- shows local-only data without crashing.
13. Status command detects CC hook installation by checking `~/.claude/settings.json`.
14. Status command detects git hook installation by checking `git config --global core.hooksPath`.
15. Queue depth is computed by counting files in the queue directory.
16. "Not initialized" state is clearly shown when config file is missing.
17. All three commands support `--json` flag for machine-readable output.
18. All commands are registered in `packages/cli/src/index.ts` and appear in `fuel-code --help`.
19. Data-fetching functions (`fetchWorkspaces`, `fetchWorkspaceDetail`, `fetchStatus`) are exported for TUI reuse.
20. Active sessions in status are capped at 5 with "and N more" indicator if more exist.
21. All error states produce user-friendly messages.
22. All tests pass (`bun test`).
