# Task W10.2: Fix --live Filter Not Showing Active Sessions

## Validation Workflow: W10.2

## Problem

The `fuel-code sessions --live` command is designed to show currently active (running) Claude Code sessions. However, it always returns empty results because of a gap in the session lifecycle state machine.

The `--live` flag maps to `lifecycle = "capturing"` (line 249 of `packages/cli/src/commands/sessions.ts`), but no code in the entire codebase ever transitions a session from `detected` to `capturing`. The `session.start` handler inserts sessions with `lifecycle = 'detected'` (line 47 of `packages/core/src/handlers/session-start.ts`), and the `session.end` handler transitions directly from `["detected", "capturing"]` to `"ended"` (line 42 of `packages/core/src/handlers/session-end.ts`). Since no intermediate step moves the session to `capturing`, the transition path is always `detected -> ended`, skipping `capturing` entirely.

This means:
- `fuel-code sessions --live` always returns zero results
- `fuel-code status` shows 0 active sessions (it also queries `lifecycle = "capturing"` at line 196 of `packages/cli/src/commands/status.ts`)
- The workspace list `active_session_count` in the server is always 0 (counts `lifecycle = 'capturing'` at line 148 of `packages/server/src/routes/workspaces.ts` and line 62 of `packages/server/src/routes/devices.ts`)
- The TUI Dashboard creates new sessions from WS events with `lifecycle: "capturing"` (line 138 of `packages/cli/src/tui/Dashboard.tsx`), but the actual DB row remains `detected`, creating a data mismatch
- The WS broadcaster incorrectly broadcasts `"capturing"` on session.start (line 179 of `packages/server/src/pipeline/consumer.ts`) even though the DB never stores that state

## How to Reproduce

```bash
# 1. Start a Claude Code session in one terminal
claude

# 2. In another terminal, try to see the active session
fuel-code sessions --live
# Expected: Shows the active session
# Actual: "No sessions found." (empty table)

# 3. Verify the session exists but is in "detected" state
fuel-code sessions --lifecycle detected
# Shows the session with lifecycle = detected

# 4. Also visible in status command
fuel-code status
# "Active Sessions" section shows 0, even though a session is running
```

## Expected Behavior

When a Claude Code session is actively running:
1. `fuel-code sessions --live` should list it
2. `fuel-code status` should show it under "Active Sessions"
3. Workspace/device `active_session_count` should reflect running sessions
4. The TUI Dashboard should display the session as live with the green LIVE indicator

## Root Cause Analysis

### 1. Session creation sets `detected`, nothing transitions to `capturing`

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/handlers/session-start.ts` (line 47)
```typescript
await sql`
  INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, ...)
  VALUES (${ccSessionId}, ${workspaceId}, ${event.device_id}, ${"detected"}, ...)
  ON CONFLICT (id) DO NOTHING
`;
```

The session is created with `lifecycle = 'detected'`. The state machine defines `detected -> capturing` as a valid transition (line 59 of `packages/core/src/session-lifecycle.ts`), but no handler or event processor ever calls `transitionSession(sql, id, "detected", "capturing")`.

### 2. The `--live` flag hardcodes `capturing`

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/sessions.ts` (lines 247-249)
```typescript
// --live implies lifecycle=capturing
if (opts.live) {
  params.lifecycle = "capturing";
}
```

### 3. The `status` command also queries `capturing`

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/status.ts` (line 196)
```typescript
const { data } = await api.listSessions({
  lifecycle: "capturing",
  limit: 10,
});
```

### 4. Server-side `active_session_count` counts only `capturing`

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/server/src/routes/workspaces.ts` (line 148)
```sql
COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) AS active_session_count,
```

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/server/src/routes/devices.ts` (line 62)
```sql
COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END)::int AS active_session_count,
```

### 5. WS broadcaster lies about lifecycle state

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/server/src/pipeline/consumer.ts` (lines 175-179)
```typescript
// session.start -> lifecycle "capturing", session.end -> lifecycle "ended".
if (eventType === "session.start") {
  broadcaster.broadcastSessionUpdate(session_id, workspace_id, "capturing");
}
```

The broadcaster sends `"capturing"` even though the DB has `"detected"`. This makes the TUI appear to work during a session (via WS), but any API query returns the wrong data.

### 6. The git correlator correctly handles both states

**File**: `/Users/johnmemon/Desktop/fuel-code/packages/core/src/git-correlator.ts` (line 57)
```sql
AND lifecycle IN ('detected', 'capturing')
```

The git correlator already accounts for both `detected` and `capturing`, so it works correctly regardless of this bug.

### 7. TUI components check `lifecycle === "capturing"` for live behavior

Multiple TUI components use `lifecycle === "capturing"` to determine if a session is live:
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/hooks/useSessionDetail.ts` (lines 84, 154)
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/components/SessionHeader.tsx` (line 26)
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/components/SessionRow.tsx` (line 96)

## Fix Plan

### Recommended approach: Change `--live` to filter on `detected,capturing` (Option B+)

The `capturing` state was designed for a future scenario where we distinguish "session just started" from "session is actively receiving messages." Since nothing currently produces that distinction, and the state machine already allows `detected -> ended` (for short sessions), the pragmatic fix is to treat both `detected` and `capturing` as "live" states.

This is lower-risk than adding a new transition trigger (Option A) because it does not change the event processing pipeline or require a new event type.

### Step-by-step

**Step 1: Update `--live` filter in CLI sessions command**

File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/sessions.ts` (line 249)

