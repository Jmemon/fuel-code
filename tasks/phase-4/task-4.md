# Task 4: CLI: `fuel-code sessions` + `fuel-code timeline` Commands

## Parallel Group: B

**Dependencies**: Task 3 (API Client + Output Formatting Utilities)

## Description

Implement two list-style CLI commands: `fuel-code sessions` (tabular session listing with filtering) and `fuel-code timeline` (session-grouped activity feed). Both commands follow the same architecture pattern established in Task 3: a data layer (exported functions for TUI reuse) and a presentation layer (stdout formatting). Both commands use `ApiClient` for data fetching and the shared formatters for output.

### `fuel-code sessions` Command

**`packages/cli/src/commands/sessions.ts`**:

```typescript
import { Command } from 'commander';
import { ApiClient, ApiError, ApiConnectionError } from '../lib/api-client';
import {
  renderTable, formatDuration, formatCost, formatRelativeTime,
  formatLifecycle, truncate, outputResult, formatEmpty, formatError, colors
} from '../lib/formatters';

// ─── Data Layer (exported for TUI reuse) ───────────────────────────

// Parameters accepted by the sessions data-fetching function.
// CLI flags are translated to this shape before calling fetchSessions().
export interface FetchSessionsParams {
  workspaceId?: string;    // resolved workspace ULID (not display name)
  deviceId?: string;       // resolved device ULID (not display name)
  lifecycle?: string;      // single lifecycle filter (e.g., "capturing")
  after?: string;          // ISO-8601 start bound
  before?: string;         // ISO-8601 end bound
  tag?: string;            // tag filter
  limit?: number;          // max results (default 20)
  cursor?: string;         // pagination cursor from previous response
}

// Fetches sessions from the API with the given params.
// Returns the raw paginated response for the presentation layer to format.
export async function fetchSessions(
  api: ApiClient,
  params: FetchSessionsParams
): Promise<{ sessions: SessionSummary[]; cursor: string | null; total: number }>

// ─── Workspace Resolution Helper ───────────────────────────────────

// Resolves a workspace display name or canonical ID to a workspace ULID.
// - If the value contains "/" → treat as canonical_id, pass directly to API
// - If the value is 26 alphanumeric chars → treat as ULID, pass directly
// - Otherwise → call api.listWorkspaces(), find by case-insensitive prefix match
// - Exact match takes priority over prefix match
// - If no match: throw with available workspace names
// - If ambiguous prefix: throw with candidate names
export async function resolveWorkspaceName(
  api: ApiClient,
  nameOrId: string
): Promise<string>   // returns workspace ULID

// ─── Device Resolution Helper ──────────────────────────────────────

// Same pattern as workspace resolution but for device names.
// - If 26 alphanumeric chars → treat as ULID
// - Otherwise → call api.listDevices(), find by case-insensitive prefix match on name
export async function resolveDeviceName(
  api: ApiClient,
  nameOrId: string
): Promise<string>   // returns device ULID

// ─── Presentation Layer ────────────────────────────────────────────

// Formats a sessions list as a terminal-width-aware table string.
// Columns: STATUS | ID | WORKSPACE | DEVICE | DURATION | COST | STARTED | SUMMARY
// STATUS uses formatLifecycle() for colored icons.
// ID is the first 8 chars of the session ULID, dimmed.
// WORKSPACE is the display_name.
// SUMMARY is truncated to fit remaining terminal width.
export function formatSessionsTable(sessions: SessionSummary[]): string

// Commander registration
export function registerSessionsCommand(program: Command): void
```

**Flag definitions** (registered on the commander command):

| Flag | Type | Default | Behavior |
|------|------|---------|----------|
| `--workspace <name>` | string | none | Filter by workspace display name, canonical ID, or ULID. Resolved via `resolveWorkspaceName()`. |
| `--device <name>` | string | none | Filter by device display name or ULID. Resolved via `resolveDeviceName()`. |
| `--today` | boolean | false | Sets `after` to start of today (local timezone midnight as ISO-8601). Mutually exclusive with `--after`. |
| `--live` | boolean | false | Sets `lifecycle` to `"capturing"`. Overrides `--lifecycle` if both provided. |
| `--lifecycle <state>` | string | none | Filter by lifecycle state (detecting, capturing, ended, parsed, summarized, failed). |
| `--tag <tag>` | string | none | Filter by tag. |
| `--limit <n>` | number | 20 | Max results per page. Passed to API. |
| `--cursor <cursor>` | string | none | Pagination cursor from previous response. |
| `--json` | boolean | false | Output raw JSON instead of formatted table. |

