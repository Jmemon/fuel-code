# fuel-code

## Vision

A CLI-first developer activity tracking system that captures, stores, and surfaces Claude Code sessions as the primary unit of work. Events from local and remote machines flow through a unified pipeline to a central backend. Remote dev environments are disposable EC2+Docker instances provisioned via CLI. The system is designed so that an analytical layer (prompt extraction, workflow clustering, skill derivation) can be added on top of the operational data without changing any V1 abstractions.

**Core value**: Every Claude Code session you run — anywhere, on any machine — is captured, parsed, summarized, and queryable. Git activity is tracked alongside sessions for full context. Remote environments let you run experiments in isolation while events still flow back to the same system.

---

## Five Abstractions

Everything in the system is built from five concepts.

### 1. Workspace

The organizing principle. A Workspace is a project — almost always a git repo — that you work on across one or more machines.

**Identity**: Canonical ID derived from the normalized git remote URL. This is deterministic and computed client-side without a server round-trip.

```
Normalization rules:
  git@github.com:user/repo.git     → github.com/user/repo
  https://github.com/user/repo.git → github.com/user/repo
  ssh://git@github.com/user/repo   → github.com/user/repo

Strip protocol, strip .git suffix, strip auth prefix, lowercase host.
```

**Edge cases**:
- Repos with multiple remotes: use `origin`. If no `origin`, first remote alphabetically. All remotes stored in metadata.
- Repos with no remote (local-only): use `local:<sha256(first-commit-hash)>`. Migrates to remote-based ID when a remote is added.
- Non-repo directories (`~/scratch`): belong to `_unassociated` workspace — a synthetic singleton. Sessions here are captured but shown separately.
- Forks: different canonical IDs (different user/org). Correct — forks are different workspaces.

**What it knows**: All Sessions across all Devices, git activity summary, active RemoteEnvs, tracking status per Device, environment manifest.

### 2. Session

The primary view. A single Claude Code invocation from start to finish.

**Identity**: Claude Code's own session ID (provided via `$CLAUDE_SESSION_ID` in hook context). This is the primary key.

**Lifecycle state machine**:

```
detected → capturing → ended → parsed → summarized → archived
              │          │        │          │
              └──► failed └► failed └► failed  └──► (terminal)
```

- **detected**: SessionStart hook fired. Minimal record created.
- **capturing**: Events streaming in. Session is live. Transcript being written by CC.
- **ended**: SessionEnd/Stop hook fired. CC process exited. Transcript upload to S3 triggered.
- **parsed**: Raw JSONL transcript processed into structured messages, content blocks, and tool results in Postgres. Aggregate stats computed.
- **summarized**: LLM-generated summary stored. Session is fully queryable.
- **archived**: Parsed message rows pruned from Postgres (retained in S3). Summary, stats, and metadata remain. Cost-optimization for old sessions.

**Association rules**:
- A Session belongs to exactly **one Workspace** (determined by CWD at session start).
- A Session belongs to exactly **one Device** (the machine it ran on).
- A Session optionally belongs to a RemoteEnv (if it ran on a provisioned remote device).

**What it stores**: CC session ID, workspace_id, device_id, start/end time, lifecycle status, transcript S3 key, LLM summary, initial prompt, stats (tool call counts, tokens, commits made, files modified, cost estimate), metadata.

### 3. Event

The atomic unit of activity data. Immutable, append-only, timestamped.

**Identity**: ULID — lexicographically sortable, embeds creation timestamp, no coordination needed across devices. Generated client-side.

**Structure**:

```typescript
interface Event {
  // Identity
  id: string;                  // ULID, generated at capture time
  type: EventType;             // dot-notation: "session.start", "git.commit", etc.
  timestamp: string;           // ISO-8601, from originating machine's clock

  // Attribution
  device_id: string;           // which machine emitted this
  workspace_id: string;        // which workspace this relates to
  session_id: string | null;   // which CC session (nullable — git events outside sessions)

  // Payload
  data: Record<string, unknown>; // type-specific payload, validated by Zod schema per type

  // Storage metadata (set server-side)
  ingested_at: string | null;  // when the backend received this
  blob_refs: BlobRef[];        // S3 keys for large payloads (transcripts, diffs)
}
```

**Design decisions**:
- `session_id` is **nullable**: Git commits, pushes, and checkouts can happen outside CC sessions. These events still have a `workspace_id`.
- `blob_refs` for large payloads: Tool results and transcripts can be megabytes. The event carries S3 references; the blob lives in S3. The event stream stays lean.
- Events are **never updated or deleted** (except by TTL-based data retention, if added later).

### 4. Device

A machine that reports events. Local laptops and remote EC2 instances are symmetric — same hooks, same events, same processing.

**Identity**: Generated on first `fuel-code init`, stored in `~/.fuel-code/device.json`. A ULID plus a human-friendly name (defaulting to hostname, user-editable).

**Types**:
- `local`: Your laptop, desktop, etc. Persistent. Survives reboots.
- `remote`: An EC2 instance provisioned by `fuel-code remote up`. Ephemeral. Destroyed on termination.

**Remote Device sub-lifecycle**: `provisioning` → `ready` → `active` (has live session) → `idle` → `terminated`

**What it stores**: ID, friendly name, type (`local`/`remote`), hostname, OS/arch, status, last seen timestamp, metadata (CC version, bun version).

**Symmetry principle**: The backend does not distinguish between events from local and remote devices. The processing pipeline is identical. A remote Device emits `session.start` the same way a local Device does. This means adding a new machine to the topology is just "install fuel-code, run init, events flow."

### 5. Blueprint

A recipe for creating a remote Device. The `.fuel-code/env.yaml` file.

**Lifecycle**: Auto-detect scans project → generates `.fuel-code/env.yaml` → user reviews/edits → committed to repo → used to provision EC2 instance with Docker.

**Structure**:

```yaml
# .fuel-code/env.yaml — auto-generated, human-reviewed, committed to repo
runtime: node
version: "22"
package_manager: bun

system_deps:
  - postgresql-client
  - redis-tools

docker:
  base_image: "node:22-bookworm"
  additional_packages: []

resources:
  instance_type: t3.xlarge
  region: us-east-1
  disk_gb: 50

environment:
  NODE_ENV: development

ports:
  - 3000
  - 5432

setup:
  - bun install
```

**Why a separate abstraction**: Different projects need radically different environments. A Python ML project needs CUDA drivers and a GPU instance. A Node API needs nothing special. The Blueprint captures this per-workspace. It's also inspectable (`fuel-code blueprint show`) and versioned (committed to the repo).

---

## How They Relate

```
Workspace (github.com/johnmemon/fuel-code)
│
├── Session A (ran on macbook-pro, 45 min, "fixed auth middleware")
│   ├── Event: session.start
│   ├── Event: git.commit "fix auth bug" ← linked to session
│   ├── Event: git.commit "add auth tests" ← linked to session
│   ├── Event: session.end
│   └── Parsed Transcript:
│       ├── transcript_messages (30 rows)
│       ├── content_blocks (120 rows)
│       └── tool_results (47 rows)
│
├── Session B (ran on remote-abc, 2 hours, "load testing")
│   ├── Event: session.start
│   ├── Event: session.end
│   └── Parsed Transcript: ...
│
├── Event: git.push main → origin (no session — pushed from terminal)
│
├── Devices:
│   ├── macbook-pro (local, online)
│   └── remote-abc (remote, terminated)
│
└── Blueprint: .fuel-code/env.yaml (t3.xlarge, node:22, bun)
```

