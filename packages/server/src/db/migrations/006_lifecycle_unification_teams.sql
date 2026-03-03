-- Migration 006: Lifecycle unification and teams redesign
--
-- Consolidates the session lifecycle state machine, removes the separate
-- parse_status/parse_error columns (replaced by last_error), and rebuilds
-- the teams/teammates schema from scratch to support session-scoped,
-- transcript-derived team data instead of the previous global team_name model.
--
-- Changes:
--   1. Lifecycle CHECK constraint updated (adds transcript_ready, complete; removes capturing, archived)
--   2. Existing rows migrated: archived/summarized → complete, capturing → detected
--   3. parse_status + parse_error dropped; last_error added
--   4. Recovery index recreated for lifecycle = 'transcript_ready'
--   5. team_name, team_role dropped from sessions
--   6. resumed_from_session_id dropped from sessions
--   7. is_inferred added to subagents
--   8. teams table dropped and recreated (session-scoped, ULID PK)
--   9. teammates table created
--  10. subagents: team_name dropped, teammate_id FK added
--  11. transcript_messages: teammate_id FK added
--  12. content_blocks: teammate_id FK added

-- ============================================================================
-- 1 & 2. LIFECYCLE: migrate data then replace CHECK constraint
-- Must migrate data BEFORE changing the constraint, since the new constraint
-- won't accept the old values and vice versa.
-- ============================================================================

-- Migrate existing rows to new lifecycle values before swapping constraints.
-- archived and summarized both map to 'complete'; capturing maps to 'detected'.
UPDATE sessions SET lifecycle = 'complete' WHERE lifecycle IN ('archived', 'summarized');
UPDATE sessions SET lifecycle = 'detected' WHERE lifecycle = 'capturing';

-- Drop the old CHECK constraint. The constraint name comes from Postgres's
-- auto-naming convention: {table}_{column}_check.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_lifecycle_check;

-- Add the new CHECK constraint with the unified lifecycle states.
ALTER TABLE sessions ADD CONSTRAINT sessions_lifecycle_check
  CHECK (lifecycle IN ('detected', 'ended', 'transcript_ready', 'parsed', 'summarized', 'complete', 'failed'));

-- ============================================================================
-- 3. REPLACE parse_status/parse_error WITH last_error
-- The old two-column approach (parse_status + parse_error) is replaced by a
-- single last_error column. If last_error IS NOT NULL, the session had an error
-- during its last processing step. The lifecycle column itself now encodes
-- pipeline progress, making parse_status redundant.
-- ============================================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Preserve any existing parse_error values before dropping the columns.
UPDATE sessions SET last_error = parse_error WHERE parse_error IS NOT NULL AND last_error IS NULL;

-- Drop the old recovery index first (it references parse_status).
DROP INDEX IF EXISTS idx_sessions_needs_recovery;

ALTER TABLE sessions DROP COLUMN IF EXISTS parse_status;
ALTER TABLE sessions DROP COLUMN IF EXISTS parse_error;

-- ============================================================================
-- 4. NEW RECOVERY INDEX
-- The backfill/recovery job needs to find sessions stuck in transcript_ready
-- (transcript downloaded but not yet parsed). Ordered by updated_at so the
-- oldest stuck sessions are retried first.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_needs_recovery
  ON sessions(lifecycle, updated_at)
  WHERE lifecycle = 'transcript_ready';

-- ============================================================================
-- 5. DROP team_name, team_role FROM sessions
-- Team membership is now tracked in the dedicated teammates table rather than
-- denormalized on sessions. permission_mode remains (it's session-level config).
-- ============================================================================

ALTER TABLE sessions DROP COLUMN IF EXISTS team_name;
ALTER TABLE sessions DROP COLUMN IF EXISTS team_role;

-- ============================================================================
-- 6. DROP resumed_from_session_id FROM sessions
-- Session resume chains are subsumed by the broader lifecycle model. The
-- worktree-based 006 migration added this; we're removing it here.
-- ============================================================================

ALTER TABLE sessions DROP COLUMN IF EXISTS resumed_from_session_id;

-- ============================================================================
-- 7. ADD is_inferred TO subagents
-- Marks subagents that were inferred from transcript analysis rather than
-- directly observed via events. Defaults to false for all existing rows.
-- ============================================================================

ALTER TABLE subagents ADD COLUMN IF NOT EXISTS is_inferred BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- 8. DROP AND RECREATE teams TABLE
-- The old teams table was globally scoped (team_name UNIQUE). The new design
-- is session-scoped: each session can independently record a team as observed
-- in its transcript. The compound unique constraint on (session_id, team_name,
-- created_at) allows the same team name to appear across sessions while
-- preventing duplicates within a session at the same timestamp.
-- ============================================================================

-- Drop the old teams table. Existing data was minimal and will be
-- reconstructed from transcripts going forward.
DROP TABLE IF EXISTS teams CASCADE;

CREATE TABLE teams (
  id              TEXT PRIMARY KEY,              -- ULID
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_name       TEXT NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB DEFAULT '{}'
);

-- Compound unique: one team_name per session per creation timestamp.
CREATE UNIQUE INDEX idx_teams_session_name_created
  ON teams(session_id, team_name, created_at);

CREATE INDEX idx_teams_session ON teams(session_id);

-- ============================================================================
-- 9. CREATE teammates TABLE
-- Represents individual entities (human, agent, subagent) participating in a
-- team within a session. summary stores the per-entity LLM-generated summary.
-- ============================================================================

CREATE TABLE IF NOT EXISTS teammates (
  id              TEXT PRIMARY KEY,              -- ULID
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('lead', 'member')),
  entity_type     TEXT NOT NULL CHECK (entity_type IN ('human', 'agent', 'subagent')),
  entity_name     TEXT,
  summary         TEXT,                          -- per-entity LLM summary
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_teammates_team ON teammates(team_id);
CREATE INDEX idx_teammates_session ON teammates(session_id);

-- ============================================================================
-- 10. SUBAGENTS: drop team_name, add teammate_id FK
-- Replaces the string-based team_name with a proper FK to teammates.
-- ON DELETE SET NULL: if a teammate is removed, the subagent row stays intact.
-- ============================================================================

-- Drop the old team_name index and column.
DROP INDEX IF EXISTS idx_subagents_team;
ALTER TABLE subagents DROP COLUMN IF EXISTS team_name;

-- Add the new FK to teammates.
ALTER TABLE subagents ADD COLUMN IF NOT EXISTS teammate_id TEXT REFERENCES teammates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_subagents_teammate ON subagents(teammate_id) WHERE teammate_id IS NOT NULL;

-- ============================================================================
-- 11. TRANSCRIPT_MESSAGES: add teammate_id FK
-- Links a transcript message to the teammate that produced it.
-- ON DELETE SET NULL: dropping teammates leaves transcript data intact.
-- ============================================================================

ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS teammate_id TEXT REFERENCES teammates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_messages_teammate ON transcript_messages(teammate_id) WHERE teammate_id IS NOT NULL;

-- ============================================================================
-- 12. CONTENT_BLOCKS: add teammate_id FK
-- Links a content block to the teammate that produced it.
-- ON DELETE SET NULL: dropping teammates leaves content block data intact.
-- ============================================================================

ALTER TABLE content_blocks ADD COLUMN IF NOT EXISTS teammate_id TEXT REFERENCES teammates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_blocks_teammate ON content_blocks(teammate_id) WHERE teammate_id IS NOT NULL;
