# Phase 4 Downstream Impact Review

> **Reviewed by**: Agent (single-pass analysis)
> **Scope**: Phase 4 — CLI + TUI
> **Codebase state**: Phases 1 through 4 implemented
> **Review target**: Impact on Phases 5 through 7

## Purpose

Determine whether Phase 4's implementation (as-built vs as-planned) breaks
assumptions, prerequisites, or implicit contracts in downstream phases.
Each finding compares:
  - The downstream phase's **spec claim** (DAG line, task file quote)
  - Phase 4's **actual implementation** (file path + line number)
  - The **delta** between planned and actual that causes the break

---

## Phase 5: Remote Dev Environments

### Schema & Migration Assumptions
Table of every DB artifact that Phase 5's DAG/tasks expect Phase 4 to have created:

| ID | Claimed Artifact | Source (DAG/task line) | Phase 4 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 5.S.1 | No new Phase 4 tables; existing schema sufficient | Phase 5 DAG line 189: "Phase 1's sessions table has remote_env_id TEXT" | Confirmed: Phase 4 created zero migrations, uses Phase 1-3 schema only | OK |
| 5.S.2 | `sessions.remote_env_id TEXT` column exists (no FK) | Phase 5 Task 6 line 181: "Phase 1's sessions table already has a remote_env_id TEXT column with NO foreign key constraint" | Confirmed: Phase 1 `001_initial.sql` has `remote_env_id TEXT` — Phase 4 did not modify it | OK |

#### Findings

No schema findings. Phase 4 created no migrations and did not alter existing schema. Phase 5's migration (Task 6) creates `remote_envs` and `blueprints` tables independently and adds the FK constraint on `sessions.remote_env_id`.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 4 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 5.C.1 | `FuelApiClient` class with extensible instance methods | Phase 5 DAG line 153: "existing ApiClient gets new remote environment methods" | `packages/cli/src/lib/api-client.ts:1-661` — class-based with instance methods | OK |
| 5.C.2 | `ApiClient` constructor accepts `{ baseUrl, apiKey }` options | Phase 5 Task 6 line 192-201: adds `provisionRemote()`, `getRemoteEnvs()`, etc. | Constructor at line 140 accepts options object — extensible | OK |
| 5.C.3 | `WsBroadcaster` interface with `broadcastRemoteUpdate()` | Phase 5 Task 6 line 19: `broadcaster: WsBroadcaster` in remote router deps | `packages/server/src/ws/broadcaster.ts:38-56` — interface exported with all 3 methods | OK |
| 5.C.4 | `broadcastRemoteUpdate(remoteEnvId, workspaceId, status, publicIp?)` signature | Phase 5 Task 7 lines 32, 42, 48, 57: handlers broadcast `remote.update` | `broadcaster.ts:50-55` — exact match: `broadcastRemoteUpdate(remoteEnvId: string, workspaceId: string, status: string, publicIp?: string)` | OK |
| 5.C.5 | `ServerRemoteUpdateMessage` type in shared WS types | Phase 5 Task 14 line 87-98: WsClient dispatches `remote.update` | `packages/shared/src/types/ws.ts:76-81` — type exists with `remote_env_id`, `status`, `public_ip?` | OK |
| 5.C.6 | `WsClient` handles incoming `remote.update` messages | Phase 5 Task 14 line 87-98: "The WsClient already handles incoming messages" | `packages/cli/src/lib/ws-client.ts` — emits all incoming `ServerMessage` types via EventEmitter | DRIFT |
| 5.C.7 | `ConsumerDeps` accepts optional `broadcaster` | Phase 5 Task 7 line 102: "register remote handlers" in handler registry | `packages/server/src/pipeline/consumer.ts:48` — `broadcaster?: WsBroadcaster` is optional in ConsumerDeps | OK |
| 5.C.8 | Consumer calls `broadcaster.broadcastEvent()` after processing | Phase 5 Task 7 relies on existing broadcast pipeline | `consumer.ts:169-184` — broadcasts event + session lifecycle updates after successful processing | OK |
| 5.C.9 | TUI `useWsConnection()` hook exists | Phase 5 Task 14 line 87: "uses Phase 4 WsClient" | `packages/cli/src/tui/hooks/useWsConnection.ts` — hook exported | OK |
| 5.C.10 | TUI Dashboard supports sidebar extension | Phase 5 Task 14 line 105-127: adds RemotePanel below WorkspaceList | `packages/cli/src/tui/Dashboard.tsx:286` — two-column layout with left sidebar | OK |
| 5.C.11 | `createApiClient()` backward-compat shim | Phase 5 DAG line 169: "Commander entry point with all Phase 1-4 commands" | `api-client.ts` exports `createApiClient()` for `emit.ts`, `drain.ts` | OK |