---

## Event Types

Dot-notation hierarchy. Two levels: `domain.action`.

```
session.start           CC session began
session.end             CC session ended
session.compact         CC session was compacted (context window reset)

git.commit              Commit created
git.push                Pushed to remote
git.checkout            Branch switched
git.merge               Merge completed

remote.provision.start  EC2 provisioning began
remote.provision.ready  EC2 + Docker ready, SSH available
remote.provision.error  Provisioning failed
remote.terminate        Remote device terminated

system.device.register  New device contacted the backend
system.hooks.installed  Hooks installed in a workspace
system.heartbeat        Periodic health ping from a device
```

### Event Payloads (Zod-validated per type)

```typescript
// session.start
interface SessionStartPayload {
  cc_session_id: string;         // Claude Code's session ID
  cwd: string;                   // working directory
  git_branch: string | null;     // current branch if in a git repo
  git_remote: string | null;     // remote URL for workspace resolution
  cc_version: string;            // Claude Code version
  model: string | null;          // model being used
  source: string;                // "startup" | "resume" | "clear" | "compact"
  transcript_path: string;       // path to CC's JSONL transcript file
}

// session.end
interface SessionEndPayload {
  cc_session_id: string;
  duration_ms: number;
  end_reason: string;            // "exit" | "clear" | "logout" | "crash"
  transcript_path: string;       // path to JSONL file for upload
}

// session.compact
interface SessionCompactPayload {
  cc_session_id: string;
  compact_sequence: number;      // 0 = original, 1 = first compact, etc.
  transcript_path: string;       // path to JSONL, for mid-session backup
}

// git.commit
interface GitCommitPayload {
  hash: string;
  message: string;
  author_name: string;
  author_email: string;
  branch: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  file_list: { path: string; status: string }[];
}

// git.push
interface GitPushPayload {
  branch: string;
  remote: string;
  commit_count: number;
  commits: string[];             // list of pushed commit hashes
}

// git.checkout
interface GitCheckoutPayload {
  from_ref: string;
  to_ref: string;
  from_branch: string | null;
  to_branch: string | null;
}

// git.merge
interface GitMergePayload {
  merge_commit: string;
  message: string;
  merged_branch: string;
  into_branch: string;
  files_changed: number;
  had_conflicts: boolean;
}

// remote.provision.ready
interface RemoteProvisionReadyPayload {
  instance_id: string;
  public_ip: string;
  ssh_port: number;
  device_id: string;             // the new remote device's ID
}

// remote.terminate
interface RemoteTerminatePayload {
  instance_id: string;
  reason: string;                // "manual" | "ttl" | "idle" | "error"
  uptime_seconds: number;
  total_cost_usd: number | null;
}
```

---

## Data Model — Postgres Schema

