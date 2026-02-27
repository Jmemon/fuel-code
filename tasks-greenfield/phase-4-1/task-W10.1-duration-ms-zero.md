# Task W10.1: Fix duration_ms Always Zero for Ended Sessions

## Validation Workflow: W10.1

## Problem

15 of 19 ended/parsed/summarized sessions have `duration_ms=0` in the database. Only 4 have non-zero values -- those 4 were created via the backfill path, which correctly computes duration from transcript timestamps. All sessions created via the live hook pipeline (Claude Code SessionEnd hook) have `duration_ms=0` because of a design mismatch between the hook and the server handler.

The session-end hook intentionally sends `duration_ms: 0` with a comment saying "the server computes actual duration from the session.start event's timestamp." However, the server-side handler (`handleSessionEnd`) reads `duration_ms` directly from the event payload and stores it verbatim. **Nobody on the server side computes `ended_at - started_at`.**

This means:
- All live sessions show "-" or "0s" for duration in `fuel-code sessions`
- Workspace total time aggregates (`SUM(duration_ms)`) are near-zero
- Timeline duration stats are meaningless
- Any future analytics over session duration will be wrong

## How to Reproduce

1. Start infrastructure and server:
   ```bash
   docker compose -f docker-compose.test.yml up -d
   cd packages/server && bun run src/index.ts
   ```

2. Start a Claude Code session in a git repo:
   ```bash
   cd /path/to/any-repo
   claude
   ```

3. Do some work (ask a question, have Claude read a file), then exit:
   ```
   /exit
   ```

4. Wait 10 seconds for pipeline processing, then check:
   ```bash
   fuel-code sessions --limit 1
   ```

5. Observe the DURATION column shows "-" or "0s".

6. Confirm via API:
   ```bash
   curl -s -H "Authorization: Bearer fc_local_dev_key_123" \
     http://localhost:3020/api/sessions | python3 -c "
   import sys, json
   data = json.load(sys.stdin)
   for s in data.get('sessions', [])[:5]:
       print(f\"  {s['id'][:8]}  lifecycle={s['lifecycle']}  duration_ms={s.get('duration_ms')}\")"
   ```

7. All hook-originated sessions will show `duration_ms=0` or `duration_ms=None`.

## Expected Behavior

Every ended/parsed/summarized session should have a non-zero `duration_ms` reflecting the actual wall-clock time from `started_at` to `ended_at`. For example, a session that started at 10:00 and ended at 10:05 should have `duration_ms=300000`.

## Root Cause Analysis

There are **three code paths** that set `duration_ms` on a session, and only one of them works correctly:

### Path 1: Live Hook (BROKEN) -- The Primary Issue

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/hooks/claude/_helpers/session-end.ts`, lines 50-54
**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/cc-hook.ts`, line 168

Both the standalone hook helper and the CLI `cc-hook` command hardcode `duration_ms: 0`:

```typescript
// packages/hooks/claude/_helpers/session-end.ts:50-54
//    duration_ms is set to 0 -- the server computes actual duration
//    from the session.start event's timestamp.
const payload = {
  cc_session_id: sessionId,
  duration_ms: 0,       // <-- hardcoded to 0
  end_reason: endReason,
  transcript_path: transcriptPath,
};
```

```typescript
// packages/cli/src/commands/cc-hook.ts:166-171
const payload = {
  cc_session_id: sessionId,
  duration_ms: 0,       // <-- hardcoded to 0
  end_reason: endReason,
  transcript_path: transcriptPath,
};
```

The comment claims "the server computes actual duration" but the server does not.

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/handlers/session-end.ts`, lines 33, 47

The server handler reads `duration_ms` directly from the event data and passes it through to the database:

```typescript
// packages/core/src/handlers/session-end.ts:33
const durationMs = event.data.duration_ms as number;   // reads the 0

// packages/core/src/handlers/session-end.ts:39-48
const result = await transitionSession(
  sql,
  ccSessionId,
  ["detected", "capturing"],
  "ended",
  {
    ended_at: event.timestamp,
    end_reason: endReason,
    duration_ms: durationMs,    // stores the 0
  },
);
```

### Path 2: Backfill (WORKS) -- Correctly Computes Duration

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-backfill.ts`, lines 604-611

The backfill code correctly computes duration from the transcript's first and last timestamps:

```typescript
let durationMs = 0;
if (session.firstTimestamp && session.lastTimestamp) {
  durationMs = Math.max(
    0,
    new Date(session.lastTimestamp).getTime() -
      new Date(session.firstTimestamp).getTime(),
  );
}
```

This is why the 4 non-zero sessions all came from backfill.

