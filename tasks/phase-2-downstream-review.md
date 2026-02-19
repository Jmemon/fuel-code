# Phase 2 Downstream Impact Review

## Purpose

This document analyzes whether downstream phases (3–7) expect outputs from Phase 2 that were not implemented, were implemented differently than specified, or have implicit assumptions that the Phase 2 implementation violates. For each issue found, the fix is specified.

---

## Phase 3: Git Tracking

### CRITICAL: Git-Session Correlation Will Not Work

**Phase 3 Expects**: Sessions in `lifecycle = 'capturing'` state during active CC usage, so git events can be correlated with the active session.

**Phase 3 Task 3 specifies this SQL**:
```sql
SELECT id FROM sessions
WHERE workspace_id = $1
  AND device_id = $2
  AND lifecycle = 'capturing'
  AND started_at <= $3
ORDER BY started_at DESC
LIMIT 1
```

**Phase 2 Reality**: Sessions are created with `lifecycle = 'detected'` by the session.start handler (session-start.ts:44). The session.end handler transitions directly from `['detected', 'capturing'] -> 'ended'`. Nothing in Phase 1 or Phase 2 transitions a session to `capturing`. Sessions are never in `capturing` state.

**Impact**: The correlation query will ALWAYS return zero rows. Every git event will be an "orphan" with `session_id = NULL`. The entire git-session correlation feature of Phase 3 is broken.

**Fix (two options)**:

**Option A (preferred — minimal change)**: Modify Phase 3's git-correlator to match `lifecycle IN ('detected', 'capturing')` instead of just `'capturing'`. Since `detected` is the state a session is in from session.start until session.end, this achieves the desired behavior. The `capturing` state can be introduced later as a refinement (e.g., for detecting when CC is actively doing work vs. idle).

**Option B**: Add a lifecycle transition to `capturing`. Modify the session.start handler to transition from `detected` -> `capturing` immediately after creating the session row, or transition on some meaningful signal (first tool use, first user message). This adds complexity for minimal benefit at this stage.

**Recommendation**: Option A. Update the spec for Phase 3 Task 3 to use `lifecycle IN ('detected', 'capturing')`.

---

### OK: Session.end Handler Triggers Pipeline for Backfill Path

**Phase 3 Expects**: When session.end fires and `transcript_s3_key` is already set, the pipeline is triggered.

**Phase 2 Reality**: The session.end handler (session-end.ts:62-77) checks for `transcript_s3_key` after transition and triggers pipeline if present. This works correctly for the backfill path (where transcript is uploaded before session.end event).