#### Findings

##### [4→5.C.1] WsClient `remote.update` dispatch may need explicit handler — Severity: LOW

**Spec claim**: Phase 5 Task 14 (line 87-98) says "The WsClient (from Phase 4) already handles incoming messages. Add handling for `remote.update` message type" with explicit `case 'remote.update':` dispatch.

**Actual state**: `packages/cli/src/lib/ws-client.ts` uses a generic message handler that parses all incoming `ServerMessage` JSON and emits them via EventEmitter by `message.type`. The `remote.update` message type is already in the `ServerMessage` union (`packages/shared/src/types/ws.ts:77-81`), so it will be parsed and emitted.

**Impact**: No breakage. The WsClient already handles `remote.update` messages through its generic dispatch. Phase 5 Task 14's `useRemotes` hook can listen for `remote.update` events on the WsClient without modification.

**Recommended fix**: Informational. Phase 5 Task 14 can subscribe to `remote.update` events on WsClient as-is. No WsClient changes needed.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 4 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 5.A.1 | `GET /api/workspaces` returns workspace list with aggregates | Phase 5 Task 14 line 105: "TUI remote panel shows workspace dropdown" | `packages/server/src/routes/workspaces.ts:90+` — returns `{ workspaces, next_cursor, has_more }` with session_count, active_session_count, device_count, cost, duration | OK |
| 5.A.2 | `GET /api/workspaces/:id` returns workspace detail | Phase 5 Task 14: TUI shows workspace name for remotes | `workspaces.ts:190+` — returns full detail with devices, sessions, git activity | OK |
| 5.A.3 | `GET /api/devices` and `GET /api/devices/:id` exist | Phase 5 Task 14: remote panel shows device info | `packages/server/src/routes/devices.ts:49+` — both endpoints implemented | OK |
| 5.A.4 | `GET /api/health` returns `ws_clients` count | Phase 5 DAG (implicit): health checks for monitoring | `packages/server/src/routes/health.ts` — includes `ws_clients` field | OK |
| 5.A.5 | WebSocket upgrade at `/api/ws` with token auth | Phase 5 Task 14: TUI subscribes via WS | `packages/server/src/ws/index.ts` — WS server on `/api/ws`, token validation on upgrade | OK |

#### Findings

No API contract issues. All endpoints Phase 5 depends on are implemented and return the expected shapes.

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 4 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 5.B.1 | Consumer broadcasts after event processing (not before) | Phase 5 Task 7: remote handlers produce WS events | `consumer.ts:169-184` — broadcasts after `processEvent()` succeeds, before ack | OK |
| 5.B.2 | Broadcast is non-blocking (fire-and-forget) | Phase 5 Task 7: handlers must not block on WS | `broadcaster.ts:8-9` — fire-and-forget with error callback that logs | OK |
| 5.B.3 | WS subscription matching: "all", workspace, session | Phase 5 Task 14: remote panel subscribes by scope | `broadcaster.ts:80-88` — `clientMatchesFilter` checks all three | OK |
| 5.B.4 | TUI debounce buffer for WS updates (500ms) | Phase 5 Task 14: remote updates should also be debounced | `Dashboard.tsx` — 500ms flush interval, max 2 renders/sec | DRIFT |
| 5.B.5 | TUI polling fallback (10s) when WS disconnected | Phase 5 Task 14 line 81: "Poll every 30s as fallback if WS is disconnected" | Dashboard polls at 10s interval on WS disconnect | DRIFT |

