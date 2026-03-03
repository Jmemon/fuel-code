# Phase 4-4: Session Lifecycle Unification + Agent Teams Support

## Design Document — 2026-03-03

---

## 1. Goals

1. **Unify session lifecycle**: Replace `lifecycle` + `parse_status` split-brain with a single state machine: `DETECTED → ENDED → TRANSCRIPT_READY → PARSED → SUMMARIZED → COMPLETE | FAILED`
2. **Implement reconcile pattern**: SessionSeed, computeGap(), reconcileSession() — one idempotent function for all entry points (live, backfill, recovery, reparse)
3. **Support agent teams**: New `teammates` table, team detection from transcripts, stitched teammate message feeds
4. **Per-entity summaries**: Each teammate gets its own LLM-generated summary stored on `teammates.summary`
5. **Deprecation safety**: Team-related data lives in dedicated tables (`teams`, `teammates`), easily droppable. Core tables (`sessions`, `transcript_messages`, `content_blocks`) have minimal team coupling (only FK columns that become NULL if team tables are dropped)
6. **TUI integration**: Teammates appear nested under sessions (replacing subagents for team-affiliated agents), with stitched message feeds

---

## 2. Decisions Record

| # | Decision | Choice |
|---|----------|--------|
| 1 | Teammates storage | New `teammates` table separate from `subagents` |
| 2 | Message feed stitching | Query-time via `teammate_id` FK on `transcript_messages` |
| 3 | Team uniqueness | UUID PK, no uniqueness constraint on team_name |
| 4 | Legacy team cols on sessions | DROP `team_name` and `team_role` |
| 5 | Existing teams table | DROP and recreate |
| 6 | Subagent team linkage | Add `teammate_id` FK to subagents, DROP `team_name` |
| 7 | Retroactive team detection | Only new sessions going forward |
| 8 | Teammate identification timing | During `persistRelationships()` step |
| 9 | Stuck session detection | `lifecycle` + `updated_at` (no new column) |
| 10 | FK placement | `teammate_id` on BOTH `subagents` AND `transcript_messages` |
| 11 | Summary generation | Per-entity: session summary + per-teammate summaries |
| 12 | TUI sidebar display | Teammates section replaces subagents for team-affiliated agents |
| 13 | Pipeline pattern | Full reconcile pattern (SessionSeed, computeGap, reconcileSession) |
| 14 | Summary storage | `teammates.summary` column |
| 15 | Migration number | Supersedes 006 (subsumes worktree session-tracking-fixes) |
| 16 | num_teams | Derive at query time, no column on sessions |

---

## 3. New Session Lifecycle

### State Machine

```
DETECTED → ENDED → TRANSCRIPT_READY → PARSED → SUMMARIZED → COMPLETE
    |         |            |               |           |
    +→ ENDED  +→ FAILED    +→ FAILED       +→ FAILED   +→ (terminal)
    |
    +→ TRANSCRIPT_READY  (out-of-order: transcript arrives before session.end)
    |
    +→ FAILED
```

### Transition Map

```typescript
export const TRANSITIONS: Record<SessionLifecycle, SessionLifecycle[]> = {
  detected:          ["ended", "transcript_ready", "failed"],
  ended:             ["transcript_ready", "failed"],
  transcript_ready:  ["parsed", "failed"],
  parsed:            ["summarized", "failed"],
  summarized:        ["complete"],
  complete:          [],
  failed:            ["ended"],  // reset for retry via resetSessionForReparse()
};
```

### What Gets Eliminated

- `parse_status` column — folded into lifecycle (`transcript_ready` = pending, `parsed` = completed)
- `capturing` state — dead code, never set
- `archived` state — renamed to `complete`
- Split-brain recovery logic (`findStuckSessions` checking both `lifecycle` AND `parse_status`)

### Stuck Session Detection

Sessions stuck in `transcript_ready` for >10 minutes (configurable) are candidates for retry:

```sql
SELECT id FROM sessions
WHERE lifecycle = 'transcript_ready'
  AND updated_at < now() - interval '10 minutes'
ORDER BY updated_at ASC
```

No new column needed — `updated_at` is set on every lifecycle transition.

---

## 4. Database Migration 006

This migration supersedes the worktree migration 006 (session-tracking-fixes). It incorporates `is_inferred` on subagents and drops `resumed_from_session_id`.

### 4.1 Lifecycle Changes

