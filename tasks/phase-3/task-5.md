# Task 5: Timeline API Endpoint

## Parallel Group: C

## Dependencies: Task 3

## Description

Implement the `GET /api/timeline` endpoint that returns a session-grouped activity feed with embedded git activity highlights. This is the unified view of "what happened" — sessions with their associated commits, pushes, merges, and checkouts. Also includes orphan git events (activity outside any CC session).

### Endpoint: `GET /api/timeline`

**`packages/server/src/routes/timeline.ts`**:

```typescript
function createTimelineRouter(deps: {
  sql: postgres.Sql;
  logger: pino.Logger;
}): Router
```

### Query Parameters

All optional:
- `workspace_id` — filter by workspace ULID
- `device_id` — filter by device ULID
- `after` — ISO-8601 timestamp, include activity after this time
- `before` — ISO-8601 timestamp, include activity before this time
- `types` — comma-separated git activity types to include as highlights (e.g., `"commit,push"`). Default: all types.
- `limit` — max sessions per page, default 20, max 100. Clamped.
- `cursor` — opaque pagination cursor (base64-encoded `{ s: started_at, i: id }`)

### Zod Validation Schema

**`packages/shared/src/schemas/timeline-query.ts`**:

```typescript
const timelineQuerySchema = z.object({
  workspace_id: z.string().optional(),
  device_id: z.string().optional(),
  after: z.string().datetime({ offset: true }).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  types: z.string().optional().transform(val => val ? val.split(',') : null),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
```

### Response Format

```typescript
interface TimelineResponse {
  items: TimelineItem[];
  next_cursor: string | null;
  has_more: boolean;
}

// A timeline item is either a session (with embedded git highlights) or
// a group of orphan git events (activity outside any CC session)
type TimelineItem = TimelineSessionItem | TimelineOrphanGitItem;

interface TimelineSessionItem {
  type: 'session';
  session: {
    id: string;
    workspace_id: string;
    workspace_name: string;
    device_id: string;
    device_name: string;
    lifecycle: string;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    summary: string | null;
    cost_estimate_usd: number | null;
    total_messages: number | null;
    tags: string[];
  };
  git_activity: {
    id: string;
    type: string;          // "commit" | "push" | "checkout" | "merge"
    branch: string | null;
    commit_sha: string | null;
    message: string | null;
    files_changed: number | null;
    timestamp: string;
    data: Record<string, unknown>;
  }[];
}

interface TimelineOrphanGitItem {
  type: 'git_activity';
  workspace_id: string;
  workspace_name: string;
  device_id: string;
  device_name: string;
  git_activity: {
    id: string;
    type: string;
    branch: string | null;
    commit_sha: string | null;
    message: string | null;
    files_changed: number | null;
    timestamp: string;
    data: Record<string, unknown>;
  }[];
  // The "anchor" timestamp for this group (earliest event)
  started_at: string;
}
```

### Query Strategy

The timeline is session-centric: sessions are the primary items, with git activity embedded. Orphan git activity (not linked to a session) is grouped and interleaved chronologically.

**Step 1: Fetch sessions** (paginated, filtered):

```sql
SELECT s.id, s.workspace_id, s.device_id, s.lifecycle,
       s.started_at, s.ended_at, s.duration_ms, s.summary,
       s.cost_estimate_usd, s.total_messages, s.tags,
       w.display_name AS workspace_name,
       d.name AS device_name
FROM sessions s
JOIN workspaces w ON s.workspace_id = w.id
JOIN devices d ON s.device_id = d.id
WHERE 1=1
  AND ($workspace_id IS NULL OR s.workspace_id = $workspace_id)
  AND ($device_id IS NULL OR s.device_id = $device_id)
  AND ($after IS NULL OR s.started_at > $after)
  AND ($before IS NULL OR s.started_at < $before)
  AND ($cursor_started_at IS NULL OR (s.started_at, s.id) < ($cursor_started_at, $cursor_id))
ORDER BY s.started_at DESC, s.id DESC
LIMIT $limit + 1
```

