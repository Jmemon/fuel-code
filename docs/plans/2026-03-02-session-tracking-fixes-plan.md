# Session Tracking Fixes — Implementation Plan

**Date:** 2026-03-02

## Decision Record

- **RC4 (session chains):** Remove all chain infrastructure (column, queries, UI). CC doesn't support it at the transcript level. No stubs.
- **RC1 (teammates):** Option A — teammates get first-class session rows, matching real-time behavior.
- **RC3 (subagent fallback):** Multi-strategy extraction + two-layer synthetic dedup.
- **RC2 (count overwrite):** DB-derived count is single source of truth; stats value is for logging only.

---

## Implementation Order

Dependencies flow: RC4 (schema cleanup) → RC3 (types + parser) → RC2 (pipeline) → RC1 (backfill + handlers). But several steps can be done in any order within each phase.

---

## Phase 0 — Database Migrations

Two migrations, run in order.

### Migration A: Drop resumed_from_session_id (RC4)

```sql
-- XXX_drop_session_chain.sql
ALTER TABLE sessions DROP COLUMN IF EXISTS resumed_from_session_id;
```

Edge cases:
- If any rows already have non-null values (shouldn't happen — parser never set it), the DROP discards them. Acceptable.
- FK constraint drops automatically with the column.
- Idempotent: IF EXISTS guard.

### Migration B: Add is_inferred to subagents (RC3)

```sql
-- XXX_subagents_is_inferred.sql
ALTER TABLE subagents ADD COLUMN IF NOT EXISTS is_inferred BOOLEAN NOT NULL DEFAULT false;
```

Edge cases:
- Existing rows get false (correct — they were created from real hook events with real IDs).
- IF NOT EXISTS guard for idempotency.
- NOT NULL DEFAULT false avoids NULL ambiguity in the pre-check query (`agent_id NOT LIKE 'synth:%'`).

---

## Phase 1 — Shared Types

**File:** `packages/shared/src/types/transcript.ts`

**Change 1 (RC3):** Add `is_inferred` to `ParsedSubagent`:

```typescript
export interface ParsedSubagent {
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  spawning_tool_use_id: string;
  started_at?: string;
  is_inferred?: boolean;   // ← NEW: true when agent_id was synthesized from tool_use_id
}
```

**Change 2 (RC4):** Remove `resumed_from_session_id` from `ParseResult`:

```typescript
export interface ParseResult {
  messages: TranscriptMessage[];
  contentBlocks: ParsedContentBlock[];
  stats: TranscriptStats;
  errors: Array<{ lineNumber: number; error: string }>;
  metadata: { sessionId: string | null; cwd: string | null; version: string | null; gitBranch: string | null; firstTimestamp: string | null; lastTimestamp: string | null; };
  subagents: ParsedSubagent[];
  teams: ParsedTeam[];
  skills: ParsedSkill[];
  worktrees: ParsedWorktree[];
  permission_mode?: string;
  // resumed_from_session_id REMOVED — CC does not expose this in transcripts
}
```

**File:** `packages/shared/src/types/session.ts` (RC4)

Remove `resumed_from` and `resumed_by` from the `Session` type. Remove `resumed_from_session_id` column reference.

---

## Phase 2 — Transcript Parser Changes

**File:** `packages/core/src/transcript-parser.ts`

### Change 1 (RC3): New `extractAgentId` helper

Add this function before Pass 4:

```typescript
/**
 * Extract the CC-assigned agent_id from an Agent/Task tool result.
 *
 * Real CC tool results are stringified arrays:
 *   '[{"type":"text","text":"Spawned successfully.\nagent_id: alpha@team\n..."}]'
 * NOT a plain JSON object, so simple JSON.parse().agent_id fails.
 *
 * Tries four strategies in specificity order:
 *   1. JSON parse → direct field lookup (rare structured result)
 *   2. Regex extraction from text content (most common — handles stringified arrays)
 *   3. Metadata field lookup (from makeToolResultBlock enrichment)
 *   4. Synthetic fallback using tool_use_id (always succeeds)
 *
 * Returns { agentId, inferred } — inferred=true when synthetic fallback used.
 * Synthetic IDs use 'synth:' prefix (never collides with CC's hex or name@team IDs).
 */
function extractAgentId(
  resultBlock: ParsedContentBlock | undefined,
  toolUseId: string,
): { agentId: string; inferred: boolean } {
  if (resultBlock) {
    const text = resultBlock.result_text ?? "";

    // Strategy 1: JSON parse for rare structured result objects
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const id = parsed.agent_id ?? parsed.teammate_id ?? parsed.agentId;
          if (typeof id === "string" && id.length > 0) {
            return { agentId: id, inferred: false };
          }
        }
      } catch {
        // Not JSON — fall through
      }
    }

    // Strategy 2: Regex from text content
    // Handles: "agent_id: alpha@team", "agentId: aaf1aa9fb3a4b7678"
    // Captured group: any non-whitespace, non-paren token (covers name@team and hex IDs)
    const match = text.match(/(?:agent_id|agentId):\s*([^\s\n(,\]]+)/);
    if (match?.[1] && match[1].length > 0) {
      return { agentId: match[1], inferred: false };
    }

    // Strategy 3: Metadata field (from makeToolResultBlock enrichment path)
    const metaId = (resultBlock.metadata as Record<string, unknown>)?.agent_id;
    if (typeof metaId === "string" && metaId.length > 0) {
      return { agentId: metaId, inferred: false };
    }
  }

  // Strategy 4: Synthetic fallback — every Agent/Task call gets a row
  // 'synth:' prefix cannot collide with real CC IDs (hex strings or name@team)
  return { agentId: `synth:${toolUseId}`, inferred: true };
}
```

Resilience notes on the regex:
- `[^\s\n(,\]]+` stops at whitespace, newline, `(`, `,`, `]` — handles trailing punctuation in serialized arrays
- Checked against all observed real-world ID formats: `alpha@session-tracking-fixes`, `aaf1aa9fb3a4b7678`, UUIDs

### Change 2 (RC3): Update Pass 4 subagent extraction

Replace lines 292-331 (the `if (agentId)` block):

```typescript
// For both Task and Agent tool calls, always produce a subagent entry.
// extractAgentId handles all tool result shapes and falls back to a
// deterministic synthetic ID when CC doesn't embed one.
const { agentId, inferred } = extractAgentId(
  block.tool_use_id ? toolResultMap.get(block.tool_use_id) : undefined,
  block.tool_use_id!,
);

subagents.push({
  agent_id: agentId,
  agent_type: agentType,
  agent_name: agentName,
  model,
  team_name: teamName,
  isolation,
  run_in_background: runInBackground,
  spawning_tool_use_id: block.tool_use_id!,
  started_at: block.metadata?.timestamp as string | undefined,
  is_inferred: inferred || undefined,
});
```

The `if (agentId)` guard is removed entirely. Every Agent/Task tool call produces a subagent entry, with or without a real agent ID.

Guard against absent `tool_use_id`: Add before the push:
```typescript
if (!block.tool_use_id) continue; // malformed block — tool_use blocks always have IDs in CC
```

### Change 3 (RC2): Fix `computeStats` to count Agent tool calls

Around line 939:
```typescript
// Count both legacy "Task" and current "Agent" tool names
if (block.tool_name === "Task" || block.tool_name === "Agent") {
  subagentCount++;
}
```

### Change 4 (RC4): Remove `resumed_from_session_id` from return value

The `parseTranscript` return (line 449-467) already doesn't set it — just ensure the type definition no longer declares it (done in Phase 1).

---

## Phase 3 — Pipeline Changes

**File:** `packages/core/src/session-pipeline.ts`

### Change 1 (RC2): Remove `subagent_count` from `transitionSession` call

In `runSessionPipeline`, the call at line 232-248:
```typescript
const transitionResult = await transitionSession(sql, sessionId, "ended", "parsed", {
  parse_status: "completed",
  parse_error: null,
  initial_prompt: initialPrompt ?? undefined,
  duration_ms: stats.duration_ms,
  total_messages: stats.total_messages,
  user_messages: stats.user_messages,
  assistant_messages: stats.assistant_messages,
  tool_use_count: stats.tool_use_count,
  thinking_blocks: stats.thinking_blocks,
  // subagent_count: stats.subagent_count,  ← REMOVED — set from DB after persistRelationships
  tokens_in: stats.tokens_in,
  tokens_out: stats.tokens_out,
  cache_read_tokens: stats.cache_read_tokens,
  cache_write_tokens: stats.cache_write_tokens,
  cost_estimate_usd: stats.cost_estimate_usd,
});
```

`stats.subagent_count` is preserved in `PipelineResult.stats` for logging but never written to the DB session row.

### Change 2 (RC2): Add post-transition DB-derived count

After the `transitionResult.success` check (after line 265), add:

```typescript
// Derive subagent_count from actual DB rows — single source of truth.
// Runs after transitionSession succeeds, so we know this pipeline run owns
// the session. Captures rows from all paths: real-time hooks, parser extraction,
// and gamma's synthetic fallback rows (which still represent real agent spawns).
try {
  await sql`
    UPDATE sessions
    SET subagent_count = (SELECT COUNT(*) FROM subagents WHERE session_id = ${sessionId})
    WHERE id = ${sessionId}
  `;
} catch (err) {
  log.warn({ err }, "Failed to update subagent_count from DB — non-fatal");
}
```

Why non-fatal try/catch: The lifecycle has already advanced to `parsed`. A failure here leaves `subagent_count` slightly stale, but the next reparse will correct it.

### Change 3 (RC3): Rewrite `persistRelationships` subagent section

Replace the subagent upsert block (lines 367-385) with the two-layer defensive version:

```typescript
// LAYER 1 — Pre-check: prevent synthetic duplicate INSERTs
// When real-time hooks have already inserted a row with a real CC agent_id
// for the same spawning_tool_use_id, skip creating a synthetic row.
// This avoids double-counting a single agent spawn in the final COUNT(*).
const syntheticSubagents = parseResult.subagents.filter(sa => sa.is_inferred);
const existingRealToolUseIds = new Set<string>();

if (syntheticSubagents.length > 0) {
  const toolUseIds = syntheticSubagents
    .map(sa => sa.spawning_tool_use_id)
    .filter(Boolean);

  if (toolUseIds.length > 0) {
    const rows = await sql`
      SELECT spawning_tool_use_id FROM subagents
      WHERE session_id = ${sessionId}
        AND spawning_tool_use_id = ANY(${toolUseIds})
        AND (agent_id NOT LIKE 'synth:%' OR agent_id IS NULL)
    `;
    for (const row of rows) {
      if (row.spawning_tool_use_id) {
        existingRealToolUseIds.add(row.spawning_tool_use_id as string);
      }
    }
  }
}

// Upsert all subagent rows
for (const sa of parseResult.subagents) {
  // Layer 1: Skip synthetic inserts when a real row already exists
  if (sa.is_inferred && existingRealToolUseIds.has(sa.spawning_tool_use_id)) {
    continue;
  }

  const id = generateId();
  await sql`
    INSERT INTO subagents (
      id, session_id, agent_id, agent_type, agent_name, model,
      spawning_tool_use_id, team_name, isolation, run_in_background,
      status, started_at, is_inferred
    )
    VALUES (
      ${id}, ${sessionId}, ${sa.agent_id}, ${sa.agent_type},
      ${sa.agent_name ?? null}, ${sa.model ?? null},
      ${sa.spawning_tool_use_id}, ${sa.team_name ?? null},
      ${sa.isolation ?? null}, ${sa.run_in_background},
      ${"completed"}, ${sa.started_at || null},
      ${sa.is_inferred ?? false}
    )
    ON CONFLICT (session_id, agent_id) DO UPDATE SET
      agent_type    = COALESCE(EXCLUDED.agent_type, subagents.agent_type),
      agent_name    = COALESCE(EXCLUDED.agent_name, subagents.agent_name),
      model         = COALESCE(EXCLUDED.model, subagents.model),
      spawning_tool_use_id = COALESCE(EXCLUDED.spawning_tool_use_id, subagents.spawning_tool_use_id),
      team_name     = COALESCE(EXCLUDED.team_name, subagents.team_name),
      isolation     = COALESCE(EXCLUDED.isolation, subagents.isolation),
      is_inferred   = LEAST(EXCLUDED.is_inferred::int, subagents.is_inferred::int)::boolean
      -- LEAST ensures: if either path has a real ID (is_inferred=false), false wins
  `;
}

// LAYER 2 — Post-cleanup: delete orphaned synthetic rows superseded by real ones.
// Handles the scenario: parser ran first (synthetic row created), then backfill
// uploaded the transcript providing the real agent_id. On next reparse, the
// regex extracts the real ID, upsert creates a real row, and this cleanup
// removes the now-redundant synthetic row.
if (syntheticSubagents.length > 0) {
  await sql`
    DELETE FROM subagents
    WHERE session_id = ${sessionId}
      AND agent_id LIKE 'synth:%'
      AND spawning_tool_use_id IN (
        SELECT spawning_tool_use_id FROM subagents
        WHERE session_id = ${sessionId}
          AND agent_id NOT LIKE 'synth:%'
          AND spawning_tool_use_id IS NOT NULL
      )
  `;
}
```

### Change 4 (RC4): Remove `resumed_from_session_id` from `persistRelationships`

The UPDATE in `persistRelationships` (lines 424-432) becomes:

```typescript
if (parseResult.permission_mode || parseResult.teams.length > 0) {
  await sql`
    UPDATE sessions SET
      permission_mode = COALESCE(${parseResult.permission_mode ?? null}, permission_mode),
      team_name       = COALESCE(${parseResult.teams[0]?.team_name ?? null}, team_name),
      team_role       = COALESCE(${parseResult.teams.length > 0 ? "lead" : null}, team_role)
      -- resumed_from_session_id REMOVED — CC does not provide chain data
    WHERE id = ${sessionId}
  `;
}
```

### Change 5 (RC2): Remove the old conditional `subagent_count` from `persistRelationships`

Delete lines 435-442 entirely (the `if (parseResult.subagents.length > 0)` block). Count is now always derived post-transition (Change 2 above).

---

## Phase 4 — Server Route Changes

**File:** `packages/server/src/routes/sessions.ts` (RC4)

### Change 1: Remove chain queries from session detail endpoint

In `GET /sessions/:id` (line 306-329), remove:
- The `resumedFromRows` and `resumedByRows` Promise.all entries
- `session.resumed_from = ...` and `session.resumed_by = ...` assignments

Before:
```typescript
const [subagents, skills, worktrees, teamRows, resumedFromRows, resumedByRows] =
  await Promise.all([
    sql`SELECT * FROM subagents WHERE session_id = ${id} ORDER BY started_at`,
    sql`SELECT * FROM session_skills WHERE session_id = ${id} ORDER BY invoked_at`,
    sql`SELECT * FROM session_worktrees WHERE session_id = ${id} ORDER BY created_at`,
    session.team_name
      ? sql`SELECT * FROM teams WHERE team_name = ${session.team_name}`
      : Promise.resolve([]),
    session.resumed_from_session_id   // ← REMOVE
      ? sql`SELECT id, started_at, initial_prompt FROM sessions WHERE id = ${session.resumed_from_session_id}`
      : Promise.resolve([]),
    sql`SELECT id, started_at, initial_prompt FROM sessions WHERE resumed_from_session_id = ${id}`, // ← REMOVE
  ]);
```

After:
```typescript
const [subagents, skills, worktrees, teamRows] =
  await Promise.all([
    sql`SELECT * FROM subagents WHERE session_id = ${id} ORDER BY started_at`,
    sql`SELECT * FROM session_skills WHERE session_id = ${id} ORDER BY invoked_at`,
    sql`SELECT * FROM session_worktrees WHERE session_id = ${id} ORDER BY created_at`,
    session.team_name
      ? sql`SELECT * FROM teams WHERE team_name = ${session.team_name}`
      : Promise.resolve([]),
  ]);

// Remove these two lines too:
// session.resumed_from = resumedFromRows.length > 0 ? resumedFromRows[0] : null;
// session.resumed_by = resumedByRows;
```

---

## Phase 5 — CC Hook Handler Changes

**File:** `packages/core/src/handlers/session-start.ts` (RC4 + RC1 groundwork)

### Change 1 (RC4): Capture `source='resume'` on conflict

The `ON CONFLICT (id) DO NOTHING` currently silently drops resume events. Update to at least record that a resume happened:

```sql
-- In the INSERT ... ON CONFLICT:
INSERT INTO sessions (id, ...)
VALUES (...)
ON CONFLICT (id) DO UPDATE SET
  source = CASE
    WHEN EXCLUDED.source = 'resume' THEN 'resume'
    ELSE sessions.source
  END,
  updated_at = now()
WHERE sessions.source != 'resume'  -- avoid unnecessary writes
```

This preserves `source='resume'` as a signal on the session row without implying a chain link.

### Change 2 (RC1): Accept `team_name` and `team_role` in session.start events

When backfill emits synthetic `session.start` events for teammate sessions, it needs to carry `team_name` and `team_role='member'`. The handler must accept and persist these:

```typescript
// Extract from event.data (new optional fields):
const teamName = (event.data.team_name as string | undefined) ?? null;
const teamRole = (event.data.team_role as string | undefined) ?? null;

// Include in INSERT:
INSERT INTO sessions (id, ..., team_name, team_role, ...)
VALUES (..., ${teamName}, ${teamRole}, ...)
ON CONFLICT (id) DO UPDATE SET
  team_name = COALESCE(EXCLUDED.team_name, sessions.team_name),
  team_role = COALESCE(EXCLUDED.team_role, sessions.team_role),
  source = CASE
    WHEN EXCLUDED.source = 'resume' THEN 'resume'
    ELSE sessions.source
  END,
  updated_at = now()
```

COALESCE ensures: if real-time hooks already created the session row with team metadata, backfill's synthetic event doesn't overwrite it.

---

## Phase 6 — Backfill Changes

**File:** `packages/core/src/session-backfill.ts` (RC1)

This is the largest new code. Adding teammate sessions as first-class session rows.

### Change 1: Enrich `DiscoveredSubagentTranscript`

Add fields to carry workspace/time metadata needed to construct session rows:

```typescript
export interface DiscoveredSubagentTranscript {
  parentSessionId: string;
  agentId: string;            // from filename: agent-{agentId}.jsonl
  transcriptPath: string;
  fileSizeBytes: number;
  // NEW: enriched during scan phase B
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  workspaceCanonicalId: string;  // inherited from parent or resolved independently
  resolvedCwd: string | null;    // inherited from parent DiscoveredSession
  teamName: string | null;       // extracted from transcript or parent's team context
}
```

### Change 2: Enrich during scan Phase B

In the subagent workers loop (`scanForSessions`, around line 740), after collecting the path, add metadata extraction:

```typescript
// Read first and last lines of the transcript for timestamps
const { firstTimestamp, lastTimestamp, teamName } = readSubagentMeta(item.saPath);

// Inherit workspace from parent session if already discovered
const parentSession = result.discovered.find(s => s.sessionId === item.parentSessionId);
const workspaceCanonicalId = parentSession?.workspaceCanonicalId ?? "_unassociated";
const resolvedCwd = parentSession?.resolvedCwd ?? null;

result.subagentTranscripts.push({
  parentSessionId: item.parentSessionId,
  agentId: item.agentId,
  transcriptPath: item.saPath,
  fileSizeBytes: fs.statSync(item.saPath).size,
  firstTimestamp,
  lastTimestamp,
  workspaceCanonicalId,
  resolvedCwd,
  teamName,
});
```

New helper function `readSubagentMeta`:

```typescript
/**
 * Read the first and last JSONL lines of a subagent transcript to extract
 * timestamps and team context. Fast: reads only line boundaries, not the full file.
 * Returns nulls on any read error — non-fatal for backfill.
 */
function readSubagentMeta(filePath: string): {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  teamName: string | null;
} {
  try {
    // Read first line for timestamps and initial metadata
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);

    const firstLine = buf.slice(0, bytesRead).toString("utf8").split("\n")[0];
    let firstTimestamp: string | null = null;
    let teamName: string | null = null;

    try {
      const parsed = JSON.parse(firstLine);
      firstTimestamp = parsed.timestamp ?? null;
      // Check for team context in system messages or metadata
      teamName = parsed.data?.team_name ?? parsed.teamName ?? null;
    } catch { /* malformed first line — continue */ }

    // For lastTimestamp, read last 512 bytes
    const stats = fs.statSync(filePath);
    const tailBuf = Buffer.alloc(512);
    const tailFd = fs.openSync(filePath, "r");
    const tailOffset = Math.max(0, stats.size - 512);
    const tailBytes = fs.readSync(tailFd, tailBuf, 0, 512, tailOffset);
    fs.closeSync(tailFd);

    const tailStr = tailBuf.slice(0, tailBytes).toString("utf8");
    const lines = tailStr.split("\n").filter(l => l.trim());
    let lastTimestamp: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const p = JSON.parse(lines[i]);
        if (p.timestamp) { lastTimestamp = p.timestamp; break; }
      } catch { continue; }
    }

    return { firstTimestamp, lastTimestamp, teamName };
  } catch {
    return { firstTimestamp: null, lastTimestamp: null, teamName: null };
  }
}
```

### Change 3: New `ingestTeammateAsSession` function

```typescript
/**
 * Ingest a teammate's transcript as a first-class session row.
 *
 * Creates a deterministic session ID (UUID v5) from parentSessionId + agentId,
 * emits synthetic session.start and session.end events (with team_name and
 * team_role='member'), then uploads the transcript to the new session row.
 *
 * Idempotent: the deterministic ID means re-running backfill produces the same
 * session ID. The session.start handler uses ON CONFLICT DO UPDATE with COALESCE,
 * so re-runs are safe.
 *
 * Also uploads to the parent's subagent row (existing behavior) to set
 * transcript_s3_key, enabling the pipeline to parse the subagent's messages.
 */
async function ingestTeammateAsSession(
  transcript: DiscoveredSubagentTranscript,
  parentSession: DiscoveredSession | undefined,
  deps: IngestDeps,
): Promise<void> {
  // Derive deterministic session ID using UUID v5
  // Namespace: a fixed UUID for fuel-code backfill teammate sessions
  const TEAMMATE_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // UUID v5 DNS namespace
  const teammateSessionId = uuidv5(
    `backfill:teammate:${transcript.parentSessionId}:${transcript.agentId}`,
    TEAMMATE_NS,
  );

  const now = new Date().toISOString();
  const startTs = transcript.firstTimestamp ?? now;
  const endTs = transcript.lastTimestamp ?? startTs;

  // Determine team context: try transcript metadata first, then parent session's parsed data
  const teamName = transcript.teamName ?? null;

  // Emit session.start for the teammate
  const startEvent: Event = {
    id: generateId(),
    type: "session.start" as EventType,
    timestamp: startTs,
    device_id: deps.deviceId,
    data: {
      session_id: teammateSessionId,   // deterministic ID
      workspace_canonical_id: transcript.workspaceCanonicalId,
      cwd: transcript.resolvedCwd,
      device_name: deps.deviceName,
      device_type: deps.deviceType ?? "local",
      source: "backfill",
      team_name: teamName,             // picked up by session-start handler
      team_role: teamName ? "member" : null,
    },
  };

  await postEvents([startEvent], deps.serverUrl, deps.apiKey, deps.signal);

  // Emit session.end
  const endEvent: Event = {
    id: generateId(),
    type: "session.end" as EventType,
    timestamp: endTs,
    device_id: deps.deviceId,
    data: { session_id: teammateSessionId },
  };

  await postEvents([endEvent], deps.serverUrl, deps.apiKey, deps.signal);

  // Upload transcript to the teammate's own session row
  // (pipeline will parse it, giving the session messages/stats/summary)
  await uploadTranscriptWithRetry(
    teammateSessionId,
    transcript.transcriptPath,
    deps.serverUrl,
    deps.apiKey,
    deps.signal,
  );
}
```

Note on double upload: The teammate transcript is uploaded to the teammate's session row for pipeline parsing. The existing `uploadSubagentTranscriptFile` uploads to the parent's subagent row (for `transcript_s3_key` on the subagent row). These are two separate uploads. A future optimization could deduplicate. Not needed now.

### Change 4: Wire into `ingestBackfillSessions`

After main sessions are ingested, process teammates:

```typescript
// Phase 4: Ingest teammate sessions as first-class session rows
// Only process transcripts whose parent was successfully ingested
for (const transcript of subagentTranscripts) {
  if (!ingestedParentIds.has(transcript.parentSessionId)) continue;
  if (alreadyIngested?.has(`teammate:${transcript.parentSessionId}:${transcript.agentId}`)) continue;

  try {
    const parentSession = discovered.find(s => s.sessionId === transcript.parentSessionId);
    await ingestTeammateAsSession(transcript, parentSession, deps);
    // Record in alreadyIngested under a prefixed key to distinguish from main sessions
    ingestedParentIds.add(`teammate:${transcript.parentSessionId}:${transcript.agentId}`);
  } catch (err) {
    result.errors.push({
      sessionId: `teammate:${transcript.parentSessionId}:${transcript.agentId}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

### Change 5: Wire into CLI backfill command

In `packages/cli/src/commands/backfill.ts`, pass `scanResult.subagentTranscripts` into the ingest call:

```typescript
const result = await ingestBackfillSessions(
  scanResult.discovered,
  scanResult.subagentTranscripts,  // ← NEW param
  { ...deps }
);
```

---

## Phase 7 — UI Cleanup (RC4)

Files: `packages/cli/src/tui/SessionDetailView.tsx`, `packages/cli/src/tui/components/SessionHeader.tsx`, any component rendering `session.resumed_from` or `session.resumed_by`.

Remove all chain-display rendering. The data no longer comes from the API and the types no longer include it. Any `session.resumed_from` / `session.resumed_by` references become compile errors after Phase 1 types are updated — use those as a guide for what to delete.

---

## Phase 8 — Tests

### Tests to ADD

| File | Test Cases |
|------|-----------|
| `transcript-parser-relationships.test.ts` | Tool result as stringified array → regex extraction; no tool result → synthetic; error result → synthetic; agentId: camelCase → extracted; nested JSON text → extracted; duplicate tool_use_id → single subagent entry |
| `transcript-parser.test.ts` | computeStats counts Agent tool calls; combined Task + Agent count |
| `session-pipeline.test.ts` | subagent_count = DB-derived (not stats); post-transition count fires; pre-check prevents synthetic duplicate insert; Layer 2 cleanup removes superseded synthetic row; persistRelationships update excludes resumed_from_session_id |
| `session-backfill.test.ts` | Teammate session gets deterministic ID; idempotent (same ID on re-run); transcript uploaded to teammate session row; parent-not-yet-ingested → teammate skipped; no team_name → teammate row has NULL team fields |
| `sessions.test.ts` (server) | Detail endpoint no longer returns resumed_from/resumed_by |

### Tests to UPDATE

| File | Change |
|------|--------|
| `transcript-parser-relationships.test.ts` | Change "Task tool call without agent_id is NOT extracted" → now expects 1 subagent with `is_inferred: true` |
| `relationship-handlers.test.ts` | session-start handler test: assert team_name/team_role fields are persisted when present in event data |

---

## Edge Case Master Table

| Scenario | RC | Handling |
|----------|-----|---------|
| Teammate transcript has no timestamps | RC1 | firstTimestamp = lastTimestamp = now() at ingest time. Acceptable approximation. |
| Parent session ingested AFTER teammate | RC1 | ingestedParentIds.has() check skips teammate. Next backfill run (idempotent) processes it. |
| Teammate is itself a team lead (nested team) | RC1 + pipeline | Backfill creates member row. Pipeline parses transcript, finds TeamCreate, calls persistRelationships which sets team_role='lead' — overwriting member. Correct: pipeline is more authoritative. |
| Team name collision across different CC projects | RC1 | Teams table has UNIQUE (team_name). ON CONFLICT DO UPDATE merges — lead_session_id keeps first-seen. Since CC team names include random suffixes, collision probability is negligible. |
| Teammate that crashed (truncated transcript) | RC1 | readSubagentMeta reads what's available. Truncated files upload fine. Pipeline fails gracefully on malformed parse. Session row still created. |
| Real-time created session row before backfill | RC1 | session.start ON CONFLICT DO UPDATE with COALESCE merges. Real-time metadata preserved. |
| Same synth: ID re-inserted on reparse after real ID created | RC3 | Layer 1 pre-check sees real row for same spawning_tool_use_id → skips synthetic insert. Layer 2 cleanup would also catch it. |
| Agent tool result content truncated by maxInlineContentBytes | RC3 | agent_id line typically appears in first few hundred bytes. 256 KB limit rarely truncates it. If truncated, synthetic fallback. |
| Agent tool called but errored (is_error=true) | RC3 | Regex still runs on error text. Usually falls through to synthetic. Error subagent is tracked — correct, it was still spawned. |
| Multiple Agent calls in one message | RC3 | Each has unique tool_use_id → unique synthetic IDs. No collision. |
| subagent_count race: hooks insert rows between step 5.5 and post-transition count | RC2 | Post-transition COUNT includes them. Slightly over-counts if hooks run mid-pipeline, but is accurate to the moment. Acceptable. |
| Pipeline transitionSession fails (race) | RC2 | Post-transition count update is inside the success branch → not reached. Next pipeline run will do its own count. |
| persistRelationships fails (non-fatal) | RC2 | No subagent rows created. Post-transition COUNT returns 0. Correct — no rows means count is 0. Hooks-created rows are not affected (they're already in DB). |
| Backfill running while real-time session active | RC1 | Existing active-session detection skips main sessions. Teammate files inside those sessions are also skipped (their parent is live). |
| CC version using future tool name (not Task/Agent) | RC2+RC3 | computeStats would miss the count; extraction block would miss the subagent. One-line fix in each when we discover the new name. The is_inferred flag helps detect the gap in production. |
| UUID v5 collision for teammate session IDs | RC1 | UUID v5 is deterministic and collision-resistant for the namespace+name combination. The namespace is unique to fuel-code backfill. |
| Session chain UI renders stale data from before migration | RC4 | Column dropped. Types updated. Compile errors force removal. No stale UI path. |
| source='resume' session that was previously source=NULL | RC4 | ON CONFLICT DO UPDATE SET source = CASE WHEN EXCLUDED.source = 'resume' THEN 'resume' ELSE sessions.source END correctly updates only on explicit resume signal. |

---

## Rollout Order

1. **Migrations (Phase 0)** — drop resumed_from column; add is_inferred
2. **Shared types (Phase 1)** — compile-error-driven removal of chain refs
3. **Transcript parser (Phase 2)** — extractAgentId + computeStats fix
4. **Pipeline (Phase 3)** — ordering fix + two-layer subagent defense
5. **Server routes (Phase 4)** — remove chain queries
6. **CC hook handler (Phase 5)** — session.start accepts team_name/team_role
7. **Backfill (Phase 6)** — teammate session rows
8. **UI cleanup (Phase 7)** — remove chain display components
9. **Tests (Phase 8)** — verify all paths

Phases 0–5 can ship as a self-contained batch (all invisible improvements to existing data). Phases 6–8 can follow. The critical path for making teams visible in fuel-code sessions is: Phase 2 → Phase 3 → Phase 6 (parser extracts subagents → pipeline counts them correctly → backfill creates teammate rows).
