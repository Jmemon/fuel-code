# Parallel Session Handling: Subagents, Teams, and Backfill

## Core Constructs

Understanding the system requires exactly **5 constructs**:

| Construct | What it is | Where it lives |
|-----------|-----------|----------------|
| **Hook** | A shell command CC invokes on a lifecycle event (SubagentStart, PostToolUse[TeamCreate], etc.) | `~/.claude/settings.json` → `fuel-code cc-hook <subcommand>` |
| **Event** | A typed JSON payload (e.g. `subagent.start`) POSTed to the backend | `packages/shared/src/schemas/` |
| **Handler** | Server-side function that processes an event into DB rows | `packages/core/src/handlers/` |
| **Parser extraction** | Pass 4 of the transcript parser that retroactively discovers subagents/teams from tool_use blocks | `packages/core/src/transcript-parser.ts` |
| **Backfill discovery** | Filesystem scan of `~/.claude/projects/` that finds subagent transcript files | `packages/core/src/session-backfill.ts` |

The system has **two independent paths** for getting subagent/team data into the database:

1. **Real-time path**: Hook → Event → Handler → DB row (while session is live)
2. **Retroactive path**: Transcript parse → `persistRelationships()` → upsert into same DB tables (after session ends)

Both converge on the same tables via `ON CONFLICT ... DO UPDATE` (the "upsert convergence pattern"). This means the system is self-healing: if a hook is missed, the parser catches it; if both fire, the upsert merges gracefully.

---

## 1. Database Schema

All parallel-session tables are created in `005_session_relationships.sql`.

### Sessions table additions
```sql
-- packages/server/src/db/migrations/005_session_relationships.sql
ALTER TABLE sessions ADD COLUMN resumed_from_session_id TEXT REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN team_name TEXT;
ALTER TABLE sessions ADD COLUMN team_role TEXT CHECK (team_role IN ('lead', 'member'));
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
```

A session that creates a team gets `team_role = 'lead'`. Teammate sessions (spawned as subagents with a `team_name`) could get `team_role = 'member'` — though currently only `'lead'` is ever written.

### Subagents table
```sql
CREATE TABLE subagents (
  id                    TEXT PRIMARY KEY,           -- ULID
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL,              -- CC's internal agent UUID
  agent_type            TEXT NOT NULL,              -- "general-purpose", "Explore", etc.
  agent_name            TEXT,                       -- human-readable ("researcher")
  model                 TEXT,                       -- "sonnet", "opus", etc.
  spawning_tool_use_id  TEXT,                       -- links to content_blocks.tool_use_id
  team_name             TEXT,                       -- which team this belongs to (nullable)
  isolation             TEXT,                       -- "worktree" or null
  run_in_background     BOOLEAN DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'completed', 'failed')),
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  transcript_s3_key     TEXT,                       -- S3 key for subagent's own transcript
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_subagents_session_agent ON subagents(session_id, agent_id);
```

Key design: `UNIQUE(session_id, agent_id)` is the convergence point. Both the real-time hook path and the retroactive parser path write to this table via `ON CONFLICT (session_id, agent_id) DO UPDATE`, using `COALESCE` to fill gaps without overwriting existing data.

### Teams table
```sql
CREATE TABLE teams (
  id                TEXT PRIMARY KEY,
  team_name         TEXT NOT NULL UNIQUE,           -- globally unique team name
  description       TEXT,
  lead_session_id   TEXT REFERENCES sessions(id),   -- which session created this team
  created_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  member_count      INTEGER DEFAULT 0,
  metadata          JSONB DEFAULT '{}'              -- contains { message_count: N }
);
```

### Subagent FK on transcript data
```sql
ALTER TABLE transcript_messages ADD COLUMN subagent_id TEXT REFERENCES subagents(id);
ALTER TABLE content_blocks ADD COLUMN subagent_id TEXT REFERENCES subagents(id);
```

This means each message/block can be attributed to a specific subagent. The pipeline's `parseSubagentTranscripts()` function uses this to insert subagent transcript data with the FK set.

---

## 2. The Real-Time Path (Hooks → Events → Handlers)

### 2.1 Hook Definitions

