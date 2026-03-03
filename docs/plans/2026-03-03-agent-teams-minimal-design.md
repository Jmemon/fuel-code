# Agent Teams: Minimal Design

**Date:** 2026-03-03
**Status:** Design

## The Core Problem in One Sentence

A "teammate" is not a persistent entity — it is a logical role that CC implements as a series of single-use subagents. When CC dispatches a message to the teammate named "alice", it creates a fresh subagent, runs it to completion, and the subagent dies. The next message to "alice" spawns another fresh subagent. So across a 90-subagent session, 4 teammates might each have 20–30 subagent instances. The subagents table already has all the raw rows. The only missing data is: **which teammate does each subagent instance belong to?**

That answer lives in the JSONL: `routing.sender` inside a `SendMessage` tool_use result identifies the teammate that received the message, which is the same teammate the resulting subagent was spawned to handle.

## What We Know From the Code

**Schema state:**
- `subagents` table has `agent_id` (unique per subagent instance), `agent_name`, `team_name`, `session_id`, and `transcript_s3_key`
- `teams` table exists with `team_name` as the natural unique key
- `transcript_messages` and `content_blocks` have `subagent_id` FK — so we already parse subagent transcripts and store their messages with attribution
- Sessions have `team_name` and `team_role` columns

**Parse state:**
- `transcript-parser.ts` already extracts `ParsedTeam` and `ParsedSubagent` from tool_use blocks
- `session-pipeline.ts:persistRelationships()` already upserts to `subagents` and `teams` tables
- The parser currently does NOT extract `routing.sender` from `SendMessage` tool_use_results

**TUI state:**
- `SessionsView` already groups sessions by `team_name`, shows collapsed/expanded TeamGroupRow
- `TeamDetailView` already shows "members" — but they are `subagents` rows, not logical teammates
- `SubagentsPanel` renders a flat list of subagents in SessionDetailView sidebar
- The `useTeams` hook and `GET /api/teams` endpoint already exist

**Lifecycle state:**
- `detected → capturing → ended → parsed → summarized → archived | failed`
- `parse_status` is a second parallel field that duplicates the intent of `ended → parsed`
- `capturing` only exists because "real-time capture" was once envisioned; it is never set by any current code path — `session-start.ts` sets `detected`, `session-end.ts` transitions directly `detected → ended`

---

## What We Don't Need

Before stating what to build, let me explicitly exclude things that seem appealing but are not required.

**No new "teammate" table.** The teammate identity is `agent_name` on the subagents rows, scoped to a team. A teammate is `(team_name, agent_name)`. This is already in the database. Querying "all subagent instances for teammate alice in team foo" is just `SELECT * FROM subagents WHERE team_name = 'foo' AND agent_name = 'alice'`. No new table needed.

**No "teammate timeline" materialized table.** The stitched timeline is a query result, not stored data. We compute it at query time from existing `transcript_messages` rows that already have `subagent_id` FK set.

**No new event types.** The JSONL `routing.sender` extraction is a parser enhancement, not a new hook event. Hooks don't see subagent internals anyway.

**No "subagent_instances" join table.** Subagents already have `agent_name`. Group by it.

**No changes to how teams are created.** The `team-create.ts` handler and `handleTeamCreate` are fine.

**No new lifecycle states beyond what's required.** The problem statement says `TRANSCRIPT_READY` — I'll evaluate whether this actually adds value vs. just creating another split-brain with `parse_status`.

---

## Required Outcomes vs. Minimal Implementation

### Outcome 1: New lifecycle with `parse_status` gone

**Current problem:** `parse_status` (pending/parsing/completed/failed) partially overlaps with `lifecycle` (ended/parsed/failed). A session at `lifecycle=ended, parse_status=parsing` means "currently being parsed" — but `lifecycle=ended` already means "ready to parse". The recovery query in `session-lifecycle.ts:findStuckSessions()` JOIN-filters both fields. `failSession()` sets both. `resetSessionForReparse()` sets both. It's genuinely two fields for one concept.

**Proposed lifecycle:** `detected → ended → transcript_ready → parsed → summarized → complete`

Wait — let me re-examine. The problem statement proposes `TRANSCRIPT_READY` as a state between `ended` and `parsed`. Currently:
- `ended` = session finished AND transcript uploaded to S3
- `parsed` = transcript has been parsed into `transcript_messages`

`TRANSCRIPT_READY` would mean "session finished, transcript ready to parse". That is exactly what `ended` means now. Adding `TRANSCRIPT_READY` as a new state between `ended` and `parsed` creates a 3-way confusion: `ended`, `transcript_ready`, `parsed`.

**Counter-proposal:** Drop `parse_status` entirely. Absorb its role into `lifecycle`.

```
detected -> ended -> parsed -> summarized -> complete -> (no archived)
                               \-> failed (at any non-terminal state)
```

