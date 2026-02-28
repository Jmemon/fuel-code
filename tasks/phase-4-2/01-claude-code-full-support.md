# Phase 4.2 — Claude Code Full Capability Support

## Date: 2026-02-28

## Motivation

fuel-code currently tracks Claude Code sessions as flat, independent units. In reality, Claude Code sessions have rich internal structure: sub-agents (Explore, Plan, general-purpose, custom) spawned via the Task tool, agent teams with coordinated teammates, session chains (resume/fork/continue), skill invocations, and worktree isolation. None of this topology is modeled in fuel-code today.

The `sessions` table has a `subagent_count` integer, and the transcript parser stores individual `Task` tool calls in `content_blocks` — but there's no way to see the parent→child tree, team membership, skill usage patterns, or worktree lifecycle. This makes fuel-code blind to the most interesting structural data Claude Code produces.

## Scope

**In scope:**
- Sub-agent relationship tracking (parent session → child agents, including nested spawns)
- Agent team modeling (team creation, membership, inter-agent messaging, task coordination)
- Session chains (resume, fork, continue — linking related sessions)
- Skill/command invocation tracking
- Worktree lifecycle tracking
- Both real-time capture (new hooks) AND retroactive extraction (transcript parser)
- API endpoints to query this data
- TUI views to display it

**Out of scope:**
- Tool call aggregation / per-tool analytics (separate task)
- MCP server identification (can be derived from tool_name prefix; separate task)
- Permission decision tracking (separate task)
- File modification tracking beyond git (separate task)
- OpenTelemetry integration (separate task)
- V2 analysis layer (embeddings, workflow clustering, etc.)

---

## Research Findings

### What Claude Code Actually Produces

**Sub-agents** are spawned via the `Task` tool. Each gets its own transcript at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`. The spawning tool call contains `subagent_type`, `model`, `team_name`, `run_in_background`, `isolation`, `name`. The result contains `agent_id`, `teammate_id`, `agent_type`, `model`, `color`, `team_name`, `plan_mode_required`. Sub-agent transcript lines have `isSidechain: true` and share the parent's `sessionId`.

**Agent teams** are created via `TeamCreate`. Config stored at `~/.claude/teams/{team-name}/config.json` with a `members` array. Teammates are spawned via `Task` with `team_name` parameter. Communication happens via `SendMessage` (types: message, broadcast, shutdown_request, shutdown_response, plan_approval_response). Shared task lists at `~/.claude/tasks/{team-name}/`. Team messages appear as `<teammate-message>` XML in user messages within teammate transcripts.

**Session chains**: `--continue` resumes the most recent session in a directory. `--resume` resumes a specific session. `--fork-session` creates a new session ID from a resumed session. The `source` field on `session.start` events distinguishes `startup` (new), `resume`, `clear`, `compact`. Currently, resumed sessions get entirely new session IDs with no link to the original.

**Skills** are invoked via the `Skill` tool. Input has `skill` (name) and optional `args`. Result has `success` and `commandName`. Skills can be user-invoked (slash commands) or auto-invoked by Claude. The `toolUseResult` distinguishes these.

**Worktrees** are created via `EnterWorktree` tool or `--worktree` CLI flag. CC hooks `WorktreeCreate` and `WorktreeRemove` fire on lifecycle events. Worktrees live at `.claude/worktrees/<name>` with their own git branches. Auto-cleaned if no changes on session end.

### Available CC Hooks (17 total, fuel-code uses 2)

| Hook | Currently Used | Needed for This Task |
|------|---------------|---------------------|
| SessionStart | Yes | Already have |
| SessionEnd | Yes | Already have |
| SubagentStart | No | **Yes** — emit `subagent.start` event |
| SubagentStop | No | **Yes** — emit `subagent.stop` event |
| PostToolUse | No | **Yes** — match `TeamCreate`, `Skill`, `EnterWorktree` |
| WorktreeCreate | No | **Yes** — emit `worktree.create` event |
| WorktreeRemove | No | **Yes** — emit `worktree.remove` event |
| Stop | No | Not for this task |
| TeammateIdle | No | Not for this task |
| TaskCompleted | No | Not for this task |
| PreToolUse | No | Not for this task |
| PostToolUseFailure | No | Not for this task |
| PermissionRequest | No | Not for this task |
| UserPromptSubmit | No | Not for this task |
| PreCompact | No | Not for this task |
| ConfigChange | No | Not for this task |
| Notification | No | Not for this task |

### JSONL Transcript Structure (Key Fields)

Every transcript line has: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `type`, `version`, `cwd`, `gitBranch`, `isSidechain`.

Team sessions add: `teamName`, `slug`.

Sub-agent transcripts add: `agentId`, `isSidechain: true`.

Tool calls are `type: "assistant"` with `content[].type: "tool_use"`, containing `name`, `id`, `input`. Results are `type: "user"` with `content[].type: "tool_result"` and `toolUseResult` metadata.

Progress events for sub-agents: `type: "progress"` with `data.type: "agent_progress"`, `data.agentId`, `data.message`.

---

## Database Changes

### Migration: `005_session_relationships.sql`

#### New columns on `sessions`

```sql
-- Link to the session this was resumed/forked from
ALTER TABLE sessions ADD COLUMN resumed_from_session_id TEXT REFERENCES sessions(id);