```sql
-- ============================================================
-- Workspaces: the organizing principle
-- ============================================================
CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,        -- ULID
    canonical_id    TEXT NOT NULL UNIQUE,     -- normalized git remote URL
    display_name    TEXT NOT NULL,            -- derived from repo name
    default_branch  TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    -- metadata: { all_remotes: [], languages: [], description: "" }
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Devices: machines that report events
-- ============================================================
CREATE TABLE devices (
    id              TEXT PRIMARY KEY,        -- ULID, generated client-side
    name            TEXT NOT NULL,            -- user-friendly name
    type            TEXT NOT NULL CHECK (type IN ('local', 'remote')),
    hostname        TEXT,
    os              TEXT,                     -- "darwin", "linux"
    arch            TEXT,                     -- "arm64", "x86_64"
    status          TEXT NOT NULL DEFAULT 'online'
                    CHECK (status IN ('online', 'offline', 'provisioning', 'terminated')),
    metadata        JSONB NOT NULL DEFAULT '{}',
    -- metadata: { cc_version, bun_version, node_version }
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Workspace-Device tracking: which workspaces are tracked where
-- ============================================================
CREATE TABLE workspace_devices (
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    device_id       TEXT NOT NULL REFERENCES devices(id),
    local_path      TEXT NOT NULL,           -- absolute path on that device
    hooks_installed BOOLEAN NOT NULL DEFAULT false,
    git_hooks_installed BOOLEAN NOT NULL DEFAULT false,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, device_id)
);

-- ============================================================
-- Sessions: Claude Code invocations (the primary view)
-- ============================================================
CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,        -- CC's session ID (text, not UUID)
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    device_id       TEXT NOT NULL REFERENCES devices(id),
    remote_env_id   TEXT REFERENCES remote_envs(id),

    -- Lifecycle
    lifecycle       TEXT NOT NULL DEFAULT 'detected'
                    CHECK (lifecycle IN (
                        'detected', 'capturing', 'ended',
                        'parsed', 'summarized', 'archived', 'failed'
                    )),
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    end_reason      TEXT,                    -- "exit" | "clear" | "logout" | "crash"

    -- Context
    initial_prompt  TEXT,                    -- first user message or --task prompt
    git_branch      TEXT,                    -- branch at session start
    model           TEXT,                    -- claude model used
    source          TEXT,                    -- "startup" | "resume" | "clear" | "compact"

    -- Transcript storage
    transcript_s3_key TEXT,                  -- S3 key for raw JSONL
    parse_status    TEXT DEFAULT 'pending'
                    CHECK (parse_status IN ('pending', 'parsing', 'completed', 'failed')),
    parse_error     TEXT,                    -- error message if parse_status = 'failed'

    -- LLM summary
    summary         TEXT,                    -- 1-3 sentence past-tense summary

    -- Aggregate stats (computed after parsing)
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

    -- Extensible
    tags            TEXT[] NOT NULL DEFAULT '{}',
    metadata        JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, started_at DESC);
CREATE INDEX idx_sessions_device ON sessions(device_id, started_at DESC);
CREATE INDEX idx_sessions_lifecycle ON sessions(lifecycle);
CREATE INDEX idx_sessions_tags ON sessions USING GIN(tags);

-- ============================================================
-- Events: immutable, append-only activity log
-- ============================================================
CREATE TABLE events (
    id              TEXT PRIMARY KEY,        -- ULID, client-generated
    type            TEXT NOT NULL,           -- dot-notation: "session.start", "git.commit"
    timestamp       TIMESTAMPTZ NOT NULL,    -- when it happened on source machine
    device_id       TEXT NOT NULL REFERENCES devices(id),
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    session_id      TEXT REFERENCES sessions(id), -- nullable for events outside CC sessions
    data            JSONB NOT NULL,          -- type-specific payload
    blob_refs       JSONB NOT NULL DEFAULT '[]', -- S3 keys for large payloads
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_workspace_time ON events(workspace_id, timestamp DESC);
CREATE INDEX idx_events_session ON events(session_id, timestamp ASC) WHERE session_id IS NOT NULL;
CREATE INDEX idx_events_type ON events(type, timestamp DESC);
CREATE INDEX idx_events_device ON events(device_id, timestamp DESC);

-- ============================================================
-- Parsed transcript: messages (one row per JSONL line)
-- ============================================================
CREATE TABLE transcript_messages (
    id              TEXT PRIMARY KEY,        -- ULID
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    line_number     INTEGER NOT NULL,        -- position in JSONL file
    ordinal         INTEGER NOT NULL,        -- conversation order (may differ from line_number)
    message_type    TEXT NOT NULL,           -- "user" | "assistant" | "system" | "summary"
    role            TEXT,                    -- "human" | "assistant" | "system"
    model           TEXT,                    -- model that generated this (assistant messages)
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    cache_read      INTEGER,
    cache_write     INTEGER,
    cost_usd        NUMERIC(10, 6),
    compact_sequence INTEGER NOT NULL DEFAULT 0, -- 0 = original, 1+ = after compactions
    is_compacted    BOOLEAN NOT NULL DEFAULT false, -- true if from a prior compaction run
    timestamp       TIMESTAMPTZ,
    raw_message     JSONB,                   -- full raw JSONB from transcript for lossless reconstruction
    metadata        JSONB NOT NULL DEFAULT '{}',

    -- Content flags for quick filtering
    has_text        BOOLEAN NOT NULL DEFAULT false,
    has_thinking    BOOLEAN NOT NULL DEFAULT false,
    has_tool_use    BOOLEAN NOT NULL DEFAULT false,
    has_tool_result BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_transcript_msg_session ON transcript_messages(session_id, ordinal);
CREATE INDEX idx_transcript_msg_compact ON transcript_messages(session_id, compact_sequence);

-- ============================================================
-- Parsed transcript: content blocks within messages
-- ============================================================
CREATE TABLE content_blocks (
    id              TEXT PRIMARY KEY,        -- ULID
    message_id      TEXT NOT NULL REFERENCES transcript_messages(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    block_order     INTEGER NOT NULL,        -- position within the message
    block_type      TEXT NOT NULL,           -- "text" | "thinking" | "tool_use" | "tool_result"

    -- Text / thinking content
    content_text    TEXT,                    -- text content (for search)
    thinking_text   TEXT,                    -- thinking block content

    -- Tool use fields
    tool_name       TEXT,                    -- e.g., "Read", "Edit", "Bash"
    tool_use_id     TEXT,                    -- CC's tool_use_id for linking to results
    tool_input      JSONB,                   -- tool input parameters

    -- Tool result fields
    tool_result_id  TEXT,                    -- links back to tool_use_id
    is_error        BOOLEAN DEFAULT false,
    result_text     TEXT,                    -- truncated result for display
    result_s3_key   TEXT,                    -- S3 key if result was too large

    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_content_blocks_message ON content_blocks(message_id, block_order);
CREATE INDEX idx_content_blocks_session ON content_blocks(session_id);
CREATE INDEX idx_content_blocks_tool ON content_blocks(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX idx_content_blocks_text ON content_blocks USING GIN(to_tsvector('english', content_text))
    WHERE content_text IS NOT NULL;

-- ============================================================
-- Git activity: denormalized convenience table for fast queries
-- Populated by the event processor when git events are ingested
-- ============================================================
CREATE TABLE git_activity (
    id              TEXT PRIMARY KEY,        -- same as the event ID
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    device_id       TEXT NOT NULL REFERENCES devices(id),
    session_id      TEXT REFERENCES sessions(id), -- which CC session made this, if any
    type            TEXT NOT NULL,           -- "commit" | "push" | "checkout" | "merge"
    branch          TEXT,
    commit_sha      TEXT,
    message         TEXT,
    files_changed   INTEGER,
    insertions      INTEGER,
    deletions       INTEGER,
    timestamp       TIMESTAMPTZ NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_git_workspace ON git_activity(workspace_id, timestamp DESC);
CREATE INDEX idx_git_session ON git_activity(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_git_sha ON git_activity(commit_sha) WHERE commit_sha IS NOT NULL;

-- ============================================================
-- Remote environments: disposable cloud dev boxes
-- ============================================================
CREATE TABLE remote_envs (
    id              TEXT PRIMARY KEY,        -- ULID
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
    device_id       TEXT REFERENCES devices(id), -- the EC2 instance's device identity
    status          TEXT NOT NULL DEFAULT 'provisioning'
                    CHECK (status IN (
                        'provisioning', 'ready', 'active', 'idle', 'terminated', 'error'
                    )),
    instance_id     TEXT,                    -- EC2 instance ID
    instance_type   TEXT NOT NULL,
    region          TEXT NOT NULL,
    public_ip       TEXT,
    ssh_key_s3_key  TEXT,                    -- S3 key for ephemeral SSH key
    blueprint       JSONB NOT NULL,          -- snapshot of env.yaml used to provision
    ttl_minutes     INTEGER NOT NULL DEFAULT 480, -- 8 hours default
    idle_timeout_minutes INTEGER NOT NULL DEFAULT 60,
    cost_per_hour_usd NUMERIC(6, 3),
    total_cost_usd  NUMERIC(8, 3),
    provisioned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ready_at        TIMESTAMPTZ,
    terminated_at   TIMESTAMPTZ,
    termination_reason TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_remote_envs_workspace ON remote_envs(workspace_id);
CREATE INDEX idx_remote_envs_active ON remote_envs(status) WHERE status NOT IN ('terminated', 'error');

-- ============================================================
-- Blueprints: saved environment configurations
-- ============================================================
CREATE TABLE blueprints (
    id              TEXT PRIMARY KEY,        -- ULID
    workspace_id    TEXT REFERENCES workspaces(id), -- null for global/template blueprints
    name            TEXT NOT NULL,
    source          TEXT NOT NULL,           -- "auto-detected" | "manual"
    detected_from   TEXT,                    -- repo path or URL that was scanned
    config          JSONB NOT NULL,          -- full env.yaml content as JSON
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## S3 Storage Layout

```
fuel-code-blobs/
├── transcripts/
│   └── {workspace_canonical_id}/
│       └── {session_id}/
│           ├── raw.jsonl                    # Full JSONL transcript (source of truth, never deleted)
│           └── parsed.json                  # Backup of parsed hierarchy (for archive recovery)
│
├── artifacts/
│   └── {session_id}/
│       └── {artifact_id}.{ext}              # Screenshots, large tool outputs, generated files
│
├── ssh-keys/
│   └── {remote_env_id}/
│       ├── id_ed25519                       # Ephemeral private key
│       └── id_ed25519.pub                   # Ephemeral public key
│
└── manifests/
    └── {workspace_canonical_id}/
        └── env.yaml                         # Cached environment manifest
