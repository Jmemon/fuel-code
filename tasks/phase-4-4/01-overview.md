# Phase 4-4: Session Lifecycle Unification

## Problem Statement

Session processing has two main code paths -- **live** (hook-driven) and **backfill** (filesystem-driven) -- that are supposed to produce identical outcomes but diverge in significant ways. This divergence is the root cause of recurring bugs.

### The Five Root Problems

**1. `handleSessionEnd` is the #1 bug factory**

The session-end handler (`packages/core/src/handlers/session-end.ts:67-136`) has 3 distinct code paths that conflate session lifecycle management with backfill awareness:

```typescript
// PATH A: Normal transition (detected/capturing -> ended)
const result = await transitionSession(sql, ccSessionId, ["detected", "capturing"], "ended", {...});

// PATH B: Session doesn't exist yet (race or backfill) -> create directly in 'ended'
if (result.reason === "Session not found") {
  await sql`INSERT INTO sessions (...) VALUES (..., ${"ended"}, ..., ${"backfill"}, ...)`;
  // Creates with started_at = ended_at, duration_ms = 0 -- NEVER corrected
}

// PATH C: Session already ended AND was backfill -> override with real data
if (result.previousLifecycle === "ended" && source === "backfill") {
  await sql`UPDATE sessions SET ended_at=..., end_reason=..., duration_ms=... WHERE ...`;
}
```

Path B creates sessions with `started_at = ended_at` and `duration_ms = 0`. The pipeline later extracts correct timestamps from the transcript but never propagates them back to fix `started_at`.

**2. Pipeline trigger logic is scattered across 4 locations**

The decision "should I trigger the pipeline?" is made independently in:
- `handleSessionEnd` (line 148-167) -- checks if `transcript_s3_key` already exists
- `transcript-upload.ts` (line 186-191) -- checks if `lifecycle='ended'`
- `recoverStuckSessions` in `session-recovery.ts` -- on server startup
- `session-actions.ts` reparse endpoint -- manual re-trigger

Each checks different preconditions with different error handling.

**3. `lifecycle` + `parse_status` is a split-brain**

Two independent status fields updated by different code at different times:

```sql
lifecycle       TEXT  -- detected/capturing/ended/parsed/summarized/archived/failed
parse_status    TEXT  -- pending/parsing/completed/failed
```

The `parse_status` is updated outside the lifecycle state machine via raw SQL. If the parser crashes between setting `parse_status='parsing'` and the lifecycle transition, the session is left in a zombie state (`lifecycle='ended', parse_status='parsing'`) that requires dedicated recovery logic (`findStuckSessions`).

**4. `capturing` state is dead code**

Defined in the transition map, accepted as a source state in `handleSessionEnd`, but **nothing in the codebase ever transitions a session TO `capturing`**.

**5. Backfill creates impoverished session data**

Synthetic events carry `null` for `model`, `git_remote`, `cc_version` even though `model` is extractable from the JSONL transcript header. The backfill also routes synthetic events through HTTP -> Redis -> consumer, adding unnecessary round-trips, rate-limiting concerns, and race conditions against its own server.

---

## Current Architecture: The Two Flows

### Live Flow (Hook-Driven)

```
CC SessionStart hook
  -> cli/cc-hook.ts reads stdin, resolves workspace
  -> POST /api/events/ingest (session.start event)
  -> Redis Stream -> consumer -> processEvent()
  -> handleSessionStart() -> INSERT sessions (lifecycle='detected')

[Session runs -- subagent/team/skill/worktree hooks fire in real-time]

CC SessionEnd hook
  -> POST /api/events/ingest (session.end event)
  -> Redis -> consumer -> handleSessionEnd()
  -> transitionSession(detected -> ended)
  -> BACKGROUND: spawn `fuel-code transcript upload`
     -> POST /api/sessions/:id/transcript/upload
     -> S3 upload, UPDATE transcript_s3_key
     -> if lifecycle='ended': triggerPipeline()

Pipeline (session-pipeline.ts):
  -> Download transcript from S3
  -> parseTranscript() -> messages + contentBlocks + stats
  -> Persist to Postgres (batch inserts)
  -> persistRelationships() (subagents, teams, skills, worktrees via UPSERT)
  -> parseSubagentTranscripts()
  -> transitionSession(ended -> parsed) with stats
  -> generateSummary() -> transitionSession(parsed -> summarized)
  -> Upload parsed backup to S3
```