#### Findings

##### [4→5.B.1] TUI debounce buffer only covers sessions, not remote updates — Severity: MEDIUM

**Spec claim**: Phase 5 Task 14 (line 87-98) expects `remote.update` WS events to be handled in the TUI with real-time updates.

**Actual state**: `Dashboard.tsx` has a debounce buffer that batches WS updates at 500ms intervals, but this buffer is specifically for session updates via `useSessions` hook's `updateSession`/`prependSession` callbacks. The new `useRemotes` hook (Phase 5 Task 14) will manage its own state.

**Impact**: Phase 5's `useRemotes` hook must implement its own update buffering for `remote.update` WS events. Without it, rapid remote status changes (e.g., provisioning → ready → active in quick succession) could cause excessive re-renders.

**Recommended fix**: Phase 5 Task 14 should include a debounce buffer in `useRemotes` similar to the session update pattern in `useSessions`. This is a design consideration, not a Phase 4 bug.

##### [4→5.B.2] TUI polling interval mismatch with spec — Severity: LOW

**Spec claim**: Phase 5 Task 14 (line 81) specifies "Poll every 30s as fallback if WS is disconnected."

**Actual state**: Phase 4 Dashboard polling fallback is 10s, not 30s.

**Impact**: Trivial. Phase 5's `useRemotes` hook should use its own polling interval (30s as spec'd) since remote status changes less frequently than session updates. The 10s/30s difference is a design choice, not a conflict.

**Recommended fix**: Informational. Phase 5 uses a separate hook with its own polling interval.

---

## Phase 6: Hardening

### Schema & Migration Assumptions

| ID | Claimed Artifact | Source (DAG/task line) | Phase 4 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 6.S.1 | No schema changes required from Phase 4 | Phase 6 DAG — no schema deps on Phase 4 | Phase 4 created zero migrations | OK |
| 6.S.2 | `sessions` table has `lifecycle` column with CHECK constraint including `archived` | Phase 6 Task 8: session archival transitions to `archived` | Phase 1 schema — `archived` exists in CHECK constraint, Phase 4 did not modify | OK |

#### Findings

No schema findings.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 4 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 6.C.1 | `ApiClient` class with `fetch()` calls using `AbortSignal.timeout()` | Phase 6 Task 6 line 55-93: wraps HTTP calls in `withRetry()` | `packages/cli/src/lib/api-client.ts` — uses `AbortSignal.timeout(10000)` for all requests | OK |
| 6.C.2 | `ApiError` class with `statusCode` property | Phase 6 Task 6 line 75-79: retry predicate checks `error.status` | `api-client.ts:30-40` — `ApiError` has `statusCode: number` property | DRIFT |
| 6.C.3 | `ApiConnectionError` class for network failures | Phase 6 Task 6 line 127: "fall back to queue instead of surfacing an error" | `api-client.ts:46-54` — `ApiConnectionError` extends `Error` with `cause` | OK |
| 6.C.4 | `createApiClient()` backward-compat shim | Phase 6 Task 6 line 153: "Modify packages/cli/src/lib/api-client.ts" | `api-client.ts` exports both `FuelApiClient` class and `createApiClient()` shim | OK |
| 6.C.5 | CLI commands use `outputResult()` for json/text dispatch | Phase 6 Task 2 line 217-224: top-level error handler uses `formatError()` | `formatters.ts` exports `outputResult()` for all commands | OK |
| 6.C.6 | `Promise.allSettled()` in status command | Phase 6 DAG line 5: "surfaces comprehensive error messages" | `packages/cli/src/commands/status.ts` — `fetchStatus()` uses `Promise.allSettled()` | OK |
| 6.C.7 | Data/presentation separation in CLI commands | Phase 6 Task 12: "Progress integration for long operations" wraps data-fetch layer | All 5 command modules export `fetchX()` + `formatX()` separately | OK |