Change:
```typescript
params.lifecycle = "capturing";
```
To:
```typescript
params.lifecycle = "detected,capturing";
```

The server already supports comma-separated lifecycle values via `parseLifecycleParam()` in `/Users/johnmemon/Desktop/fuel-code/packages/shared/src/schemas/session-query.ts` (line 97-107).

**Step 2: Update `status` command active sessions query**

File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/status.ts` (line 196)

Change:
```typescript
lifecycle: "capturing",
```
To:
```typescript
lifecycle: "detected,capturing",
```

**Step 3: Update server-side `active_session_count` in workspaces**

File: `/Users/johnmemon/Desktop/fuel-code/packages/server/src/routes/workspaces.ts` (line 148)

Change:
```sql
COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END) AS active_session_count,
```
To:
```sql
COUNT(CASE WHEN s.lifecycle IN ('detected', 'capturing') THEN 1 END) AS active_session_count,
```

Also update the second occurrence at line 274:
```sql
COUNT(CASE WHEN lifecycle IN ('detected', 'capturing') THEN 1 END)::int AS active_sessions,
```

**Step 4: Update server-side `active_session_count` in devices**

File: `/Users/johnmemon/Desktop/fuel-code/packages/server/src/routes/devices.ts` (line 62)

Change:
```sql
COUNT(CASE WHEN s.lifecycle = 'capturing' THEN 1 END)::int AS active_session_count,
```
To:
```sql
COUNT(CASE WHEN s.lifecycle IN ('detected', 'capturing') THEN 1 END)::int AS active_session_count,
```

**Step 5: Fix WS broadcaster to send actual DB state**

File: `/Users/johnmemon/Desktop/fuel-code/packages/server/src/pipeline/consumer.ts` (line 179)

Change:
```typescript
broadcaster.broadcastSessionUpdate(session_id, workspace_id, "capturing");
```
To:
```typescript
broadcaster.broadcastSessionUpdate(session_id, workspace_id, "detected");
```

**Step 6: Update TUI components to treat `detected` as live**

File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/hooks/useSessionDetail.ts` (lines 84, 154)

Change all `lifecycle === "capturing"` checks to:
```typescript
session.lifecycle === "capturing" || session.lifecycle === "detected"
```

Or introduce a helper function `isLiveSession(lifecycle)` that returns true for both states.

File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/components/SessionHeader.tsx` (line 26)
File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/components/SessionRow.tsx` (line 96)

Apply the same pattern.

**Step 7: Update TUI Dashboard WS handler to use `detected` for new sessions**

File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/Dashboard.tsx` (line 138)

Change:
```typescript
lifecycle: "capturing",
```
To:
```typescript
lifecycle: "detected",
```

**Step 8: Update formatLifecycle to show "LIVE" for `detected` too**

File: `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/lib/formatters.ts` (line 161)

Currently only `capturing` maps to the green "LIVE" label. Add `detected` to also show as "LIVE":
```typescript
detected:    { icon: "\u25CF", label: "LIVE",      color: pc.green },
capturing:   { icon: "\u25CF", label: "LIVE",      color: pc.green },
```

**Step 9: Update tests**

Files to update:
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/__tests__/sessions.test.ts` (line 172-179) - update `--live` test to expect `lifecycle=detected%2Ccapturing`
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/commands/__tests__/status.test.ts` (lines 257-283) - update active session lifecycle expectations
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/lib/__tests__/formatters.test.ts` - add test for `detected` rendering as LIVE
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/lib/__tests__/api-client.test.ts` (line 185) - update lifecycle query expectation
- `/Users/johnmemon/Desktop/fuel-code/packages/server/src/routes/__tests__/sessions.test.ts` - verify comma-separated lifecycle filter works for `detected,capturing`
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/__tests__/Dashboard.test.ts` - update WS prepend lifecycle
- `/Users/johnmemon/Desktop/fuel-code/packages/cli/src/tui/__tests__/components.test.tsx` - update lifecycle checks

### Files changed (summary)

| File | Change |
|------|--------|
| `packages/cli/src/commands/sessions.ts` | `--live` -> `detected,capturing` |
| `packages/cli/src/commands/status.ts` | Active sessions query -> `detected,capturing` |
| `packages/server/src/routes/workspaces.ts` | `active_session_count` includes `detected` |
| `packages/server/src/routes/devices.ts` | `active_session_count` includes `detected` |
| `packages/server/src/pipeline/consumer.ts` | WS broadcasts `detected` on session.start |
| `packages/cli/src/tui/hooks/useSessionDetail.ts` | `isLive` includes `detected` |
| `packages/cli/src/tui/components/SessionHeader.tsx` | `isLive` includes `detected` |
| `packages/cli/src/tui/components/SessionRow.tsx` | Live row includes `detected` |
| `packages/cli/src/tui/Dashboard.tsx` | WS prepend uses `detected` |
| `packages/cli/src/lib/formatters.ts` | `detected` renders as LIVE |
| Various test files | Updated expectations |

### What about the `capturing` state long-term?

The `capturing` state remains valid in the state machine for future use. If/when we add mid-session event tracking (e.g., "first assistant response received"), we can introduce a transition to `capturing` at that point. The fix above is forward-compatible -- all the checks already handle both states.
