-- Phase 1 Schema: Core tables for fuel-code
-- Creates the foundational tables: workspaces, devices, workspace_devices, sessions, events
-- Plus indexes for common query patterns (timeline, filtering, GIN for tags)

-- ============================================================================
-- WORKSPACES
-- A workspace is a git repository (identified by its canonical remote URL).
-- canonical_id is derived from the git remote and is the stable identifier
-- across devices. display_name is the human-readable repo name.
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT PRIMARY KEY,
    canonical_id    TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    default_branch  TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- DEVICES
-- A device is a machine where coding happens — either a local laptop/desktop
-- or a remote environment (EC2, codespace, etc.). type is constrained to
-- 'local' or 'remote'. status tracks whether the device is currently reachable.
-- ============================================================================
CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('local', 'remote')),
    hostname        TEXT,
    os              TEXT,
    arch            TEXT,
    status          TEXT NOT NULL DEFAULT 'online'
                    CHECK (status IN ('online', 'offline', 'provisioning', 'terminated')),
    metadata        JSONB NOT NULL DEFAULT '{}',
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- WORKSPACE_DEVICES
-- Junction table linking workspaces to devices. Tracks where a workspace is
-- checked out (local_path), whether hooks are installed, and when it was last
-- active on that device. Composite PK: (workspace_id, device_id).
-- ============================================================================
CREATE TABLE IF NOT EXISTS workspace_devices (
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    device_id       TEXT NOT NULL REFERENCES devices(id),
    local_path      TEXT NOT NULL,
    hooks_installed BOOLEAN NOT NULL DEFAULT false,
    git_hooks_installed BOOLEAN NOT NULL DEFAULT false,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, device_id)
);

-- ============================================================================
-- SESSIONS
-- A session represents one continuous coding interaction (e.g., one Claude Code
-- session). Links to a workspace and device. lifecycle tracks the session's
-- state machine progression. Metrics columns (total_messages, tokens_*, etc.)
-- are populated by the transcript parser after the session ends.
--
-- remote_env_id is nullable and has no FK constraint here — the remote_envs
-- table will be created in Phase 5, and an ALTER TABLE will add the FK then.
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    device_id       TEXT NOT NULL REFERENCES devices(id),
    remote_env_id   TEXT, -- FK to remote_envs added in Phase 5 migration
    lifecycle       TEXT NOT NULL DEFAULT 'detected'
                    CHECK (lifecycle IN ('detected', 'capturing', 'ended', 'parsed', 'summarized', 'archived', 'failed')),
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    end_reason      TEXT,
    initial_prompt  TEXT,
    git_branch      TEXT,
    model           TEXT,
    source          TEXT,
    transcript_s3_key TEXT,
    parse_status    TEXT DEFAULT 'pending'
                    CHECK (parse_status IN ('pending', 'parsing', 'completed', 'failed')),
    parse_error     TEXT,
    summary         TEXT,
    total_messages      INTEGER,
    user_messages       INTEGER,
    assistant_messages  INTEGER,
    tool_use_count      INTEGER,
    thinking_blocks     INTEGER,
    subagent_count      INTEGER,
    tokens_in           BIGINT,
    tokens_out          BIGINT,
    cache_read_tokens   BIGINT,
    cache_write_tokens  BIGINT,
    cost_estimate_usd   NUMERIC(10, 6),
    duration_ms         INTEGER,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- EVENTS
-- Raw events ingested from the CLI (git commits, file saves, session starts,
-- etc.). Each event belongs to a workspace and device, and optionally to a
-- session. data holds the event-type-specific payload. blob_refs links to
-- S3 objects (transcripts, diffs, etc.).
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    timestamp       TIMESTAMPTZ NOT NULL,
    device_id       TEXT NOT NULL REFERENCES devices(id),
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    session_id      TEXT REFERENCES sessions(id),
    data            JSONB NOT NULL,
    blob_refs       JSONB NOT NULL DEFAULT '[]',
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- INDEXES
-- Optimized for common query patterns: timeline views, session filtering,
-- per-device/per-workspace lookups, and tag searches (GIN for arrays).
-- ============================================================================

-- Sessions: list by workspace (most recent first)
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, started_at DESC);

-- Sessions: list by device (most recent first)
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id, started_at DESC);

-- Sessions: filter by lifecycle state (e.g., "show all active sessions")
CREATE INDEX IF NOT EXISTS idx_sessions_lifecycle ON sessions(lifecycle);

-- Sessions: search/filter by tags using GIN (supports @> operator for array containment)
CREATE INDEX IF NOT EXISTS idx_sessions_tags ON sessions USING GIN(tags);

-- Events: timeline view for a workspace (most recent first)
CREATE INDEX IF NOT EXISTS idx_events_workspace_time ON events(workspace_id, timestamp DESC);

-- Events: list events for a session (chronological order, partial index skips NULLs)
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp ASC) WHERE session_id IS NOT NULL;

-- Events: filter by event type (e.g., "show all git.commit events")
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, timestamp DESC);

-- Events: list events for a device (most recent first)
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, timestamp DESC);