```sql
-- Update lifecycle CHECK constraint
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_lifecycle_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_lifecycle_check CHECK (lifecycle IN (
    'detected', 'ended', 'transcript_ready',
    'parsed', 'summarized', 'complete', 'failed'
  ));

-- Migrate existing rows
UPDATE sessions SET lifecycle = 'complete' WHERE lifecycle = 'archived';
UPDATE sessions SET lifecycle = 'complete' WHERE lifecycle = 'summarized';
-- Sessions in 'capturing' (should be 0): move to 'detected'
UPDATE sessions SET lifecycle = 'detected' WHERE lifecycle = 'capturing';

-- Drop parse_status
DROP INDEX IF EXISTS idx_sessions_needs_recovery;
ALTER TABLE sessions DROP COLUMN IF EXISTS parse_status;
ALTER TABLE sessions DROP COLUMN IF EXISTS parse_error;

-- Add parse_error back as a simpler error tracking field
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_error TEXT;

-- New recovery index
CREATE INDEX IF NOT EXISTS idx_sessions_needs_recovery
  ON sessions(lifecycle, updated_at)
  WHERE lifecycle = 'transcript_ready';
```

### 4.2 Drop Team Columns from Sessions

```sql
-- Remove team-specific columns from the sessions core table
ALTER TABLE sessions DROP COLUMN IF EXISTS team_name;
ALTER TABLE sessions DROP COLUMN IF EXISTS team_role;
```

### 4.3 Subsume Worktree 006 Changes

```sql
-- From worktree session-tracking-fixes migration
ALTER TABLE sessions DROP COLUMN IF EXISTS resumed_from_session_id;
ALTER TABLE subagents ADD COLUMN IF NOT EXISTS is_inferred BOOLEAN NOT NULL DEFAULT false;
```

### 4.4 DROP and Recreate Teams Table

```sql
-- Drop existing teams table (data will be reconstructed from transcripts)
DROP TABLE IF EXISTS teams CASCADE;

CREATE TABLE teams (
  id            TEXT PRIMARY KEY,            -- ULID
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_name     TEXT NOT NULL,               -- display name, NOT unique
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}',
  -- No uniqueness constraint: same team_name can appear in different sessions
  -- or even multiple times in one session (TeamCreate→TeamDelete→TeamCreate)
  CONSTRAINT teams_session_name UNIQUE (session_id, team_name, created_at)
);

CREATE INDEX idx_teams_session ON teams(session_id);
CREATE INDEX idx_teams_name ON teams(team_name);
```

### 4.5 Create Teammates Table

```sql
CREATE TABLE teammates (
  id            TEXT PRIMARY KEY,            -- ULID
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,               -- e.g., "alice", "backend", "designer"
  cc_teammate_id TEXT,                       -- e.g., "alice@ping-pong" from CC
  color         TEXT,                        -- CC-assigned color for display
  summary       TEXT,                        -- LLM-generated summary of this teammate's work
  created_at    TIMESTAMPTZ NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_teammates_team ON teammates(team_id);
CREATE INDEX idx_teammates_session ON teammates(session_id);
```

### 4.6 Modify Subagents Table

```sql
-- Drop team_name, add teammate_id FK
ALTER TABLE subagents DROP COLUMN IF EXISTS team_name;
DROP INDEX IF EXISTS idx_subagents_team;

ALTER TABLE subagents ADD COLUMN IF NOT EXISTS teammate_id TEXT
  REFERENCES teammates(id) ON DELETE SET NULL;

CREATE INDEX idx_subagents_teammate ON subagents(teammate_id)
  WHERE teammate_id IS NOT NULL;
```

### 4.7 Add teammate_id to transcript_messages

```sql
ALTER TABLE transcript_messages ADD COLUMN IF NOT EXISTS teammate_id TEXT
  REFERENCES teammates(id) ON DELETE SET NULL;

CREATE INDEX idx_transcript_msg_teammate
  ON transcript_messages(teammate_id, timestamp)
  WHERE teammate_id IS NOT NULL;
```

### 4.8 Add teammate_id to content_blocks

```sql
-- For consistency with existing subagent_id pattern
ALTER TABLE content_blocks ADD COLUMN IF NOT EXISTS teammate_id TEXT
  REFERENCES teammates(id) ON DELETE SET NULL;

CREATE INDEX idx_content_blocks_teammate ON content_blocks(teammate_id)
  WHERE teammate_id IS NOT NULL;
```

