-- Phase 4-2: Session relationships — sub-agents, teams, skills, worktrees
-- Adds schema support for tracking Claude Code's multi-agent features:
--   - Session resume chains (resumed_from_session_id)
--   - Agent teams with lead/member roles
--   - Sub-agent spawning within sessions
--   - Skill invocations (e.g., /commit, /review-pr)
--   - Worktree lifecycle tracking
--   - Subagent attribution on transcript messages and content blocks

-- ============================================================================
-- 1. NEW COLUMNS ON SESSIONS
-- resumed_from_session_id: links a resumed session back to its predecessor.
-- team_name / team_role / permission_mode: agent team coordination context.
-- All nullable — existing sessions predate these features.
-- ============================================================================
ALTER TABLE sessions ADD COLUMN resumed_from_session_id TEXT REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN team_name TEXT;
ALTER TABLE sessions ADD COLUMN team_role TEXT CHECK (team_role IN ('lead', 'member'));
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;

-- ============================================================================
-- 2. NEW COLUMNS ON GIT_ACTIVITY
-- worktree_name: which worktree this git activity occurred in (NULL = main).
-- is_worktree: quick boolean filter for worktree-related activity.
-- ============================================================================
ALTER TABLE git_activity ADD COLUMN worktree_name TEXT;
ALTER TABLE git_activity ADD COLUMN is_worktree BOOLEAN DEFAULT false;

-- ============================================================================
-- 3. SUBAGENTS TABLE
-- Tracks every sub-agent spawned within a session. Claude Code can spawn
-- background agents, task agents, etc. The UNIQUE index on (session_id,
-- agent_id) supports the upsert convergence pattern: the first event for a
-- sub-agent inserts, subsequent events update status/metadata.
-- ============================================================================
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

-- ============================================================================
-- 4. TEAMS TABLE
-- Tracks agent team coordination units. team_name is globally unique — it's
-- the human-readable identifier used across sessions/sub-agents. lead_session_id
-- points to the session that created/leads the team.
-- ============================================================================
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

-- ============================================================================
-- 5. SESSION SKILLS TABLE
-- Tracks skill invocations within a session (e.g., /commit, /review-pr).
-- skill_name is the slash-command name, invoked_by identifies the actor
-- (human or sub-agent), args captures the raw argument string.
-- ============================================================================
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

-- ============================================================================
-- 6. SESSION WORKTREES TABLE
-- Tracks worktree lifecycle within a session. Claude Code can create isolated
-- git worktrees for parallel work; this table records creation, removal, and
-- whether the worktree had uncommitted changes when removed.
-- ============================================================================
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

-- ============================================================================
-- 7. SUBAGENT FK ON TRANSCRIPT_MESSAGES AND CONTENT_BLOCKS
-- Links individual messages/blocks to the sub-agent that produced them.
-- Partial indexes exclude NULLs since most rows belong to the main agent.
-- ============================================================================
ALTER TABLE transcript_messages ADD COLUMN subagent_id TEXT REFERENCES subagents(id);
ALTER TABLE content_blocks ADD COLUMN subagent_id TEXT REFERENCES subagents(id);

CREATE INDEX idx_transcript_messages_subagent ON transcript_messages(subagent_id) WHERE subagent_id IS NOT NULL;
CREATE INDEX idx_content_blocks_subagent ON content_blocks(subagent_id) WHERE subagent_id IS NOT NULL;
