# Task 1: Server: Workspace + Device REST Endpoints

## Parallel Group: A

## Dependencies: None

## Description

Add the 4 missing REST API endpoints to `packages/server/` for workspaces and devices. These endpoints power the `fuel-code workspaces`, `fuel-code workspace <name>`, and TUI dashboard sidebar. Sessions, timeline, and health endpoints already exist from Phases 2-3. The workspace and device data already exists in Postgres (populated by the event processor when events are ingested). These endpoints are read-only aggregation queries over existing tables.

### Route File: `packages/server/src/routes/workspaces.ts`

```typescript
function createWorkspacesRouter(deps: {
  sql: postgres.Sql;
  logger: pino.Logger;
}): Router
```

Follow the same pattern as `createSessionsRouter` from Phase 2 Task 9: a factory function that takes dependencies and returns an Express Router.

---

**`GET /api/workspaces`** -- List all workspaces with aggregate session counts and last activity.

Query parameters (all optional):
- `limit` -- max results, default 50, max 250. Values > 250 clamped.
- `cursor` -- opaque pagination cursor (base64-encoded `{ u: last_session_at, i: id }`)

Zod validation schema for query params:
```typescript
import { z } from 'zod';

const workspaceListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(50).optional(),
  cursor: z.string().optional(),
});
```

SQL query:
```sql
SELECT w.*,
  COUNT(s.id) AS session_count,
  COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) AS active_session_count,
  MAX(s.started_at) AS last_session_at,
  COUNT(DISTINCT s.device_id) AS device_count,
  COALESCE(SUM(s.cost_estimate_usd), 0) AS total_cost_usd,
  COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms
FROM workspaces w
LEFT JOIN sessions s ON s.workspace_id = w.id
GROUP BY w.id
ORDER BY MAX(s.started_at) DESC NULLS LAST, w.id DESC
LIMIT $limit + 1
```

If a cursor is provided, decode it and add a WHERE clause:
```sql
AND (MAX(s.started_at), w.id) < ($cursor_last_session_at, $cursor_id)
```

Note: Since the cursor references an aggregate (`MAX(s.started_at)`), the cursor filter needs to be applied via a HAVING clause or a subquery/CTE. Use a CTE approach:

```sql
WITH workspace_agg AS (
  SELECT w.*,
    COUNT(s.id) AS session_count,
    COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) AS active_session_count,
    MAX(s.started_at) AS last_session_at,
    COUNT(DISTINCT s.device_id) AS device_count,
    COALESCE(SUM(s.cost_estimate_usd), 0) AS total_cost_usd,
    COALESCE(SUM(s.duration_ms), 0) AS total_duration_ms
  FROM workspaces w
  LEFT JOIN sessions s ON s.workspace_id = w.id
  GROUP BY w.id
)
SELECT * FROM workspace_agg
WHERE ($1::timestamptz IS NULL OR (last_session_at, id) < ($1, $2))
ORDER BY last_session_at DESC NULLS LAST, id DESC
LIMIT $3
```

Fetch `limit + 1` rows. If `limit + 1` rows returned, `has_more = true` and the cursor is built from the `limit`-th row. Drop the extra row from the response.

Cursor encoding: `btoa(JSON.stringify({ u: last_session_at_iso, i: workspace_id }))`. Decoding: `JSON.parse(atob(cursor))`. Invalid cursors return 400.

Response shape:
```json
{
  "workspaces": [
    {
      "id": "01JMF3...",
      "canonical_id": "github.com/user/repo",
      "display_name": "repo",
      "default_branch": "main",
      "session_count": 12,
      "active_session_count": 1,
      "last_session_at": "2026-02-14T10:23:00Z",
      "device_count": 2,
      "total_cost_usd": 4.27,
      "total_duration_ms": 180000,
      "first_seen_at": "2026-02-01T...",
      "updated_at": "2026-02-14T..."
    }
  ],
  "next_cursor": "eyJ1IjoiMjAyNi0wMi..." | null,
  "has_more": true
}
```

---

**`GET /api/workspaces/:id`** -- Workspace detail with recent sessions, devices, git activity summary, and aggregate stats.