---

## 5. The Reconcile Pattern

### 5.1 SessionSeed — Universal Normalized Input

```typescript
interface SessionSeed {
  ccSessionId: string;
  origin: 'hook' | 'backfill' | 'recovery';
  workspaceCanonicalId: string;
  deviceId: string;
  cwd: string;
  gitBranch: string | null;
  gitRemote: string | null;
  model: string | null;
  ccVersion: string | null;
  source: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  endReason: string | null;
  transcriptRef: { type: 'disk'; path: string } | { type: 's3'; key: string } | null;
  isLive: boolean;
}
```

Both live hooks and backfill construct a SessionSeed. Live hooks have rich data (model, gitRemote, ccVersion). Backfill extracts what it can from the JSONL header.

### 5.2 computeGap() — Desired State Diff

```typescript
interface SessionGap {
  needsTranscriptUpload: boolean;
  needsParsing: boolean;
  needsSubagentParsing: boolean;
  needsTeamDetection: boolean;
  needsStats: boolean;
  needsSummary: boolean;
  needsTeammateSummaries: boolean;
  needsLifecycleAdvance: boolean;
  staleStartedAt: boolean;
  staleDurationMs: boolean;
  staleSubagentCount: boolean;
}
```

### 5.3 reconcileSession() — Idempotent Gap Closer

The single function that closes the gap. Safe to call from any context.

```
reconcileSession(deps, sessionId):

  Step 1: Fetch session, compute gap
  Step 2: If needsTranscriptUpload → cannot proceed, return
  Step 3: Transition to TRANSCRIPT_READY (if not already)
  Step 4: Download and parse main transcript
  Step 5: Persist messages + content_blocks (delete-first for idempotency)
  Step 6: persistRelationships() — subagents, teams, teammates, skills, worktrees
          *** This is where teammate identification happens ***
  Step 7: Parse subagent transcripts (set subagent_id AND teammate_id on messages)
  Step 8: Fix stale timestamps (backfill started_at = ended_at bug)
  Step 9: Update stats, advance to PARSED
  Step 10: Generate session summary → advance to SUMMARIZED
  Step 11: Generate per-teammate summaries (non-fatal)
  Step 12: Advance to COMPLETE
```

### 5.4 How Every Entry Point Simplifies

```typescript
// session-end handler:
await transitionSession(sql, id, ['detected'], 'ended', { ended_at, end_reason });
const session = await sql`SELECT transcript_s3_key FROM sessions WHERE id = ${id}`;
if (session[0]?.transcript_s3_key) {
  await transitionSession(sql, id, 'ended', 'transcript_ready');
  enqueueReconcile(id);
}

// transcript-upload route:
await s3.upload(s3Key, body);
await sql`UPDATE sessions SET transcript_s3_key = ${s3Key} WHERE id = ${id}`;
await transitionSession(sql, id, ['ended', 'detected'], 'transcript_ready');
enqueueReconcile(id);

// recovery (startup):
const stuck = await findStuckSessions(sql);
for (const s of stuck) enqueueReconcile(s.id);

// reparse:
enqueueReconcile(sessionId);  // delete-first makes it idempotent

// backfill:
for (const session of discoveredSessions) {
  const seed = buildSeedFromFilesystem(session);
  await ensureSessionRow(sql, seed);
  if (!seed.isLive) {
    await endSession(sql, seed);
    await uploadTranscript(s3, sql, seed);          // main + all subagents
    enqueueReconcile(seed.ccSessionId);
  }
}
```

---

## 6. Team Detection Algorithm

Team detection runs inside `persistRelationships()` (Step 6 of reconcileSession). It requires the main transcript to be parsed but NOT the subagent transcripts (those come in Step 7).

### 6.1 Phase A: Extract Team Intervals

Scan `content_blocks` for `TeamCreate` and `TeamDelete` tool_use blocks in the main transcript (where `subagent_id IS NULL`).

```typescript
// Find TeamCreate calls
const teamCreates = contentBlocks.filter(
  b => b.block_type === 'tool_use' && b.tool_name === 'TeamCreate'
);

// Find TeamDelete calls
const teamDeletes = contentBlocks.filter(
  b => b.block_type === 'tool_use' && b.tool_name === 'TeamDelete'
);

// Build team intervals: [{team_name, description, created_at, ended_at}]
// Pair creates with deletes in ordinal order
```