### Backfill Flow (Filesystem-Driven)

```
scanForSessions()
  -> Walk ~/.claude/projects/ directories
  -> Read JSONL headers + sessions-index.json for metadata
  -> Resolve workspaces from git remote
  -> Detect live sessions via process detection
  -> Return DiscoveredSession[]

ingestBackfillSessions() -- per session, 10 concurrent workers:
  1. checkSessionExists() via GET /api/sessions/:id (dedup)
  2. Construct + POST synthetic session.start event
     -> HTTP -> Redis -> consumer -> handleSessionStart()
  3. Construct + POST synthetic session.end event
     -> HTTP -> Redis -> consumer -> handleSessionEnd()
  4. uploadTranscriptWithRetry() -- POST /api/sessions/:id/transcript/upload
     -> With 15 retries (race: events may not be processed yet)
  5. Pipeline triggers from transcript-upload route

waitForPipelineCompletion()
  -> Poll until all sessions reach parsed/summarized/failed
```

### Where the Flows Diverge

| Aspect | Live Flow | Backfill Flow |
|--------|-----------|---------------|
| Session creation | `handleSessionStart` with rich hook data | Same handler, but `model=null`, `git_remote=null`, `cc_version=null` |
| Relationship data | Real-time hooks (subagent.start, team.create, etc.) | Only from transcript parsing (UPSERT convergence) |
| session.end edge cases | Simple transition | 3-path branching for race handling |
| Pipeline trigger | Race between session-end handler and transcript-upload | Deterministic (events emitted before upload) but still goes through Redis |
| Duration computation | From hook data or DB query | From JSONL timestamps, then overwritten by pipeline stats |
| Retry mechanism | `session-recovery.ts` finds stuck sessions | `failedSessionIds` in BackfillState |
| Transport | Direct HTTP -> Redis -> consumer | Same (synthetic events through same pipeline) |

---

## Proposed Architecture: Four Abstractions

### Abstraction 1: `SessionSeed` -- Universal Normalized Input

A single data structure that captures everything known about a session at discovery time, regardless of source. Eliminates the data quality divergence between live and backfill.

```typescript
interface SessionSeed {
  /** CC session UUID -- becomes the session PK */
  ccSessionId: string;
  /** Where the data came from */
  origin: 'hook' | 'backfill' | 'recovery';
  /** Workspace canonical ID (from git resolution) */
  workspaceCanonicalId: string;
  /** Device ID */
  deviceId: string;
  /** Working directory */
  cwd: string;
  /** Git branch if known */
  gitBranch: string | null;
  /** Git remote if known */
  gitRemote: string | null;
  /** Model if known (live: from CC context; backfill: from JSONL header) */
  model: string | null;
  /** CC version if known */
  ccVersion: string | null;
  /** Session source (startup/resume/clear/compact/backfill) */
  source: string;
  /** When the session started */
  startedAt: string;
  /** When the session ended (null if still live) */
  endedAt: string | null;
  /** Duration in ms if known */
  durationMs: number | null;
  /** End reason if known */
  endReason: string | null;
  /** Where the transcript lives */
  transcriptRef: { type: 'disk'; path: string } | { type: 's3'; key: string } | null;
  /** Whether this session is still active */
  isLive: boolean;
}
```

Both live hooks and backfill construct a `SessionSeed`:
- **Live hook**: Rich data from CC context (`model`, `gitRemote`, `ccVersion` all present)
- **Backfill**: Extracts what it can from JSONL header (model, gitBranch, cwd) -- still missing `gitRemote`/`ccVersion` but now explicit about it

### Abstraction 2: `TRANSCRIPT_READY` Lifecycle State -- Explicit Pipeline Gate

Replace the implicit "ended AND transcript_s3_key IS NOT NULL" conjunction with an explicit lifecycle state that IS the pipeline trigger.

**New lifecycle:**

```
DETECTED -> ENDED -> TRANSCRIPT_READY -> PARSED -> SUMMARIZED -> COMPLETE
    |          |           |                |           |
    +--------->+---------->+--------------->+---------->+-> FAILED
```

```typescript
export const TRANSITIONS: Record<SessionLifecycle, SessionLifecycle[]> = {
  detected:          ["ended", "transcript_ready", "failed"],
  ended:             ["transcript_ready", "failed"],
  transcript_ready:  ["parsed", "failed"],
  parsed:            ["summarized", "failed"],
  summarized:        ["complete"],
  complete:          [],
  failed:            [],
};
```