**Table output format**:

```
STATUS   ID        WORKSPACE        DEVICE        DURATION  COST    STARTED    SUMMARY
● LIVE   01jmf3a8  fuel-code        macbook-pro   12m       $0.18   12m ago    Redesigning the event pipeline
✓ DONE   01jmf2b4  fuel-code        macbook-pro   47m       $0.42   2h ago     Refactored auth middleware to use JWT
✓ DONE   01jmf1c9  api-service      remote-abc    1h22m     $1.87   3h ago     Implemented cursor-based pagination
✗ FAIL   01jmf0d2  dotfiles         macbook-pro   23m       $0.31   5h ago     (parse failed)

Showing 4 of 4 sessions
```

**Pagination footer**: When `cursor` is non-null in the response (more results available), append:
```
Showing 20 of 47 sessions. Use --limit or --cursor <cursor> for more.
```
Include the actual cursor value so the user can copy-paste it.

**Empty state**: When zero sessions returned:
```
No sessions found.
```
If filters were applied, append hint: `Try removing filters or expanding the date range.`

**Error messages**:
- `ApiConnectionError` → `Cannot connect to backend at <url>. Is it running?`
- `ApiError` (401) → `Invalid API key. Run 'fuel-code init' to reconfigure.`
- `ApiError` (other) → `Server error: <message> (HTTP <code>)`
- Workspace not found → `Workspace "<name>" not found. Available workspaces: <list>`
- Ambiguous workspace → `Ambiguous workspace name "<name>". Did you mean: <candidates>?`

**Color scheme** (using `picocolors`):
- Headers: bold
- Session ID: dim
- `● LIVE`: green
- `✓ DONE`: green (dimmer than LIVE)
- `✗ FAIL`: red
- `◌ PARSING` / `◐ ENDED`: yellow
- `○ DETECTED`: dim
- Cost: default (no color)
- Duration: default
- Summary: default, truncated with dim `...`

**Command handler flow** (the `action` callback):
1. Load config. If missing, print init prompt and exit 1.
2. Create `ApiClient` from config.
3. If `--workspace` provided, resolve to ULID via `resolveWorkspaceName()`.
4. If `--device` provided, resolve to ULID via `resolveDeviceName()`.
5. If `--today`, compute `after` as local midnight ISO-8601. If `--live`, set `lifecycle = "capturing"`.
6. Call `fetchSessions(api, params)`.
7. If `--json`, output `JSON.stringify(result, null, 2)` and exit.
8. If zero results, print empty state and exit.
9. Format table via `formatSessionsTable()`, print.
10. Print pagination footer.

---

### `fuel-code timeline` Command

**`packages/cli/src/commands/timeline.ts`**:

```typescript
import { Command } from 'commander';
import { ApiClient } from '../lib/api-client';
import {
  formatDuration, formatCost, formatRelativeTime, formatLifecycle,
  truncate, outputResult, formatEmpty, colors
} from '../lib/formatters';

// ─── Data Layer (exported for TUI reuse) ───────────────────────────

export interface FetchTimelineParams {
  workspaceId?: string;    // resolved workspace ULID
  after?: string;          // ISO-8601
  before?: string;         // ISO-8601
}

// Timeline API returns session-grouped activity data.
// Each entry is a session with embedded events, or an orphan event.
export async function fetchTimeline(
  api: ApiClient,
  params: FetchTimelineParams
): Promise<TimelineData>

// ─── Presentation Layer ────────────────────────────────────────────

// Renders the timeline as a structured text block.
// Groups entries by date when spanning multiple days.
// Sessions render as blocks with summary + embedded events.
// Orphan events render as standalone lines.
export function formatTimeline(data: TimelineData): string

// Commander registration
export function registerTimelineCommand(program: Command): void
```

**Flag definitions**:

| Flag | Type | Default | Behavior |
|------|------|---------|----------|
| `--workspace <name>` | string | none | Filter by workspace. Uses same `resolveWorkspaceName()` from sessions module. |
| `--today` | boolean | true (default behavior) | Today's activity (midnight to now). This is the implicit default. |
| `--week` | boolean | false | This week's activity (Monday 00:00 to now). Overrides `--today`. |
| `--after <date>` | string | none | Custom start date. Accepts ISO-8601 (`2026-02-10`) or relative (`-3d`, `-1w`). Overrides `--today`. |
| `--before <date>` | string | none | Custom end date. Accepts ISO-8601 or relative. |
| `--json` | boolean | false | Output raw JSON. |