-- Team membership
ALTER TABLE sessions ADD COLUMN team_name TEXT;
ALTER TABLE sessions ADD COLUMN team_role TEXT CHECK (team_role IN ('lead', 'member'));

-- Permission mode used during the session
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
```

**Rationale**: `parent_session_id` was considered but rejected — sub-agents are NOT separate session rows (they share the parent's `sessionId` in CC). Sub-agents are tracked in their own table. `resumed_from_session_id` specifically handles session chains (resume/fork/continue).

#### New table: `subagents`

Tracks every sub-agent spawned within a session. This includes Explore agents, Plan agents, general-purpose agents, named teammates, and custom agents.

```sql
CREATE TABLE subagents (
  id                    TEXT PRIMARY KEY,           -- ULID
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL,              -- CC's internal ID (e.g., "a834e7d28b48e3de6")
  agent_type            TEXT NOT NULL,              -- "Explore", "Plan", "general-purpose", custom name
  agent_name            TEXT,                       -- for named agents (e.g., "phase-4-reviewer")
  model                 TEXT,                       -- model used (e.g., "claude-haiku-4-5-20251001")
  spawning_tool_use_id  TEXT,                       -- tool_use_id of the Task call that spawned it
  team_name             TEXT,                       -- if spawned as part of a team
  isolation             TEXT,                       -- "worktree" or null
  run_in_background     BOOLEAN DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  transcript_s3_key     TEXT,                       -- S3 key for sub-agent's parsed transcript
  metadata              JSONB DEFAULT '{}'
);

CREATE INDEX idx_subagents_session ON subagents(session_id);
CREATE INDEX idx_subagents_team ON subagents(team_name) WHERE team_name IS NOT NULL;
```

#### New table: `teams`

Tracks agent teams. A team is a coordination unit: one lead session + N member sub-agents.

```sql
CREATE TABLE teams (
  id                TEXT PRIMARY KEY,               -- ULID
  team_name         TEXT NOT NULL UNIQUE,
  description       TEXT,
  lead_session_id   TEXT REFERENCES sessions(id),
  created_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  member_count      INTEGER DEFAULT 0,
  metadata          JSONB DEFAULT '{}'
);

CREATE INDEX idx_teams_lead ON teams(lead_session_id);
```

#### New table: `session_skills`

Tracks skill invocations within a session (both user-invoked slash commands and Claude auto-invocations).

```sql
CREATE TABLE session_skills (
  id            TEXT PRIMARY KEY,                   -- ULID
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_name    TEXT NOT NULL,                      -- e.g., "brainstorming", "commit", "review-pr"
  invoked_at    TIMESTAMPTZ NOT NULL,
  invoked_by    TEXT,                               -- "user" or "claude"
  args          TEXT,                               -- arguments passed to the skill
  metadata      JSONB DEFAULT '{}'
);