Registered in `~/.claude/settings.json` by `fuel-code hooks install`:

```typescript
// packages/cli/src/commands/hooks.ts
const HOOK_DEFINITIONS: HookDefinition[] = [
  { event: "SessionStart", subcommand: "session-start", background: true },
  { event: "SessionEnd", subcommand: "session-end", background: true },
  { event: "SubagentStart", subcommand: "subagent-start" },
  { event: "SubagentStop", subcommand: "subagent-stop" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "TeamCreate" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "Skill" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "EnterWorktree" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "SendMessage" },
  { event: "WorktreeCreate", subcommand: "worktree-create" },
  { event: "WorktreeRemove", subcommand: "worktree-remove" },
];
```

**Subagent hooks**: CC natively fires `SubagentStart` and `SubagentStop` when spawning/completing agents. These are dedicated hook events — not tool-use matchers.

**Team hooks**: Teams are detected via `PostToolUse` matchers. CC fires `PostToolUse` after every tool call. The hook filters on `tool_name`:
- `TeamCreate` → emits `team.create` event
- `SendMessage` → emits `team.message` event

### 2.2 CLI Hook Handlers

Each hook reads CC's JSON context from stdin and emits a typed event:

```typescript
// packages/cli/src/commands/cc-hook.ts — subagent-start handler
const payload = {
  session_id: sessionId,    // CC session that spawned this
  agent_id: agentId,        // unique agent instance ID
  agent_type: agentType,    // "general-purpose", "Explore", etc.
};
await runEmit("subagent.start", {
  data: JSON.stringify(payload),
  workspaceId: workspace.workspaceId,
});
```

```typescript
// packages/cli/src/commands/cc-hook.ts — post-tool-use handler (TeamCreate dispatch)
switch (toolName) {
  case "TeamCreate":
    eventType = "team.create";
    payload = {
      session_id: sessionId,
      team_name: String(toolInput.team_name ?? "").trim(),
      description: String(toolInput.description ?? "").trim(),
    };
    break;
  case "SendMessage":
    eventType = "team.message";
    payload = {
      session_id: sessionId,
      team_name: String(toolInput.team_name ?? "").trim(),
      message_type: String(toolInput.type ?? "").trim(),
      from: String(context.from ?? "").trim(),
      to: String(toolInput.recipient ?? "").trim(),
    };
    break;
  // ... Skill, EnterWorktree
}
```

### 2.3 Server-Side Event Handlers

All handlers follow the same pattern: resolve session by CC session ID, then upsert into the DB.

**`handleSubagentStart`** — Inserts a `subagents` row with `status='running'`:
```typescript
// packages/core/src/handlers/subagent-start.ts
await sql`
  INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model,
    team_name, isolation, run_in_background, status, started_at, metadata)
  VALUES (${id}, ${session.id}, ${agentId}, ${agentType}, ${agentName}, ${model},
    ${teamName}, ${isolation}, ${runInBackground}, ${"running"}, ${event.timestamp},
    ${JSON.stringify({})})
  ON CONFLICT (session_id, agent_id) DO UPDATE SET
    agent_type = EXCLUDED.agent_type,
    agent_name = COALESCE(EXCLUDED.agent_name, subagents.agent_name),
    model = COALESCE(EXCLUDED.model, subagents.model),
    team_name = COALESCE(EXCLUDED.team_name, subagents.team_name),
    isolation = COALESCE(EXCLUDED.isolation, subagents.isolation),
    run_in_background = EXCLUDED.run_in_background,
    started_at = COALESCE(subagents.started_at, EXCLUDED.started_at)
`;
```

**`handleSubagentStop`** — Updates to `status='completed'`, or inserts a complete row if stop arrives first:
```typescript
// packages/core/src/handlers/subagent-stop.ts
const updated = await sql`
  UPDATE subagents
  SET status = ${"completed"},
      ended_at = ${event.timestamp},
      transcript_s3_key = COALESCE(${transcriptPath}, transcript_s3_key)
  WHERE session_id = ${session.id} AND agent_id = ${agentId}
  RETURNING id
