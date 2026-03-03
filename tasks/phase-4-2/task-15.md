# Task 15: API — Session Sub-endpoints + Enhanced Detail

## Parallel Group: E

## Dependencies: Task 1 (tables), Task 4 (handlers), Task 12 (pipeline persist relationships)

## Description

Add three new sub-endpoints to the sessions router and enhance the existing session detail endpoint with relationship data. Add filter parameters to the session list endpoint.

### New Sub-endpoints

**`GET /api/sessions/:id/subagents`** — List sub-agents for a session.

Response:
```json
[
  {
    "id": "01J...",
    "agent_id": "a834e7d",
    "agent_type": "Explore",
    "agent_name": null,
    "model": "claude-haiku-4-5-20251001",
    "status": "completed",
    "started_at": "...",
    "ended_at": "...",
    "team_name": null,
    "isolation": null,
    "run_in_background": false
  }
]
```

SQL: `SELECT * FROM subagents WHERE session_id = $1 ORDER BY started_at`

**`GET /api/sessions/:id/skills`** — List skills invoked in a session.

Response:
```json
[
  {
    "id": "01J...",
    "skill_name": "commit",
    "invoked_at": "...",
    "invoked_by": "user",
    "args": null
  }
]
```

SQL: `SELECT * FROM session_skills WHERE session_id = $1 ORDER BY invoked_at`

**`GET /api/sessions/:id/worktrees`** — List worktrees used in a session.

Response:
```json
[
  {
    "id": "01J...",
    "worktree_name": "agent-a834e7d",
    "branch": "worktree-agent-a834e7d",
    "created_at": "...",
    "removed_at": "...",
    "had_changes": true
  }
]
```

SQL: `SELECT * FROM session_worktrees WHERE session_id = $1 ORDER BY created_at`

All three return 404 for unknown session IDs, empty arrays for sessions with no data.

### Enhanced Session Detail

Modify `GET /api/sessions/:id` to include relationship data inline:

```json
{
  "id": "uuid",
  "workspace_id": "...",
  // ... existing fields ...

  // NEW: Relationship data
  "subagents": [{ "agent_id": "...", "agent_type": "...", "status": "..." }],
  "skills": [{ "skill_name": "...", "invoked_at": "...", "invoked_by": "..." }],
  "worktrees": [{ "worktree_name": "...", "branch": "..." }],
  "team": { "team_name": "...", "description": "...", "member_count": 5 },
  "resumed_from": { "id": "uuid", "started_at": "...", "initial_prompt": "..." },
  "resumed_by": [{ "id": "uuid", "started_at": "...", "initial_prompt": "..." }],

  // NEW: Session metadata
  "permission_mode": "default",
  "team_name": "phase-2-impl",
  "team_role": "lead"
}
```

Implementation:
- Subagents: `SELECT * FROM subagents WHERE session_id = $1 ORDER BY started_at`
- Skills: `SELECT * FROM session_skills WHERE session_id = $1 ORDER BY invoked_at`
- Worktrees: `SELECT * FROM session_worktrees WHERE session_id = $1 ORDER BY created_at`
- Team: `SELECT * FROM teams WHERE team_name = session.team_name` (if team_name not null)
- Resumed from: `SELECT id, started_at, initial_prompt FROM sessions WHERE id = session.resumed_from_session_id`
- Resumed by: `SELECT id, started_at, initial_prompt FROM sessions WHERE resumed_from_session_id = $1`

**Performance note**: This adds up to 6 queries per detail request. For single-user this is fine. If needed later, batch into a CTE or join.

### Session List Filter Enhancements

Add query params to `GET /api/sessions`:

- `team=<team_name>` — filter by `team_name` column
- `has_subagents=true` — filter `subagent_count > 0`
- `has_team=true` — filter `team_name IS NOT NULL`

Add to the existing WHERE clause builder. These are optional filters that don't affect default behavior.

### Backward Compatibility

Sessions without relationship data return:
- `subagents: []`
- `skills: []`
- `worktrees: []`
- `team: null`
- `resumed_from: null`
- `resumed_by: []`

No breaking changes to the existing response shape — all new fields are additive.

## Relevant Files
- Modify: `packages/server/src/routes/sessions.ts`

## Success Criteria
1. `GET /api/sessions/:id/subagents` returns correct data for sessions with sub-agents.
2. `GET /api/sessions/:id/skills` returns correct skill invocations.
3. `GET /api/sessions/:id/worktrees` returns correct worktree data.
4. All three sub-endpoints return empty arrays for sessions without data (not 404).
5. All three return 404 for nonexistent session IDs.
6. `GET /api/sessions/:id` includes inline relationship data.
7. `GET /api/sessions?team=phase-2-impl` filters correctly.
8. `GET /api/sessions?has_subagents=true` filters correctly.
9. Old sessions without new data return empty/null for new fields.
10. Auth middleware applied to all new endpoints.
11. All existing session endpoint tests pass.
