# Task 9: Session API Endpoints

## Parallel Group: E

## Description

Build the REST API endpoints for querying sessions: list with filtering and cursor-based pagination, session detail, parsed transcript, raw transcript presigned URL, session events, and tag/summary mutation. These endpoints are the primary data access layer for the CLI (Phase 4) and future web UI.

### Files to Create

**`packages/server/src/routes/sessions.ts`**:

```typescript
function createSessionsRouter(deps: {
  sql: postgres.Sql;
  s3: FuelCodeS3Client;
  logger: pino.Logger;
}): Router
```

---

**`GET /api/sessions`** — List sessions with filtering and cursor-based pagination.

Query parameters (all optional):
- `workspace_id` — filter by workspace ULID
- `device_id` — filter by device ULID
- `lifecycle` — comma-separated lifecycle values (e.g., `"parsed,summarized"`)
- `after` — ISO-8601 timestamp, sessions started after this time
- `before` — ISO-8601 timestamp, sessions started before this time
- `tag` — filter sessions containing this tag
- `limit` — max results, default 50, max 250. Values > 250 clamped.
- `cursor` — opaque pagination cursor (base64-encoded `{ s: started_at, i: id }`)
- `ended_before` — ISO-8601 timestamp, filters on `sessions.ended_at`
- `ended_after` — ISO-8601 timestamp, filters on `sessions.ended_at`

Query construction (dynamic WHERE clauses):
```sql
SELECT s.*, w.canonical_id AS workspace_canonical_id, w.display_name AS workspace_name,
       d.name AS device_name
FROM sessions s
JOIN workspaces w ON s.workspace_id = w.id
JOIN devices d ON s.device_id = d.id
WHERE 1=1
  AND ($workspace_id IS NULL OR s.workspace_id = $workspace_id)
  AND ($device_id IS NULL OR s.device_id = $device_id)
  AND ($lifecycle IS NULL OR s.lifecycle = ANY($lifecycle::text[]))
  AND ($after IS NULL OR s.started_at > $after)
  AND ($before IS NULL OR s.started_at < $before)
  AND ($tag IS NULL OR $tag = ANY(s.tags))
  AND ($cursor_started_at IS NULL OR (s.started_at, s.id) < ($cursor_started_at, $cursor_id))
ORDER BY s.started_at DESC, s.id DESC
LIMIT $limit + 1
```

Fetch `limit + 1` rows. If `limit + 1` rows returned, `has_more = true` and the cursor is from the `limit`-th row.

**Cursor encoding**: `btoa(JSON.stringify({ s: started_at_iso, i: session_id }))`. Decoding: `JSON.parse(atob(cursor))`. Invalid cursors return 400.

Response:
```json
{
  "sessions": [{ id, workspace_id, workspace_name, device_id, device_name, lifecycle, started_at, ended_at, duration_ms, summary, cost_estimate_usd, total_messages, tags, ... }],
  "next_cursor": "base64..." | null,
  "has_more": true | false
}
```

---

**`GET /api/sessions/:id`** — Session detail with all stats.

```sql
SELECT s.*, w.canonical_id, w.display_name AS workspace_name,
       d.name AS device_name, d.type AS device_type
FROM sessions s
JOIN workspaces w ON s.workspace_id = w.id
JOIN devices d ON s.device_id = d.id
WHERE s.id = $id
```

If not found: `404 { error: "Session not found" }`.

Response: `200 { session: { ...full session record with stats, summary, tags... } }`

---

**`GET /api/sessions/:id/transcript`** — Parsed transcript (messages with nested content blocks).

```sql
SELECT tm.*,
  COALESCE(json_agg(
    json_build_object(
      'id', cb.id, 'block_type', cb.block_type, 'block_order', cb.block_order,
      'content_text', cb.content_text, 'thinking_text', cb.thinking_text,
      'tool_name', cb.tool_name, 'tool_use_id', cb.tool_use_id,
      'tool_input', cb.tool_input, 'is_error', cb.is_error, 'result_text', cb.result_text
    ) ORDER BY cb.block_order
  ) FILTER (WHERE cb.id IS NOT NULL), '[]') AS content_blocks
FROM transcript_messages tm
LEFT JOIN content_blocks cb ON cb.message_id = tm.id
WHERE tm.session_id = $id
GROUP BY tm.id
ORDER BY tm.ordinal
```

If session not found: 404.
If session exists but `parse_status != 'completed'`: `404 { error: "Transcript not yet parsed", parse_status, parse_error }`.
If session parsed but no rows: return empty array (valid for empty sessions).

Response: `200 { messages: [...messages with nested content_blocks...] }`

---

**`GET /api/sessions/:id/transcript/raw`** — Redirect to S3 presigned URL.