`;

// If no row was found (stop arrived before start), insert a complete row
if (updated.length === 0) {
  await sql`
    INSERT INTO subagents (id, session_id, agent_id, agent_type, status,
      started_at, ended_at, transcript_s3_key, metadata)
    VALUES (${id}, ${session.id}, ${agentId}, ${agentType}, ${"completed"},
      ${event.timestamp}, ${event.timestamp}, ${transcriptPath}, ${JSON.stringify({})})
    ON CONFLICT (session_id, agent_id) DO UPDATE SET
      status = ${"completed"},
      ended_at = EXCLUDED.ended_at,
      transcript_s3_key = COALESCE(EXCLUDED.transcript_s3_key, subagents.transcript_s3_key)
  `;
}
```

**`handleTeamCreate`** — Inserts team row and marks session as lead:
```typescript
// packages/core/src/handlers/team-create.ts
await sql`
  INSERT INTO teams (id, team_name, description, lead_session_id, created_at, metadata)
  VALUES (${id}, ${teamName}, ${description}, ${session.id}, ${event.timestamp},
    ${JSON.stringify({})})
  ON CONFLICT (team_name) DO UPDATE SET
    description = COALESCE(EXCLUDED.description, teams.description),
    lead_session_id = COALESCE(EXCLUDED.lead_session_id, teams.lead_session_id)
`;

await sql`
  UPDATE sessions SET team_name = ${teamName}, team_role = ${"lead"}
  WHERE id = ${session.id}
`;
```

**`handleTeamMessage`** — Atomically increments message count:
```typescript
// packages/core/src/handlers/team-message.ts
await sql`
  UPDATE teams
  SET metadata = jsonb_set(
    metadata,
    '{message_count}',
    to_jsonb(COALESCE((metadata->>'message_count')::int, 0) + 1)
  )
  WHERE team_name = ${teamName}
  RETURNING id
`;
```

### 2.4 Subagent Transcript Upload (Session End)

When a session ends, the `session-end` hook discovers and uploads subagent transcripts:

```typescript
// packages/cli/src/commands/cc-hook.ts
async function discoverAndUploadSubagentTranscripts(
  sessionId: string,
  transcriptPath: string,
): Promise<void> {
  const transcriptDir = dirname(transcriptPath);

  // CC may store sub-agent transcripts in either location:
  const candidates = [
    join(transcriptDir, "subagents"),
    join(transcriptDir, sessionId, "subagents"),
  ];

  for (const subagentsDir of candidates) {
    if (!existsSync(subagentsDir)) continue;
    const files = readdirSync(subagentsDir);
    const agentFiles = files.filter(
      (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
    );

    for (const file of agentFiles) {
      const agentId = file.replace("agent-", "").replace(".jsonl", "");
      await runTranscriptUpload(sessionId, agentPath, agentId);
    }
  }
}
```

File pattern: `~/.claude/projects/<project-dir>/<session-id>/subagents/agent-<agent-id>.jsonl`

---

## 3. The Retroactive Path (Transcript Parsing)

After a session reaches `ended` state and its transcript is uploaded to S3, the pipeline (`session-pipeline.ts`) parses the transcript. Pass 4 of the parser extracts relationship data from the JSONL content.

### 3.1 Subagent Extraction from Transcript

The parser finds subagents by looking for `Task` or `Agent` tool_use blocks and correlating them with their tool_result blocks:

```typescript
// packages/core/src/transcript-parser.ts — Pass 4
for (const block of contentBlocks) {
  if (
    block.block_type === "tool_use" &&
    (block.tool_name === "Task" || block.tool_name === "Agent")
  ) {
    const input = block.tool_input as Record<string, unknown> | null;
    const resultBlock = block.tool_use_id
      ? toolResultMap.get(block.tool_use_id)
      : undefined;

    const agentType = (input?.subagent_type as string) ?? "unknown";
    const agentName = input?.name as string | undefined;
    const model = input?.model as string | undefined;
    const teamName = input?.team_name as string | undefined;
    const isolation = input?.isolation as string | undefined;
    const runInBackground = (input?.run_in_background as boolean) ?? false;

    // Extract agent_id from the tool result
    let agentId: string | undefined;
    if (resultBlock) {
      try {
        const resultData = JSON.parse(resultBlock.result_text ?? "{}");
        agentId = resultData.agent_id ?? resultData.teammate_id;
      } catch {
        agentId = (resultBlock.metadata as Record<string, unknown>)
          ?.agent_id as string | undefined;
      }
    }

    // Only record if we got an agent_id from the result
    if (agentId) {
      subagents.push({
        agent_id: agentId,
        agent_type: agentType,
        agent_name: agentName,
        model, team_name: teamName,
        isolation, run_in_background: runInBackground,
        spawning_tool_use_id: block.tool_use_id!,
        started_at: block.metadata?.timestamp as string | undefined,
      });
    }
  }
}
```

