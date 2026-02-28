# Task 4: Session Lifecycle State Machine

## Parallel Group: B

## Description

Formalize the session lifecycle state machine as a core module. This defines which transitions are valid, performs guarded state transitions in Postgres using optimistic locking, and provides recovery utilities for stuck sessions. Every component that changes session lifecycle (handlers, pipeline, reparse, recovery) imports this module — no raw `UPDATE sessions SET lifecycle = ...` queries elsewhere.

### Files to Create

**`packages/core/src/session-lifecycle.ts`**:

```typescript
// Valid lifecycle transitions:
//   detected   → capturing | failed
//   capturing  → ended     | failed
//   ended      → parsed    | failed
//   parsed     → summarized| failed
//   summarized → archived
//   archived   → (terminal)
//   failed     → (terminal, but resetSessionForReparse can move failed → ended)

type SessionLifecycle = "detected" | "capturing" | "ended" | "parsed" | "summarized" | "archived" | "failed";

const TRANSITIONS: Record<SessionLifecycle, SessionLifecycle[]>;

function isValidTransition(from: SessionLifecycle, to: SessionLifecycle): boolean;

interface TransitionResult {
  success: boolean;
  previousLifecycle: SessionLifecycle | null;
  newLifecycle: SessionLifecycle | null;
  reason?: string;  // if success=false, explains why
}
```

**`transitionSession`**: The core function for lifecycle changes.

```typescript
async function transitionSession(
  sql: postgres.Sql,
  sessionId: string,
  from: SessionLifecycle | SessionLifecycle[],  // accept array for "from any of these"
  to: SessionLifecycle,
  updates?: Partial<{
    ended_at: string;
    end_reason: string;
    duration_ms: number;
    transcript_s3_key: string;
    parse_status: string;
    parse_error: string | null;
    summary: string;
    initial_prompt: string;
    total_messages: number;
    user_messages: number;
    assistant_messages: number;
    tool_use_count: number;
    thinking_blocks: number;
    subagent_count: number;
    tokens_in: number;
    tokens_out: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_estimate_usd: number;
  }>
): Promise<TransitionResult>
```

Implementation:
- Validate `isValidTransition(from, to)` first (for each `from` if array).
- Execute: `UPDATE sessions SET lifecycle = $to, ...updates, updated_at = now() WHERE id = $id AND lifecycle = ANY($from) RETURNING lifecycle`
- If 0 rows updated: query current lifecycle for diagnostics. Return `{ success: false, reason: "Session is in state '{actual}', expected '{from}'" }`.
- If session not found: return `{ success: false, reason: "Session not found" }`.

**`failSession`**: Convenience for transitioning any non-terminal state to `failed`.

```typescript
async function failSession(
  sql: postgres.Sql,
  sessionId: string,
  error: string,
  fromStates?: SessionLifecycle[]  // defaults to all non-terminal states
): Promise<TransitionResult>
```

Sets `lifecycle = 'failed'`, `parse_error = error`, `parse_status = 'failed'`.

**`resetSessionForReparse`**: Move a session back to `ended` for re-processing.

```typescript
async function resetSessionForReparse(
  sql: postgres.Sql,
  sessionId: string
): Promise<{ reset: boolean; previousLifecycle: SessionLifecycle | null }>
```