**Relative date parsing**: Support `-Nd` (days), `-Nw` (weeks), `-Nh` (hours) via regex `/^-(\d+)([dwh])$/`. Convert to ISO-8601 by subtracting from `Date.now()`.

**Timeline output format** (session-grouped):

```
── Today, Feb 14 ──────────────────────────────────────────────

  14:30  ● fuel-code · macbook-pro                       12m  $0.18
         Redesigning the event pipeline
         Edit(3) Bash(2) Read(5)

  12:15  ✓ fuel-code · macbook-pro                       47m  $0.42
         Refactored auth middleware to use JWT
         ↑ abc123 refactor: JWT auth middleware
         ↑ def456 test: add JWT validation tests

  11:50  ↑ fuel-code · git push main → origin (3 commits)

  09:30  ✓ api-service · macbook-pro                     23m  $0.31
         Fixed timezone handling in event timestamps

── Yesterday, Feb 13 ──────────────────────────────────────────

  16:45  ✓ fuel-code · macbook-pro                       1h02m  $1.12
         Implemented event processor pipeline
         ↑ 7890ab feat: event processor pipeline

Today: 4 sessions · 2h50m · $2.78 · 8 commits
```

**Rendering logic**:
1. Group timeline entries by calendar date (local timezone).
2. For each date group, print a date header: `── Today, Feb 14 ──────...` (padded to terminal width with `─`).
3. For "today" use "Today", for "yesterday" use "Yesterday", otherwise use day name + date.
4. Within each date group, render entries in reverse chronological order (most recent first).
5. Session entries: time, lifecycle icon, workspace + device, right-aligned duration + cost. Below: summary line. Below: tool usage summary (if available). Below: recent git commits (hash prefix + message, prefixed with `↑`).
6. Orphan events (outside sessions): time, `↑` for git events, workspace + event description.
7. Footer: summary stats for the entire time range.

**Date headers for multi-day views** (`--week`):
```
── Monday, Feb 10 ─────────────────────────────────────────────
  ...
── Tuesday, Feb 11 ────────────────────────────────────────────
  ...
```

**Empty state**: `No activity found for <date range>.`

**Command handler flow**:
1. Load config, create `ApiClient`.
2. Compute date range: default is today. `--week` sets `after` to Monday 00:00. `--after`/`--before` override.
3. Resolve `--workspace` if provided.
4. Call `fetchTimeline(api, params)`.
5. If `--json`, output JSON and exit.
6. If empty, print empty state with date range.
7. Format and print timeline via `formatTimeline()`.

---

### Commander Registration

**Modify `packages/cli/src/index.ts`**:

Import and register both commands:
```typescript
import { registerSessionsCommand } from './commands/sessions';
import { registerTimelineCommand } from './commands/timeline';

registerSessionsCommand(program);
registerTimelineCommand(program);
```

### Shared Helpers

The `resolveWorkspaceName()` and `resolveDeviceName()` helpers are defined in `sessions.ts` but exported for reuse by other commands (Task 5, Task 6). If a separate module is cleaner, they can live in `packages/cli/src/lib/resolvers.ts` and be imported by both.

## Relevant Files

- `packages/cli/src/commands/sessions.ts` (create)
- `packages/cli/src/commands/timeline.ts` (create)
- `packages/cli/src/lib/resolvers.ts` (create -- workspace/device name resolution helpers, optional: can inline in sessions.ts)
- `packages/cli/src/index.ts` (modify -- register both commands)
- `packages/cli/src/commands/__tests__/sessions.test.ts` (create)
- `packages/cli/src/commands/__tests__/timeline.test.ts` (create)

## Tests

### `packages/cli/src/commands/__tests__/sessions.test.ts`

Test approach: Mock `ApiClient` by creating a test instance backed by `Bun.serve()` as a local HTTP mock server. Capture stdout writes to assert output format.