**Key detection signals:**
- **Subagent**: `tool_use` block with `tool_name === "Task"` or `tool_name === "Agent"`. The agent_id comes from the **tool_result** (not the tool_use input), because CC assigns the agent_id after spawning.
- **Team create**: `tool_use` block with `tool_name === "TeamCreate"`. The `team_name` comes from `tool_input.team_name`.
- **Team message**: `tool_use` block with `tool_name === "SendMessage"`. Increments message count on the corresponding team.
- **Skill**: `tool_use` block with `tool_name === "Skill"`. The parser also looks backwards through messages to determine if it was user-invoked (via slash command) or claude-invoked.
- **Worktree**: `tool_use` block with `tool_name === "EnterWorktree"`.

### 3.2 Persisting Extracted Relationships

After parsing, the pipeline calls `persistRelationships()`:

```typescript
// packages/core/src/session-pipeline.ts
async function persistRelationships(sql, sessionId, parseResult, logger) {
  // 1. Upsert subagents — hooks may have inserted rows in real-time,
  //    parser upserts retroactively with COALESCE to fill gaps.
  for (const sa of parseResult.subagents) {
    await sql`
      INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model,
        spawning_tool_use_id, team_name, isolation, run_in_background, status, started_at)
      VALUES (${id}, ${sessionId}, ${sa.agent_id}, ${sa.agent_type}, ...)
      ON CONFLICT (session_id, agent_id) DO UPDATE SET
        agent_type = COALESCE(EXCLUDED.agent_type, subagents.agent_type),
        agent_name = COALESCE(EXCLUDED.agent_name, subagents.agent_name),
        model = COALESCE(EXCLUDED.model, subagents.model),
        spawning_tool_use_id = COALESCE(EXCLUDED.spawning_tool_use_id, subagents.spawning_tool_use_id),
        ...
    `;
  }

  // 2. Upsert teams
  for (const team of parseResult.teams) {
    const memberCount = parseResult.subagents.filter(s => s.team_name === team.team_name).length;
    await sql`
      INSERT INTO teams (id, team_name, description, lead_session_id, ...)
      VALUES (...)
      ON CONFLICT (team_name) DO UPDATE SET
        description = COALESCE(EXCLUDED.description, teams.description),
        member_count = GREATEST(teams.member_count, EXCLUDED.member_count),
        metadata = jsonb_set(...)
    `;
  }

  // 3-4. Skills and worktrees: delete-then-insert (idempotent on reparse)
  // 5. Update session metadata (team_name, team_role, permission_mode, resumed_from)
  // 6. Update subagent_count from actual DB rows
}
```

### 3.3 Subagent Transcript Parsing

After persisting relationships, the pipeline parses each subagent's own transcript:

```typescript
// packages/core/src/session-pipeline.ts
async function parseSubagentTranscripts(sql, s3, sessionId, logger) {
  const subagentRows = await sql`
    SELECT id, agent_id, transcript_s3_key
    FROM subagents
    WHERE session_id = ${sessionId}
      AND transcript_s3_key IS NOT NULL
  `;

  for (const row of subagentRows) {
    const content = await s3.download(row.transcript_s3_key);
    const subParseResult = await parseTranscript(sessionId, content);

    // Insert messages and blocks with subagent_id FK set
    await sql.begin(async (tx) => {
      await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId} AND subagent_id = ${subagentUlid}`;
      await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId} AND subagent_id = ${subagentUlid}`;
      await batchInsertMessages(tx, subParseResult.messages, subagentUlid);
      await batchInsertContentBlocks(tx, subParseResult.contentBlocks, subagentUlid);
    });
  }
}
```