CREATE INDEX idx_session_skills_session ON session_skills(session_id);
CREATE INDEX idx_session_skills_name ON session_skills(skill_name);
```

#### New table: `session_worktrees`

Tracks worktree creation/removal within a session.

```sql
CREATE TABLE session_worktrees (
  id              TEXT PRIMARY KEY,                 -- ULID
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_name   TEXT,
  branch          TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  removed_at      TIMESTAMPTZ,
  had_changes     BOOLEAN,
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_session_worktrees_session ON session_worktrees(session_id);
```

---

## Git Hooks + Worktree Interaction

**Key insight**: Git worktrees share the same repository (same `core.hooksPath`), so all 4 existing git hooks (`post-commit`, `pre-push`, `post-checkout`, `post-merge`) **already fire inside worktrees**. The `resolve-workspace.sh` resolves the same workspace (same origin remote). But currently, git events from worktrees are indistinguishable from events in the main working tree.

**Detection method**: Inside a worktree, `git rev-parse --git-dir` returns a linked path (e.g., `/repo/.git/worktrees/<name>`) while `git rev-parse --git-common-dir` returns the main `.git` dir. If they differ, we're in a worktree:

```bash
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
IS_WORKTREE=false
WORKTREE_NAME=""
if [ "$GIT_DIR" != "$GIT_COMMON" ]; then
  IS_WORKTREE=true
  WORKTREE_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
fi
```

### Changes to all 4 git hooks

Add worktree detection to `post-commit`, `pre-push`, `post-checkout`, `post-merge`. Include in the JSON payload:

```json
{
  "is_worktree": true,
  "worktree_name": "agent-a3067cc4"
}
```

When `is_worktree` is false, these fields are omitted (or `is_worktree: false, worktree_name: null`).

### Git event handlers update

The existing git event handlers (`packages/core/src/handlers/`) should:
1. Store `is_worktree` and `worktree_name` in the `git_activity.data` JSONB
2. If `is_worktree` is true, attempt to correlate with a `session_worktrees` row by matching `worktree_name`
3. Add `worktree_name` column to `git_activity` table for direct querying:
   ```sql
   ALTER TABLE git_activity ADD COLUMN worktree_name TEXT;
   ALTER TABLE git_activity ADD COLUMN is_worktree BOOLEAN DEFAULT false;
   ```

### Why this matters

- `post-checkout` fires when a worktree is created (git does a checkout as part of `git worktree add`). This gives us a **git-level signal** of worktree creation, even if the CC `WorktreeCreate` hook doesn't fire (e.g., sub-agent in isolation mode where CC hooks might not be configured).
- `post-commit` from a worktree means a sub-agent committed code in isolation. We can correlate this to the sub-agent via the `worktree_name` (which matches `agent-<agentId>` pattern).
- All git activity inside worktrees should be visible in the session detail view, tagged with the worktree/sub-agent context.

### Existing worktrees on this machine

```
/Users/johnmemon/Desktop/fuel-code                                   main
/Users/johnmemon/Desktop/fuel-code/.claude/worktrees/agent-a3067cc4  worktree-agent-a3067cc4
/Users/johnmemon/Desktop/fuel-code/.claude/worktrees/agent-a52e0c3c  worktree-agent-a52e0c3c
/Users/johnmemon/Desktop/fuel-code/.claude/worktrees/agent-aab34f6f  worktree-agent-aab34f6f
/Users/johnmemon/Desktop/fuel-code/.claude/worktrees/agent-aad09c25  worktree-agent-aad09c25
```

Note the naming convention: `agent-<agentId>` — this maps directly to the `agent_id` field in the `subagents` table (with the `agent-` prefix stripped).

---

## New Event Types

Add to `packages/shared/src/types/event.ts`:

```typescript
// Sub-agent events
'subagent.start'    // Sub-agent spawned — from SubagentStart hook
'subagent.stop'     // Sub-agent finished — from SubagentStop hook

// Team events
'team.create'       // Team created — from PostToolUse hook matching TeamCreate
'team.message'      // Inter-agent message — from PostToolUse hook matching SendMessage

// Skill events
'skill.invoke'      // Skill invoked — from PostToolUse hook matching Skill

// Worktree events
'worktree.create'   // Worktree created — from WorktreeCreate hook
'worktree.remove'   // Worktree removed — from WorktreeRemove hook
```

### Event Schemas (Zod)

```typescript
// subagent.start
{
  session_id: string,
  agent_id: string,
  agent_type: string,         // "Explore", "Plan", "general-purpose", custom
  agent_name?: string,        // named agents
  model?: string,
  team_name?: string,
  isolation?: string,         // "worktree" or undefined
  run_in_background?: boolean
}

// subagent.stop
{
  session_id: string,
  agent_id: string,
  agent_type: string
}

// team.create
{
  session_id: string,
  team_name: string,
  description?: string
}

// team.message
{
  session_id: string,
  team_name: string,
  message_type: string,       // "message", "broadcast", "shutdown_request", etc.
  from: string,               // sender name
  to?: string,                // recipient name (null for broadcast)
}

// skill.invoke
{
  session_id: string,
  skill_name: string,
  args?: string,
  invoked_by?: string         // "user" or "claude"
}

// worktree.create
{
  session_id: string,
  worktree_name?: string,
  branch?: string
}

// worktree.remove
{
  session_id: string,
  worktree_name?: string,
  had_changes?: boolean
}
```

---

## New Event Handlers

Add to `packages/core/src/handlers/`:

### `subagent-start.ts`
On `subagent.start`: INSERT into `subagents` table with status='running'.

### `subagent-stop.ts`
On `subagent.stop`: UPDATE `subagents` SET status='completed', ended_at=NOW(). UPDATE `sessions` SET subagent_count = (SELECT COUNT(*) FROM subagents WHERE session_id = $1).

### `team-create.ts`
On `team.create`: INSERT into `teams` table. UPDATE `sessions` SET team_name, team_role='lead'.

### `team-message.ts`
On `team.message`: UPDATE `teams` metadata with message count. (Messages themselves are in transcript — no need to duplicate full content.)

### `skill-invoke.ts`
On `skill.invoke`: INSERT into `session_skills`.

### `worktree-create.ts`
On `worktree.create`: INSERT into `session_worktrees`.

### `worktree-remove.ts`
On `worktree.remove`: UPDATE `session_worktrees` SET removed_at, had_changes.

---

## New Hooks

### Hook Registration

Add to `packages/cli/src/commands/hooks.ts` — the hook installer should register these additional hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SubagentStart": [{
      "type": "command",
      "command": "fuel-code cc-hook subagent-start"
    }],
    "SubagentStop": [{
      "type": "command",
      "command": "fuel-code cc-hook subagent-stop"
    }],
    "PostToolUse": [
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "TeamCreate"
      },
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "Skill"
      },
      {
        "type": "command",
        "command": "fuel-code cc-hook post-tool-use",
        "matcher": "EnterWorktree"
      }
    ],
    "WorktreeCreate": [{
      "type": "command",
      "command": "fuel-code cc-hook worktree-create"
    }],
    "WorktreeRemove": [{
      "type": "command",
      "command": "fuel-code cc-hook worktree-remove"
    }]
  }
}
```

### Hook Handlers in CLI

Add to `packages/cli/src/commands/cc-hook.ts`:

**`fuel-code cc-hook subagent-start`** — reads SubagentStart hook context from stdin. Expected input fields: `session_id`, `agent_type`, plus whatever CC provides. Emits `subagent.start` event.

**`fuel-code cc-hook subagent-stop`** — reads SubagentStop hook context from stdin. Emits `subagent.stop` event.

**`fuel-code cc-hook post-tool-use`** — reads PostToolUse hook context from stdin. Dispatches based on `tool_name`:
- `TeamCreate` → emits `team.create` with team_name/description from `tool_input`
- `Skill` → emits `skill.invoke` with skill_name/args from `tool_input`
- `EnterWorktree` → emits `worktree.create` with name from `tool_input`

**`fuel-code cc-hook worktree-create`** — reads WorktreeCreate hook context from stdin. Emits `worktree.create` event.

**`fuel-code cc-hook worktree-remove`** — reads WorktreeRemove hook context from stdin. Emits `worktree.remove` event.

### Hook Input Format

CC hooks receive JSON on stdin. For PostToolUse, the shape is:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "tool_name": "TeamCreate",
  "tool_input": { ... },
  "tool_response": { ... }
}
```

For SubagentStart/SubagentStop:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "agent_type": "Explore"
}
```