### Path 3: Pipeline Parse (DOES NOT SET duration_ms)

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-pipeline.ts`, lines 212-227

The transcript parser computes `duration_ms` in `parseResult.stats.duration_ms` (see `/Users/johnmemon/Desktop/fuel-code/packages/core/src/transcript-parser.ts`, lines 750-771), but the pipeline's transition from `ended` to `parsed` **does not include `duration_ms`** in the update fields:

```typescript
const transitionResult = await transitionSession(sql, sessionId, "ended", "parsed", {
  parse_status: "completed",
  // ... stats fields like total_messages, tokens_in, tokens_out, etc.
  // BUT NOT duration_ms!
});
```

This is a missed opportunity -- the parser already computes the correct duration from transcript timestamps, but it's never written to the sessions row.

### Summary

| Path | Sends `duration_ms` | Value | Result |
|------|---------------------|-------|--------|
| Live hook -> session-end handler | Yes | 0 (hardcoded) | Stored as 0 |
| Backfill -> session-end handler | Yes | Computed from timestamps | Correct |
| Pipeline parse -> transition to parsed | No | (computed but not saved) | Duration stays 0 |

## Fix Plan

There are two complementary fixes. Either one alone solves the problem, but both should be applied for defense-in-depth.

### Fix A: Server-side computation in session-end handler (PRIMARY FIX)

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/handlers/session-end.ts`

When `duration_ms` from the event payload is 0 (or missing), compute it from the session's `started_at` timestamp and the event's `timestamp` (which is `ended_at`).

```typescript
// After line 33, replace the simple assignment with:
let durationMs = event.data.duration_ms as number;

// If the hook sent 0, compute from session timestamps
if (!durationMs || durationMs <= 0) {
  // Look up the session's started_at to compute duration
  const sessionRow = await sql`
    SELECT started_at FROM sessions WHERE id = ${ccSessionId}
  `;
  if (sessionRow.length > 0 && sessionRow[0].started_at) {
    const startedAt = new Date(sessionRow[0].started_at).getTime();
    const endedAt = new Date(event.timestamp).getTime();
    if (!isNaN(startedAt) && !isNaN(endedAt)) {
      durationMs = Math.max(0, endedAt - startedAt);
    }
  }
}
```

This is the most correct fix because:
- It handles the live hook path which is the primary ingestion flow
- It preserves non-zero values from backfill or any future hook that computes duration client-side
- The `started_at` is already in the sessions table from the `session.start` handler

### Fix B: Include duration_ms in pipeline parse transition (SECONDARY FIX)

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-pipeline.ts`

At the `transitionSession` call around line 212, add `duration_ms` from the parsed stats. This serves as a fallback that corrects duration even if Fix A is somehow missed, and it provides the most accurate duration (from actual transcript message timestamps).

Change the transition call to include:

```typescript
const transitionResult = await transitionSession(sql, sessionId, "ended", "parsed", {
  parse_status: "completed",
  parse_error: null,
  initial_prompt: initialPrompt ?? undefined,
  duration_ms: stats.duration_ms,    // <-- ADD THIS LINE
  total_messages: stats.total_messages,
  // ... rest of existing fields
});
```

Note: The `UpdatableSessionFields` type in `/Users/johnmemon/Desktop/fuel-code/packages/core/src/session-lifecycle.ts` (line 92) already includes `duration_ms: number`, so no type changes are needed.

### Fix C (Optional): Update hook comments

**Files**:
- `/Users/johnmemon/Desktop/fuel-code/packages/hooks/claude/_helpers/session-end.ts`, line 50
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/cc-hook.ts`, around line 168

Update or remove the misleading comment. After Fix A, the comment is technically true (the server does compute it when the hook sends 0), but it would be clearer to state the intention explicitly:

```typescript
// duration_ms: 0 signals the server to compute actual duration from started_at and ended_at.
```

### Fix D (Optional): Backfill data migration

Run a one-time SQL migration to fix the 15 existing sessions that have `duration_ms=0` but valid `started_at` and `ended_at`:

```sql
UPDATE sessions
SET duration_ms = EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000,
    updated_at = now()
WHERE duration_ms = 0
  AND ended_at IS NOT NULL
  AND started_at IS NOT NULL
  AND lifecycle IN ('ended', 'parsed', 'summarized');
```

This can be run manually or added as a migration (005_backfill_duration.sql).

### Testing

1. **Unit test**: Add a test to `packages/core/src/__tests__/event-processor.test.ts` that sends a `session.end` event with `duration_ms: 0` and verifies the handler computes the correct duration from `started_at` and `event.timestamp`.

2. **E2E test**: After the fix, run a live Claude Code session and verify:
   ```bash
   fuel-code sessions --limit 1
   ```
   The DURATION column should show a non-zero value like `2m 15s`.

3. **Existing test regression**: Run `bun test` across all packages to ensure no existing tests break. The key test file is `packages/core/src/__tests__/event-processor.test.ts` which tests the session-end handler with `duration_ms: 5400000` (a non-zero value). That test should still pass since Fix A only activates when `duration_ms <= 0`.