---

## 4. How Backfill Handles Subagents and Teams

### 4.1 Discovery Phase

Backfill scans `~/.claude/projects/` and discovers subagent transcripts as a distinct output:

```typescript
// packages/core/src/session-backfill.ts — ScanResult
export interface ScanResult {
  discovered: DiscoveredSession[];
  subagentTranscripts: DiscoveredSubagentTranscript[];
  // ...
}

export interface DiscoveredSubagentTranscript {
  parentSessionId: string;    // directory name containing subagents/
  agentId: string;            // from filename: agent-<id>.jsonl → <id>
  transcriptPath: string;
  fileSizeBytes: number;
}
```

Discovery logic in `scanForSessions()`:
```typescript
// packages/core/src/session-backfill.ts
if (entry.isDirectory()) {
  if (UUID_REGEX.test(entry.name)) {
    const subagentsDir = path.join(projectDirPath, entry.name, "subagents");
    if (fs.existsSync(subagentsDir)) {
      const saFiles = fs.readdirSync(subagentsDir);
      for (const saFile of saFiles) {
        if (saFile.startsWith("agent-") && saFile.endsWith(".jsonl")) {
          const agentId = saFile.replace("agent-", "").replace(".jsonl", "");
          pendingSubagents.push({ parentSessionId: entry.name, agentId, saPath });
        }
      }
    }
  }
}
```

Active subagent detection:
```typescript
// If parent session is live, skip the subagent transcript
if (!saTail.includes("<command-name>/exit</command-name>") &&
    activeSessions.has(item.parentSessionId)) {
  result.skipped.activeSubagents++;
  continue;
}
```

### 4.2 Ingestion Phase

Backfill does **NOT** emit `subagent.start`, `subagent.stop`, `team.create`, or `team.message` events. It only emits:
- `session.start` (synthetic)
- `session.end` (synthetic)
- Transcript upload

**Subagent/team data is populated entirely by the retroactive parser path.** Here's the flow:

```
Backfill ingestion per session:
  1. Emit session.start event → creates session row
  2. Emit session.end event → session lifecycle → "ended"
  3. Upload main transcript to S3 → triggers pipeline
  4. Pipeline runs:
     a. parseTranscript() → extracts subagents/teams from tool_use blocks
     b. persistRelationships() → upserts into subagents/teams tables
     c. parseSubagentTranscripts() → downloads/parses subagent S3 transcripts
```

**Subagent transcript upload from backfill** is handled separately after all main sessions are ingested:

```typescript
// packages/core/src/session-backfill.ts
export async function ingestSubagentTranscripts(
  transcripts: DiscoveredSubagentTranscript[],
  deps: SubagentIngestDeps,
): Promise<SubagentIngestResult> {
  for (const tx of transcripts) {
    // Only upload if the parent session was ingested
    if (!deps.ingestedParentSessionIds.has(tx.parentSessionId)) {
      result.skippedNoParent++;
      continue;
    }
    // Upload via POST /api/sessions/:id/transcript/upload?subagent_id=<agentId>
    await uploadSubagentTranscriptFile(baseUrl, deps.apiKey,
      tx.parentSessionId, tx.agentId, tx.transcriptPath, deps.signal);
  }
}
```

### 4.3 Live Session Handling in Backfill

Live sessions get special treatment — backfill emits `session.start` only (no `session.end`, no transcript upload):

```typescript
// packages/core/src/session-backfill.ts
if (session.isLive) {
  result.liveStarted = (result.liveStarted ?? 0) + 1;
  return;  // Stop here — no session.end, no transcript upload
}
```

When the live session eventually ends, the normal `SessionEnd` hook fires, emits `session.end`, uploads the transcript, and the pipeline processes it normally — including subagent/team extraction.

---

## 5. What the System Does NOT Currently Use

### `~/.claude/teams/` config files

