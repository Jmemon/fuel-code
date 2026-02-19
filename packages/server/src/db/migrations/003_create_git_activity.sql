-- git_activity: Stores processed git events with session correlation.
-- Populated by git event handlers (git.commit, git.push, git.checkout, git.merge).
-- session_id is nullable: git events outside an active CC session are "orphan" workspace-level activity.

CREATE TABLE git_activity (
  id TEXT PRIMARY KEY,                            -- same ULID as the event
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  session_id TEXT REFERENCES sessions(id),        -- nullable: orphan git events have NULL
  type TEXT NOT NULL CHECK (type IN ('commit', 'push', 'checkout', 'merge')),
  branch TEXT,
  commit_sha TEXT,
  message TEXT,
  files_changed INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  timestamp TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_git_activity_workspace ON git_activity(workspace_id);
CREATE INDEX idx_git_activity_session ON git_activity(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_git_activity_timestamp ON git_activity(timestamp DESC);
CREATE INDEX idx_git_activity_type ON git_activity(type);
CREATE INDEX idx_git_activity_workspace_time ON git_activity(workspace_id, timestamp DESC);
