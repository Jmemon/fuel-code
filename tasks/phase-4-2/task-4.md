# Task 4: Core Event Handlers (7 handlers)

## Parallel Group: B

## Dependencies: Task 1 (tables), Task 3 (event types)

## Description

Create 7 new event handler files in `packages/core/src/handlers/` following the existing pattern. Register all 7 in the handler registry. Also create a shared `resolveSessionByCC()` helper function used by all new handlers.

### Shared Helper: `resolveSessionByCC()`

Create in `packages/core/src/handlers/resolve-session.ts`:

```typescript
/**
 * Look up a fuel-code session row by Claude Code's session_id.
 * CC hooks provide cc_session_id in event.data.session_id.
 * The sessions table stores this as the primary key `id` (cc_session_id IS the PK).
 * Returns the session row or null if not found.
 */
export async function resolveSessionByCC(
  sql: Sql,
  ccSessionId: string
): Promise<{ id: string; workspace_id: string; device_id: string } | null>
```

This avoids duplicating the session lookup logic across all 7 handlers. If the session doesn't exist yet (e.g., subagent.start arrives before session.start is processed), the handler should log a warning and skip — **do not create the session**. The session.start handler is responsible for session creation.

### Handler Implementations

All handlers follow the existing pattern:
```typescript
async function handleSubagentStart(ctx: EventHandlerContext): Promise<void>
```

Where `ctx` provides `sql`, `event`, `workspaceId`, `logger`.

**`subagent-start.ts`**:
- Extract from `event.data`: `session_id`, `agent_id`, `agent_type`, `agent_name`, `model`, `team_name`, `isolation`, `run_in_background`
- Look up session via `resolveSessionByCC(sql, event.data.session_id)`
- If session not found, log warning and return (event is queued, will be reprocessed or caught by parser)
- INSERT into `subagents` with `ON CONFLICT (session_id, agent_id) DO UPDATE` — update fields that might be more complete from the hook than from a previous partial insert
- Generate ULID for `subagents.id`

**`subagent-stop.ts`**:
- Extract: `session_id`, `agent_id`, `agent_type`, `agent_transcript_path`
- Look up session, find subagent row by `(session_id, agent_id)`
- UPDATE subagent: `status = 'completed'`, `ended_at = NOW()`
- UPDATE session: `SET subagent_count = (SELECT COUNT(*) FROM subagents WHERE session_id = $1)`
- If subagent row doesn't exist (stop arrived before start), INSERT with status='completed'

**`team-create.ts`**:
- Extract: `session_id`, `team_name`, `description`
- INSERT into `teams` with `ON CONFLICT (team_name) DO UPDATE` (team might already exist from a previous session)
- UPDATE session: `SET team_name = $1, team_role = 'lead'`
- Generate ULID for `teams.id`

**`team-message.ts`**:
- Extract: `session_id`, `team_name`, `message_type`, `from`, `to`
- Find team by `team_name`
- UPDATE `teams.metadata` — increment message count in JSONB: `metadata = jsonb_set(metadata, '{message_count}', ((COALESCE(metadata->>'message_count', '0')::int + 1)::text)::jsonb)`
- If team doesn't exist, log warning and skip (team.create should arrive first)

**`skill-invoke.ts`**:
- Extract: `session_id`, `skill_name`, `args`, `invoked_by`
- Look up session
- INSERT into `session_skills` — no upsert needed (skills are append-only, deduped by ULID)

**`worktree-create.ts`**:
- Extract: `session_id`, `worktree_name`, `branch`
- Look up session
- INSERT into `session_worktrees`

**`worktree-remove.ts`**:
- Extract: `session_id`, `worktree_name`, `had_changes`
- Look up session
- Find worktree row by `(session_id, worktree_name)` — UPDATE `removed_at = NOW()`, `had_changes`
- If no matching create row found, INSERT a complete row with both created_at and removed_at

### Handler Registry Update

In `packages/core/src/handlers/index.ts`, register all 7 new handlers in `createHandlerRegistry()`. The registry should now have 13 handlers total (6 existing + 7 new).

## Relevant Files
- Create: `packages/core/src/handlers/resolve-session.ts`
- Create: `packages/core/src/handlers/subagent-start.ts`
- Create: `packages/core/src/handlers/subagent-stop.ts`
- Create: `packages/core/src/handlers/team-create.ts`
- Create: `packages/core/src/handlers/team-message.ts`
- Create: `packages/core/src/handlers/skill-invoke.ts`
- Create: `packages/core/src/handlers/worktree-create.ts`
- Create: `packages/core/src/handlers/worktree-remove.ts`
- Modify: `packages/core/src/handlers/index.ts`

## Success Criteria
1. Each handler produces the expected DB row when given a synthetic event via the handler registry.
2. `subagent-start` + `subagent-stop` in sequence creates then updates a subagents row correctly (status: running → completed).
3. Duplicate events (same session_id + agent_id) produce exactly one subagent row (upsert idempotency).
4. `team-create` creates a teams row AND updates the session's `team_name`/`team_role`.
5. `team-message` increments the message count in teams.metadata.
6. `skill-invoke` creates a session_skills row.
7. `worktree-create` + `worktree-remove` creates then updates a session_worktrees row.
8. All handlers gracefully handle missing sessions (log warning, don't crash).
9. All handlers are registered in `createHandlerRegistry()` — registry has 13 handlers.
10. Existing 6 handlers continue to work unchanged.
11. All existing tests pass.
