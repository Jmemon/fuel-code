# Task 12: Session Pipeline — Persist Relationships

## Parallel Group: D

## Dependencies: Task 1 (tables), Task 4 (handlers), Task 7 (parser sub-agent+team), Task 9 (parser skill+worktree+chain)

## Description

Add a `persistRelationships()` step to `packages/core/src/session-pipeline.ts` that writes parser-extracted relationship data (sub-agents, teams, skills, worktrees, session metadata) to the new database tables. This step runs after parsing and before summarization.

### Pipeline Position

Current pipeline steps:
1. Fetch session, validate
2. Mark parse_status = "parsing"
3. Download transcript from S3
4. Parse JSONL → parseTranscript()
5. Batch insert messages + content_blocks
6. Transition lifecycle to "parsed", update stats
7. Generate LLM summary
8. Upload parsed backup to S3

**Insert new step between 5 and 6:**
```
5. Batch insert messages + content_blocks
5.5 Persist relationships (NEW)
6. Transition lifecycle to "parsed", update stats
```

### persistRelationships() Implementation

```typescript
async function persistRelationships(
  sql: Sql,
  sessionId: string,
  parseResult: ParseResult,
  logger: Logger
): Promise<void> {
  try {
    // 1. Upsert subagents
    for (const sa of parseResult.subagents) {
      const id = ulid();
      await sql`
        INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model,
          spawning_tool_use_id, team_name, isolation, run_in_background, status, started_at)
        VALUES (${id}, ${sessionId}, ${sa.agent_id}, ${sa.agent_type}, ${sa.agent_name ?? null},
          ${sa.model ?? null}, ${sa.spawning_tool_use_id}, ${sa.team_name ?? null},
          ${sa.isolation ?? null}, ${sa.run_in_background}, 'completed', ${sa.started_at ?? null})
        ON CONFLICT (session_id, agent_id) DO UPDATE SET
          agent_type = COALESCE(EXCLUDED.agent_type, subagents.agent_type),
          agent_name = COALESCE(EXCLUDED.agent_name, subagents.agent_name),
          model = COALESCE(EXCLUDED.model, subagents.model),
          spawning_tool_use_id = COALESCE(EXCLUDED.spawning_tool_use_id, subagents.spawning_tool_use_id),
          team_name = COALESCE(EXCLUDED.team_name, subagents.team_name),
          isolation = COALESCE(EXCLUDED.isolation, subagents.isolation)
      `;
    }

    // 2. Upsert teams
    for (const team of parseResult.teams) {
      const id = ulid();
      await sql`
        INSERT INTO teams (id, team_name, description, lead_session_id, created_at, member_count)
        VALUES (${id}, ${team.team_name}, ${team.description ?? null}, ${sessionId}, now(),
          ${parseResult.subagents.filter(s => s.team_name === team.team_name).length})
        ON CONFLICT (team_name) DO UPDATE SET
          description = COALESCE(EXCLUDED.description, teams.description),
          member_count = GREATEST(teams.member_count, EXCLUDED.member_count),
          metadata = jsonb_set(
            teams.metadata,
            '{message_count}',
            ${team.message_count}::text::jsonb
          )
      `;
    }

    // 3. Insert skills (delete-first for idempotent reparse)
    await sql`DELETE FROM session_skills WHERE session_id = ${sessionId}`;
    for (const skill of parseResult.skills) {
      await sql`
        INSERT INTO session_skills (id, session_id, skill_name, invoked_at, invoked_by, args)
        VALUES (${ulid()}, ${sessionId}, ${skill.skill_name}, ${skill.invoked_at},
          ${skill.invoked_by}, ${skill.args ?? null})
      `;
    }

    // 4. Insert worktrees (delete-first for idempotent reparse)
    await sql`DELETE FROM session_worktrees WHERE session_id = ${sessionId}`;
    for (const wt of parseResult.worktrees) {
      await sql`
        INSERT INTO session_worktrees (id, session_id, worktree_name, created_at)
        VALUES (${ulid()}, ${sessionId}, ${wt.worktree_name ?? null}, ${wt.created_at})
      `;
    }

    // 5. Update session metadata
    const updates: Record<string, unknown> = {};
    if (parseResult.permission_mode) updates.permission_mode = parseResult.permission_mode;
    if (parseResult.teams.length > 0) {
      updates.team_name = parseResult.teams[0].team_name;
      updates.team_role = 'lead'; // parser only runs for the main session
    }
    if (parseResult.resumed_from_session_id) {
      updates.resumed_from_session_id = parseResult.resumed_from_session_id;
    }

    if (Object.keys(updates).length > 0) {
      // Build dynamic UPDATE — use the pattern from existing code
      await sql`
        UPDATE sessions SET
          permission_mode = COALESCE(${updates.permission_mode ?? null}, permission_mode),
          team_name = COALESCE(${updates.team_name ?? null}, team_name),
          team_role = COALESCE(${updates.team_role ?? null}, team_role),
          resumed_from_session_id = COALESCE(${updates.resumed_from_session_id ?? null}, resumed_from_session_id)
        WHERE id = ${sessionId}
      `;
    }

    // 6. Update subagent_count on session
    if (parseResult.subagents.length > 0) {
      await sql`
        UPDATE sessions SET subagent_count = (
          SELECT COUNT(*) FROM subagents WHERE session_id = ${sessionId}
        ) WHERE id = ${sessionId}
      `;
    }

  } catch (err) {
    // NON-FATAL: log warning but don't block pipeline
    logger.warn({ err, sessionId }, 'Failed to persist relationships — continuing pipeline');
  }
}
```

### Convergence Pattern

The upsert pattern on `subagents` is critical. Two data paths write to this table:

1. **Hooks** (real-time): `subagent-start` handler INSERTs with status='running', `subagent-stop` UPDATEs to status='completed'
2. **Parser** (retroactive): `persistRelationships()` UPSERTs with status='completed' and additional metadata from the transcript

The `ON CONFLICT (session_id, agent_id) DO UPDATE` with `COALESCE` ensures:
- If hook row exists: parser fills in missing fields (spawning_tool_use_id, model from transcript)
- If hook row doesn't exist: parser creates the complete row
- Either path results in the same final state

### Idempotent Reparse

For skills and worktrees, the `DELETE FROM ... WHERE session_id` before INSERT ensures that running `--reparse` produces clean results without duplicates. For subagents and teams, the upsert handles idempotency.

### Non-Fatal Requirement

The entire `persistRelationships()` function is wrapped in try/catch. If it fails for any reason:
- Log the error at WARN level
- Pipeline continues to step 6 (lifecycle transition)
- The session is still marked as 'parsed'
- Relationship data can be recovered by running `--reparse` later

## Relevant Files
- Modify: `packages/core/src/session-pipeline.ts`

## Success Criteria
1. **Hook then parser convergence**: Handler creates subagent row (status='running'), then pipeline upserts → one row with status='completed' and additional fields from transcript.
2. **Parser-only path**: No hook data exists, pipeline creates complete subagent/team/skill/worktree rows.
3. **Reparse idempotency**: Running pipeline twice on the same session produces identical DB state.
4. **Non-fatal**: Pipeline continues and session reaches 'parsed' even if `persistRelationships()` throws.
5. **Old sessions**: Sessions without sub-agents/teams/skills/worktrees have empty relationships (no errors, no null pointer issues).
6. **subagent_count updated**: Session's `subagent_count` column reflects actual count from subagents table.
7. **Team member_count**: Reflects count of subagents with matching team_name.
8. All existing pipeline tests pass.