```

**Storage rules**:
- Raw transcripts go to S3 always (they can be megabytes). Never deleted.
- Parsed transcript data lives in Postgres for querying. Pruned on archive (sessions older than configurable TTL). Recoverable from S3.
- Tool results > 256KB go to S3 with a reference in `content_blocks.result_s3_key`.
- Everything else stays in Postgres JSONB.

---

## Event Pipeline

```
┌──────────────────────┐
│   Any Machine         │
│   (local or remote)   │
│                       │
│  CC Hook fires ──┐    │
│  Git Hook fires ─┤    │
│                  ▼    │
│  fuel-code emit       │
│       │               │
│       ├─ HTTP POST ───┼──────────────────────────┐
│       │  to Railway    │                          │
│       │               │                          │
│       └─ Local Queue  │  (fallback if POST fails) │
│          ~/.fuel-code/ │                          │
│          queue/        │                          │
│                       │                          │
│  Queue Drainer ───────┼──── retries ─────────────┤
│  (background, every   │                          │
│   30s when events     │                          │
│   are queued)         │                          │
└───────────────────────┘                          │
                                                    ▼
                              ┌──────────────────────────────────┐
                              │   Railway Backend                 │
                              │                                   │
                              │   POST /api/events/ingest         │
                              │       │                           │
                              │       ▼                           │
                              │   Validate (Zod)                  │
                              │       │                           │
                              │       ▼                           │
                              │   Redis Stream                    │
                              │   XADD "events:incoming"          │
                              │       │                           │
                              │       ▼                           │
                              │   Event Processor                 │
                              │   (Redis consumer group)          │
                              │       │                           │
                              │       ├──► Resolve/create         │
                              │       │    Workspace & Device     │
                              │       │                           │
                              │       ├──► INSERT into events     │
                              │       │    table (Postgres)       │
                              │       │                           │
                              │       ├──► Type-specific handler: │
                              │       │    session.start → create │
                              │       │      session record       │
                              │       │    session.end → update   │
                              │       │      session, trigger     │
                              │       │      transcript parse     │
                              │       │    git.commit → upsert    │
                              │       │      git_activity row     │
                              │       │                           │
                              │       ├──► Upload blobs to S3     │
                              │       │    (if applicable)        │
                              │       │                           │
                              │       └──► WebSocket broadcast    │
                              │            to connected clients   │
                              │                                   │
                              │   Post-processing pipeline:       │
                              │   ┌─────────────────────────┐    │
                              │   │ Transcript Parser        │    │
                              │   │ (triggered by session.end)│    │
                              │   │                          │    │
                              │   │ 1. Download JSONL from S3│    │
                              │   │ 2. Parse into messages,  │    │
                              │   │    content_blocks        │    │
                              │   │ 3. Compute session stats │    │
                              │   │ 4. Update session record │    │
                              │   └──────────┬──────────────┘    │
                              │              │                    │
                              │              ▼                    │
                              │   ┌─────────────────────────┐    │
                              │   │ Summary Generator        │    │
                              │   │ (triggered after parsing) │    │
                              │   │                          │    │
                              │   │ 1. Render messages as MD │    │
                              │   │ 2. Call Claude Sonnet    │    │
                              │   │ 3. Store summary on      │    │
                              │   │    session record        │    │
                              │   │ 4. Transition session to │    │
                              │   │    "summarized"          │    │
                              │   └─────────────────────────┘    │
                              └──────────────────────────────────┘
```

### Local Queue (Offline Fallback)

Lives at `~/.fuel-code/queue/`. Each event is a JSON file named by ULID.

1. Hook fires → constructs event → calls `fuel-code emit`
2. `fuel-code emit` tries HTTP POST to backend (timeout: 2 seconds — hooks must be fast)
3. If POST succeeds → done
4. If POST fails → write event to `~/.fuel-code/queue/{ulid}.json`
5. Background drainer process reads queue in ULID order (oldest first), POSTs in batches
6. On success, deletes the file. On failure, retries with exponential backoff.
7. Events with 100+ failed attempts move to `~/.fuel-code/dead-letter/`

**Deduplication**: Backend uses `INSERT ... ON CONFLICT (id) DO NOTHING`. Events have globally unique ULIDs. Sending the same event twice is harmless.

**Ordering**: Events carry their own `timestamp` from the originating machine. The backend sorts by `timestamp` for display, not by ingestion order. Late-arriving events from an offline machine slot into the correct chronological position.

### Session-Git Correlation

When a `git.commit` event arrives for workspace W on device D:

1. Query for active session: `SELECT id FROM sessions WHERE workspace_id = W AND device_id = D AND lifecycle = 'capturing' ORDER BY started_at DESC LIMIT 1`
2. If found, set `git_activity.session_id = session.id` and `events.session_id = session.id`
3. If not found, `session_id` stays NULL. The commit is associated with the workspace but not a specific session.

This is a heuristic. It works because CC sessions and git commits happen on the same device in the same workspace. The window is well-defined by `session.start` and `session.end` events.

---

## Hook Architecture

### Claude Code Hooks (User-Level)

Installed at `~/.claude/settings.json` (or `~/.claude/hooks/` depending on CC version). User-level = captures ALL Claude Code sessions across all projects on the machine.

**Hooks installed**:

| Hook | Event Emitted | Trigger |
|---|---|---|
| `SessionStart` | `session.start` | CC process launched |
| `SessionEnd` / `Stop` | `session.end` | CC process exited |
| `PreCompact` | `session.compact` | CC is about to compact context |

Each hook is a lightweight bash/bun script that:
1. Reads hook context from stdin / environment variables
2. Resolves workspace canonical ID from `$CWD` (walk up for `.git/`, read remote URL)
3. Reads `device_id` from `~/.fuel-code/device.json`
4. Calls `fuel-code emit <event-type> --data '{...}'`
5. Exits immediately (must not block CC)

### Git Hooks

**Auto-prompted**: When a `session.start` event is processed and the workspace doesn't have git hooks installed on that device, the system records that git hooks should be offered. The next time the user runs `fuel-code` interactively, they're prompted: "Install git tracking for <workspace>?"

**Global approach**: Use `git config --global core.hooksPath ~/.fuel-code/git-hooks/` so ALL repos get tracked automatically. Individual repos can opt out via `.fuel-code/config.yaml`.

**Hooks installed**:

| Hook | Event Emitted |
|---|---|
| `post-commit` | `git.commit` |
| `post-checkout` | `git.checkout` |
| `post-merge` | `git.merge` |
| `pre-push` | `git.push` |

Each hook is a bash script that:
1. Extracts git metadata via `git log`, `git diff-tree`, etc.
2. Resolves workspace canonical ID from the repo's remote URL
3. Calls `fuel-code emit <event-type> --data '{...}'` with `&` (fire-and-forget, non-blocking)
4. Exits 0 always (never block git operations)

**Chaining**: If the user has existing git hooks, fuel-code detects them and chains (runs existing hook first, then fuel-code hook). Never overwrites.

### Historical Session Backfill

When hooks are first installed on a machine (`fuel-code init` or `fuel-code hooks install`), the system scans for ALL existing Claude Code sessions and ingests them. This ensures no historical data is lost — you get full visibility from your first CC session, not just from installation time.

**How it works**:

1. Scan `~/.claude/projects/` for all project directories.
2. Within each project, scan for session transcript files (JSONL files in session subdirectories).
3. For each discovered transcript:
   a. Extract session metadata (session ID, timestamps, working directory) from the JSONL content.
   b. Resolve workspace canonical ID from the project path (walk up for `.git/`, read remote URL).
   c. Upload raw JSONL to S3 at `transcripts/{workspace_canonical_id}/{session_id}/raw.jsonl`.
   d. Emit a synthetic `session.start` event (timestamp from first transcript line) and `session.end` event (timestamp from last transcript line).
   e. These flow through the normal pipeline: session record created, transcript parsed, summary generated.

**Design considerations**:
- **Idempotent**: If a session has already been ingested (by ID), it is skipped. Re-running backfill is safe.
- **Batched**: Backfill can discover hundreds of sessions. Events are batched (50 per POST) and throttled to avoid overwhelming the backend. Progress is shown in the CLI.
- **Background**: Backfill runs asynchronously after init completes. The user can start using fuel-code immediately while historical sessions are ingested in the background.
- **Workspace resolution**: Historical sessions may be from repos the user no longer has locally. If the CWD from the transcript no longer exists or isn't a git repo, the session is associated with `_unassociated`.
- **Deduplication**: Uses Claude Code's session ID as the primary key. If hooks were partially installed before (e.g., user ran init twice), already-ingested sessions are skipped via `INSERT ... ON CONFLICT DO NOTHING`.

**CLI**:
```
fuel-code backfill                      # Manually trigger historical session scan
fuel-code backfill --status             # Show backfill progress (sessions found, ingested, skipped)
fuel-code backfill --dry-run            # Show what would be ingested without doing it
```

The backfill is also automatically triggered during `fuel-code init` and `fuel-code hooks install`.

---

## Remote Dev Environments

### Provisioning Flow

```
$ fuel-code remote up