The `:id` parameter accepts both a ULID (`01JMF3...`) and a canonical_id (`github.com/user/repo`) or display_name. Resolution logic:
1. If `id` is 26 chars and alphanumeric (ULID format): `WHERE w.id = $1`.
2. Otherwise: `WHERE LOWER(w.display_name) = LOWER($1) OR w.canonical_id = $1`. If multiple matches on display_name, return `400 { error: "Ambiguous workspace name", matches: [...] }`.

This endpoint makes 4 queries (can be parallelized with `Promise.all`):

**1. Workspace record**:
```sql
SELECT * FROM workspaces WHERE id = $1
-- OR: SELECT * FROM workspaces WHERE LOWER(display_name) = LOWER($1) OR canonical_id = $1
```
If not found: `404 { error: "Workspace not found" }`.

**2. Recent sessions (last 10)**:
```sql
SELECT s.*, d.name AS device_name, d.type AS device_type
FROM sessions s
JOIN devices d ON s.device_id = d.id
WHERE s.workspace_id = $1
ORDER BY s.started_at DESC
LIMIT 10
```

**3. Devices tracking this workspace**:
```sql
SELECT d.*, wd.local_path, wd.hooks_installed, wd.git_hooks_installed, wd.last_active_at
FROM devices d
JOIN workspace_devices wd ON wd.device_id = d.id
WHERE wd.workspace_id = $1
ORDER BY wd.last_active_at DESC
```

**4. Git activity summary**:
```sql
SELECT
  COUNT(*) FILTER (WHERE type = 'commit') AS total_commits,
  COUNT(*) FILTER (WHERE type = 'push') AS total_pushes,
  array_agg(DISTINCT branch) FILTER (WHERE branch IS NOT NULL) AS active_branches,
  MAX(timestamp) AS last_commit_at
FROM git_activity
WHERE workspace_id = $1
```

**5. Aggregate stats** (can be combined with workspace query or separate):
```sql
SELECT
  COUNT(*) AS total_sessions,
  COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
  COALESCE(SUM(cost_estimate_usd), 0) AS total_cost_usd,
  MIN(started_at) AS first_session_at,
  MAX(started_at) AS last_session_at
FROM sessions
WHERE workspace_id = $1
```

Response shape:
```json
{
  "workspace": {
    "id": "01JMF3...",
    "canonical_id": "github.com/user/repo",
    "display_name": "repo",
    "default_branch": "main",
    "first_seen_at": "...",
    "updated_at": "...",
    "metadata": {}
  },
  "recent_sessions": [
    {
      "id": "01JMF4...",
      "lifecycle": "summarized",
      "started_at": "...",
      "ended_at": "...",
      "duration_ms": 2820000,
      "cost_estimate_usd": 0.42,
      "summary": "Refactored auth middleware...",
      "device_name": "macbook-pro",
      "device_type": "local"
    }
  ],
  "devices": [
    {
      "id": "01JMF5...",
      "name": "macbook-pro",
      "type": "local",
      "local_path": "/Users/john/code/repo",
      "hooks_installed": true,
      "git_hooks_installed": true,
      "last_active_at": "..."
    }
  ],
  "git_summary": {
    "total_commits": 47,
    "total_pushes": 12,
    "active_branches": ["main", "feature/auth"],
    "last_commit_at": "..."
  },
  "stats": {
    "total_sessions": 47,
    "total_duration_ms": 136800000,
    "total_cost_usd": 42.18,
    "first_session_at": "...",
    "last_session_at": "..."
  }
}
```

---

### Route File: `packages/server/src/routes/devices.ts`

```typescript
function createDevicesRouter(deps: {
  sql: postgres.Sql;
  logger: pino.Logger;
}): Router
```

---

**`GET /api/devices`** -- List all devices with aggregate counts.

SQL query:
```sql
SELECT d.*,
  COUNT(DISTINCT wd.workspace_id) AS workspace_count,
  COUNT(s.id) AS session_count,
  COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) AS active_session_count,
  MAX(s.started_at) AS last_session_at
FROM devices d
LEFT JOIN workspace_devices wd ON wd.device_id = d.id
LEFT JOIN sessions s ON s.device_id = d.id
GROUP BY d.id
ORDER BY d.last_seen_at DESC
```

Response shape:
```json
{
  "devices": [
    {
      "id": "01JMF3...",
      "name": "macbook-pro",
      "type": "local",
      "hostname": "Johns-MBP",
      "os": "darwin",
      "arch": "arm64",
      "status": "online",
      "workspace_count": 3,
      "session_count": 47,
      "active_session_count": 1,
      "last_session_at": "...",
      "last_seen_at": "...",
      "created_at": "...",
      "metadata": {}
    }
  ]
}
```