Key design decisions:
- **`TRANSCRIPT_READY` replaces `parse_status`**. No more split-brain. A session in `transcript_ready` means "has transcript, ready for parsing". A session in `parsed` means parsing is complete.
- **`DETECTED -> TRANSCRIPT_READY`** allows the out-of-order case where transcript upload arrives before session.end.
- **`capturing` is removed**. Dead code.
- **`complete` replaces `archived`**. Clearer semantics.
- **Pipeline trigger happens in ONE place**: the transition to `TRANSCRIPT_READY`.

```typescript
// transcript-upload handler -- THE ONLY place that triggers the pipeline:
await s3.upload(s3Key, body);
await sql`UPDATE sessions SET transcript_s3_key = ${s3Key} WHERE id = ${sessionId}`;
const result = await transitionSession(sql, sessionId,
  ["ended", "detected"],  // accept either -- handles out-of-order arrival
  "transcript_ready"
);
if (result.success) {
  enqueueReconcile(sessionId);
}

// session-end handler -- JUST transition lifecycle, check for existing transcript:
await transitionSession(sql, id, ["detected"], "ended", { ended_at, end_reason, durationMs });
const session = await sql`SELECT transcript_s3_key FROM sessions WHERE id = ${id}`;
if (session[0]?.transcript_s3_key) {
  // Transcript arrived before session.end -- catch up
  const result = await transitionSession(sql, id, "ended", "transcript_ready");
  if (result.success) enqueueReconcile(id);
}
```

Both paths try to transition to `TRANSCRIPT_READY`. Optimistic locking (`WHERE lifecycle = ANY($from)`) ensures exactly one succeeds. The loser logs and exits. Race eliminated by design.

### Abstraction 3: `computeGap()` -- Desired State Diff

A query function that compares current session state against the desired end-state and returns what is missing or inconsistent.

```typescript
interface SessionGap {
  // What's missing
  needsTranscriptUpload: boolean;   // no transcript_s3_key
  needsParsing: boolean;            // transcript_ready but no parsed messages in DB
  needsRelationships: boolean;      // parsed but relationships not persisted
  needsSubagentParsing: boolean;    // subagents with transcripts but no parsed data
  needsStats: boolean;              // parsed but stats columns empty on session row
  needsSummary: boolean;            // parsed but no summary text
  needsLifecycleAdvance: boolean;   // lifecycle < target state

  // What's inconsistent
  staleStartedAt: boolean;          // started_at doesn't match transcript first timestamp
  staleDurationMs: boolean;         // duration_ms doesn't match computed value
  staleSubagentCount: boolean;      // subagent_count != COUNT(*) from subagents table
}

async function computeGap(sql: Sql, sessionId: string, config: SummaryConfig): Promise<SessionGap> {
  const session = await sql`
    SELECT lifecycle, transcript_s3_key, summary, initial_prompt,
           total_messages, subagent_count, started_at, duration_ms
    FROM sessions WHERE id = ${sessionId}
  `;

  const [msgCount] = await sql`
    SELECT COUNT(*) as c FROM transcript_messages
    WHERE session_id = ${sessionId} AND subagent_id IS NULL
  `;

  const [subagentsMissing] = await sql`
    SELECT COUNT(*) as c FROM subagents
    WHERE session_id = ${sessionId}
      AND transcript_s3_key IS NOT NULL
      AND id NOT IN (
        SELECT DISTINCT subagent_id FROM transcript_messages
        WHERE session_id = ${sessionId} AND subagent_id IS NOT NULL
      )
  `;

  const s = session[0];
  const hasParsedMessages = Number(msgCount.c) > 0;

  return {
    needsTranscriptUpload: !s.transcript_s3_key,
    needsParsing: !!s.transcript_s3_key && !hasParsedMessages,
    needsRelationships: hasParsedMessages && /* check relationship tables */,
    needsSubagentParsing: Number(subagentsMissing.c) > 0,
    needsStats: hasParsedMessages && !s.total_messages,
    needsSummary: config.enabled && hasParsedMessages && !s.summary,
    needsLifecycleAdvance: /* lifecycle < target */,
    staleStartedAt: /* transcript first timestamp != started_at */,
    staleDurationMs: /* computed duration != stored duration */,
    staleSubagentCount: /* session.subagent_count != DB COUNT(*) */,
  };
}
```