1. **Default (no flags)**: calls `GET /api/sessions?limit=20`, renders table with all columns.
2. **`--workspace fuel-code`**: resolves workspace name by calling `GET /api/workspaces`, finds match, passes resolved ULID as `workspace_id` to sessions endpoint.
3. **`--workspace github.com/user/repo`**: detects canonical ID (contains `/`), passes directly as `workspace_id` param without workspace list call.
4. **`--workspace unknown-name`**: workspace resolution fails, prints error listing available workspaces.
5. **`--workspace fu` (ambiguous prefix)**: two workspaces match prefix `fu` (`fuel-code`, `fun-project`), prints ambiguous error with candidates.
6. **`--device macbook-pro`**: resolves device name by calling `GET /api/devices`, passes resolved ULID as `device_id`.
7. **`--today`**: computes `after` as local midnight ISO-8601, verifies it is passed to API.
8. **`--live`**: passes `lifecycle=capturing` to API.
9. **`--lifecycle summarized`**: passes `lifecycle=summarized` to API.
10. **`--tag refactoring`**: passes `tag=refactoring` to API.
11. **`--limit 5`**: passes `limit=5` to API.
12. **`--cursor <value>`**: passes cursor to API.
13. **`--json`**: outputs `JSON.stringify` of the API response data (valid JSON, no table formatting).
14. **Empty result**: prints "No sessions found." message.
15. **Empty result with filters**: prints "No sessions found." with hint about removing filters.
16. **Pagination footer**: when `cursor` is non-null, footer includes cursor value and hint.
17. **Network error**: prints user-friendly "Cannot connect to backend" message, no stack trace.
18. **Auth error (401)**: prints "Invalid API key" message.
19. **Table respects terminal width**: SUMMARY column truncates when table exceeds width.
20. **Session status colors**: LIVE sessions show green indicator, DONE shows green check, FAIL shows red X.
21. **`resolveWorkspaceName` exact match**: "fuel-code" resolves when workspace list contains it.
22. **`resolveWorkspaceName` prefix match**: "fuel" resolves to "fuel-code" when it is the only prefix match.

### `packages/cli/src/commands/__tests__/timeline.test.ts`

1. **Default (no flags)**: requests timeline with `after` set to start of today (ISO-8601 midnight).
2. **`--week`**: requests timeline with `after` set to Monday 00:00 of current week.
3. **`--after -3d`**: parses relative date, computes ISO-8601 3 days ago.
4. **`--after 2026-02-10`**: passes ISO-8601 date directly.
5. **`--workspace fuel-code`**: resolves workspace and filters timeline.
6. **Session groups render correctly**: session entries show lifecycle icon, workspace, device, duration, cost, summary, and embedded git commits.
7. **Orphan events render correctly**: standalone git push events show `↑` prefix and "(outside session)" or standalone formatting.
8. **Date headers for multi-day view**: `--week` output contains date header lines with `──` separators.
9. **Footer stats**: footer correctly sums sessions, total duration, total cost, commit count.
10. **`--json`**: outputs raw JSON timeline response.
11. **Empty timeline**: prints "No activity found for today." with date range.
12. **Single-day view**: no date header when all results are from today.
13. **Tool usage summary**: sessions with tool data show `Edit(3) Bash(2) Read(5)` line.
14. **Git commits within session**: show as `↑ <hash> <message>` lines below the session summary.
15. **Relative date parsing**: `-1d`, `-7d`, `-2w`, `-12h` all parse correctly.

## Success Criteria

1. `fuel-code sessions` lists recent sessions in a formatted, terminal-width-aware table.
2. Table columns are: STATUS, ID (8-char prefix), WORKSPACE, DEVICE, DURATION, COST, STARTED, SUMMARY.
3. `--workspace` flag accepts display names (fuzzy prefix match), canonical IDs, and ULIDs.
4. Workspace resolution: exact match preferred, then unique prefix match, with clear errors for no-match and ambiguous-match cases.
5. `--device` flag resolves device names to ULIDs using the same pattern.
6. `--today` correctly computes local midnight as ISO-8601 `after` bound.
7. `--live` filters to `lifecycle=capturing` sessions only.
8. `--lifecycle`, `--tag`, `--limit`, `--cursor` flags all pass correct API query params.
9. `--json` outputs valid JSON (the raw API response data, not the formatted table).
10. Pagination footer shows cursor and hint when more results exist.
11. Empty state shows "No sessions found." with filter hint when applicable.
12. Error messages are user-friendly (no stack traces, actionable hints).
13. `fuel-code timeline` shows today's activity by default, grouped by session.
14. Timeline entries display session summary + embedded git commits + tool usage.
15. `--week` shows multi-day timeline with date headers.
16. `--after` and `--before` accept both ISO-8601 and relative date formats (`-Nd`, `-Nw`, `-Nh`).
17. Timeline footer summarizes total sessions, duration, cost, and commits for the period.
18. Orphan events (outside sessions) are clearly distinguished from session-embedded events.
19. Both commands are registered in `packages/cli/src/index.ts` and show in `fuel-code --help`.
20. Data-fetching functions (`fetchSessions`, `fetchTimeline`) are exported for TUI reuse (Task 8).
21. `resolveWorkspaceName` and `resolveDeviceName` are exported for reuse by Tasks 5 and 6.
22. All lifecycle states have correct colored icons matching the color scheme.
23. All tests pass (`bun test`).