For WorktreeCreate/WorktreeRemove:
```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir"
}
```

**Note**: The exact hook input schemas should be verified against CC's actual output at implementation time, as they're not fully documented. The hook handlers should be defensive — log and skip unknown fields, don't crash on missing optional fields.

---

## Transcript Parser Enhancements

File: `packages/core/src/transcript-parser.ts`

The existing parser already iterates every JSONL line and extracts messages + content blocks. Add extraction passes for:

### 1. Sub-agent extraction

When a `content_block` has `tool_name = "Task"`:
- Extract from `tool_input`: `subagent_type`, `name`, `team_name`, `model`, `run_in_background`, `isolation`, `description`
- Extract from the corresponding `tool_result` (matched by `tool_use_id`): `agent_id` (from `toolUseResult.agent_id` or `toolUseResult.teammate_id`), `agent_type`, `model`, `status`
- Build a `ParsedSubagent` record and include in parser output

### 2. Team extraction

When `tool_name = "TeamCreate"`:
- Extract `team_name`, `description` from `tool_input`
- Extract `lead_agent_id`, `team_file_path` from `tool_response`

When `tool_name = "SendMessage"`:
- Extract `type` (message/broadcast/shutdown_request/etc.), `recipient`, summary from `tool_input`
- Count messages per team for metadata