### Abstraction 4: `reconcileSession()` -- Idempotent Gap Closer

A single function that closes the gap between current state and desired state. Safe to call from any context: pipeline trigger, recovery, reparse, retry. Each step is independently idempotent.

```typescript
async function reconcileSession(deps: PipelineDeps, sessionId: string): Promise<ReconcileResult> {
  const { sql, s3, summaryConfig, logger } = deps;
  const gap = await computeGap(sql, sessionId, summaryConfig);

  if (isFullyReconciled(gap)) {
    return { sessionId, success: true, errors: [] };
  }

  // Cannot proceed without transcript
  if (gap.needsTranscriptUpload) {
    return { sessionId, success: false, errors: ['No transcript in S3'] };
  }

  // Step 1: Parse transcript if needed (idempotent via delete-first)
  if (gap.needsParsing) {
    const session = await sql`SELECT transcript_s3_key FROM sessions WHERE id = ${sessionId}`;
    const content = await s3.download(session[0].transcript_s3_key);
    const parseResult = await parseTranscript(sessionId, content);

    await sql.begin(async (tx) => {
      await tx`DELETE FROM content_blocks WHERE session_id = ${sessionId} AND subagent_id IS NULL`;
      await tx`DELETE FROM transcript_messages WHERE session_id = ${sessionId} AND subagent_id IS NULL`;
      await batchInsertMessages(tx, parseResult.messages);
      await batchInsertContentBlocks(tx, parseResult.contentBlocks);
    });

    // Persist relationships (idempotent via upsert/delete-first)
    await persistRelationships(sql, sessionId, parseResult, logger);

    // Write stats (always overwrite -- latest parse is truth)
    const stats = parseResult.stats;
    await sql`
      UPDATE sessions SET
        initial_prompt = ${stats.initial_prompt},
        duration_ms = ${stats.duration_ms},
        total_messages = ${stats.total_messages},
        user_messages = ${stats.user_messages},
        assistant_messages = ${stats.assistant_messages},
        tool_use_count = ${stats.tool_use_count},
        thinking_blocks = ${stats.thinking_blocks},
        tokens_in = ${stats.tokens_in},
        tokens_out = ${stats.tokens_out},
        cache_read_tokens = ${stats.cache_read_tokens},
        cache_write_tokens = ${stats.cache_write_tokens},
        cost_estimate_usd = ${stats.cost_estimate_usd},
        updated_at = now()
      WHERE id = ${sessionId}
    `;
  }

  // Step 2: Fix stale timestamps (the backfill started_at = ended_at bug)
  if (gap.staleStartedAt) {
    // Correct started_at from transcript's first timestamp
    await correctTimestampsFromTranscript(sql, sessionId);
  }

  // Step 3: Parse subagent transcripts if needed
  if (gap.needsSubagentParsing) {
    await parseSubagentTranscripts(sql, s3, sessionId, logger);
  }

  // Step 4: Advance lifecycle (transcript_ready -> parsed)
  if (gap.needsLifecycleAdvance) {
    await transitionSession(sql, sessionId, "transcript_ready", "parsed");
  }

  // Step 5: Generate summary if needed (no re-parsing required!)
  if (gap.needsSummary) {
    const messages = await sql`SELECT * FROM transcript_messages WHERE session_id = ${sessionId}`;
    const blocks = await sql`SELECT * FROM content_blocks WHERE session_id = ${sessionId}`;
    const summary = await generateSummary(messages, blocks, summaryConfig);
    await sql`UPDATE sessions SET summary = ${summary.text} WHERE id = ${sessionId}`;
    await transitionSession(sql, sessionId, "parsed", "summarized");
  }

  return { sessionId, success: true, errors: [] };
}
```

---

## How Every Entry Point Simplifies

Every current trigger becomes a thin wrapper around `enqueueReconcile`:

```typescript
// session-end handler: transition lifecycle, check for existing transcript
await transitionSession(sql, id, ['detected'], 'ended', { ended_at, end_reason });
const session = await sql`SELECT transcript_s3_key FROM sessions WHERE id = ${id}`;
if (session[0]?.transcript_s3_key) {
  await transitionSession(sql, id, 'ended', 'transcript_ready');
  enqueueReconcile(id);
}

// transcript-upload route: upload to S3, transition, reconcile
await s3.upload(s3Key, body);
await sql`UPDATE sessions SET transcript_s3_key = ${s3Key} WHERE id = ${id}`;
await transitionSession(sql, id, ['ended', 'detected'], 'transcript_ready');
enqueueReconcile(id);

// recovery: just reconcile all stuck sessions
const stuck = await findStuckSessions(sql);
for (const s of stuck) enqueueReconcile(s.id);

// reparse: just reconcile (delete-first makes it idempotent, no reset needed)
enqueueReconcile(sessionId);
```