**Status**: ✅ No issue (assuming Issue #3 from implementation review is fixed so transcripts actually get uploaded before session.end).

---

### OK: `GET /api/sessions/:id/git` Returns Empty Array

**Phase 3 Expects**: Phase 2 creates a stub `GET /api/sessions/:id/git` endpoint.

**Phase 2 Reality**: Implemented as a stub returning `{ git_activity: [] }` (sessions.ts:443-465). Phase 3 Task 3 will replace the query behind this endpoint with actual git_activity data.

**Status**: ✅ Correct stub. Phase 3 will need to either modify this endpoint or create a new route handler.

---

### OK: Handler Registry Is Extensible

**Phase 3 Expects**: Can register `git.commit`, `git.push`, `git.checkout`, `git.merge` handlers in the existing registry.

**Phase 2 Reality**: `EventHandlerRegistry` class supports `.register()` for any EventType. `createHandlerRegistry()` in `handlers/index.ts` returns a registry with session.start and session.end. Phase 3 will add 4 more registrations.

**Status**: ✅ No issue.

---

### OK: `--workspace-id` and `--data-stdin` CLI Flags

**Phase 3 Task 1 Expects**: These flags exist on `fuel-code emit` for the git hook scripts.

**Phase 2 Reality**: These flags are NOT part of Phase 2 scope. They're explicitly listed as Phase 3 Task 1 deliverables.

**Status**: ✅ No issue — Phase 3 creates them.

---

### OK: workspace_devices Table Structure

**Phase 3 Task 4 Expects**: `workspace_devices` table with `git_hooks_installed` boolean column.

**Phase 2 Reality**: This column was created in Phase 1. Phase 3 adds `pending_git_hooks_prompt` and `git_hooks_prompted` columns via its own migration.

**Status**: ✅ No issue.

---

## Phase 4: CLI + TUI

### OK: Session List API

**Phase 4 Task 4 Expects**: `GET /api/sessions` with cursor-based pagination, workspace/device filters, lifecycle filter, date range filters, tag filter.

**Phase 2 Reality**: All implemented. Cursor is base64-encoded `{ s: started_at, i: id }`. Filters: workspace_id, device_id, lifecycle (comma-separated for multi-value), after/before, ended_after/ended_before, tag. Limit default 50, max 250.

**Status**: ✅ API matches expected contract.

---

### OK: Session Detail API

**Phase 4 Task 5 Expects**: `GET /api/sessions/:id` returning session with workspace_name, device_name, summary, stats, tags.

**Phase 2 Reality**: Implemented with JOIN to workspaces and devices tables. Returns all session columns plus workspace_canonical_id, workspace_name, device_name.

**Status**: ✅ Complete.

---

### OK: Transcript APIs

**Phase 4 Task 5 Expects**: Parsed transcript and raw transcript download endpoints.

**Phase 2 Reality**: `GET /api/sessions/:id/transcript` returns messages with nested content blocks (LEFT JOIN + json_agg). `GET /api/sessions/:id/transcript/raw` returns presigned S3 URL (302 redirect or 200 JSON depending on `?redirect=false`).

**Status**: ✅ Complete.

---

### OK: Session PATCH for Tags/Summary

**Phase 4 Tasks 5/8 Expect**: PATCH endpoint for tags (replace/add/remove) and summary override.

**Phase 2 Reality**: `PATCH /api/sessions/:id` supports `tags` (replace), `add_tags` (append), `remove_tags` (filter), and `summary` fields with mutual exclusivity validation for tag modes.

**Status**: ✅ Complete.

---

### MINOR: WebSocket Not Yet Available

**Phase 4 Task 2 Expects**: WebSocket server for real-time updates.

**Phase 2 Reality**: No WebSocket server exists yet.

**Status**: ✅ No issue — WebSocket is a Phase 4 deliverable (Task 2). Not a Phase 2 dependency.

---

## Phase 5: Remote Development Environments

### OK: Session Pipeline Works for Remote Sessions

**Phase 5 Task 7 Expects**: Session events from remote environments flow through the same pipeline (session.start -> session.end -> pipeline -> parsed -> summarized).

**Phase 2 Reality**: The pipeline is session-source-agnostic. Any session with a transcript_s3_key will be processed. Remote sessions will work the same as local sessions.

**Status**: ✅ No issue.

---

### OK: Session Lifecycle State Machine Is Extensible

**Phase 5 Task 9 Expects**: Lifecycle enforcer can read session lifecycle states and remote env statuses.

**Phase 2 Reality**: `getSessionState()` and `findStuckSessions()` are exported from core. The lifecycle state machine is a pure data structure (TRANSITIONS map) that can be consulted.

**Status**: ✅ No issue.

---

## Phase 6: Hardening

### MINOR: Archived → Summarized Reverse Transition Not in Phase 2

**Phase 6 Task 13 Expects**: `archived -> summarized` backward lifecycle transition for session restoration.

**Phase 2 Reality**: TRANSITIONS map has `archived: []` (terminal). The lifecycle state machine will need modification.

**Impact**: Phase 6 will need to update `TRANSITIONS` to add `archived: ["summarized"]` and implement the restore logic. The optimistic locking in `transitionSession` will correctly enforce this if the TRANSITIONS map is updated.

**Status**: ✅ No issue — Phase 6 spec explicitly states it modifies the lifecycle. Phase 2 just needs to not break the extension point.

**Verified**: `transitionSession` validates against `TRANSITIONS[from]`, so adding `"summarized"` to `TRANSITIONS.archived` will enable the transition. No Phase 2 code changes needed.

---

### OK: Archival Can Delete Parsed Data

**Phase 6 Task 8 Expects**: Archive can delete transcript_messages and content_blocks for a session, with S3 backup integrity verification.

**Phase 2 Reality**: CASCADE deletes are configured (session -> transcript_messages -> content_blocks). `resetSessionForReparse` demonstrates the pattern of deleting and re-inserting these tables. The S3 backup at `parsed.json` is uploaded by the pipeline (session-pipeline.ts:286-303).

**Status**: ✅ Phase 6 archival has the primitives it needs.

---

### WATCH: Summary Retry Gap Compounds in Phase 6

**Phase 6 Expects**: Sessions that complete parsing flow through to summarized state.

**Phase 2 Reality**: Sessions that fail summary generation stay at `lifecycle = 'parsed'` with no automatic retry (Issue #4 from implementation review). Over time, this could accumulate many parsed-but-not-summarized sessions.

**Impact for Phase 6**: The archival engine targets `lifecycle = 'summarized'` sessions. Sessions stuck at `parsed` won't be archival candidates. This isn't a breakage, but it means some sessions will never reach the archival pipeline.

**Recommendation**: Fix Phase 2 Issue #4 (summary retry) before or during Phase 6.

---

### OK: Shared Retry Utility Will Replace Inline Retries

**Phase 6 Task 1 Expects**: Create a shared `withRetry()` utility that replaces inline retry logic in EC2 client, S3 client, etc.

**Phase 2 Reality**: S3 client uses AWS SDK built-in retries (3 retries via SDK config). No custom retry logic in Phase 2.

**Status**: ✅ Phase 6 can wrap/replace the SDK retry config. No conflict.

---

### OK: Queue System Available for Hardening

**Phase 6 Task 7 Expects**: Per-event batch isolation in queue drain, dead-letter metadata envelopes.

**Phase 2 Reality**: Queue system is a Phase 1 deliverable in packages/cli/src/lib/queue.ts. Phase 2 doesn't modify it.

**Status**: ✅ No conflict.

---

## Phase 7: Slack Integration + Change Orchestration

### OK: Session Pipeline Available for Change Request Sessions

**Phase 7 Task 4 Expects**: Headless CC sessions on remote environments produce transcripts that flow through the pipeline.

**Phase 2 Reality**: The pipeline is triggered by transcript upload + session.end, regardless of how the session was initiated. Headless CC sessions that emit events will work.

**Status**: ✅ No issue.

---

### OK: Session API Sufficient for Change Request Tracking

**Phase 7 Task 2 Expects**: Can query sessions by workspace and link them to change requests.

**Phase 2 Reality**: `GET /api/sessions?workspace_id=<id>` filter works. Session detail includes all needed fields. PATCH for tags allows linking sessions to change requests via tagging.

**Status**: ✅ No issue.

---

## Cross-Phase Concern: PipelineDeps Interface Growth

**Current state**: `PipelineDeps` is `{ sql, s3, summaryConfig, logger }`.

Phase 3 may need to extend this for git-event processing (e.g., passing workspace_id resolution into the pipeline). Phase 5 will need it for remote env status updates. Phase 7 for change request status.

**Recommendation**: The current interface is stable for Phase 3–4. Monitor for whether Phases 5–7 need additional deps. The pattern of optional fields (like `pipelineDeps?` in `EventHandlerContext`) keeps it backward-compatible.

---

## Summary of Downstream Issues

| # | Phase | Issue | Severity | Fix |
|---|-------|-------|----------|-----|
| 1 | 3 | Git correlation queries `capturing` but sessions never reach that state | **Critical** | Change correlation to use `IN ('detected', 'capturing')` |
| 2 | 3 | Backfill creates sessions that can't correlate (if ordering bug fixed) | Low | N/A — backfill sessions have no active CC session to correlate with |
| 3 | 6 | Summary retry gap leaves sessions stuck at `parsed` | Low | Add periodic summary retry job |
| 4 | 6 | `archived -> summarized` transition needed | None | Phase 6 spec already plans for this |

### Issues Inherited from Implementation Review That Affect Downstream

| # | Phase Affected | Implementation Issue | Impact |
|---|---------------|---------------------|--------|
| I-1 | 5, 7 | Pipeline queue unused | **FIXED** — queue wired into server startup |
| I-2 | All | Upload buffers 200MB | **FIXED** — streams directly to S3 |
| I-3 | All | Backfill ordering bug | **FIXED** — events emitted before upload, retry on 404 |

---

## Verdict (Updated post-fix)

**All critical and medium issues have been fixed.** Phase 2 is ready for Phase 3.

**Remaining action for Phase 3**:
1. Phase 3 Task 3 spec must use `IN ('detected', 'capturing')` for git-session correlation (Downstream Issue #1)