- `detected`: session started, no transcript yet
- `ended`: session finished, transcript uploaded
- `parsed`: transcript parsed into transcript_messages/content_blocks, teammates stitched
- `summarized`: LLM summary generated
- `complete`: terminal done state (replaces `archived` which implies long-term storage concern; rename is cleaner)
- `failed`: terminal error state (unchanged)

Drop `capturing` (never used). Drop `archived` (rename to `complete`). Drop `parse_status` entirely.

**Migration:** One SQL migration adds the new CHECK constraint and renames states.

```sql
-- 006_lifecycle_cleanup.sql
ALTER TABLE sessions
  DROP COLUMN parse_status,
  DROP COLUMN parse_error;

-- Rename 'archived' -> 'complete' for existing rows
UPDATE sessions SET lifecycle = 'complete' WHERE lifecycle = 'archived';

-- Add parse_error back as a standalone column (still useful for debugging)
ALTER TABLE sessions ADD COLUMN parse_error TEXT;

-- Update CHECK constraint
ALTER TABLE sessions DROP CONSTRAINT sessions_lifecycle_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_lifecycle_check
  CHECK (lifecycle IN ('detected', 'ended', 'parsed', 'summarized', 'complete', 'failed'));
```

`session-lifecycle.ts` changes: update `TRANSITIONS`, remove all `parse_status` references. `failSession()` now just sets `lifecycle='failed'` and `parse_error`. `findStuckSessions()` now filters `WHERE lifecycle = 'ended' AND updated_at < now() - interval`.

**What drops out:** every `parse_status = 'parsing'` claim-and-lock pattern. The pipeline simply transitions `ended → parsed` atomically — if two workers race, only one succeeds (optimistic lock already handles this). No pre-claiming step needed.

### Outcome 2: TUI shows teammates nested under sessions

**The teammate concept in the TUI is:** a named logical agent (e.g., "alice") that belongs to a team. The current `TeamDetailView` shows raw subagent instances (`subagents` rows) as "members". This is wrong at scale: 30 subagent instances of "alice" would show 30 rows.

**Minimal change:** Group subagents by `(team_name, agent_name)` in the `GET /api/teams/:name` response. Return teammates, not individual subagent instances.

**Server change — `routes/teams.ts`:**
```sql
SELECT
  agent_name,
  team_name,
  COUNT(*) as invocation_count,
  MIN(started_at) as first_seen,
  MAX(ended_at) as last_seen,
  MAX(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as ever_failed
FROM subagents
WHERE team_name = $1
GROUP BY agent_name, team_name
ORDER BY first_seen
```

The response shape changes from `members: Subagent[]` to `teammates: Teammate[]` where:
```typescript
interface Teammate {
  agent_name: string;       // the logical teammate identity
  invocation_count: number; // how many subagent instances handled messages for this teammate
  first_seen: string;
  last_seen: string | null;
  ever_failed: boolean;
}
```

**`useTeams.ts` change:** Replace `TeamMember` with `Teammate` type. `TeamDetailView` renders teammate rows instead of raw subagent rows.

This is a 3-file change (teams route, useTeams hook, TeamDetailView). No schema changes.

### Outcome 3: Clicking a teammate shows its stitched message feed

**The feed:** All messages from all subagent instances that were "alice", in chronological order, with indicators of which subagent instance handled each message.

**Query:** Already achievable. `transcript_messages` has `subagent_id` FK. `subagents` has `agent_name`. Join them:
```sql
SELECT tm.*, sa.agent_name, sa.agent_id as instance_id
FROM transcript_messages tm
JOIN subagents sa ON tm.subagent_id = sa.id
WHERE sa.session_id = $sessionId
  AND sa.team_name = $teamName
  AND sa.agent_name = $agentName
ORDER BY tm.timestamp
```

**New API endpoint:** `GET /api/sessions/:id/teammates/:name/messages?team_name=foo`

This returns a flat chronological feed of messages across all subagent instances for a given teammate. Each message includes `instance_id` so the TUI can show "subagent #3 of 28" inline.

**TUI:** A new `TeammateDetailView` (or reuse `TranscriptViewer` with modified data source). Navigation: Team → Teammate → stitched message feed. This is a new view but reuses the existing `TranscriptViewer` and `MessageBlock` components.

**No new Ink components needed if** we wire it to the existing `TranscriptViewer` with the teammate messages as the data. The `TranscriptViewer` already renders `TranscriptMessageWithBlocks[]` — we just need to fetch a different source.

### Outcome 4: Parser extracts `routing.sender` for teammate attribution

This is the crux of making teammate grouping work from historical data. Currently, subagent `agent_name` is populated from the `Task`/`Agent` tool_use `name` input field. For teammate-dispatched subagents, the right identifier is `routing.sender` from the `SendMessage` tool_use result.