### 3. Skill extraction

When `tool_name = "Skill"`:
- Extract `skill` (name) and `args` from `tool_input`
- Extract `success`, `commandName` from `toolUseResult`
- Determine `invoked_by`: if the Skill tool call immediately follows a user message containing `/<skill-name>`, it's user-invoked; otherwise it's claude-invoked

### 4. Worktree extraction

When `tool_name = "EnterWorktree"`:
- Extract `name` from `tool_input`

### 5. Session chain detection

From the first `type: "user"` message:
- Check `source` field on the session.start event data (already captured)
- If `source` is "resume" or if transcript metadata indicates continuation, mark the session

From transcript-level metadata:
- The `version` field gives CC CLI version
- The `permissionMode` field gives the permission mode

### 6. Sub-agent transcript parsing

Currently only the main session transcript is uploaded and parsed. Extend to also handle sub-agent transcripts:

- During `session-end` hook: discover sub-agent transcript files at `{sessionId}/subagents/agent-*.jsonl`
- Upload each to S3 with key pattern: `transcripts/{session_id}/subagents/{agent_id}.jsonl`
- Parse each through the same parser pipeline
- Store resulting messages in `transcript_messages` with a new `subagent_id` column (FK to `subagents`)
- Store in `content_blocks` with same `subagent_id` FK

### New parser output types

```typescript
interface ParsedSubagent {
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  spawning_tool_use_id: string;
  started_at?: string;    // timestamp of the Task tool call
}

interface ParsedTeam {
  team_name: string;
  description?: string;
  message_count: number;
}

interface ParsedSkill {
  skill_name: string;
  invoked_at: string;
  invoked_by: 'user' | 'claude';
  args?: string;
}

interface ParsedWorktree {
  worktree_name?: string;
  created_at: string;
}

// Added to existing ParseResult
interface ParseResult {
  // ... existing fields ...
  subagents: ParsedSubagent[];
  teams: ParsedTeam[];
  skills: ParsedSkill[];
  worktrees: ParsedWorktree[];
  permission_mode?: string;
  resumed_from_session_id?: string;
}
```

---

## Session Pipeline Changes

File: `packages/core/src/session-pipeline.ts`

After transcript parsing completes, add a new pipeline step:

### Step: "persist_relationships"

After `parse` and before `summarize`:

1. **Upsert subagents**: For each `ParsedSubagent`, INSERT INTO `subagents` ON CONFLICT (session_id, agent_id) DO UPDATE. This handles both hook-created rows (from `subagent.start`) and parser-discovered rows.

2. **Upsert teams**: For each `ParsedTeam`, INSERT INTO `teams` ON CONFLICT (team_name) DO UPDATE with member_count and metadata.

3. **Insert skills**: For each `ParsedSkill`, INSERT INTO `session_skills`.

4. **Insert worktrees**: For each `ParsedWorktree`, INSERT INTO `session_worktrees`.

5. **Update session**: SET `permission_mode`, `team_name`, `team_role`, `resumed_from_session_id` on the session row.

6. **Upload sub-agent transcripts**: For each sub-agent with a local transcript file, upload to S3 and parse through the transcript parser. Store messages with the `subagent_id` FK.

