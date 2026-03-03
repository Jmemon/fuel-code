# Task 23: API — Update Session Detail + List for New Lifecycle

## Phase: G — API + TUI + CLI
## Dependencies: T4
## Parallelizable With: T22, T24, T25

---

## Description

Update session API endpoints for new lifecycle values and teammate data.

## Files

- **Modify**: `packages/server/src/routes/sessions.ts` — update `GET /sessions` and `GET /sessions/:id`
- **Modify**: `packages/server/src/routes/teams.ts` — update to query from new teams table schema

## Key Changes

**`GET /sessions/:id`**:
- Add `teammates` array to response (JOIN through teams → teammates)
- Remove `team` field (was from old `team_name` column on sessions)
- Remove `parse_status` from response
- Add `last_error` to response

**`GET /sessions`**:
- Remove `?team` and `?has_team` filter params (or reimplement through teams table JOIN)
- Replace `has_team` with a subquery: `EXISTS (SELECT 1 FROM teams WHERE session_id = s.id)`
- Add `num_teammates` computed field (subquery count)

**`GET /teams`** and **`GET /teams/:name`**:
- Update to query from new schema (session-scoped teams, teammates as members instead of subagents)
- `GET /teams/:name` returns teammates (not subagents) as members

**`POST /sessions/batch-status`**:
- Return only `{ lifecycle }` per session (no `parse_status`)
- Recognize `complete` as terminal state

## How to Test

```bash
cd packages/server && bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+"
```

## Success Criteria

1. Session detail includes `teammates[]` array
2. No `parse_status` in any response
3. `lifecycle` values use new state names
4. Teams API returns session-scoped teams with teammate members
5. `batch-status` uses new terminal states