**Transcript parser change (`transcript-parser.ts`):**

In Pass 4 (relationship extraction), when we encounter a `SendMessage` tool_use block, we already increment message count. We need to also look at the corresponding `tool_result` block:

```typescript
// Inside the SendMessage block handling:
if (block.block_type === "tool_use" && block.tool_name === "SendMessage") {
  const input = block.tool_input as Record<string, unknown> | null;
  const resultBlock = block.tool_use_id ? toolResultMap.get(block.tool_use_id) : undefined;

  let senderName: string | undefined;
  if (resultBlock?.result_text) {
    try {
      const result = JSON.parse(resultBlock.result_text);
      senderName = result?.routing?.sender;
    } catch { /* ignore */ }
  }

  // senderName is now the teammate name — associate with the spawned subagent
  // The subagent spawned to handle this message will have a spawning_tool_use_id
  // that matches the tool_use_id of the SendMessage call
  if (senderName && block.tool_use_id) {
    teammateMap.set(block.tool_use_id, senderName);
  }
}
```

Then in subagent extraction, when we find a `Task`/`Agent` tool_use whose result contains an `agent_id`, we check if the parent SendMessage's tool_use_id is in `teammateMap` and use that as `agent_name`:

```typescript
// In subagent extraction:
const parentSendMsgId = /* correlate via spawning context */;
const teammateName = parentSendMsgId ? teammateMap.get(parentSendMsgId) : undefined;
const agentName = teammateName ?? (input?.name as string | undefined);
```

**The correlation challenge:** The link between a `SendMessage` call and the `Task`/`Agent` call it triggers is not explicit in the JSONL. However, the `teamName` field on both calls is the same, and they appear close together chronologically. The practical approach is:
- When a `SendMessage` result contains `routing.sender`, record `(team_name, sender_name)` as the "active teammate context"
- When the next `Task`/`Agent` tool_use appears with the same `team_name`, it inherits `agent_name = sender_name`
- Reset the context after each Task/Agent block

This is a heuristic but it works for CC's actual behavior: SendMessage to alice → Task spawned to handle alice's work → SendMessage to bob → Task spawned for bob.

**`ParsedSubagent` type change:**
```typescript
export interface ParsedSubagent {
  agent_id: string;
  agent_type: string;
  agent_name?: string;    // already exists; now populated from routing.sender when available
  model?: string;
  team_name?: string;
  // ... rest unchanged
}
```

No schema change. `agent_name` already exists on `subagents` table. The parser just gets smarter about populating it.

---

## Schema Changes: Migration 006

This is the only migration needed. It has three parts:

```sql
-- packages/server/src/db/migrations/006_lifecycle_cleanup.sql

-- 1. Drop the split-brain parse_status column
-- Absorb parse_error into sessions as a standalone debug field
ALTER TABLE sessions DROP COLUMN parse_status;
-- parse_error already absent? Add it if not present
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parse_error TEXT;

-- 2. Rename 'capturing' → 'detected' (never used, merge states)
UPDATE sessions SET lifecycle = 'detected' WHERE lifecycle = 'capturing';

-- 3. Rename 'archived' → 'complete' (terminal done state)
UPDATE sessions SET lifecycle = 'complete' WHERE lifecycle = 'archived';

-- 4. Update CHECK constraint to reflect new valid states
ALTER TABLE sessions DROP CONSTRAINT sessions_lifecycle_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_lifecycle_check
  CHECK (lifecycle IN ('detected', 'ended', 'parsed', 'summarized', 'complete', 'failed'));

-- 5. Drop the obsolete recovery index (was keyed on parse_status)
DROP INDEX IF EXISTS idx_sessions_needs_recovery;

-- 6. Add new recovery index (keyed only on lifecycle + updated_at)
CREATE INDEX idx_sessions_needs_parse
  ON sessions(updated_at)
  WHERE lifecycle = 'ended';
```

**Zero new tables. Zero new columns on subagents or teams.**

---

## Code Changes Summary

### packages/server/src/db/migrations/
- **New:** `006_lifecycle_cleanup.sql` — drop `parse_status`, rename states, update CHECK

### packages/shared/src/types/session.ts
- Remove `ParseStatus` type and `parse_status` field
- Remove `"capturing"` and `"archived"` from `SessionLifecycle`
- Add `"complete"` to `SessionLifecycle`

### packages/core/src/session-lifecycle.ts
- Remove `TRANSITIONS` entries for `capturing` and `archived`
- Add `complete` as terminal state
- Remove all `parse_status` column references from UPDATE queries
- Update `failSession()` to only set `lifecycle='failed'` and `parse_error`
- Update `findStuckSessions()` to filter on `lifecycle = 'ended'` only