1. DETECT / LOAD BLUEPRINT                            (~2s)
   ├── Check for .fuel-code/env.yaml in current workspace
   ├── If missing: auto-detect from repo (package.json, Dockerfile, etc.)
   │   └── Generate .fuel-code/env.yaml, show to user for review
   └── Freeze blueprint → immutable JSON

2. PROVISION EC2 INSTANCE                              (~45-90s)
   ├── Generate ephemeral SSH key pair → upload to S3
   ├── Create/reuse security group (SSH inbound from caller IP only)
   ├── Launch EC2 instance (Docker-ready AMI)
   │   ├── User-data script:
   │   │   ├── Install Docker
   │   │   ├── Pull Docker image from blueprint
   │   │   ├── Start container with env vars, port mappings
   │   │   ├── Inside container:
   │   │   │   ├── Clone repo (full, checkout branch)
   │   │   │   ├── Run setup commands from blueprint
   │   │   │   ├── Install fuel-code CLI
   │   │   │   ├── Run fuel-code init (device_type=remote)
   │   │   │   ├── Install Claude Code
   │   │   │   ├── Copy user's ~/.claude/ config (settings, permissions, CLAUDE.md)
   │   │   │   └── Install CC hooks + git hooks
   │   │   └── Health check: `claude --version`
   │   └── Callback to backend: POST /api/remote/:id/ready
   ├── Tag EC2 instance (fuel-code:remote-env-id, fuel-code:workspace)
   └── Emit remote.provision.ready event

3. CONNECT                                             (~1s)
   ├── Download ephemeral SSH key from S3
   ├── SSH into EC2 → exec into Docker container
   ├── User gets a regular terminal (can run claude, git, etc.)
   └── Events flow back to the same backend as local events

4. LIFECYCLE
   ├── Auto-terminate after idle timeout (configurable, default 60 min)
   ├── Auto-terminate after TTL (configurable, default 8 hours)
   ├── Manual: fuel-code remote down <id>
   └── On terminate: emit remote.terminate event, update remote_envs record
```

### Remote Device Symmetry

Once provisioned, a remote EC2 is just another Device in the topology. It has:
- Its own `device_id` (generated during `fuel-code init` on the remote)
- fuel-code CLI installed with hooks configured
- Events flowing through the same HTTP POST → Redis → Processor pipeline

The backend does not special-case remote events. A `session.start` from `remote-abc` is processed identically to one from `macbook-pro`. The TUI shows both, distinguished by device name.

---

## CLI Commands

```
fuel-code                               # Launch TUI dashboard (default)
fuel-code init                          # Initialize this device (one-time setup)
fuel-code status                        # Quick status: active sessions, queue depth, connectivity

# Sessions (primary view)
fuel-code sessions                      # List recent sessions across all workspaces
fuel-code sessions --workspace <name>   # Filter by workspace
fuel-code sessions --device <name>      # Filter by device
fuel-code sessions --today              # Today's sessions
fuel-code sessions --live               # Live-updating session feed
fuel-code session <id>                  # Session detail view (transcript, events, git activity)
fuel-code session <id> --transcript     # View parsed transcript
fuel-code session <id> --events         # View raw events for this session
fuel-code session <id> --git            # View git activity during this session
fuel-code session <id> --export json    # Export session data as JSON
fuel-code session <id> --export md      # Export session as Markdown
fuel-code session <id> --tag <tag>      # Add a tag to a session
fuel-code session <id> --reparse        # Re-trigger transcript parsing

# Timeline (unified activity view)
fuel-code timeline                      # Today's activity across all workspaces
fuel-code timeline --workspace <name>   # Scoped to a workspace
fuel-code timeline --week               # This week

# Workspaces
fuel-code workspaces                    # List all known workspaces
fuel-code workspace <name>              # Workspace detail (sessions, git, remotes)

# Remote environments
fuel-code remote up                     # Provision from .fuel-code/env.yaml (or auto-detect)
fuel-code remote up --repo <url>        # Provision for a specific repo
fuel-code remote ls                     # List active remote environments
fuel-code remote ssh <id>               # SSH into a remote environment
fuel-code remote status <id>            # Show remote env detail
fuel-code remote down <id>              # Terminate a remote environment
fuel-code remote down --all             # Terminate all (with confirmation)

# Blueprint / environment manifest
fuel-code blueprint detect              # Auto-detect and generate .fuel-code/env.yaml
fuel-code blueprint show                # Show current env.yaml
fuel-code blueprint validate            # Validate env.yaml

# Hooks management
fuel-code hooks install                 # Install CC hooks (user-level) + git hooks (global)
fuel-code hooks status                  # Show hook installation status
fuel-code hooks test                    # Fire a test event through the pipeline

# Historical backfill (also auto-triggered by init and hooks install)
fuel-code backfill                      # Scan ~/.claude/projects/ and ingest all historical sessions
fuel-code backfill --status             # Show backfill progress
fuel-code backfill --dry-run            # Show what would be ingested without doing it

# Queue management
fuel-code queue status                  # Show queue depth, pending events
fuel-code queue drain                   # Force-flush queued events to backend
fuel-code queue dead-letter             # Show failed events