For each team interval → INSERT into `teams` table.

### 6.2 Phase B: Identify Teammates from Agent Tool Calls

When the lead session spawns teammates via the `Agent` tool with `team_name` in the input, the `toolUseResult` contains:
- `status: "teammate_spawned"`
- `teammate_id: "alice@ping-pong"`
- `agent_id: "alice@ping-pong"`
- `team_name: "ping-pong"`

We extract these from content_blocks where `tool_name = 'Agent'` and the result indicates `teammate_spawned`.

For each unique teammate name within a team → INSERT into `teammates` table.

### 6.3 Phase C: Map Subagents to Teammates

This happens later during Step 7 (subagent transcript parsing). When parsing each subagent transcript, we look for `routing.sender` in `SendMessage` tool results within that subagent's content. The sender name maps to a teammate name.

Additionally, the `teamName` field on JSONL lines identifies which team a subagent belongs to.

```typescript
// During subagent transcript parsing:
for (const subagentRow of subagentsWithTranscripts) {
  const content = await s3.download(subagentRow.transcript_s3_key);
  const parseResult = parseTranscript(sessionId, content);

  // Find teammate name from routing.sender in SendMessage results
  const teammateName = extractTeammateName(parseResult);
  // Find team name from teamName field in raw lines
  const teamName = extractTeamName(parseResult);

  // Resolve teammate row
  const teammate = await sql`
    SELECT tm.id FROM teammates tm
    JOIN teams t ON t.id = tm.team_id
    WHERE tm.session_id = ${sessionId}
      AND tm.name = ${teammateName}
      AND t.team_name = ${teamName}
  `;

  const teammateId = teammate[0]?.id ?? null;

  // Update subagent row
  await sql`UPDATE subagents SET teammate_id = ${teammateId} WHERE id = ${subagentRow.id}`;

  // Insert messages + content_blocks with BOTH subagent_id AND teammate_id
  await batchInsertMessages(tx, parseResult.messages, subagentRow.id, teammateId);
  await batchInsertContentBlocks(tx, parseResult.contentBlocks, subagentRow.id, teammateId);
}
```

### 6.4 Extracting teammate name from subagent transcript

```typescript
function extractTeammateName(parseResult: ParseResult): string | null {
  // Method 1: routing.sender from SendMessage tool results
  for (const block of parseResult.contentBlocks) {
    if (block.block_type === 'tool_result' && block.tool_result_id) {
      try {
        const result = JSON.parse(block.result_text ?? '{}');
        if (result.routing?.sender) return result.routing.sender;
      } catch {}
    }
  }

  // Method 2: Look for the teammate-message XML tags in user messages
  // <teammate-message teammate_id="alice" ...>
  for (const msg of parseResult.messages) {
    if (msg.message_type === 'user' && msg.raw_message) {
      const content = msg.raw_message.message?.content;
      if (typeof content === 'string') {
        const match = content.match(/teammate_id="([^"]+)"/);
        if (match) return match[1];
      }
    }
  }

  return null;
}

function extractTeamName(parseResult: ParseResult): string | null {
  // teamName field appears on JSONL lines after TeamCreate
  for (const msg of parseResult.messages) {
    if (msg.raw_message?.teamName) return msg.raw_message.teamName;
  }
  return null;
}
```

---

## 7. Summary Generation Changes

### 7.1 Session Summary (Existing, Enhanced)

For team sessions, the session summary is enhanced to mention the team structure:

```typescript
// After all teammate summaries are generated:
const teammateContext = teammates.map(t =>
  `- ${t.name}: ${t.summary ?? 'No summary available'}`
).join('\n');

const prompt = `
# Session with ${teams.length} team(s), ${teammates.length} teammates

## Lead orchestration
${renderTranscriptForSummary(mainMessages, mainBlocks)}

## Teammate work
${teammateContext}
`;
```

System prompt updated to mention multi-agent coordination for team sessions.

### 7.2 Teammate Summaries (New)

After the session reaches PARSED, generate a summary for each teammate:

