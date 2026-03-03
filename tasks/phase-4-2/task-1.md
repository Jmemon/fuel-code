# Task 1: Database Migration 005_session_relationships.sql

## Parallel Group: A

## Dependencies: None

## Description

Create migration `005_session_relationships.sql` that adds all database schema changes for Phase 4-2. This is a single migration file containing:

1. **New columns on `sessions`**: `resumed_from_session_id`, `team_name`, `team_role`, `permission_mode`
2. **New columns on `git_activity`**: `worktree_name`, `is_worktree`
3. **New table `subagents`**: Tracks every sub-agent spawned within a session
4. **New table `teams`**: Tracks agent team coordination units
5. **New table `session_skills`**: Tracks skill invocations
6. **New table `session_worktrees`**: Tracks worktree lifecycle
7. **New columns on `transcript_messages` and `content_blocks`**: `subagent_id` FK to subagents

### Critical Design Choices

- `subagents` has a **UNIQUE index** on `(session_id, agent_id)` — this is required for the upsert convergence pattern where hooks create rows and the pipeline upserts them.
- `teams` has a **UNIQUE constraint** on `team_name` — globally unique in Claude Code, not session-scoped.
- All new columns on existing tables (`sessions`, `git_activity`, `transcript_messages`, `content_blocks`) are **nullable** — no NOT NULL additions to populated tables.
- `ON DELETE CASCADE` on FKs from `subagents`, `session_skills`, `session_worktrees` to `sessions` — deleting a session cleans up related data.
- Partial indexes on `transcript_messages.subagent_id` and `content_blocks.subagent_id` — only index non-null values.

### Full SQL

```sql
-- Phase 4-2: Session relationships — sub-agents, teams, skills, worktrees

-- 1. New columns on sessions
ALTER TABLE sessions ADD COLUMN resumed_from_session_id TEXT REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN team_name TEXT;
ALTER TABLE sessions ADD COLUMN team_role TEXT CHECK (team_role IN ('lead', 'member'));
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;

-- 2. New columns on git_activity for worktree context
ALTER TABLE git_activity ADD COLUMN worktree_name TEXT;
ALTER TABLE git_activity ADD COLUMN is_worktree BOOLEAN DEFAULT false;

-- 3. Subagents table
CREATE TABLE subagents (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL,
  agent_type            TEXT NOT NULL,
  agent_name            TEXT,
  model                 TEXT,
  spawning_tool_use_id  TEXT,
  team_name             TEXT,
  isolation             TEXT,
  run_in_background     BOOLEAN DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  transcript_s3_key     TEXT,
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_subagents_session_agent ON subagents(session_id, agent_id);
CREATE INDEX idx_subagents_session ON subagents(session_id);
CREATE INDEX idx_subagents_team ON subagents(team_name) WHERE team_name IS NOT NULL;

-- 4. Teams table
CREATE TABLE teams (
  id                TEXT PRIMARY KEY,
  team_name         TEXT NOT NULL UNIQUE,
  description       TEXT,
  lead_session_id   TEXT REFERENCES sessions(id),
  created_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  member_count      INTEGER DEFAULT 0,
  metadata          JSONB DEFAULT '{}'
);

CREATE INDEX idx_teams_lead ON teams(lead_session_id);

-- 5. Session skills table
CREATE TABLE session_skills (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_name    TEXT NOT NULL,
  invoked_at    TIMESTAMPTZ NOT NULL,
  invoked_by    TEXT,
  args          TEXT,
  metadata      JSONB DEFAULT '{}'
);

CREATE INDEX idx_session_skills_session ON session_skills(session_id);
CREATE INDEX idx_session_skills_name ON session_skills(skill_name);

-- 6. Session worktrees table
CREATE TABLE session_worktrees (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_name   TEXT,
  branch          TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  removed_at      TIMESTAMPTZ,
  had_changes     BOOLEAN,
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_session_worktrees_session ON session_worktrees(session_id);

-- 7. Subagent FK on transcript_messages and content_blocks
ALTER TABLE transcript_messages ADD COLUMN subagent_id TEXT REFERENCES subagents(id);
ALTER TABLE content_blocks ADD COLUMN subagent_id TEXT REFERENCES subagents(id);

CREATE INDEX idx_transcript_messages_subagent ON transcript_messages(subagent_id) WHERE subagent_id IS NOT NULL;
CREATE INDEX idx_content_blocks_subagent ON content_blocks(subagent_id) WHERE subagent_id IS NOT NULL;
```

## Relevant Files
- Create: `packages/server/src/db/migrations/005_session_relationships.sql`

## Success Criteria
1. Migration runs cleanly on a **fresh** database (all 5 migrations in sequence).
2. Migration runs cleanly on an **existing** database with data in all tables (ALTER TABLE on populated tables).
3. All foreign key relationships are correct — inserting a subagent with a nonexistent session_id fails.
4. UNIQUE index on `subagents(session_id, agent_id)` works — inserting duplicate `(session_id, agent_id)` pair fails with conflict, `ON CONFLICT DO UPDATE` works.
5. UNIQUE constraint on `teams.team_name` works — duplicate team names fail.
6. `ON DELETE CASCADE` works — deleting a session deletes its subagents, skills, and worktrees.
7. Existing queries on `sessions`, `transcript_messages`, `content_blocks`, `git_activity` are unaffected — new nullable columns don't break anything.
8. `bun test` passes in `packages/server` after running the migration.
9. Rollback path: `DROP TABLE session_worktrees, session_skills, teams, subagents CASCADE; ALTER TABLE sessions DROP COLUMN resumed_from_session_id, DROP COLUMN team_name, DROP COLUMN team_role, DROP COLUMN permission_mode;` etc. (document but don't automate — migrations are forward-only).