# Internal (called by hooks, not user-facing)
fuel-code emit <event-type> --data '{}' # Emit an event (HTTP POST with queue fallback)
```

---

## TUI Dashboard

The TUI is built with Ink (React for terminals) or similar. It connects to the backend via WebSocket for live updates.

### Main View: Sessions by Workspace

```
┌─ fuel-code ─────────────────────────────────────────────────────────┐
│                                                                      │
│  WORKSPACES           │  SESSIONS                                    │
│  ──────────           │  ────────                                    │
│                       │                                              │
│  ► fuel-code    (3)   │  ● LIVE  macbook-pro              12m $0.18 │
│    api-service  (1)   │    Redesigning the event pipeline            │
│    dotfiles     (0)   │    Edit(3) Bash(2) Read(5)                   │
│    _unassociated(2)   │                                              │
│                       │  ✓ DONE  macbook-pro       47m $0.42 · 2↑   │
│                       │    Refactored auth middleware to use JWT      │
│                       │    abc123 refactor: JWT auth middleware       │
│                       │    def456 test: add JWT validation tests     │
│                       │                                              │
│  REMOTES              │  ✓ DONE  remote-abc       1h22m $1.87 · 5↑  │
│  ───────              │    Implemented cursor-based pagination        │
│  ● fuel-code          │    7890ab feat: cursor-based pagination      │
│    t3.xl $0.42        │    ... 4 more commits                        │
│    idle 12m           │                                              │
│                       │  ✓ DONE  macbook-pro        23m $0.31 · 1↑  │
│                       │    Fixed timezone handling in event timestamps│
│                       │                                              │
│──────────────────────────────────────────────────────────────────────│
│  Today: 4 sessions · 2h50m · $2.78 · 8 commits                      │
│  Queue: 0 pending · Backend: connected (ws)                          │
│  j/k:navigate  enter:detail  f:filter  r:refresh  /:search  q:quit  │
└──────────────────────────────────────────────────────────────────────┘
```

### Session Detail View

```
┌─ Session: fuel-code ─────────────────────────────────────────────────┐
│  Workspace: fuel-code     Device: macbook-pro (local)                │
│  Started: 47m ago         Duration: 47m         Cost: $0.42          │
│  Tokens: 125K in / 48K out / 890K cache                             │
│  Summary: Refactored authentication middleware to use JWT tokens...  │
│                                                                      │
│  TRANSCRIPT                       │  SIDEBAR                         │
│  ──────────                       │  ───────                         │
│  [1] Human:                       │  Git Activity:                   │
│    Fix the auth bug in login...   │  ● abc123 refactor: JWT auth     │
│                                   │  ● def456 test: JWT validation   │
│  [2] Assistant:                   │                                  │
│    I'll investigate the auth...   │  Tools Used:                     │
│    ├ Read: src/auth/middleware.ts  │  Edit     12                     │
│    ├ Read: src/auth/jwt.ts        │  Read     15                     │
│    ├ Edit: src/auth/middleware.ts  │  Bash      8                     │
│    └ Bash: bun test               │  Grep      4                     │
│                                   │  Write     3                     │
│  [3] Human:                       │                                  │
│    Now add tests for the JWT...   │  Files Modified:                 │
│                                   │  src/auth/middleware.ts           │
│  [4] Assistant:                   │  src/auth/jwt.ts                 │
│    I'll write tests for...        │  src/auth/__tests__/jwt.test.ts  │
│                                   │                                  │
│──────────────────────────────────────────────────────────────────────│
│  b:back  t:toggle-transcript  g:git  e:events  x:export  q:quit     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## WebSocket Protocol

Single WebSocket connection per client. Server pushes updates.

**Connection**: `wss://<backend>/api/ws?token=<api_key>`

### Server → Client

```typescript
// New event ingested
{ type: "event", event: Event }

// Session lifecycle changed
{
  type: "session.update",
  session_id: string,
  lifecycle: string,
  summary?: string,          // when transitioning to "summarized"
  stats?: SessionStats       // updated stats
}

// Remote env status changed
{
  type: "remote.update",
  remote_env_id: string,
  status: string,
  public_ip?: string         // when transitioning to "ready"
}

// Keepalive
{ type: "ping" }
```

### Client → Server

```typescript
// Subscribe to workspace events
{ type: "subscribe", workspace_id: string }

// Subscribe to a specific session (for live transcript)
{ type: "subscribe", session_id: string }

// Subscribe to all events
{ type: "subscribe", scope: "all" }

// Unsubscribe
{ type: "unsubscribe", workspace_id?: string, session_id?: string }

// Keepalive response
{ type: "pong" }
```

---

## API Endpoints

All endpoints prefixed with `/api`. Auth via `Authorization: Bearer <api_key>`.

### Event Ingestion

```
POST   /api/events/ingest              # Batch ingest events
       Body: { events: Event[] }
       Response: 202 { ingested: number, duplicates: number }
```

### Sessions

```
GET    /api/sessions                    # List sessions (paginated, filterable)
       ?workspace_id=...
       &device_id=...
       &lifecycle=summarized
       &after=2026-02-01T00:00:00Z
       &before=...
       &tag=...
       &limit=50&cursor=...

GET    /api/sessions/:id                # Session detail with stats
GET    /api/sessions/:id/transcript     # Parsed transcript (messages + content blocks)
GET    /api/sessions/:id/transcript/raw # Redirect to S3 presigned URL for raw JSONL
GET    /api/sessions/:id/events         # Events within this session
GET    /api/sessions/:id/git            # Git activity during this session
PATCH  /api/sessions/:id               # Update tags, manual summary override
POST   /api/sessions/:id/reparse       # Re-trigger transcript parsing
```

### Timeline

```
GET    /api/timeline                    # Unified activity feed
       ?workspace_id=...
       &after=...&before=...
       &types=session.start,git.commit  # Filter by event type

Response: Session-grouped timeline. Sessions with embedded highlight
events (notable commits, cost milestones), not a flat event list.
```

### Workspaces

```
GET    /api/workspaces                  # List workspaces
GET    /api/workspaces/:id              # Workspace detail (recent sessions, git, remotes)
```

### Devices

```
GET    /api/devices                     # List devices
GET    /api/devices/:id                 # Device detail
```

### Remote Environments

```
POST   /api/remote                      # Provision a remote environment
       Body: { workspace_id, blueprint }
GET    /api/remote                      # List remote envs
GET    /api/remote/:id                  # Remote env detail
POST   /api/remote/:id/terminate        # Terminate
GET    /api/remote/:id/ssh-key          # Download ephemeral SSH key (one-time, token-gated)
```

### System

```
GET    /api/health                      # Health check
WS     /api/ws                          # WebSocket (see protocol above)
```

---

## Configuration

### Global Config (`~/.fuel-code/config.yaml`)

```yaml
# Backend connection
backend:
  url: "https://fuel-code.up.railway.app"
  api_key: "fc_..."                      # generated during init

# Device identity
device:
  id: "01JMF3..."                        # ULID, generated during init
  name: "macbook-pro"                    # user-friendly, editable

# AWS (for remote environments)
aws:
  region: "us-east-1"
  profile: "default"                     # AWS CLI profile

# Remote defaults
remote:
  default_instance_type: "t3.xlarge"
  default_ttl_minutes: 480               # 8 hours
  default_idle_timeout_minutes: 60
  ssh_key_name: "fuel-code"

# Event pipeline
pipeline:
  queue_path: "~/.fuel-code/queue/"
  drain_interval_seconds: 30
  batch_size: 50                         # max events per HTTP POST
  post_timeout_ms: 2000                  # timeout for individual event POST from hooks

# S3
storage:
  bucket: "fuel-code-blobs"
  region: "us-east-1"

# Summary generation
summary:
  enabled: true
  model: "claude-sonnet-4-5-20250929"
  temperature: 0.3
  max_output_tokens: 150

# Session archival
archive:
  auto_archive_days: 30                  # prune parsed messages from Postgres after N days
  retain_summary: true                   # always keep summary and stats
  retain_s3: true                        # never delete S3 transcripts
```

---

## Project Structure