```typescript
for (const teammate of teammates) {
  // Query all messages for this teammate (via teammate_id FK)
  const messages = await sql`
    SELECT * FROM transcript_messages
    WHERE teammate_id = ${teammate.id}
    ORDER BY timestamp
  `;
  const blocks = await sql`
    SELECT * FROM content_blocks
    WHERE teammate_id = ${teammate.id}
    ORDER BY block_order
  `;

  const rendered = renderTranscriptForSummary(messages, blocks);
  const summary = await generateSummary(rendered, {
    systemPrompt: `Summarize this agent teammate's work in 1-2 sentences, past tense.
    This is "${teammate.name}", a member of team "${teamName}".
    Focus on what they accomplished, not how they communicated.`,
    maxTokens: 100,
  });

  await sql`UPDATE teammates SET summary = ${summary.text} WHERE id = ${teammate.id}`;
}
```

### 7.3 Pipeline Integration

```
reconcileSession Step 10: Generate session summary → SUMMARIZED
reconcileSession Step 11: Generate per-teammate summaries (non-fatal, best-effort)
reconcileSession Step 12: Advance to COMPLETE
```

Teammate summary failures do NOT block lifecycle advancement. The session moves to COMPLETE regardless. Missing teammate summaries can be retried independently.

---

## 8. Backfill Changes

### 8.1 New Flow (Direct DB + S3, No Synthetic Events)

```typescript
// Old: construct fake events, POST to ingest, wait for Redis
// New:
for (const session of discoveredSessions) {
  const seed = buildSeedFromFilesystem(session);
  await ensureSessionRow(sql, seed);               // INSERT ... ON CONFLICT DO NOTHING
  if (!seed.isLive) {
    await endSession(sql, seed);                    // DETECTED → ENDED
    await uploadMainTranscript(s3, sql, seed);      // S3 upload
    await uploadSubagentTranscripts(s3, sql, seed); // All subagent .jsonl files
    await transitionToTranscriptReady(sql, seed);   // ENDED → TRANSCRIPT_READY
    enqueueReconcile(seed.ccSessionId);             // Reconciler handles the rest
  } else {
    // Live session: just ensure row exists in DETECTED state
  }
}
```

### 8.2 Subagent Transcript Discovery

The session-end hook already discovers subagent transcripts from:
- `{transcriptDir}/subagents/agent-*.jsonl`
- `{transcriptDir}/{sessionId}/subagents/agent-*.jsonl`

Backfill does the same during scan phase. Each discovered subagent transcript is uploaded to S3 at `transcripts/{canonicalId}/{sessionId}/subagents/{agentId}.jsonl`.

### 8.3 What Gets Eliminated

- Synthetic session.start/session.end events through HTTP → Redis → consumer
- Rate limiting against own server
- 15-retry loop for transcript upload (race against event processing)
- The 3-path branching in handleSessionEnd for backfill

---

## 9. TUI Changes

### 9.1 Sessions List

```
  Workspace: fuel-code

  ● 2h15m  Session abc123 (claude-opus-4.6)
  │  "Implement agent teams support"
  │  └─ Teammates: alice, bob, player-a, player-b
  │  └─ Other: 10 utility agents
  │
  ◌ 45m   Session def456 (claude-sonnet-4.6)
     "Fix backfill race conditions"
     └─ 3 agents (code-executor, researcher, writer)
```

For sessions with teams: show teammates grouped by team, with a count of their component subagents. Non-team subagents shown separately as "Other" or by their usual display.

### 9.2 Session Detail Sidebar

The SubagentsPanel is enhanced to detect team-affiliated subagents:

```
┌─ Teammates ──────────────────┐
│ 🟢 alice (30 agents) ✓      │
│ 🟢 bob (29 agents) ✓        │
│ 🟡 player-a (11 agents) ✓   │
│ 🟡 player-b (10 agents) ✓   │
├─ Other Subagents ────────────┤
│ ● code-executor ✓            │
│ ● researcher ✓               │
│ ...8 more                    │
└──────────────────────────────┘
```

Clicking a teammate opens the **Teammate Detail View**.

### 9.3 Teammate Detail View

New view showing the stitched message feed:

```
┌─ Teammate: alice (Team: ping-pong) ─────────────────────┐
│ Summary: Played 15 rounds of ping-pong, escalating...   │
├──────────────────────────────────────────────────────────┤
│ [1] User (agent-a113f) 18:42:28                         │
│   ├─ <teammate-message from bob>: "Round 1..."          │
│   └─ Tool uses:                                         │
│       ├─ SendMessage → bob                              │
│       └─ Write: /test/round-1.txt                       │
│                                                          │
│ [2] Assistant (agent-a113f) 18:42:35                     │
│   ├─ "I'll respond with 42891..."                       │
│   └─ SendMessage → bob: "Round 1 response"              │
│                                                          │
│ [3] User (agent-a2b7e) 18:43:12                         │
│   ├─ <teammate-message from bob>: "Round 2..."          │
│   ...                                                    │
│                                                          │
│ Message 1 of 142  │  [b]ack  [j/k] scroll               │
└──────────────────────────────────────────────────────────┘
```

Key feature: each message shows the `agent_id` of the subagent that emitted it (e.g., `agent-a113f`), giving the user visibility into the underlying subagent structure.

### 9.4 Data Fetching

New API endpoint: `GET /api/sessions/:id/teammates/:teammateId/messages`

```sql
SELECT tm.*, sa.agent_id, sa.agent_name,
  COALESCE(json_agg(
    json_build_object('id', cb.id, 'block_type', cb.block_type, ...)
    ORDER BY cb.block_order
  ) FILTER (WHERE cb.id IS NOT NULL), '[]') AS content_blocks
FROM transcript_messages tm
JOIN subagents sa ON sa.id = tm.subagent_id
LEFT JOIN content_blocks cb ON cb.message_id = tm.id
WHERE tm.teammate_id = $teammateId
GROUP BY tm.id, sa.agent_id, sa.agent_name
ORDER BY tm.timestamp
```

### 9.5 Navigation Updates

```typescript
type View =
  | { name: "workspaces" }
  | { name: "sessions"; workspace: WorkspaceSummary }
  | { name: "session-detail"; sessionId: string; fromView: ... }
  | { name: "teams-list"; fromView: ... }
  | { name: "team-detail"; teamName: string; fromView: ... }
  | { name: "teammate-detail"; teammateId: string; sessionId: string; fromView: ... }  // NEW
```

---

## 10. API Changes

### 10.1 New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions/:id/teammates` | List teammates for a session |
| GET | `/api/sessions/:id/teammates/:id/messages` | Stitched message feed for a teammate |

### 10.2 Modified Endpoints

| Endpoint | Change |
|----------|--------|
| GET `/api/sessions` | Remove `?team` and `?has_team` filter params (or make them work through teams table JOIN) |
| GET `/api/sessions/:id` | Return `teammates[]` alongside `subagents[]` in detail response |
| GET `/api/teams` | Query from new teams table (session_id scoped) |
| GET `/api/teams/:name` | Return teammates (not subagents) as members |
| POST `/api/sessions/batch-status` | Use new lifecycle values |

### 10.3 WebSocket Broadcasts

Add `teammate.update` broadcast type for teammate summary completion.

---

## 11. Entity Relationship Diagram (Post-Migration)

```
sessions (1) ──────── (N) teams
    │                       │
    │                       │
    │                  (1) ── (N) teammates
    │                              │
    │                              │
    ├── (N) subagents ─────────── teammate_id FK (nullable)
    │         │
    │         │
    ├── (N) transcript_messages ── subagent_id FK (nullable)
    │         │                    teammate_id FK (nullable)
    │         │
    │         └── (N) content_blocks ── subagent_id FK (nullable)
    │                                   teammate_id FK (nullable)
    │
    ├── (N) session_skills
    └── (N) session_worktrees
```

Key: A `transcript_message` always has `session_id`. It may additionally have `subagent_id` (if from a subagent) and/or `teammate_id` (if from a team-affiliated subagent). Messages from the main session context have both as NULL.

---

## 12. Deprecation Runbook

To remove all team support:

```sql
-- 1. Drop team tables (CASCADE removes teammates too)
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS teammates CASCADE;

-- 2. The FK columns on subagents/transcript_messages/content_blocks
--    become NULL automatically (ON DELETE SET NULL).
--    Optionally clean up:
ALTER TABLE subagents DROP COLUMN teammate_id;
ALTER TABLE transcript_messages DROP COLUMN teammate_id;
ALTER TABLE content_blocks DROP COLUMN teammate_id;
```

Server-side file removals:
- Routes: `teams.ts`
- Handlers: `team-create.ts`, `team-message.ts`
- Pipeline: team detection block in `persistRelationships()`
- TUI: `TeamsListView.tsx`, `TeamDetailView.tsx`, `TeammateDetailView.tsx`, `useTeams.ts`
- Remove `?team` query param support from session list