## How Backfill Becomes Trivial

```typescript
// Old: construct fake events, POST to ingest, wait for Redis, retry with rate limiting...
// New:
for (const session of discoveredSessions) {
  const seed = buildSeedFromFilesystem(session);        // SessionSeed
  await ensureSessionRow(sql, seed);                     // INSERT ... ON CONFLICT DO NOTHING
  if (!seed.isLive) {
    await endSession(sql, seed);                         // transition DETECTED -> ENDED
    await uploadTranscript(s3, sql, seed);               // S3 upload + ENDED -> TRANSCRIPT_READY
    enqueueReconcile(seed.ccSessionId);                  // reconciler does the rest
  }
}
```

No synthetic events. No HTTP round-trips through the ingest endpoint. No Redis. No rate limiting against the server. Backfill writes directly to DB and S3, then the reconciler handles parsing, summarization, and lifecycle advancement -- using the exact same code path as live sessions.

---

## What Gets Eliminated

| Current Code | Approx Lines | Replaced By |
|-------------|-------------|-------------|
| `handleSessionEnd` 3-path branching (session-end.ts:67-136) | ~70 | Simple `transitionSession` + check for existing transcript |
| `parse_status` column + all its checks | scattered | `TRANSCRIPT_READY` lifecycle state |
| `recoverStuckSessions` (session-recovery.ts) | ~100 | `reconcileSession` IS the recovery |
| `recoverUnsummarizedSessions` (session-recovery.ts) | ~50 | `reconcileSession` detects `needsSummary` without re-parsing |
| `resetSessionForReparse` (session-lifecycle.ts) | ~30 | `reconcileSession` re-parses idempotently (delete-first) |
| Pipeline trigger in session-end handler | ~20 | Eliminated -- only transcript upload triggers |
| Pipeline trigger in transcript-upload route | ~10 | Single `transitionSession` to `TRANSCRIPT_READY` |
| Backfill synthetic event construction | ~100 | `SessionSeed` feeds directly to DB |
| Backfill HTTP round-trips through ingest | ~60 | Direct DB writes |
| `capturing` state | dead code | Removed |
| `findStuckSessions` zombie state detection | ~40 | No zombie states possible (no split-brain) |

**Total: ~550+ lines eliminated or simplified.**

---

## Subagent / Team Session Handling

Subagents currently go through a different path:
- **Live**: Real-time hooks create rows in `subagents` table, transcripts uploaded to parent session's S3 path
- **Backfill**: Relationships discovered only from transcript parsing via `persistRelationships()`
- **Pipeline**: `parseSubagentTranscripts()` downloads and parses each subagent's transcript, inserting messages/blocks with `subagent_id` FK

Under the new model, subagents are handled by the reconciler's `needsSubagentParsing` gap check. The reconciler queries for subagent rows with `transcript_s3_key IS NOT NULL` but no corresponding parsed messages, and parses them. This works identically whether the subagent row came from a real-time hook or from transcript parsing.

If teammates become first-class session rows (as discussed in phase-4-2 plans), they would go through the exact same lifecycle: `DETECTED -> ENDED -> TRANSCRIPT_READY -> PARSED -> SUMMARIZED -> COMPLETE`. The only difference is `team_role = 'member'` on the session row.

---

## Migration Path

This can be done incrementally:

1. **Add `transcript_ready` and `complete` to lifecycle CHECK constraint** -- DB migration, zero risk
2. **Implement `computeGap()` and `reconcileSession()`** -- new code, runs alongside existing pipeline
3. **Wire transcript-upload route to use `TRANSCRIPT_READY` transition** -- replace distributed trigger
4. **Simplify `handleSessionEnd`** -- remove 3-path branching, just transition lifecycle
5. **Wire recovery to use `reconcileSession`** -- replace `recoverStuckSessions` + `recoverUnsummarizedSessions`
6. **Wire backfill to use `SessionSeed` + direct DB writes** -- bypass synthetic events
7. **Drop `parse_status` column** -- final cleanup after all code paths migrated
8. **Remove `capturing` state** -- dead code cleanup
