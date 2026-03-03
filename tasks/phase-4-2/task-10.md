# Task 10: API — Teams Routes

## Parallel Group: C

## Dependencies: Task 1 (tables), Task 4 (handlers create team data)

## Description

Create a new route file `packages/server/src/routes/teams.ts` with two endpoints for querying agent teams. Mount it in the server app.

### Endpoints

**`GET /api/teams`** — List all teams

Query params:
- `limit` (number, default 50, max 250)
- `cursor` (string, base64-encoded pagination cursor)

Response:
```json
{
  "teams": [
    {
      "id": "01J...",
      "team_name": "phase-2-impl",
      "description": "Implementing Phase 2...",
      "lead_session_id": "uuid",
      "lead_session": {
        "id": "uuid",
        "initial_prompt": "Implement Phase 2...",
        "started_at": "2026-02-19T15:30:00Z",
        "lifecycle": "parsed"
      },
      "created_at": "2026-02-19T15:30:00Z",
      "ended_at": null,
      "member_count": 5,
      "metadata": {}
    }
  ],
  "next_cursor": "...",
  "has_more": false
}
```

SQL: Join `teams` with `sessions` on `lead_session_id` for the lead session summary. Order by `created_at DESC`.

**`GET /api/teams/:name`** — Team detail with members

Path param: `name` (team_name, e.g., "phase-2-impl")

Response:
```json
{
  "id": "01J...",
  "team_name": "phase-2-impl",
  "description": "...",
  "lead_session_id": "uuid",
  "lead_session": {
    "id": "uuid",
    "initial_prompt": "...",
    "started_at": "...",
    "lifecycle": "parsed",
    "model": "claude-opus-4-6"
  },
  "created_at": "...",
  "ended_at": null,
  "member_count": 5,
  "members": [
    {
      "id": "01J...",
      "agent_id": "a01e254",
      "agent_type": "general-purpose",
      "agent_name": "task-1-worker",
      "model": "claude-sonnet-4-6",
      "status": "completed",
      "started_at": "...",
      "ended_at": "...",
      "session_id": "uuid"
    }
  ],
  "metadata": { "message_count": 12 }
}
```

SQL: Fetch team by `team_name`, then `SELECT * FROM subagents WHERE team_name = $1 ORDER BY started_at`.

404 for unknown team names.

### Mounting

In the server app (wherever routes are mounted), add:
```typescript
import { teamsRouter } from './routes/teams.js';
app.use('/api/teams', authMiddleware, teamsRouter);
```

### Pagination

Follow the existing cursor pagination pattern from `sessions.ts`:
- Cursor: base64-encoded `{ c: created_at, i: id }`
- WHERE clause: `(created_at, id) < ($cursor_created_at, $cursor_id)`

## Relevant Files
- Create: `packages/server/src/routes/teams.ts`
- Modify: Server app route mounting file (e.g., `packages/server/src/routes/index.ts` or `packages/server/src/app.ts`)

## Success Criteria
1. `GET /api/teams` returns teams ordered by `created_at DESC`.
2. Cursor pagination works (next page returns correct results).
3. `GET /api/teams/:name` returns team detail with `members` populated from subagents table.
4. 404 response for unknown team names.
5. Empty `members` array when no subagents have the matching `team_name`.
6. Auth middleware applied (401 without valid Bearer token).
7. `lead_session` joined data is correct (shows initial_prompt, lifecycle).
8. All existing route tests pass.