**Core tables (`sessions`, `transcript_messages`, `content_blocks`, `subagents`) require NO schema migration to remove teams.** The nullable FK columns simply stop being populated.

---

## 13. Implementation Order

### Phase A: Lifecycle Unification (foundation)
1. Migration 006 — schema changes
2. Update `session-lifecycle.ts` — new state machine, drop parse_status logic
3. Update `transitionSession()` — new valid transitions
4. Update all handlers to use new lifecycle states
5. Update recovery logic to use `lifecycle + updated_at`

### Phase B: Reconcile Pattern
6. Implement `SessionSeed` type
7. Implement `computeGap()`
8. Implement `reconcileSession()` — the unified pipeline
9. Wire transcript-upload route to use TRANSCRIPT_READY transition
10. Wire session-end handler to simplified logic
11. Wire recovery to use reconcileSession

### Phase C: Backfill Rewrite
12. Rewrite backfill to use direct DB writes + S3 upload
13. Add subagent transcript upload to backfill
14. Remove synthetic event construction
15. Simplify pipeline completion polling

### Phase D: Team Detection
16. Implement team detection in `persistRelationships()`
17. Add teammate identification from Agent tool results
18. Map subagents to teammates during subagent transcript parsing
19. Set teammate_id on transcript_messages and content_blocks

### Phase E: Summaries
20. Enhance session summary for team sessions
21. Implement per-teammate summary generation
22. Store teammate summaries

### Phase F: TUI
23. Update SubagentsPanel to show Teammates section
24. Implement TeammateDetailView (stitched message feed)
25. Add new API endpoints for teammate data
26. Update navigation state machine
27. Update SessionsView grouping for teammate display

### Phase G: Cleanup
28. Remove old pipeline trigger logic (4 scattered locations → 1)
29. Remove synthetic event handling in session-end handler
30. Remove `capturing` state references
31. Update tests

---

## 14. Key Files to Modify

| File | Changes |
|------|---------|
| `packages/server/src/db/migrations/006_*.sql` | New migration (all schema changes) |
| `packages/core/src/session-lifecycle.ts` | New state machine, drop parse_status |
| `packages/core/src/session-pipeline.ts` | Implement reconcileSession pattern |
| `packages/core/src/transcript-parser.ts` | Extract teammate info from transcripts |
| `packages/core/src/handlers/session-end.ts` | Simplify to single transition |
| `packages/core/src/handlers/session-start.ts` | Minor lifecycle updates |
| `packages/core/src/session-backfill.ts` | Rewrite to direct DB+S3 |
| `packages/core/src/summary-generator.ts` | Per-teammate summary support |
| `packages/server/src/routes/transcript-upload.ts` | TRANSCRIPT_READY transition |
| `packages/server/src/routes/sessions.ts` | New teammate endpoints, updated queries |
| `packages/server/src/routes/teams.ts` | Updated to use new schema |
| `packages/cli/src/commands/backfill.ts` | Simplified backfill command |
| `packages/cli/src/tui/SessionsView.tsx` | Teammate grouping in list |
| `packages/cli/src/tui/SessionDetailView.tsx` | Updated sidebar |
| `packages/cli/src/tui/components/SubagentsPanel.tsx` | Teammates section |
| `packages/cli/src/tui/TeammateDetailView.tsx` | NEW: stitched message feed |
| `packages/cli/src/tui/App.tsx` | New navigation state |
| `packages/cli/src/tui/hooks/useTeams.ts` | Updated data fetching |
| `packages/shared/src/types/session.ts` | Updated types |
| `packages/shared/src/types/transcript.ts` | Teammate types |

---

## 15. Open Questions / Future Work

1. **Live team sessions**: Currently team detection only works post-hoc from transcripts. Live team sessions could emit real-time teammate events via PostToolUse hooks for TeamCreate/Agent calls. Deferred to a future phase.

2. **Team cost aggregation**: Summing cost across all teammates for a team session. Can be done at query time from transcript_messages token columns. No schema change needed.

3. **Cross-session teams**: If Claude Code ever supports persistent teams across sessions, the teams table would need a different scoping model. Current design is per-session.

4. **Teammate message interleaving**: When two teammates are active simultaneously, their messages are interleaved by timestamp. The TUI should make this visually clear (different colors per subagent source).