No pagination needed for devices (single-user system, unlikely to have more than a handful of devices).

---

**`GET /api/devices/:id`** -- Device detail with workspace associations and recent sessions.

This endpoint makes 3 queries (parallelized with `Promise.all`):

**1. Device record**:
```sql
SELECT * FROM devices WHERE id = $1
```
If not found: `404 { error: "Device not found" }`.

**2. Workspaces tracked on this device**:
```sql
SELECT w.id, w.canonical_id, w.display_name, w.default_branch,
       wd.local_path, wd.hooks_installed, wd.git_hooks_installed, wd.last_active_at
FROM workspaces w
JOIN workspace_devices wd ON w.id = wd.workspace_id
WHERE wd.device_id = $1
ORDER BY wd.last_active_at DESC
```

**3. Recent sessions on this device (last 10)**:
```sql
SELECT s.*, w.display_name AS workspace_name, w.canonical_id AS workspace_canonical_id
FROM sessions s
JOIN workspaces w ON s.workspace_id = w.id
WHERE s.device_id = $1
ORDER BY s.started_at DESC
LIMIT 10
```

Response shape:
```json
{
  "device": {
    "id": "01JMF3...",
    "name": "macbook-pro",
    "type": "local",
    "hostname": "Johns-MBP",
    "os": "darwin",
    "arch": "arm64",
    "status": "online",
    "last_seen_at": "...",
    "created_at": "...",
    "metadata": {}
  },
  "workspaces": [
    {
      "id": "01JMF4...",
      "canonical_id": "github.com/user/repo",
      "display_name": "repo",
      "local_path": "/Users/john/code/repo",
      "hooks_installed": true,
      "git_hooks_installed": true,
      "last_active_at": "..."
    }
  ],
  "recent_sessions": [
    {
      "id": "01JMF5...",
      "workspace_name": "repo",
      "workspace_canonical_id": "github.com/user/repo",
      "lifecycle": "summarized",
      "started_at": "...",
      "duration_ms": 2820000,
      "cost_estimate_usd": 0.42,
      "summary": "Refactored auth middleware..."
    }
  ]
}
```

---

### Mounting in `packages/server/src/app.ts`

Add workspace and device routers alongside the existing session and timeline routers. Follow the same pattern used for sessions:

```typescript
import { createWorkspacesRouter } from './routes/workspaces';
import { createDevicesRouter } from './routes/devices';

// After existing session/timeline router registrations:
const workspacesRouter = createWorkspacesRouter({ sql, logger });
const devicesRouter = createDevicesRouter({ sql, logger });

app.use('/api/workspaces', authMiddleware, workspacesRouter);
app.use('/api/devices', authMiddleware, devicesRouter);
```

Auth middleware is applied to all routes (same `authMiddleware` used by session routes). The auth middleware checks `Authorization: Bearer <api_key>` and returns 401 on failure.

---

### Error Handling

All endpoints follow the existing error handling pattern:
- Wrap route handlers in try/catch.
- On validation errors: `400 { error: "...", details: ... }`.
- On not found: `404 { error: "Workspace not found" }` or `404 { error: "Device not found" }`.
- On server errors: `500 { error: "Internal server error" }` (log full error via pino).
- Invalid cursor: `400 { error: "Invalid cursor" }`.

---

### Tests

**`packages/server/src/routes/__tests__/workspaces.test.ts`**:

Use supertest against the Express app with a test database (same pattern as session route tests from Phase 2 Task 9). Seed test data by inserting rows directly into workspaces, sessions, devices, workspace_devices, and git_activity tables.