### packages/core/src/session-pipeline.ts
- Remove the `parse_status = 'parsing'` pre-claim UPDATE (Step 2)
- Remove `parse_status: 'completed'` from `transitionSession` call
- Replace `archived` references with `complete`

### packages/core/src/transcript-parser.ts
- In Pass 4: extract `routing.sender` from `SendMessage` tool_use results
- Track "active teammate context" keyed by `team_name`
- Use teammate name as `agent_name` when populating `ParsedSubagent`

### packages/server/src/routes/teams.ts
- `GET /api/teams/:name`: replace per-subagent member query with GROUP BY `agent_name` query
- New endpoint: `GET /api/teams/:name/teammates/:teammateName/messages?session_id=X` — returns stitched message feed

### packages/server/src/routes/sessions.ts (or new file)
- Optionally expose teammate message feed under session namespace instead: `GET /api/sessions/:id/teammates/:name/messages?team_name=X`

### packages/cli/src/lib/api-client.ts
- Add `getTeammateMessages(sessionId, teammateName, teamName)` method

### packages/cli/src/tui/hooks/useTeams.ts
- Replace `TeamMember` with `Teammate` (grouped subagent type)
- Add `useTeammateMessages(sessionId, teammateName, teamName)` hook

### packages/cli/src/tui/TeamDetailView.tsx
- Render `Teammate` rows instead of raw subagent member rows
- Add Enter-to-navigate to teammate message feed

### packages/cli/src/tui/TeammateMessageView.tsx (new)
- Reuses `TranscriptViewer` component with teammate messages as data
- Shows `[instance #N]` inline delimiters between subagent handoffs
- Keybindings: b = back to TeamDetailView, j/k = scroll, q = quit

### packages/cli/src/tui/App.tsx
- Add `TeammateMessageView` to navigation state machine

### TUI component changes (TeamGroupRow.tsx)
- Update lifecycle display map: remove `capturing`, add `complete`

---

## Backfill: Detecting Teams After Normal Parsing

The problem statement says "Backfill detects teams after normal parsing". Currently `session-backfill.ts` emits synthetic `session.start` and `session.end` events which trigger normal pipeline processing. The pipeline already calls `parseSubagentTranscripts()` and `persistRelationships()`. So teams ARE already detected during backfill — the transcript parser extracts `ParsedTeam` and `persistRelationships()` upserts to the teams table.

The only gap is that the parser doesn't yet extract `routing.sender` for teammate attribution. Once `transcript-parser.ts` is enhanced (above), backfill automatically benefits — no separate backfill-specific team detection pass needed.

**Not needed:** A separate "team detection" phase, additional backfill stages, or a post-parse team-stitching job.

---

## Deprecatability

The problem statement notes this should be easily deprecatable because CC's team implementation may change.

The design is already maximally isolated:
- All teammate logic is in the transcript parser's Pass 4 (`parseTranscript` returns `subagents` with `agent_name` populated)
- The grouping query in `routes/teams.ts` is a single GROUP BY clause
- The teammate message feed is a single JOIN query
- No new tables mean nothing to drop
- If CC changes the `routing.sender` field name, only the parser extraction heuristic needs updating

If teams disappear entirely from CC, the entire teammate surface is removable by:
1. Deleting `TeammateMessageView.tsx`
2. Deleting the teammate endpoint in `routes/teams.ts`
3. Reverting the GROUP BY query to the per-subagent query
4. Removing the `routing.sender` extraction from the parser (5 lines)

The `subagents` and `teams` tables survive intact since they predate this feature.

---

## Not Doing (and Why)

| Idea | Why Not |
|------|---------|
| `teammates` table | `(team_name, agent_name)` is a derived group of existing subagent rows. No persistent data about the group itself that isn't already in the aggregation. |
| Materialized teammate timeline | It's a JOIN query. At 90 subagents/session, this is fast. Materialize only if profiling shows a problem. |
| Real-time teammate tracking via WS | Teammates only become meaningful after parse. No live-session teammate updates needed. |
| Separate "team detection" backfill pass | The transcript parser already handles this. Backfill runs the same pipeline. |
| `TRANSCRIPT_READY` lifecycle state | Redundant with `ended`. `ended` already means "transcript uploaded, ready to parse". |
| Keeping `parse_status` | It's a split-brain. `lifecycle` already expresses the same information. The pre-claim pattern it enabled (`parse_status='parsing'`) is unnecessary given optimistic locking on lifecycle transitions. |
| `capturing` state | Never set by any current code path. Dead weight. |
| `archived` vs `complete` rename | Minor but worth doing: `archived` implies cold storage tiering concern that doesn't exist. `complete` is what it means. |
| Sub-agent message replay view | Already works via SessionDetailView's transcript tab with subagent filter. Don't duplicate. |
| Storing teammate metadata (bio, avatar) | YAGNI. CC doesn't provide it and we don't need it. |