```
fuel-code/
├── packages/
│   ├── shared/                          # Types, schemas, utilities — NO side effects
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── workspace.ts         # Workspace type + canonical ID normalization
│   │   │   │   ├── session.ts           # Session type + lifecycle enum
│   │   │   │   ├── event.ts             # Event type + EventType enum
│   │   │   │   ├── device.ts            # Device type
│   │   │   │   ├── blueprint.ts         # Blueprint type + env.yaml schema
│   │   │   │   ├── transcript.ts        # TranscriptMessage, ContentBlock types
│   │   │   │   └── remote.ts            # RemoteEnv type
│   │   │   ├── schemas/                 # Zod validators for every event payload
│   │   │   │   ├── session-start.ts
│   │   │   │   ├── session-end.ts
│   │   │   │   ├── git-commit.ts
│   │   │   │   └── ...
│   │   │   ├── ulid.ts                  # ULID generation utility
│   │   │   └── canonical.ts             # Git remote URL normalization
│   │   └── package.json
│   │
│   ├── core/                            # Domain logic — NO HTTP, NO UI, NO infrastructure
│   │   ├── src/
│   │   │   ├── event-processor.ts       # Process raw events: resolve workspace/device, dispatch
│   │   │   ├── transcript-parser.ts     # Parse JSONL into messages/content_blocks hierarchy
│   │   │   ├── summary-generator.ts     # LLM-powered session summary generation
│   │   │   ├── workspace-resolver.ts    # Canonical ID computation + upsert logic
│   │   │   ├── session-manager.ts       # Session lifecycle state machine
│   │   │   ├── git-correlator.ts        # Associate git events with active sessions
│   │   │   ├── blueprint-detector.ts    # Auto-detect project environment from repo contents
│   │   │   └── session-backfill.ts     # Scan ~/.claude/projects/ for historical CC sessions
│   │   └── package.json
│   │
│   ├── server/                          # Express backend — deployed to Railway
│   │   ├── src/
│   │   │   ├── routes/                  # REST API route handlers
│   │   │   │   ├── events.ts            # POST /api/events/ingest
│   │   │   │   ├── sessions.ts          # GET/PATCH /api/sessions
│   │   │   │   ├── workspaces.ts        # GET /api/workspaces
│   │   │   │   ├── devices.ts           # GET /api/devices
│   │   │   │   ├── remote.ts            # POST/GET /api/remote
│   │   │   │   └── timeline.ts          # GET /api/timeline
│   │   │   ├── pipeline/                # Redis Stream consumer + event dispatch
│   │   │   │   ├── consumer.ts          # Redis consumer group management
│   │   │   │   └── handlers/            # Per-event-type handlers (call into core/)
│   │   │   ├── ws/                      # WebSocket server + subscription management
│   │   │   ├── aws/                     # EC2 provisioning, S3 operations
│   │   │   ├── db/
│   │   │   │   ├── postgres.ts          # Connection pool (postgres.js)
│   │   │   │   └── migrations/          # Sequential SQL migrations
│   │   │   ├── middleware/              # Auth, error handling, logging
│   │   │   └── index.ts                 # Express app entry point
│   │   ├── package.json
│   │   └── Dockerfile                   # Railway deployment
│   │
│   ├── cli/                             # CLI + TUI — one UI consumer of the server API
│   │   ├── src/
│   │   │   ├── commands/                # One file per CLI command
│   │   │   │   ├── init.ts
│   │   │   │   ├── backfill.ts          # Historical session scanner + ingester
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── session-detail.ts
│   │   │   │   ├── timeline.ts
│   │   │   │   ├── workspaces.ts
│   │   │   │   ├── remote-up.ts
│   │   │   │   ├── remote-ls.ts
│   │   │   │   ├── remote-ssh.ts
│   │   │   │   ├── remote-down.ts
│   │   │   │   ├── blueprint.ts
│   │   │   │   ├── hooks.ts
│   │   │   │   ├── queue.ts
│   │   │   │   ├── emit.ts              # Internal: called by hooks
│   │   │   │   └── status.ts
│   │   │   ├── tui/                     # TUI components (Ink / blessed)
│   │   │   │   ├── Dashboard.tsx        # Main session-by-workspace view
│   │   │   │   ├── SessionDetail.tsx    # Session transcript + sidebar
│   │   │   │   ├── Timeline.tsx         # Unified activity feed
│   │   │   │   ├── RemoteStatus.tsx     # Remote env panel
│   │   │   │   └── components/          # Shared TUI components
│   │   │   ├── lib/
│   │   │   │   ├── api-client.ts        # HTTP client for backend API
│   │   │   │   ├── ws-client.ts         # WebSocket client for live updates
│   │   │   │   ├── config.ts            # Config file management
│   │   │   │   └── queue.ts             # Local event queue management
│   │   │   └── index.ts                 # CLI entry point (commander / yargs)
│   │   └── package.json
│   │
│   ├── hooks/                           # Hook scripts installed on machines
│   │   ├── claude/                      # Claude Code hook scripts
│   │   │   ├── SessionStart.sh
│   │   │   ├── SessionEnd.sh
│   │   │   └── PreCompact.sh
│   │   ├── git/                         # Git hook scripts
│   │   │   ├── post-commit
│   │   │   ├── post-checkout
│   │   │   ├── post-merge
│   │   │   └── pre-push
│   │   └── package.json
│   │
│   ├── analysis/                        # (V2) Analysis engine — reads core data, writes derived data
│   │   └── package.json                 # Placeholder, populated in V2
│   │
│   └── web/                             # (V2) Web UI — another consumer of the server API
│       └── package.json                 # Placeholder, populated in V2
│
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.remote            # Default Docker image for remote dev environments
│   │   └── scripts/
│   │       └── user-data.sh             # EC2 bootstrap script
│   ├── railway/
│   │   └── railway.toml                 # Railway deployment config
│   └── sql/
│       └── schema.sql                   # Full Postgres schema (also in server/db/migrations/)
│
├── package.json                         # Monorepo root (bun workspaces)
├── bunfig.toml                          # Bun workspace configuration
├── tsconfig.base.json                   # Shared TypeScript config
└── CORE.md                              # This document
```

**Key architectural boundaries**:

- `shared/` has zero side effects. Pure types, schemas, utilities.
- `core/` has zero knowledge of HTTP, WebSocket, CLI, or TUI. It exports functions that transform data. It can depend on Postgres and S3 clients (injected).
- `server/` wires `core/` to HTTP endpoints, Redis consumers, and WebSocket. It imports from `core/` and `shared/`.
- `cli/` is one UI consumer. It talks to `server/` via HTTP and WebSocket. It imports from `shared/` for types.
- `web/` (V2) would be another UI consumer. Same API, different rendering.
- `analysis/` (V2) imports from `shared/`, reads from the same Postgres, writes to its own tables. `server/` adds routes to expose analysis data. UI packages add views to display it.

---

## V2: Analysis Layer (Design Considerations)

The analysis layer is NOT in V1. But the V1 abstractions are designed to support it without changes.

### What the Analysis Layer Needs

1. **Read access to all parsed transcript data**: `transcript_messages`, `content_blocks` — every conversation turn, every tool use, every tool result.
2. **Embedding storage**: Vector representations of prompts, sessions, workflows for similarity search and clustering.
3. **Derived entities**: Extracted prompt patterns, identified workflows, derived skills.
4. **Its own tables**: Analysis does NOT modify V1 tables. It reads from them and writes to `analysis_*` tables.

### How It Fits

```
V1 Tables (untouched):
  sessions, transcript_messages, content_blocks, events, git_activity, ...
      │
      │ reads from
      ▼
V2 Analysis Engine (packages/analysis/):
  - Prompt extractor: identifies reusable prompts from session transcripts
  - Workflow detector: finds multi-step patterns across sessions
  - Embedding generator: creates vector embeddings for similarity search
  - Cluster engine: groups similar sessions/prompts/workflows
  - Skill deriver: generates Claude Code skills from recurring patterns
      │
      │ writes to
      ▼
V2 Tables (new, separate):
  analysis_prompts        — extracted useful prompts with embedding vectors
  analysis_workflows      — multi-step patterns (sequences of tool uses)
  analysis_clusters       — groupings in embedding space
  analysis_skills         — derived Claude Code skills
  analysis_runs           — tracking which analyses have been run and when
      │
      │ exposed via
      ▼
Server adds new routes: GET /api/analysis/prompts, /api/analysis/workflows, ...
CLI/Web adds new views: Analysis dashboard, prompt library, skill generator
```