**Step 2: Fetch git activity for those sessions** (batch, one query):

```sql
SELECT ga.* FROM git_activity ga
WHERE ga.session_id = ANY($session_ids)
  AND ($types IS NULL OR ga.type = ANY($types))
ORDER BY ga.timestamp ASC
```

Group results by session_id in application code.

**Step 3: Fetch orphan git activity** in the same time range:

```sql
SELECT ga.*, w.display_name AS workspace_name, d.name AS device_name
FROM git_activity ga
JOIN workspaces w ON ga.workspace_id = w.id
JOIN devices d ON ga.device_id = d.id
WHERE ga.session_id IS NULL
  AND ($workspace_id IS NULL OR ga.workspace_id = $workspace_id)
  AND ($device_id IS NULL OR ga.device_id = $device_id)
  AND ga.timestamp >= $time_range_start
  AND ga.timestamp <= $time_range_end
  AND ($types IS NULL OR ga.type = ANY($types))
ORDER BY ga.timestamp DESC
```

The time range is derived from the fetched sessions: `min(started_at)` to `max(started_at)` of the current page.

**Step 4: Merge and interleave**:

Sessions and orphan git groups are interleaved by their `started_at` timestamp. Orphan git events that fall between two sessions appear between them in the timeline.

### Cursor Encoding

Same pattern as Phase 2's session list cursor:
```typescript
const cursor = btoa(JSON.stringify({ s: lastSession.started_at, i: lastSession.id }));
```

Pagination is based on sessions. `limit + 1` pattern for `has_more` detection.

### Mount

**Modify `packages/server/src/app.ts`**: Mount at `/api/timeline`.

### Tests

**`packages/server/src/routes/__tests__/timeline.test.ts`** (requires Postgres):

1. Empty database: returns `{ items: [], next_cursor: null, has_more: false }`.
2. Sessions without git activity: returns sessions with empty `git_activity` arrays.
3. Session with commits: returns session with embedded commit data.
4. Orphan git events (no session): returned as `type: 'git_activity'` items.
5. Interleaving: session at 10:00, orphan commit at 9:30, session at 9:00 → items ordered [10:00 session, 9:30 orphan, 9:00 session].
6. `workspace_id` filter: only sessions+git for that workspace.
7. `device_id` filter: only sessions+git for that device.
8. `after` filter: only sessions started after timestamp.
9. `before` filter: only sessions started before timestamp.
10. `types=commit` filter: only commit highlights, pushes/checkouts excluded.
11. Pagination: `limit=2` returns 2 items + cursor + `has_more=true`. Using cursor returns next page. No duplicates across pages.
12. Cursor with invalid format: 400 error.
13. Session with multiple git events: all appear in `git_activity` array, ordered by timestamp.
14. Git activity data field is populated correctly (author for commits, remote for pushes, etc.).
15. Auth required: 401 without Bearer token.

## Relevant Files
- `packages/server/src/routes/timeline.ts` (create)
- `packages/shared/src/schemas/timeline-query.ts` (create)
- `packages/server/src/app.ts` (modify — mount timeline router)
- `packages/server/src/routes/__tests__/timeline.test.ts` (create)

## Success Criteria
1. `GET /api/timeline` returns session-grouped items with embedded git activity.
2. Orphan git events (session_id = NULL) appear as `type: 'git_activity'` items.
3. Items are interleaved chronologically (sessions and orphan groups sorted by time).
4. `workspace_id` filter works correctly.
5. `device_id` filter works correctly.
6. `after`/`before` temporal filters work correctly.
7. `types` filter restricts which git activity types appear as highlights.
8. Pagination: cursor-based, stable, no duplicates across pages.
9. Default limit is 20, max is 100. Over-limit clamped.
10. Invalid cursor returns 400.
11. Sessions include: workspace_name, device_name, summary, cost, message count, tags.
12. Git activity includes: type, branch, commit_sha, message, files_changed, timestamp, data.
13. Git activity within a session is ordered by timestamp ascending.
14. Auth enforced on the endpoint.
15. Empty database returns valid empty response.