CC stores team configuration at `~/.claude/teams/{team-name}/config.json` and task lists at `~/.claude/tasks/{team-name}/`. **fuel-code does not read or use these files.** Team data comes exclusively from:
1. Real-time `team.create` events (via PostToolUse[TeamCreate] hook)
2. Retroactive extraction from `TeamCreate` tool_use blocks in the transcript

The config.json files contain member arrays with names, agent IDs, and agent types — data that fuel-code captures independently through the subagent hooks and parser.

### Team member tracking

While CC tracks team members with names and roles (in its local config.json), fuel-code only tracks:
- The team itself (name, description, lead session, message count)
- Subagents that reference a `team_name` in their spawning input
- The session's `team_name` and `team_role` columns

There is no `team_members` join table. The relationship is inferred: a subagent with `team_name = X` is a member of team X.

### Teammate sessions as first-class sessions

When CC spawns teammates via the Agent tool with `team_name`, those agents run as subprocesses. **They are tracked as subagent rows, not as separate session rows.** A teammate does not trigger a separate `SessionStart` hook — only the lead session has a session row. The teammate's transcript is stored as a subagent transcript file.

---

## 6. Complete Data Flow Summary

### Normal (live) lifecycle:
```
CC SessionStart hook
  → fuel-code cc-hook session-start
  → emit session.start → handleSessionStart → INSERT sessions

CC spawns Agent tool
  → CC SubagentStart hook
  → fuel-code cc-hook subagent-start
  → emit subagent.start → handleSubagentStart → INSERT subagents (status=running)

CC calls TeamCreate tool
  → CC PostToolUse[TeamCreate] hook
  → fuel-code cc-hook post-tool-use
  → emit team.create → handleTeamCreate → INSERT teams + UPDATE sessions(team_name, team_role)

CC calls SendMessage tool
  → CC PostToolUse[SendMessage] hook
  → fuel-code cc-hook post-tool-use
  → emit team.message → handleTeamMessage → UPDATE teams metadata(message_count++)

Subagent finishes
  → CC SubagentStop hook
  → fuel-code cc-hook subagent-stop
  → emit subagent.stop → handleSubagentStop → UPDATE subagents (status=completed)

CC SessionEnd hook
  → fuel-code cc-hook session-end
  → emit session.end → handleSessionEnd → UPDATE sessions (lifecycle=ended)
  → upload main transcript to S3
  → discover subagent transcripts in subagents/ dir → upload each
  → pipeline triggers:
    → parseTranscript() extracts subagents/teams/skills/worktrees
    → persistRelationships() upserts (filling any gaps from hooks)
    → parseSubagentTranscripts() parses each subagent's transcript
    → lifecycle → parsed → summarized
```

### Backfill lifecycle:
```
scanForSessions()
  → discovers main .jsonl files + subagent transcripts in subagents/ dirs
  → skips live sessions' subagent transcripts
  → marks live sessions with isLive=true

ingestBackfillSessions()
  per session:
    → emit synthetic session.start → creates session row
    → if live: STOP here (no end, no transcript)
    → emit synthetic session.end → lifecycle → ended
    → upload transcript → triggers pipeline:
      → parseTranscript() extracts ALL subagents/teams from tool_use blocks
      → persistRelationships() inserts subagents/teams (no prior hook data exists)
      → parseSubagentTranscripts() processes any subagent S3 transcripts

ingestSubagentTranscripts()
  → uploads subagent .jsonl files for sessions that were ingested
  → uses ?subagent_id query param on upload endpoint
```

### Key difference between paths:

| Aspect | Normal lifecycle | Backfill |
|--------|-----------------|----------|
| Subagent DB rows created by | Hook events (real-time) + parser upsert (retroactive) | Parser only (no hooks fired) |
| Team DB rows created by | Hook events (real-time) + parser upsert (retroactive) | Parser only (no hooks fired) |
| Subagent transcript upload | session-end hook discovers & uploads | Separate `ingestSubagentTranscripts()` phase |
| Team message counting | Atomic `jsonb_set` per hook event | Parser counts `SendMessage` tool_use blocks |
| Live sessions | Full real-time tracking | Only session.start emitted; rest deferred to normal lifecycle |