Implementation:
1. Allowed source states: `ended`, `parsed`, `summarized`, `failed`.
2. NOT allowed from: `detected`, `capturing` (session hasn't ended — maybe still active).
3. In a transaction:
   - `DELETE FROM content_blocks WHERE session_id = $1`
   - `DELETE FROM transcript_messages WHERE session_id = $1`
   - `UPDATE sessions SET lifecycle = 'ended', parse_status = 'pending', parse_error = NULL, summary = NULL, total_messages = NULL, user_messages = NULL, assistant_messages = NULL, tool_use_count = NULL, thinking_blocks = NULL, subagent_count = NULL, tokens_in = NULL, tokens_out = NULL, cache_read_tokens = NULL, cache_write_tokens = NULL, cost_estimate_usd = NULL, updated_at = now() WHERE id = $1 AND lifecycle IN ('ended', 'parsed', 'summarized', 'failed') RETURNING lifecycle`
4. Preserves `transcript_s3_key` (raw JSONL stays in S3).
5. Returns `{ reset: true, previousLifecycle }` or `{ reset: false }`.

**`getSessionState`**: Quick lookup for current lifecycle.

```typescript
async function getSessionState(
  sql: postgres.Sql,
  sessionId: string
): Promise<{ lifecycle: SessionLifecycle; parse_status: string; parse_error: string | null } | null>
```

**`findStuckSessions`**: For recovery on server startup (Task 10).

```typescript
async function findStuckSessions(
  sql: postgres.Sql,
  stuckDurationMs: number  // default: 600_000 (10 minutes)
): Promise<Array<{ id: string; lifecycle: SessionLifecycle; parse_status: string; updated_at: string }>>
```

Queries sessions stuck in `ended` or `parsed` with `parse_status` = `pending` or `parsing` for longer than the threshold.

### Tests

**`packages/core/src/__tests__/session-lifecycle.test.ts`** (requires test Postgres):

- `isValidTransition("detected", "capturing")` returns true
- `isValidTransition("detected", "ended")` returns false (must go through capturing first; but actually Phase 1 allows detected->ended for backfill, so add this to TRANSITIONS)
- `isValidTransition("detected", "parsed")` returns false
- `isValidTransition("failed", "ended")` returns false (failed is terminal; use resetSessionForReparse)
- `isValidTransition("summarized", "archived")` returns true
- `transitionSession` with correct `from`: updates lifecycle, returns `{ success: true }`
- `transitionSession` with wrong `from`: returns `{ success: false }`, session unchanged
- `transitionSession` with `from` array (e.g., `["detected", "capturing"]`): succeeds if session is in either state
- `failSession`: sets lifecycle to `failed`, records error
- `resetSessionForReparse` from `summarized`: resets to `ended`, clears stats and transcript data
- `resetSessionForReparse` from `detected`: returns `{ reset: false }`
- Concurrent transitions: two simultaneous `ended → parsed` — only one succeeds
- `getSessionState` for non-existent session: returns null
- `findStuckSessions`: finds sessions stuck for > threshold, ignores recent ones

**Note on detected → ended**: The Phase 1 session.end handler transitions `detected → ended` (or `capturing → ended`). This is valid because CC sessions can end immediately without an intermediate capturing state (e.g., very short sessions). Add `ended` to the valid transitions from `detected`.

Updated transitions:
```
detected   → [capturing, ended, failed]
capturing  → [ended, failed]
ended      → [parsed, failed]
parsed     → [summarized, failed]
summarized → [archived]
archived   → []
failed     → []
```

## Relevant Files
- `packages/core/src/session-lifecycle.ts` (create)
- `packages/core/src/__tests__/session-lifecycle.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export)

## Success Criteria
1. `isValidTransition("detected", "ended")` returns true (short sessions skip capturing).
2. `isValidTransition("detected", "parsed")` returns false.
3. `isValidTransition("failed", "ended")` returns false (terminal state).
4. `transitionSession` with matching `from` updates session and returns `{ success: true }`.
5. `transitionSession` with non-matching `from` does NOT update the session (optimistic lock).
6. `transitionSession` with `from` as an array succeeds if session matches any element.
7. `failSession` sets `lifecycle = "failed"`, stores error in `parse_error`, sets `parse_status = "failed"`.
8. `resetSessionForReparse` from `parsed`/`summarized`/`failed` resets to `ended`, clears stats, deletes transcript_messages + content_blocks.
9. `resetSessionForReparse` from `detected` or `capturing` returns `{ reset: false }`.
10. Concurrent transitions: only one succeeds (optimistic locking).
11. `findStuckSessions` returns sessions stuck for > threshold.
12. All operations set `updated_at = now()`.