The upsert pattern is important because hooks provide real-time data (rows created before transcript parsing) and the parser provides retroactive data (for backfill or when hooks didn't fire). Both should converge to the same state.

---

## Shared Types

File: `packages/shared/src/types/`

### New: `subagent.ts`

```typescript
export interface Subagent {
  id: string;
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  spawning_tool_use_id?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  status: 'running' | 'completed' | 'failed';
  started_at?: string;
  ended_at?: string;
  transcript_s3_key?: string;
  metadata: Record<string, unknown>;
}
```

### New: `team.ts`

```typescript
export interface Team {
  id: string;
  team_name: string;
  description?: string;
  lead_session_id?: string;
  created_at: string;
  ended_at?: string;
  member_count: number;
  members?: Subagent[];    // joined from subagents table
  metadata: Record<string, unknown>;
}
```

### New: `skill.ts`

```typescript
export interface SessionSkill {
  id: string;
  session_id: string;
  skill_name: string;
  invoked_at: string;
  invoked_by?: 'user' | 'claude';
  args?: string;
}
```

### New: `worktree.ts`

```typescript
export interface SessionWorktree {
  id: string;
  session_id: string;
  worktree_name?: string;
  branch?: string;
  created_at: string;
  removed_at?: string;
  had_changes?: boolean;
}
```

### Extend: `session.ts`

Add to the Session interface:
```typescript
// New fields
resumed_from_session_id?: string;
team_name?: string;
team_role?: 'lead' | 'member';
permission_mode?: string;

// Joined data (populated by detail queries)
subagents?: Subagent[];
skills?: SessionSkill[];
worktrees?: SessionWorktree[];
team?: Team;
resumed_from?: { id: string; started_at: string; initial_prompt?: string };
```

---

## API Changes

### New endpoints

**`GET /api/sessions/:id/subagents`** — List sub-agents for a session.
Returns: `Subagent[]` ordered by `started_at`.

**`GET /api/sessions/:id/skills`** — List skills invoked in a session.
Returns: `SessionSkill[]` ordered by `invoked_at`.

**`GET /api/sessions/:id/worktrees`** — List worktrees used in a session.
Returns: `SessionWorktree[]` ordered by `created_at`.

**`GET /api/teams`** — List all teams with member counts and lead session info.
Query params: `limit`, `cursor`.
Returns: `Team[]` ordered by `created_at DESC`.

**`GET /api/teams/:name`** — Team detail with members (joined from subagents) and lead session.
Returns: `Team` with `members: Subagent[]`.

### Enhanced existing endpoints

**`GET /api/sessions/:id`** — Add to response:
- `subagents`: array of subagents (summary: id, agent_type, agent_name, status)
- `skills`: array of skills used
- `worktrees`: array of worktrees
- `team`: team info if session is part of a team
- `resumed_from`: linked prior session if this was a resume/fork
- `resumed_by`: sessions that resumed from this one

**`GET /api/sessions`** — Add filter params:
- `team` — filter by team_name
- `has_subagents` — boolean, filter sessions that spawned sub-agents
- `has_team` — boolean, filter sessions that are part of a team

**`GET /api/timeline`** — Include sub-agent spawns and team events in the timeline feed. Sub-agent spawns show as nested entries under the parent session.

### WebSocket additions

New broadcast event types:
- `subagent.update` — when a sub-agent starts/completes
- `team.update` — when a team is created or membership changes

---

## TUI Changes

### SessionDetailView enhancements

**Sub-agents panel** (in the right sidebar, alongside ToolsUsedPanel and GitActivityPanel):
- Shows tree of sub-agents: type icon + name + status + duration
- Grouped by type (Explore, Plan, general-purpose, teammates)
- If session is a team lead, show team topology instead

**Skills panel** (small panel, below sub-agents):
- List of skills invoked with timestamps
- e.g., "brainstorming (auto) 2:34pm", "/commit (user) 2:45pm"

**Session chain breadcrumb** (in header):
- If this session was resumed from another, show: "Resumed from <session-id-short> →"
- Clickable to navigate to the prior session

**Team badge** (in header):
- If session is part of a team: "[team: downstream-review (lead)]"

**Worktree indicator** (in header):
- If session used worktrees: "[worktree: feature-branch]"

### Sessions list enhancements

- Sub-agent count badge: "3 agents" next to sessions that spawned sub-agents
- Team icon/badge for team sessions
- Chain icon for resumed sessions

### New: Teams view

A dedicated TUI screen accessible from the dashboard (keybind: `t` from main view).

**TeamsListView** — top-level teams list:
- Columns: team name, description (truncated), member count, lead session prompt (truncated), created date, total cost, total tokens
- Sorted by created_at DESC
- Keys: j/k navigate, Enter to expand team detail, b/Escape back to dashboard

**TeamDetailView** — expanded view for a single team:
- Header: team name, description, created/ended timestamps, total cost/tokens across all members
- Members list: each member shows agent_name, agent_type, model, status (running/completed/failed), duration, token count
- Lead session link: pressing Enter on the lead navigates to its SessionDetailView
- Member sub-agent links: pressing Enter on a member navigates to the parent session's SessionDetailView with that sub-agent highlighted
- Keys: j/k navigate members, Enter to view member's session, b/Escape back to teams list

**Data source**: `GET /api/teams` for list, `GET /api/teams/:name` for detail (includes members joined from subagents + lead session summary).

**Integration with dashboard**: Add a "Teams" option to the main dashboard's top navigation or a keybind hint in the StatusBar. The teams view is a peer of the existing workspace→sessions flow.

---

## Backfill Considerations

### Current behavior

The backfill scanner (`packages/core/src/session-backfill.ts`) discovers sessions from `~/.claude/projects/`:
- **Skips all subdirectories** (line 388-391) — this means `{sessionId}/subagents/` directories are entirely ignored today, counted as `skipped.subagents`.
- **Active session detection** via `isSessionActive()`: reads last 4KB looking for `<command-name>/exit</command-name>`, then falls back to `lsof` to check if the file is open. Active sessions are skipped.

### Required changes

1. **Process sub-agent transcript directories**: Instead of skipping all subdirectories, when a directory matches the pattern `{uuid}/subagents/`, enter it and discover the sub-agent `.jsonl` files within. Each sub-agent transcript file gets the same `isSessionActive()` check — **this is critical** because:
   - A sub-agent might still be running when the parent session's transcript is being processed
   - Teammate transcripts are separate CC instances that may outlive the lead session
   - The `/exit` + `lsof` check works identically on sub-agent transcript files

2. **Link sub-agent transcripts to parent sessions**: The subdirectory name IS the parent session UUID (`{sessionId}/subagents/agent-{agentId}.jsonl`). Use this to set `session_id` on the sub-agent's `transcript_messages` rows.

3. **Upload sub-agent transcripts during session-end hook**: When `fuel-code cc-hook session-end` runs, also discover and upload sub-agent transcripts from `{sessionId}/subagents/`. Apply `isSessionActive()` to each — only upload completed ones. (In-progress sub-agents will be caught by a later session-end or by backfill.)

4. **Re-parse existing sessions**: The existing `POST /api/sessions/:id/reparse` and `fuel-code session <id> --reparse` will automatically extract relationship data from already-parsed transcripts once the parser is enhanced. No new command needed.

### The `isSessionActive` check for sub-agents

The same two-stage check works for sub-agent transcripts:
- **Stage 1 (tail check)**: Sub-agent transcripts end the same way — the last message is typically a tool result or assistant response. The `/exit` command only appears in the parent session. So for sub-agents, Stage 1 will always fall through to Stage 2.
- **Stage 2 (lsof)**: `lsof` checks if any process has the file open. If a sub-agent is still running, CC's sub-agent process will have the file open. This is the reliable check for sub-agent liveness.

This means `isSessionActive()` already works correctly for sub-agent transcripts without modification — we just need to call it on each sub-agent file before uploading/processing.

---

## Files Modified (Summary)

| Package | File | Change |
|---------|------|--------|
| `server` | `src/db/migrations/005_session_relationships.sql` | New migration |
| `shared` | `src/types/event.ts` | Add 7 event types + Zod schemas |
| `shared` | `src/types/subagent.ts` | New type file |
| `shared` | `src/types/team.ts` | New type file |
| `shared` | `src/types/skill.ts` | New type file |
| `shared` | `src/types/worktree.ts` | New type file |
| `shared` | `src/types/session.ts` | Add new fields |
| `core` | `src/handlers/subagent-start.ts` | New handler |
| `core` | `src/handlers/subagent-stop.ts` | New handler |
| `core` | `src/handlers/team-create.ts` | New handler |
| `core` | `src/handlers/team-message.ts` | New handler |
| `core` | `src/handlers/skill-invoke.ts` | New handler |
| `core` | `src/handlers/worktree-create.ts` | New handler |
| `core` | `src/handlers/worktree-remove.ts` | New handler |
| `core` | `src/transcript-parser.ts` | Extract subagents, teams, skills, worktrees |
| `core` | `src/session-pipeline.ts` | Add persist_relationships step |
| `cli` | `src/commands/cc-hook.ts` | Add subagent-start, subagent-stop, post-tool-use, worktree-create, worktree-remove handlers |
| `cli` | `src/commands/hooks.ts` | Register new hooks in settings.json |
| `server` | `src/routes/sessions.ts` | Enhance detail endpoint, add sub-endpoints |
| `server` | `src/routes/teams.ts` | New route file |
| `server` | `src/routes/index.ts` | Mount teams router |
| `cli` | `src/tui/views/SessionDetailView.tsx` | Add sub-agents panel, skills panel, chain breadcrumb |
| `cli` | `src/tui/views/SessionListView.tsx` | Add badges for sub-agents, teams |
| `cli` | `src/tui/views/TeamsListView.tsx` | New: teams list view |
| `cli` | `src/tui/views/TeamDetailView.tsx` | New: team detail with member list |
| `cli` | `src/tui/components/SubagentsPanel.tsx` | New: sub-agent tree component |
| `cli` | `src/tui/components/SkillsPanel.tsx` | New: skills list component |
| `cli` | `src/tui/App.tsx` (or equivalent router) | Add teams view route + keybind |
| `hooks` | `git/post-commit` | Add worktree detection, include is_worktree + worktree_name in event |
| `hooks` | `git/pre-push` | Add worktree detection |
| `hooks` | `git/post-checkout` | Add worktree detection |
| `hooks` | `git/post-merge` | Add worktree detection |
| `core` | `src/handlers/git-*.ts` | Store worktree context in git_activity |

---

## Success Criteria

1. **After a session with sub-agents**: `fuel-code session <id>` shows the sub-agent tree with types, names, models, and statuses. `fuel-code session <id> --json` includes `subagents` array.

2. **After a session with agent teams**: `fuel-code session <id>` shows team name, role (lead/member), and member list. A `teams` table row exists with correct member_count.

3. **After a resumed session**: `fuel-code session <id>` shows "Resumed from <prior-session>" with the link. `resumed_from_session_id` is populated.

4. **After skill usage**: `fuel-code session <id>` lists all skills invoked with timestamps and whether they were user or auto-invoked.

5. **After worktree usage**: `fuel-code session <id>` shows worktree name, branch, and whether changes were made.

6. **Real-time via hooks**: When a sub-agent is spawned in a live session, the `subagent.start` event appears within seconds via WebSocket. Same for team creation, skill invocation, worktree creation.

7. **Retroactive via parser**: Running `fuel-code session <id> --reparse` on an old session populates sub-agents, skills, and worktrees from the transcript. Running backfill on historical sessions populates the new tables.

8. **API completeness**: `GET /api/sessions/:id` returns all new fields. `GET /api/sessions/:id/subagents`, `/skills`, `/worktrees` return correct data. `GET /api/teams` and `GET /api/teams/:name` work.

9. **TUI displays**: The session detail view shows sub-agent panel, skills panel, chain breadcrumb, and team badge. The session list shows badges for sessions with sub-agents/teams.

10. **Hooks install/uninstall**: `fuel-code hooks install` registers the 5 new hook entries (SubagentStart, SubagentStop, PostToolUse x3, WorktreeCreate, WorktreeRemove). `fuel-code hooks uninstall` removes them. `fuel-code hooks status` reports their state.

11. **Teams TUI view**: Pressing `t` from the dashboard opens the teams list. Selecting a team shows its detail with all members, their statuses, and aggregate cost/tokens. Pressing Enter on a member navigates to the parent session detail.

12. **Sub-agent transcript viewing**: `fuel-code session <id> --transcript` shows the main session transcript. Sub-agent messages are distinguishable (tagged with agent name/type). The API endpoint `GET /api/sessions/:id/transcript?subagent_id=<id>` returns only that sub-agent's messages.

---

## Resolved Design Decisions

1. **Sub-agent transcript storage**: Separate S3 objects per sub-agent, lazy-loaded. Key pattern: `transcripts/{session_id}/subagents/{agent_id}.jsonl`. Each sub-agent row has its own `transcript_s3_key`.

2. **transcript_messages subagent_id column**: Yes — add nullable `subagent_id TEXT REFERENCES subagents(id)` to both `transcript_messages` and `content_blocks`. This enables per-agent transcript views and filtering. Include in the migration:
   ```sql
   ALTER TABLE transcript_messages ADD COLUMN subagent_id TEXT REFERENCES subagents(id);
   ALTER TABLE content_blocks ADD COLUMN subagent_id TEXT REFERENCES subagents(id);
   CREATE INDEX idx_transcript_messages_subagent ON transcript_messages(subagent_id) WHERE subagent_id IS NOT NULL;
   CREATE INDEX idx_content_blocks_subagent ON content_blocks(subagent_id) WHERE subagent_id IS NOT NULL;
   ```

3. **Team message content**: Metadata only (message count, message types). Full content lives in transcripts and can be viewed there.

4. **Hook input schema verification**: Handlers must be defensive. Log raw hook input to `~/.fuel-code/hook-debug.log` during development (behind a `--debug` flag or `FUEL_CODE_DEBUG=1` env var). Gracefully handle missing/unknown fields.

5. **Session chain detection for backfill**: Best-effort matching for historical sessions using workspace + time proximity + source field. Precise linking via hooks for future sessions.

## Remaining Open Items

1. **Hook input schemas**: The exact JSON CC provides to SubagentStart, SubagentStop, WorktreeCreate, WorktreeRemove hooks needs verification at implementation time. PostToolUse schema is better documented. First implementation step should be to wire up the hooks with raw logging to capture actual schemas before building handlers.