- Get session. If `transcript_s3_key` is null: `404 { error: "No raw transcript available" }`.
- Generate presigned URL: `s3.presignedUrl(session.transcript_s3_key, 900)` (15 min expiry).
- If query param `redirect=false`: return `200 { url: presignedUrl }`.
- Otherwise: return `302 Location: presignedUrl`.

---

**`GET /api/sessions/:id/events`** — Events within this session.

```sql
SELECT * FROM events WHERE session_id = $id ORDER BY timestamp ASC
```

If session not found: 404.
Response: `200 { events: [...] }`

---

**`GET /api/sessions/:id/git`** — Git activity during this session.

The `git_activity` table exists from Phase 1 migration but won't have data until Phase 3 (git hooks). Return empty array for now. The endpoint exists so the API surface is complete.

```sql
SELECT * FROM git_activity WHERE session_id = $id ORDER BY timestamp ASC
```

Response: `200 { git_activity: [...] }` (empty array until Phase 3)

---

**`PATCH /api/sessions/:id`** — Update tags or manual summary override.

Request body (Zod-validated):
```typescript
{
  tags?: string[];        // replace tags entirely
  add_tags?: string[];    // append (deduplicated)
  remove_tags?: string[]; // remove matching
  summary?: string;       // manual override
}
```

Tag operations:
- `tags`: replace entirely with `UPDATE sessions SET tags = $1`.
- `add_tags`: append unique values using `array_cat` + `DISTINCT`.
- `remove_tags`: filter out values.
- At most one of `tags`, `add_tags`, `remove_tags` can be provided (400 if multiple).

If session not found: 404.
Response: `200 { session: updatedSession }`

---

**Mount** the router in `packages/server/src/app.ts`.

### Zod Validation Schemas

**`packages/shared/src/schemas/session-query.ts`**:
- `sessionListQuerySchema` — validates query parameters for GET /api/sessions
- `sessionPatchSchema` — validates PATCH body

### Tests

**`packages/server/src/routes/__tests__/sessions.test.ts`** (requires Postgres):

1. `GET /api/sessions` returns empty list initially.
2. After creating sessions via event pipeline, returns them in `started_at DESC` order.
3. `GET /api/sessions?lifecycle=parsed,summarized` filters correctly.
4. `GET /api/sessions?workspace_id=<id>` returns only matching sessions.
5. `GET /api/sessions?after=<timestamp>` temporal filter works.
6. `GET /api/sessions?tag=bugfix` returns only tagged sessions.
7. Pagination: `?limit=2` returns 2 results + cursor + `has_more=true`. Using cursor returns next page.
8. `GET /api/sessions/:id` returns session detail with stats.
9. `GET /api/sessions/:id` with invalid ID: 404.
10. `GET /api/sessions/:id/transcript` returns messages with nested content blocks.
11. `GET /api/sessions/:id/transcript` for unparsed session: 404 with parse status info.
12. `GET /api/sessions/:id/transcript/raw` returns presigned URL (302 or 200).
13. `GET /api/sessions/:id/events` returns events in chronological order.
14. `PATCH /api/sessions/:id` with `tags: ["test"]` replaces tags.
15. `PATCH /api/sessions/:id` with `add_tags: ["new"]` appends.
16. `PATCH /api/sessions/:id` with `remove_tags: ["old"]` removes.
17. `PATCH /api/sessions/:id` with `summary: "override"` updates summary.
18. Auth required on all endpoints: 401 without Bearer token.

## Relevant Files
- `packages/server/src/routes/sessions.ts` (create)
- `packages/server/src/app.ts` (modify — mount sessions router)
- `packages/shared/src/schemas/session-query.ts` (create)
- `packages/server/src/routes/__tests__/sessions.test.ts` (create)

## Success Criteria
1. `GET /api/sessions` returns paginated session list with `sessions`, `next_cursor`, `has_more`.
2. Cursor-based pagination is stable (no duplicates or gaps across pages).
3. All query filters work: `workspace_id`, `device_id`, `lifecycle` (comma-separated), `after`, `before`, `tag`.
4. Default limit is 50, max is 250. Over-limit values clamped.
5. `GET /api/sessions/:id` returns full session with stats, summary, workspace/device names.
6. `GET /api/sessions/:id/transcript` returns messages ordered by ordinal with nested content blocks.
7. `GET /api/sessions/:id/transcript/raw` generates valid S3 presigned URL.
8. `PATCH /api/sessions/:id` supports `tags`, `add_tags`, `remove_tags`, and `summary`.
9. `add_tags` deduplicates. `remove_tags` removes matching.
10. All endpoints return 404 for non-existent sessions.
11. Auth enforced on all endpoints.
12. Invalid cursor returns 400 with descriptive error.
13. `GET /api/sessions` supports `ended_before` and `ended_after` query parameters filtering on `sessions.ended_at`.