1. `GET /api/workspaces` returns empty array when no workspaces exist.
2. `GET /api/workspaces` returns workspaces sorted by last session time (most recent first).
3. `GET /api/workspaces` includes correct `session_count` per workspace.
4. `GET /api/workspaces` includes correct `active_session_count` (only sessions with `lifecycle = 'capturing'`).
5. `GET /api/workspaces` includes correct `total_cost_usd` and `total_duration_ms` aggregates.
6. `GET /api/workspaces` includes correct `device_count` (distinct devices with sessions).
7. `GET /api/workspaces` workspace with no sessions still appears (counts are 0, `last_session_at` is null).
8. `GET /api/workspaces?limit=2` returns at most 2 workspaces and `has_more: true` with a cursor.
9. `GET /api/workspaces?cursor=<cursor>` returns the next page correctly.
10. `GET /api/workspaces?cursor=invalid` returns 400.
11. `GET /api/workspaces` without auth header returns 401.
12. `GET /api/workspaces/:id` by ULID returns workspace detail.
13. `GET /api/workspaces/:id` by display_name (case-insensitive) resolves correctly.
14. `GET /api/workspaces/:id` by canonical_id resolves correctly.
15. `GET /api/workspaces/:id` includes `recent_sessions` (limited to 10, ordered by started_at DESC).
16. `GET /api/workspaces/:id` includes `devices` with local_path, hooks_installed, git_hooks_installed.
17. `GET /api/workspaces/:id` includes `git_summary` with total_commits, total_pushes, active_branches.
18. `GET /api/workspaces/:id` includes `stats` with total_sessions, total_duration_ms, total_cost_usd.
19. `GET /api/workspaces/:id` returns 404 for non-existent workspace ULID.
20. `GET /api/workspaces/:id` returns 404 for non-existent display_name.
21. `GET /api/workspaces/:id` without auth header returns 401.

**`packages/server/src/routes/__tests__/devices.test.ts`**:

1. `GET /api/devices` returns empty array when no devices exist.
2. `GET /api/devices` returns devices sorted by last_seen_at (most recent first).
3. `GET /api/devices` includes correct `workspace_count` (distinct workspaces via workspace_devices).
4. `GET /api/devices` includes correct `session_count` and `active_session_count`.
5. `GET /api/devices` includes correct `last_session_at`.
6. `GET /api/devices` without auth header returns 401.
7. `GET /api/devices/:id` returns device detail with all fields.
8. `GET /api/devices/:id` includes `workspaces` with local_path and hooks status.
9. `GET /api/devices/:id` includes `recent_sessions` (limited to 10, ordered by started_at DESC).
10. `GET /api/devices/:id` includes workspace_name and workspace_canonical_id on each session.
11. `GET /api/devices/:id` returns 404 for non-existent device ID.
12. `GET /api/devices/:id` without auth header returns 401.

## Relevant Files

- `packages/server/src/routes/workspaces.ts` (create)
- `packages/server/src/routes/devices.ts` (create)
- `packages/server/src/app.ts` (modify -- mount new routers with auth middleware)
- `packages/server/src/routes/__tests__/workspaces.test.ts` (create)
- `packages/server/src/routes/__tests__/devices.test.ts` (create)

## Success Criteria

1. `GET /api/workspaces` returns paginated workspace list sorted by most-recent session activity.
2. `GET /api/workspaces` includes accurate aggregate counts: `session_count`, `active_session_count`, `device_count`, `total_cost_usd`, `total_duration_ms`.
3. Workspaces with no sessions appear in the list with zero counts and null `last_session_at`.
4. Cursor-based pagination works correctly for the workspaces list (`limit`, `cursor`, `has_more`, `next_cursor`).
5. Invalid cursors return 400 with a clear error message.
6. `GET /api/workspaces/:id` accepts ULID, canonical_id, or display_name as the `:id` parameter.
7. Display name resolution is case-insensitive; ambiguous matches return 400 with candidate list.
8. Workspace detail includes `recent_sessions` (10 most recent, with device_name and device_type).
9. Workspace detail includes `devices` (all devices tracking this workspace, with local_path and hooks status).
10. Workspace detail includes `git_summary` with total_commits, total_pushes, active_branches, last_commit_at.
11. Workspace detail includes `stats` with total_sessions, total_duration_ms, total_cost_usd, date range.
12. `GET /api/devices` returns all devices sorted by `last_seen_at` with `workspace_count`, `session_count`, `active_session_count`.
13. `GET /api/devices/:id` returns device with workspace associations (including local_path, hooks status) and recent sessions.
14. All endpoints return 404 with a clear message for non-existent resources.
15. All endpoints require auth (`Authorization: Bearer <api_key>`) and return 401 without it.
16. Route factory functions follow the `createXxxRouter(deps)` pattern matching existing session routes.
17. All routes are mounted in `app.ts` under `/api/workspaces` and `/api/devices`.
18. Response shapes match the types expected by `ApiClient` (Task 3).
19. All 33 tests pass (`bun test`).