### Why This Works Without Changing V1

- The parsed transcript hierarchy (`transcript_messages` + `content_blocks`) is the rich raw material. V1 stores it for session viewing. V2 reads the same data for analysis.
- Sessions have `tags` (TEXT array) that analysis can populate: `tags = ['has-useful-prompt', 'workflow:deploy-pipeline']`.
- The `metadata` JSONB fields on sessions and content_blocks can store analysis annotations without schema changes.
- New `analysis_*` tables are additive. No existing table is modified.

---

## Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| CLI runtime | bun | Fast, TypeScript-native. Used for building and running the CLI. |
| CLI framework | commander or yargs | Command parsing, help generation |
| CLI TUI | Ink (React for terminals) | Rich interactive terminal UI |
| Backend framework | Express + TypeScript | Deployed to Railway |
| Backend validation | Zod | Schemas for API requests and event payloads |
| Database client | postgres.js | Tagged template literals, connection pooling |
| Database | PostgreSQL (Railway) | Managed, auto-scaling |
| Event queue | Redis Streams (Railway) | Ordered, durable, consumer groups |
| Real-time | WebSocket (ws) | Live updates to connected clients |
| Blob storage | AWS S3 | Transcripts, artifacts, SSH keys |
| Remote compute | AWS EC2 | Docker-ready instances for remote dev |
| Container runtime | Docker | Isolation for remote dev environments |
| LLM integration | Anthropic SDK | Claude Sonnet for session summaries |
| Logging | Winston or pino | Structured logging with rotation |

---

## Implementation Phases

### Phase 1: Foundation
Get from zero to "events flow from hooks to Postgres."

- TypeScript monorepo scaffold (bun workspaces, tsconfig)
- Shared types package (Event, Session, Workspace, Device types + Zod schemas)
- PostgreSQL schema + migrations on Railway
- Express server with POST /api/events/ingest endpoint
- Redis Stream consumer that processes events into Postgres
- `fuel-code init` command (generate device ID, store config)
- `fuel-code emit` command (HTTP POST with local queue fallback)
- Claude Code hooks (SessionStart, SessionEnd) that call `fuel-code emit`
- Verify end-to-end: start CC session → hooks fire → events appear in Postgres

### Phase 2: Session Lifecycle
Sessions are created, tracked, and their transcripts parsed.

- Session manager: create on session.start, update on session.end
- Transcript upload to S3 on session.end
- Transcript parser: JSONL → transcript_messages + content_blocks
- Summary generator: LLM call after parsing
- Session lifecycle state machine (detected → capturing → ended → parsed → summarized)
- Historical session backfill: scan ~/.claude/projects/ for all existing sessions, ingest through normal pipeline
- `fuel-code backfill` command (manual trigger, dry-run, progress reporting)
- Auto-trigger backfill during `fuel-code init` and `fuel-code hooks install`
- GET /api/sessions endpoint with filtering
- GET /api/sessions/:id with transcript data

### Phase 3: Git Tracking
Git events flow alongside CC sessions.

- Git hook scripts (post-commit, post-checkout, post-merge, pre-push)
- `fuel-code hooks install` command
- git_activity table population from git events
- Session-git correlation (associate commits with active CC sessions)
- Auto-prompt for git hooks on first CC session in a git repo
- GET /api/timeline endpoint

### Phase 4: CLI + TUI
The primary user interface.

- `fuel-code sessions` command (table output)
- `fuel-code session <id>` command (detailed view)
- `fuel-code timeline` command
- `fuel-code workspaces` command
- `fuel-code status` command
- TUI dashboard with Ink (sessions by workspace, live updates)
- TUI session detail view (transcript viewer, git sidebar)
- WebSocket client for live updates in TUI

### Phase 5: Remote Dev Environments
Provision and connect to remote machines.

- Blueprint auto-detection (scan repo for language, deps, etc.)
- `fuel-code blueprint detect` command
- `.fuel-code/env.yaml` generation and validation
- EC2 provisioning via AWS SDK
- Docker container setup on EC2 (user-data script)
- fuel-code + hooks installation on remote
- `fuel-code remote up` command
- `fuel-code remote ssh` command
- `fuel-code remote ls` and `fuel-code remote down` commands
- Remote device heartbeat + idle timeout auto-termination
- remote_envs table and API endpoints

### Phase 6: Hardening
Production readiness.

- Retry logic for AWS API calls (exponential backoff)
- Retry logic for HTTP transport (same)
- Queue drain robustness (dead letter handling)
- Progress indicators for long operations (provisioning)
- Comprehensive error messages
- EC2 tagging for orphan detection
- Graceful Ctrl-C handling (terminate EC2 on abort)
- Session archival (prune old parsed data, retain summaries)
- Cost estimation in blueprint output

---

## Security Model

### Single-User Auth

- One API key (`fc_...`) generated during `fuel-code init`
- Stored in backend as environment variable, in CLI as `~/.fuel-code/config.yaml`
- All API endpoints require `Authorization: Bearer <api_key>`
- WebSocket auth via query parameter on connection

### Remote Environment Security

- **SSH key**: Ephemeral per-environment. Stored in S3, downloaded once by CLI. Deleted on termination.
- **Security group**: SSH inbound only, from the provisioning machine's IP.
- **ANTHROPIC_API_KEY**: Injected as container env var. The remote machine needs it for CC.
- **Git credentials**: Deploy keys (read-only) or tokens. Scoped narrowly.
- **Blast radius**: Remote machines are disposable. `fuel-code remote down` destroys everything.

### What's Exposed (Know the Risks)

| Threat | Protected? | Mitigation |
|---|---|---|
| Malicious code on local machine | No (it's your machine) | Remote envs exist for risky experiments |
| Malicious code on remote touches local | Yes | Docker isolation + security group |
| API key exfiltration from remote | Partial | Container has the key. Rotate keys, use spend limits. |
| Excessive API/EC2 spend | Partial | TTL auto-terminate, idle timeout, Anthropic spend limits |
| Orphaned EC2 instances | Yes | EC2 tags + `fuel-code remote ls` always finds them |

---

## Invariants

These must always hold. If any break, there is a bug.

1. **Every event has a workspace_id.** Events outside git repos use `_unassociated`.
2. **Every session belongs to exactly one workspace and one device.** Determined at session start, never changes.
3. **Events are immutable.** Once written, never updated or deleted (except archival TTL).
4. **The local queue never drops events.** Events either reach the server or sit in the queue until they do (moved to dead-letter after 100 attempts).
5. **Raw transcripts in S3 are never deleted.** They are the source of truth for session content.
6. **Local and remote devices are architecturally symmetric.** The processing pipeline does not distinguish between them.
7. **Workspace canonical IDs are deterministic.** Given a git remote URL, any machine computes the same canonical ID without a server round-trip.
8. **The server API is the sole interface for data access.** CLI and future web UI both consume the same REST + WebSocket API. No direct database access from UI packages.
9. **Adding a new view (web, mobile, etc.) requires zero changes to core/ or server/.** Only a new package that consumes the API.
10. **The analysis layer (V2) reads from V1 tables and writes to its own tables.** No V1 table schema changes needed for analysis.