#### Findings

##### [4→6.C.1] ApiError uses `statusCode` property, Phase 6 spec expects `.status` — Severity: MEDIUM

**Spec claim**: Phase 6 Task 6 (line 75-79) shows retry predicate checking `(error as any).status`:
```typescript
const error = new NetworkError(...);
(error as any).status = response.status;
```
The `isRetryableHttpError` predicate (Task 1) will check for a `status` property.

**Actual state**: Phase 4's `ApiError` class at `api-client.ts:30-40` uses `statusCode` (not `status`):
```typescript
export class ApiError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number, body?: unknown) { ... }
}
```

**Impact**: Phase 6's `isRetryableHttpError` predicate must check for `statusCode` (Phase 4's actual property name), not `status`. If the predicate checks `.status`, it will be `undefined` for `ApiError` instances, and all HTTP errors will be treated as non-retryable (or retryable, depending on the predicate's default behavior for missing status).

**Recommended fix**: Phase 6 Task 6 spec should be updated to use `error.statusCode` instead of `error.status`, or the predicate should check both. Alternatively, Phase 6 Task 6 can rename `statusCode` to `status` when it refactors the ApiClient. Either way, this must be reconciled at Phase 6 implementation time.

##### [4→6.C.2] Phase 4 ApiClient timeout is already 10s, matching Phase 6 target — Severity: NONE

**Spec claim**: Phase 6 Task 6 (line 147-148): "Default timeout per individual request: 10 seconds (up from 2s)."

**Actual state**: Phase 4 already uses `AbortSignal.timeout(10000)` — the timeout is already 10s.

**Impact**: No change needed. Phase 6 spec references upgrading from 2s (Phase 1's value), but Phase 4 already increased it.

**Recommended fix**: Informational. Phase 6 Task 6 spec is slightly stale — it references the Phase 1 timeout, not Phase 4's.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 4 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 6.A.1 | `GET /api/sessions` supports lifecycle filtering | Phase 6 Task 13: archival-aware session queries | Phase 1/2 endpoint, Phase 4 CLI consumes it correctly | OK |
| 6.A.2 | `GET /api/health` returns structured health data | Phase 6 Task 14: E2E tests verify health | `health.ts` — returns db, redis, stream status + ws_clients | OK |

#### Findings

No API contract issues.

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 4 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 6.B.1 | CLI commands handle errors with `try/catch` at top level | Phase 6 Task 2 line 217-224: wires `formatError()` into error handler | `packages/cli/src/index.ts` — Commander `.action()` error catcher prints `error.message` | OK |
| 6.B.2 | Session lifecycle badges handle all states | Phase 6 Task 13 line 131: adds `archived → summarized` reverse transition | `formatters.ts` `formatLifecycle()` — handles 8 lifecycle states including `archived` | OK |
| 6.B.3 | CLI graceful degradation when backend unreachable | Phase 6 Task 10: ShutdownManager for Ctrl-C | `status.ts` — `Promise.allSettled()` handles partial failures | OK |
| 6.B.4 | `WsClient` reconnection with exponential backoff | Phase 6 DAG (implicit): hardened reconnection | `ws-client.ts` — 1s→30s backoff, 10 max attempts, jitter | OK |
| 6.B.5 | formatters handle null/undefined values gracefully | Phase 6 Task 2: error formatter adapts to context | `formatters.ts` — `formatCost(null)` returns "—", `formatDuration(0)` returns "0s" | OK |
| 6.B.6 | Lifecycle badge for `archived` state | Phase 6 Task 13: archived sessions in list/detail views | `formatters.ts` `formatLifecycle()` includes `archived` mapping | DRIFT |

#### Findings

##### [4→6.B.1] Lifecycle formatter may not handle `archived → summarized` reverse transition display — Severity: LOW

**Spec claim**: Phase 6 Task 13 (DAG line 131): "archived → summarized restoration" introduces a backward lifecycle transition.

**Actual state**: Phase 4's `formatLifecycle()` in `formatters.ts` maps lifecycle strings to colored icons. It handles `archived` as a state. However, the TUI session list and `sessions` CLI command sort by lifecycle implicitly — a restored session (back to `summarized`) would appear normally.

**Impact**: No breakage. A restored session simply shows the `summarized` badge again. Phase 6 may want to add a "restored" indicator, but Phase 4's formatters handle the state correctly.

**Recommended fix**: Informational. Phase 6 can add a `restored_at` field to the display if desired.

---

## Phase 7: Slack Integration + Change Orchestration

### Schema & Migration Assumptions

| ID | Claimed Artifact | Source (DAG/task line) | Phase 4 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 7.S.1 | No Phase 4 schema dependencies | Phase 7 DAG — independent `change_requests` table | Phase 4 created zero migrations | OK |

#### Findings

No schema findings. Phase 7's `change_requests` table is independent of Phase 4.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 4 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 7.C.1 | `ApiClient` class extensible with new `changes` methods | Phase 7 Task 7 line 136-157: adds `listChangeRequests()`, `getChangeRequest()`, etc. | `api-client.ts` — class-based, extensible pattern confirmed | OK |
| 7.C.2 | Output formatters reusable for change request display | Phase 7 Task 7 line 161-165: "Reuse existing formatting utilities from Phase 4 CLI" | `formatters.ts` — `formatDuration()`, `formatCost()`, `formatRelativeTime()`, `renderTable()`, `outputResult()` all exported | OK |
| 7.C.3 | Commander entry point supports new command registration | Phase 7 Task 7 line 84: `registerChangesCommands(program, apiClient)` | `packages/cli/src/index.ts` — Commander-based, supports `.command()` registration | OK |
| 7.C.4 | WebSocket server supports broadcasting change events | Phase 7 DAG line 144: "WebSocket live updates" | `broadcaster.ts` — `broadcastEvent()` broadcasts any `Event` type to matching clients | OK |
| 7.C.5 | TUI Dashboard extensible with new views | Phase 7 DAG line 144: "Ink-based terminal UI" | `App.tsx` — view routing supports adding new views | OK |

#### Findings

No code artifact findings. Phase 4's architecture cleanly supports Phase 7's extension pattern: new ApiClient methods, new Commander commands, new TUI views, and WS broadcasts for `change.*` events all fit into existing Phase 4 patterns without modification.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 4 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 7.A.1 | `POST /api/events/ingest` accepts new event types | Phase 7 DAG line 83: "new change.* event types flow through existing pipeline" | Phase 1 endpoint — accepts any `EventType` from shared union. Phase 7 Task 1 adds `change.*` types to the union. Phase 4 did not modify this. | OK |
| 7.A.2 | WebSocket broadcasts new event types to subscribed clients | Phase 7 DAG line 144 | `consumer.ts:171` — `broadcaster.broadcastEvent(entry.event)` broadcasts ALL event types | OK |

#### Findings

No API contract findings.

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 4 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 7.B.1 | Consumer broadcasts all event types, not just session/git | Phase 7: change.* events need WS delivery | `consumer.ts:171-184` — broadcasts ALL events; session lifecycle special cases are additive | OK |
| 7.B.2 | Session lifecycle broadcasts for headless CC sessions | Phase 7 Task 4: headless CC creates normal sessions | `consumer.ts:176-183` — broadcasts `session.start`→`capturing` and `session.end`→`ended` for ALL sessions | OK |
| 7.B.3 | TUI session list shows headless CC sessions alongside normal ones | Phase 7 DAG implied | Sessions command fetches all sessions regardless of source | OK |

#### Findings

No behavioral findings. Phase 7's headless CC sessions are tracked as normal sessions through the existing pipeline. Phase 4's WS broadcast and TUI display handle them without modification.

---

## Cross-Phase Concerns

Findings that affect multiple downstream phases simultaneously.

| Finding | Affected Phases | Description | Severity |
|---------|----------------|-------------|----------|
| `ApiError.statusCode` vs `.status` naming | 5, 6 | Phase 4 uses `statusCode`, Phase 6 spec uses `.status`. Phase 5 Task 6 also creates error responses. Any downstream code that checks `.status` on an `ApiError` will see `undefined`. | MEDIUM |
| TUI debounce is session-specific, not generic | 5 | New TUI hooks (useRemotes) must implement their own debounce. Not a bug, but a design pattern that must be replicated. | MEDIUM |
| No consumer→broadcaster integration E2E test | 5, 6 | Phase 4 Issue #1: WS E2E tests call broadcaster directly, not through the consumer pipeline. Remote event broadcasting (Phase 5) and retry-triggered broadcasts (Phase 6) are untested at integration level. | MEDIUM |

---

## Summary Table

| ID | Downstream Phase | Section | Severity | Title | Requires Fix Before That Phase? |
|----|-----------------|---------|----------|-------|---------------------------------|
| [4→5.C.1] | 5 | Code | LOW | WsClient `remote.update` dispatch via generic handler | No (works as-is) |
| [4→5.B.1] | 5 | Behavioral | MEDIUM | TUI debounce buffer is session-specific, not generic | No (Phase 5 implements own debounce) |
| [4→5.B.2] | 5 | Behavioral | LOW | Polling interval mismatch (10s vs 30s) | No (separate hook, separate interval) |
| [4→6.C.1] | 6 | Code | **MEDIUM** | `ApiError.statusCode` vs Phase 6 spec's `.status` | **Yes** (update Phase 6 Task 6 spec) |
| [4→6.C.2] | 6 | Code | NONE | Timeout already 10s, matching Phase 6 target | No (informational) |
| [4→6.B.1] | 6 | Behavioral | LOW | Lifecycle formatter handles `archived` but no `restored` indicator | No (cosmetic, Phase 6 can add) |

---

## Verdict

**STATUS**: READY WITH FIXES

Phase 4's implementation is production-quality and architecturally clean. The data/presentation separation, class-based ApiClient, generic WS broadcasting, and TUI component hierarchy all provide exactly the extension points downstream phases need. No breaking changes or compilation failures are introduced.

### Must Fix Before Downstream Phases Start

1. **[4→6.C.1] Update Phase 6 Task 6 spec for `ApiError.statusCode` property name**: Phase 4's `ApiError` uses `statusCode` (not `.status`). Phase 6 Task 6's `isRetryableHttpError` predicate must check `error.statusCode`, or Phase 6 can rename the property during its ApiClient refactor. The spec should be updated to reflect the actual property name.

### Can Fix During Downstream Phases

2. **[4→5.B.1]** TUI debounce for remote updates — Phase 5 Task 14 should implement its own debounce buffer in `useRemotes`, following the pattern established by Phase 4's `useSessions`.

3. **[4→6.C.2]** Phase 6 Task 6 spec references "up from 2s" timeout — Phase 4 already uses 10s. Informational, no code change needed.

### Informational Only

4. **[4→5.C.1]** WsClient already handles `remote.update` via generic dispatch. No modification needed.
5. **[4→5.B.2]** Polling intervals are per-hook — Phase 5 sets its own (30s for remotes).
6. **[4→6.B.1]** Lifecycle formatter handles `archived` state. Phase 6 can optionally add a `restored` visual cue.
7. Phase 4's WS broadcast pipeline sends all event types — Phase 5 remote events and Phase 7 change events are automatically broadcast to subscribed clients.
8. Phase 4's ApiClient, Commander registration, TUI view routing, and output formatters are all cleanly extensible for Phases 5, 6, and 7 without modification.
