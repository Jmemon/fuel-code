# Phase 4 Implementation Review

## Overview

Phase 4 ("CLI + TUI") was implemented across 10 tasks in 28 commits (813a889..09facb7). The phase delivers CLI query commands (`sessions`, `session <id>`, `timeline`, `workspaces`, `status`), an interactive TUI dashboard with live WebSocket updates, REST endpoints for workspaces/devices, a WebSocket server for real-time broadcasting, and comprehensive E2E integration tests.

**Stats**: 98 files changed, ~20,645 lines added, ~9,635 removed (includes draft cleanup). 49 production files (+7,285 lines), 27 test files (+11,492 lines). 1,033 tests pass, 64 skipped, 1 pre-existing failure (Phase 3 post-merge hook). 2,943 expect() calls across 67 test files.

---

## Task-by-Task Assessment

### Task 1: Workspace + Device REST Endpoints — PASS

**Spec**: `GET /api/workspaces` (paginated list with aggregates), `GET /api/workspaces/:id` (detail), `GET /api/devices` (list), `GET /api/devices/:id` (detail). Cursor-based pagination, ID resolution by ULID/name/canonical.

**Implementation**:
- `workspaces.ts` (297 lines): CTE-based aggregate query for session counts, active sessions, device count, cost, duration. Keyset pagination with `(last_session_at, id)` tuple comparison. Three-mode ID resolution (ULID regex, case-insensitive display_name, exact canonical_id) with ambiguity detection returning all matches on 400.
- `devices.ts` (150 lines): CTE approach prevents cross-join inflation when joining sessions × workspace_devices. Device detail includes workspace associations and recent sessions.
- Zod validation on pagination params (limit 1-250, optional cursor).

**Review fixes applied** (f90c946, 948b743):
- Replaced naive JOIN with CTEs to prevent N×M row multiplication in device list.
- Spec compliance fixes for response shapes.

**Verdict**: Complete. All SQL uses postgres.js tagged templates (zero injection risk). Proper error delegation via `next(err)`. 28 workspace tests + 12 device tests covering pagination, ID resolution, auth, empty results.

---

### Task 2: WebSocket Server — PASS

**Spec**: `wss://<host>/api/ws?token=<key>` with close code 4001 on auth fail. Subscribe by scope ("all"), workspace_id, or session_id. Ping/pong keepalive (30s/10s). Broadcaster integration into event processor pipeline. `ws_clients` count in `/api/health`.

**Implementation**:
- `ws/index.ts` (308 lines): Token validation on upgrade, ULID client IDs, subscription management via `Set<string>`, message type dispatch (subscribe/unsubscribe/pong), graceful shutdown with 1s timeout race.
- `ws/broadcaster.ts` (162 lines): `clientMatchesFilter()` correctly handles "all"/workspace/session subscriptions. `broadcastToMatching()` checks `readyState` before send, removes failed clients. Three broadcast methods (`broadcastEvent`, `broadcastSessionUpdate`, `broadcastRemoteUpdate`) with optional field spreading.
- `ws/types.ts` (44 lines): Server-side connection types.
- `shared/types/ws.ts` (114 lines): Shared client/server message discriminated unions.

**Review fixes applied** (cb36af8, d133a04):
- Added `readyState` check in broadcaster before sending.
- Added `ws_clients` to health endpoint.
- Wired broadcaster into consumer pipeline.

**Verdict**: Complete. Non-blocking fire-and-forget broadcasting — slow clients don't block the consumer. Proper cleanup on disconnect and shutdown. 22 tests covering auth, subscriptions, broadcasts, keepalive, graceful shutdown. `sendMessage()` utility wraps both sync exceptions and async send errors.

---

### Task 3: API Client + Output Formatters — PASS

**Spec**: Replace basic `createApiClient()` with comprehensive `ApiClient` class. 15+ endpoint methods with typed responses. Formatters for duration, cost, relative time, lifecycle badges, table rendering. Backward compatibility for `emit.ts`/`drain.ts`.

**Implementation**:
- `api-client.ts` (591→661 lines): Full `FuelApiClient` class with auth headers, 10s timeout via `AbortSignal.timeout()`, error classification (`ApiError` with status code, `ApiConnectionError` for network failures). Parameter mapping (camelCase→snake_case). Workspace resolution by name (case-insensitive prefix match). `createApiClient()` shim preserved for backward compat.
- `formatters.ts` (454 lines): `formatDuration()` (compound units), `formatCost()` (null/zero/<$0.01 handling), `formatRelativeTime()` (just now/3m ago/Monday 3:45pm/Feb 10), `formatLifecycle()` (colored icons per state), `formatTokens()` (K/M suffix + cache), `renderTable()` (ANSI-aware column alignment), `outputResult()` (json/text dispatch).

**Review fixes applied** (74ecfc6, 65a243b, 663b225):
- Spec compliance for lifecycle labels, error classification, timeout.

**Verdict**: Complete. Clean architecture — all CLI commands and TUI views share one API client. `outputResult()` provides consistent `--json` support across all commands. 82 tests (API client + formatters).

---

### Task 4: `sessions` + `timeline` Commands — PASS

**Spec**: Tabular session list with filters (`--workspace`, `--device`, `--today`, `--live`, `--lifecycle`, `--tag`, `--limit`, `--cursor`, `--json`). Timeline as session-grouped activity feed with date headers and relative date parsing (`-3d`, `-1w`).

**Implementation**:
- `sessions.ts` (265 lines): `fetchSessions()` (exported data layer) → `formatSessionsTable()` (presentation) → `runSessions()` (orchestrator). Filters map to API query params. Empty state with context-specific hints.
- `timeline.ts` (423 lines): `fetchTimeline()` (exported) → `formatTimeline()` (exported) → `runTimeline()`. Date headers group items. `parseRelativeDate()` handles `-Nd`/`-Nw`/`-Nh` formats. Git commits displayed inline under sessions.

**Review fixes applied** (7cbfa6a, 6c31702):
- Spec compliance for session lifecycle labels and timeline formatting.
- Code quality: extracted redundant resolver patterns.

**Verdict**: Complete. Proper data/presentation separation — TUI reuses `fetchSessions()` and `fetchTimeline()` directly. 23 tests covering filters, pagination, error handling, output formatting.

---

### Task 5: `session <id>` Command — PASS

**Spec**: Session ID resolution (full ULID, 8+ char prefix, ambiguity error). Default summary card. Flags: `--transcript` (rendered with tool tree), `--events` (table), `--git` (activity), `--export json/md`, `--tag`, `--reparse`, `--json`.

**Implementation**:
- `session-detail.ts` (568 lines): 5 exported data-fetch functions + 4 formatters + command handler. Flag dispatch determines which view to render.
- `session-resolver.ts` (70 lines): Validates prefix length ≥8, full ULID passthrough, ambiguous match shows rich candidate list with workspace/summary.
- `transcript-renderer.ts` (326 lines): Word-wrapping with configurable `maxWidth`, tool use tree with box-drawing characters (`├`/`└`), thinking block collapsing, tool-specific formatting (Read/Edit/Write/Bash/Grep/Glob input extraction), message truncation with count footer.

**Review fixes applied** (3c8fd14, 126699a):
- Spec compliance for event formatting and session resolver edge cases.

**Verdict**: Complete. Rich transcript rendering is reusable by TUI (TranscriptViewer imports it). Session resolver provides excellent error messages. 28 session-detail tests + 16 transcript-renderer tests.

---

### Task 6: `workspaces` + `status` Commands — PASS

**Spec**: Workspace list/detail with device hook status. Enriched `status` showing device info, backend connectivity (3s timeout, latency), active/recent sessions, queue depth, hook status, today's summary. Graceful degradation when backend unreachable.

**Implementation**:
- `workspaces.ts` (314 lines): List with sort by activity, detail with device list (hook status ✓/✗), recent sessions, git activity. Name/canonical/ULID resolution.
- `status.ts` (414 lines): `fetchStatus()` uses `Promise.allSettled()` — continues even if some API calls fail. Backend connectivity with latency measurement. CC hooks detected via `~/.claude/settings.json`, git hooks via `git config --global core.hooksPath`. Offline mode shows device info + error message.

**Review fixes applied** (6b32e51):
- Spec compliance for workspace detail fields and status hook detection.

**Verdict**: Complete. `Promise.allSettled()` is the right design for status — a slow or failed sub-request doesn't block the whole command. 28 workspace tests + 25 status tests including offline degradation.

---

### Task 7: WebSocket Client Library — PASS

**Spec**: EventEmitter-based `WsClient`. Auth via token query param. Subscription persistence across reconnects. Exponential backoff (1s→30s cap, 10 max attempts, jitter). `buildWsUrl()` converts HTTPS to WSS.

**Implementation**:
- `ws-client.ts` (431 lines): State machine (disconnected→connecting→connected). `connect()` returns Promise. Subscriptions stored in Set, re-sent on reconnect. Ping auto-response. Auth rejection detection (close code 4001). Backoff with jitter. `buildWsUrl()` URL conversion.
- Guards against double-connect and double-disconnect emission via state checks.

**Review fixes applied** (e25f15e, 47461c5):
- Guard against double-connect/disconnect emission.
- URL-encode API key in `buildWsUrl()` (keys with special chars).

**Verdict**: Complete. Solid reconnection logic with proper state management. 30 tests covering connection lifecycle, subscriptions, broadcasts, reconnect, ping/pong, error handling.

---

### Task 8: TUI Dashboard — PASS

**Spec**: Two-column Ink layout (workspaces ~30%, sessions ~70%). `StatusBar` with today's stats, WS indicator, key hints. Navigation (j/k, Tab, Enter). WS-driven live updates with 500ms debounce (max 2 renders/sec). 10s polling fallback when WS disconnected.

**Implementation**:
- `App.tsx` (120 lines): View routing, client lifecycle, global keybindings (q: quit, b: back).
- `Dashboard.tsx` (286 lines): Debounce buffer for WS updates (500ms flush interval), polling fallback on WS disconnect, session index reset on workspace change.
- 13 components: `WorkspaceItem`, `SessionRow` (lifecycle icon mapping for 8 states), `StatusBar`, `Spinner`, `ErrorBanner`, `FooterBar`, `GitActivityPanel`, `FilesModifiedPanel`, `ToolsUsedPanel`, `MessageBlock`, `SessionHeader`, `TranscriptViewer`, `Sidebar`.
- 5 hooks: `useWorkspaces()`, `useSessions()` (with `updateSession`/`prependSession` for WS), `useWsConnection()`, `useTodayStats()`, `useSessionDetail()`.

**Review fixes applied** (80becf4, 2db783f):
- Spec compliance for session row formatting, sidebar extraction, status bar indicators.
- Code quality: extracted helper functions, improved Sidebar tool/file extraction.

**Verdict**: Complete. All intervals and event listeners properly cleaned up (no memory leaks). WS integration is non-blocking — failure falls back to polling gracefully. Windowed rendering in TranscriptViewer (10-message window) prevents performance issues with large transcripts. 18 Dashboard tests + 10 hook tests + 10 component tests.

---

### Task 9: TUI Session Detail View — PASS

**Spec**: Header (metadata + live duration counter), TranscriptViewer (~65%), Sidebar with git/tools/files (~35%). Tab switching (t/e/g). Lazy event fetching. Keyboard navigation (j/k, Space/PageDown/PageUp, x: export, b: back). WS subscription for live sessions.

**Implementation**:
- `SessionDetailView.tsx` (298 lines): Tab system with lazy event fetching (only fetches on "e" press). Scroll clamping with `Math.min/Math.max`. Export writes to file with error handling.
- `useSessionDetail.ts` (154 lines): Parallel fetch on mount (`Promise.all` for session/transcript/git). WS subscription for capturing sessions. Export data getter.
- `TranscriptViewer.tsx` (84 lines): Windowed rendering, auto-scroll for live sessions (preserves position if user scrolled up).
- `MessageBlock.tsx` (149 lines): Tool input extraction for Read/Edit/Write/Bash/Grep/Glob. Tree characters. Thinking collapse with char count.
- `Sidebar.tsx` (78 lines): `extractToolCounts()` scans content_blocks, `extractModifiedFiles()` combines git + tool files.

**Review fixes applied** (80becf4, 2db783f):
- Spec compliance for message block formatting, sidebar panel rendering.

**Verdict**: Complete. Live session timer updates every 1s with proper cleanup. Auto-scroll correctly detects "at bottom" vs "user scrolled up". Lazy event fetching avoids unnecessary API calls. 27 SessionDetail tests + 13 TranscriptViewer tests + 9 Sidebar tests + 6 MessageBlock tests.

---

### Task 10: Phase 4 E2E Integration Tests — PASS

**Spec**: 24 test cases across 4 suites (CLI, WS, TUI, errors) against real Postgres + Redis + Express + WS. Seeded fixtures, random ports, 60s timeout.

**Implementation**:
- `setup.ts` (204 lines): Real infrastructure setup with port 0 allocation (OS-assigned random port). Advisory lock for parallel-safe fixture seeding. Proper cleanup sequence (consumer→WS→HTTP→Redis→Postgres).
- `fixtures.ts` (381 lines): 3 workspaces, 2 devices, 8 sessions (capturing/summarized/failed/parsed), 20+ events, 5 git_activity records, transcript messages with thinking/tool_use blocks. All dated today for `--today` filter testing.
- `phase4-cli.test.ts` (352 lines): 14 tests — sessions list/filter/json, session detail/transcript/git/export/tag, timeline, workspaces list/detail, status.
- `phase4-ws.test.ts` (196 lines): 4 tests — connect, subscribe-all broadcast, workspace filtering, session lifecycle updates.
- `phase4-tui.test.tsx` (167 lines): 3 tests — dashboard renders workspaces, renders sessions, session selection.
- `phase4-errors.test.ts` (100 lines): 3 tests — backend unreachable, invalid workspace 404, invalid API key 401.

**Review fixes applied** (663fb22, 3f8683d, 09facb7):
- Made E2E tests reliable under parallel execution (advisory locks, per-file server instances).
- Strengthened assertions and fixed case-sensitivity in auth error check.

**Verdict**: Complete. True E2E with real infrastructure. Port 0 allocation eliminates CI port conflicts. Advisory lock pattern enables safe parallel test file execution. 24 E2E tests covering the primary Phase 4 user flows.

---

## Issues Found

### Issue #1: WS Tests Bypass Consumer Pipeline

**Severity**: Medium
**Location**: `packages/cli/src/__tests__/e2e/phase4-ws.test.ts`

WS tests call `broadcaster.broadcastEvent()` directly rather than ingesting events via `POST /api/events/ingest` → Redis Stream → consumer → broadcast. This means the full event-to-broadcast pipeline is never tested end-to-end.

**Impact**: A bug in the consumer's broadcaster integration (wired in `consumer.ts` lines 169-184) would not be caught by E2E tests. The integration is only tested at the unit level.

**Fix**: Add at least one test that POSTs an event to the ingest endpoint and waits for it to arrive on a WS subscription. Accept the timing complexity — use `waitFor()` polling pattern from Phase 3 E2E tests.

---

### Issue #2: E2E Test 9 Mutates Shared Fixture Data

**Severity**: Medium
**Location**: `packages/cli/src/__tests__/e2e/phase4-cli.test.ts` lines 234-249

Test 9 adds a tag `"test-e2e"` to `sess_5_parsed` via `api.updateSession()`. This mutation persists in the shared Postgres database and is visible to parallel test files or subsequent runs within the same test server lifecycle.

**Impact**: If future tests assert on `sess_5_parsed`'s original tag state, they will see the mutated version. Currently no other test reads this session's tags, but it's a latent hazard.

**Fix**: Either reset the tag in an `afterEach` block, use a throwaway session for mutation testing, or wrap the mutation in a transaction with rollback.

---

### Issue #3: Hardcoded `await wait()` Timing in WS and TUI Tests

**Severity**: Medium (reliability)
**Location**: `phase4-ws.test.ts` (200ms waits), `phase4-tui.test.tsx` (500ms waits)

WS tests use `await wait(200)` before asserting subscription is active. TUI tests use `await wait(500)` for data loading. These fixed delays are timing-sensitive and could fail on slow CI runners.

**Impact**: Intermittent test failures on resource-constrained environments. The 200ms wait for WS subscription may be insufficient under load.

**Fix**: Replace with polling-with-timeout pattern:
```typescript
async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`Condition not met after ${timeoutMs}ms`);
}
```

---

### Issue #4: No Consumer Broadcaster Unit Tests

**Severity**: Low-Medium
**Location**: `packages/server/src/pipeline/consumer.ts` lines 169-184

The consumer's broadcaster integration (`broadcastEvent`, `broadcastSessionUpdate` calls after event processing) has no dedicated unit tests. The only coverage is via E2E tests — which themselves bypass the consumer (Issue #1).

**Impact**: A regression in the consumer-broadcaster wiring would go undetected until users notice missing live updates.

**Fix**: Add unit tests in `consumer.test.ts` with a mock broadcaster that captures broadcast calls. Verify that processing a `session.start` event triggers both `broadcastEvent()` and `broadcastSessionUpdate("capturing")`.

---

### Issue #5: `as any` Type Casts in Session Formatting

**Severity**: Low
**Location**: `packages/cli/src/commands/sessions.ts` line 106, `formatters.ts` line 415

Session list formatting casts sessions to `any` to access server-joined fields (`workspace_name`, `device_name`, `cost_estimate_usd`, `summary`). These fields are not part of the shared `Session` type.

```typescript
const ext = s as any;
return [
  ext.workspace_name ?? s.workspace_id,
  ext.device_name ?? s.device_id,
  formatCost(ext.cost_estimate_usd ?? null),
];
```

**Impact**: No runtime bug — fallback logic (`??`) handles missing fields. But type safety is lost, and a server-side rename of these fields would silently break formatting without compile-time detection.

**Fix**: Create a `SessionListItem` type in `packages/shared/` that extends `Session` with the optional joined fields:
```typescript
interface SessionListItem extends Session {
  workspace_name?: string;
  device_name?: string;
  cost_estimate_usd?: number | null;
  summary?: string | null;
  initial_prompt?: string | null;
}
```

---

### Issue #6: WS API Key in Query String

**Severity**: Low
**Location**: `packages/server/src/ws/index.ts` line 96, `packages/cli/src/lib/ws-client.ts` `buildWsUrl()`

The WebSocket connection passes the API key as a query parameter (`?token=<key>`), which is visible in server access logs and browser history.

**Impact**: Negligible for single-user CLI tool. Would be a security concern for multi-user production deployment.

**Fix**: Accept as known limitation for current single-user architecture. Document that multi-user deployments should switch to ticket-based auth (short-lived token exchanged via HTTP, used once for WS upgrade).

---

### Issue #7: No Limit on WebSocket Connections

**Severity**: Low
**Location**: `packages/server/src/ws/index.ts`

No maximum connection limit on the WebSocket server. A runaway reconnection loop or misconfigured client could open many connections.

**Impact**: Negligible for single-user system. OS TCP connection limits provide a natural ceiling.

**Fix**: Accept for now. Add `MAX_CLIENTS` check on connection if multi-user support is added.

---

### Issue #8: `useTodayStats` Commits Hardcoded to 0

**Severity**: Low
**Location**: `packages/cli/src/tui/hooks/useTodayStats.ts` line 40

Today's commit count is hardcoded to `0` because counting commits requires a separate API call to aggregate `git_activity` records.

```typescript
commits: 0, // Commits require a separate API call; omitted for now
```

**Impact**: StatusBar always shows "0 commits" in the dashboard. Users may find this misleading.

**Fix**: Documented as intentional in the code. Could add a `GET /api/stats/today` endpoint that returns pre-aggregated counts, or compute from the workspaces response data if git activity counts are included.

---

### Issue #9: No Pagination E2E Tests

**Severity**: Low
**Location**: `packages/cli/src/__tests__/e2e/phase4-cli.test.ts`

E2E tests only test default pagination (all 8 sessions fit within default limit). No test verifies cursor-based pagination by setting `limit=2` and iterating through pages.

**Impact**: Pagination bugs would only be caught by unit tests (which do cover this), not by the integration suite.

**Fix**: Add one pagination test:
```typescript
test("sessions pagination with cursor", async () => {
  const page1 = await fetchSessions(api, { limit: 2 });
  expect(page1.sessions).toHaveLength(2);
  const page2 = await fetchSessions(api, { limit: 2, cursor: page1.nextCursor });
  expect(page2.sessions).toHaveLength(2);
  // Verify no overlap between pages
});
```

---

### Issue #10: Workspace `any` Types in Route Handlers

**Severity**: Low
**Location**: `packages/server/src/routes/workspaces.ts` lines 197-210

Workspace detail response builds objects from `any`-typed postgres.js query results. The response shape is correct but relies on database schema rather than TypeScript types.

**Impact**: A column rename in the database would not cause a compile error. postgres.js returns `unknown[]` by default.

**Fix**: Define row types matching the SELECT columns and cast postgres.js results:
```typescript
interface WorkspaceRow {
  id: string;
  display_name: string;
  canonical_id: string;
  // ...
}
const rows = await sql<WorkspaceRow[]>`SELECT ...`;
```

---

## Design Patterns Assessment

### Positive Patterns

1. **Data/Presentation Separation**: Every CLI command exports data-fetching functions (`fetchSessions()`, `fetchTimeline()`, `fetchWorkspaceDetail()`, etc.) separately from formatting. The TUI imports the data layer directly, avoiding duplication. This is the single most important architectural decision in Phase 4 and it's executed consistently across all 5 command modules.

2. **Debounced WS Rendering**: Dashboard buffers WS updates with a 500ms flush interval (max 2 renders/second). This prevents render storms from rapid-fire events while keeping updates visibly responsive. The buffer stores pending session updates/prepends and flushes them in batch.

3. **Graceful Degradation in Status**: `fetchStatus()` uses `Promise.allSettled()` — a failed health check, session list, or queue depth request doesn't block the entire status output. The user sees what's available plus clear error indicators for what failed.

4. **Non-Blocking WS Architecture**: The entire WS stack is fire-and-forget. Broadcaster checks `readyState` before send, catches send errors, and removes failed clients. A slow or dead WS client never blocks the event processing pipeline.

5. **Windowed TUI Rendering**: TranscriptViewer renders a 10-message window (configurable `pageSize`), not the full transcript. Combined with auto-scroll detection (preserves position if user scrolled up, follows for live sessions at bottom), this keeps the TUI responsive even with 1000+ message transcripts.

6. **Consistent Error UX**: All commands provide context-specific error messages: "Cannot connect to backend at <url>. Is it running?", "Invalid API key. Run 'fuel-code init' to reconfigure.", "Workspace 'foo' not found. Available workspaces: bar, baz". No stack traces leak to users.

7. **Advisory Lock for Parallel E2E**: The test infrastructure uses Postgres advisory locks to serialize fixture seeding across parallel test files, while each file gets its own Express server on a random port. This enables safe parallel execution without port conflicts or data races.

8. **Zero SQL Injection Surface**: All server-side SQL uses postgres.js tagged templates throughout. Dynamic WHERE clauses in workspaces, devices, and existing timeline routes are composed via `sql` fragments, not string concatenation.

### Patterns to Watch

1. **Cursor Duplication**: `encodeCursor()`/`decodeCursor()` implementations are copy-pasted across `workspaces.ts`, `sessions.ts`, and the existing `timeline.ts`. These should be extracted to a shared utility in `packages/server/src/lib/`.

2. **`any` Types at Data Boundaries**: postgres.js returns `unknown[]`, which is routinely cast to `any` for field access. This is pragmatic but loses type safety at the most critical boundary (database → application). A typed query pattern would catch column renames at compile time.

3. **Implicit Extended Session Fields**: The sessions list API returns joined fields (`workspace_name`, `device_name`, `summary`) that aren't in the shared `Session` type. Formatters use `as any` to access them. This works but creates an implicit API contract not captured in types.

4. **WS Subscription Persistence Without Server ACK Verification**: `WsClient` stores subscriptions locally and re-sends them on reconnect, but doesn't wait for server acknowledgment before considering the subscription active. A dropped subscribe message after reconnect would silently fail to deliver events.

---

## Test Coverage Assessment

| Module | Test Files | Tests | Strategy |
|--------|-----------|-------|----------|
| Workspace routes | 1 | 28 | Mock SQL with fragment-aware matchers |
| Device routes | 1 | 12 | Mock SQL with CTEs |
| WebSocket server | 1 | 22 | Real WS connections, mock auth |
| API client | 1 | ~40 | Mock HTTP via Bun.serve() |
| Formatters | 1 | ~42 | Pure function input/output + ANSI stripping |
| Sessions command | 1 | 24 | Mock API client |
| Session detail | 1 | 28 | Mock API client + resolver |
| Timeline command | 1 | 23 | Mock API client |
| Workspaces command | 1 | 28 | Mock API client |
| Status command | 1 | 25 | Mock API client + Bun.spawnSync |
| Transcript renderer | 1 | 16 | Pure function rendering |
| Session resolver | 1 | ~8 | Mock API client |
| Resolvers | 1 | ~8 | Mock API client |
| WS client | 1 | 30 | Mock WebSocket |
| TUI Dashboard | 1 | 18 | ink-testing-library + mock WS |
| TUI SessionDetail | 1 | 27 | ink-testing-library |
| TUI TranscriptViewer | 1 | 13 | ink-testing-library |
| TUI MessageBlock | 1 | 6 | ink-testing-library |
| TUI Sidebar | 1 | 9 | ink-testing-library |
| TUI Hooks | 1 | 10 | Mock API client |
| TUI Components | 1 | 10 | ink-testing-library |
| E2E CLI | 1 | 14 | Real Postgres + Redis + Express |
| E2E WS | 1 | 4 | Real WS server + broadcaster |
| E2E TUI | 1 | 3 | Real backend + ink-testing-library |
| E2E Errors | 1 | 3 | Real API client error paths |
| **Total** | **25+** | **~450** | |

### Test Gaps

1. **No consumer→broadcaster integration test**: The broadcaster wiring in consumer.ts is untested at unit level, and E2E tests bypass it (Issue #1).

2. **No cursor pagination E2E test**: Pagination is tested at unit level but not in integration (Issue #9).

3. **No WS reconnection E2E test**: `WsClient` has reconnection logic with exponential backoff, but no E2E test verifies that a server disconnect triggers reconnect and subscription re-establishment.

4. **No TUI SessionDetail E2E test**: E2E TUI tests cover Dashboard only. SessionDetail rendering with real backend data is tested at unit level only.

5. **No 500-error handling test**: Error tests cover 401 and 404, but not server errors (500). `formatError()` handles them, but no test exercises this path.

6. **No combined-filter test**: Individual filters (workspace, date, lifecycle) are tested separately but not in combination (e.g., `--workspace=foo --today --lifecycle=capturing`).

---

## Summary of Findings

| # | Issue | Severity | Recommendation |
|---|-------|----------|----------------|
| 1 | WS tests bypass consumer pipeline | **Medium** | Add 1 end-to-end event→WS test |
| 2 | E2E Test 9 mutates shared fixture | **Medium** | Reset tag in afterEach or use throwaway session |
| 3 | Hardcoded `await wait()` in tests | **Medium** | Replace with polling-with-timeout |
| 4 | No consumer broadcaster unit tests | Low-Medium | Add mock broadcaster tests in consumer.test.ts |
| 5 | `as any` casts in session formatting | Low | Create `SessionListItem` extended type |
| 6 | WS API key in query string | Low | Document as known limitation |
| 7 | No WS connection limit | Low | Accept for single-user system |
| 8 | Today's commits hardcoded to 0 | Low | Add stats endpoint or compute from existing data |
| 9 | No pagination E2E test | Low | Add one cursor-walk test |
| 10 | `any` types in route handlers | Low | Define typed row interfaces |

**Overall Verdict**: Phase 4 is well-executed. The data/presentation separation is the architectural highlight — every CLI command cleanly exports reusable data-fetching functions that the TUI consumes without duplication. The WS stack is properly non-blocking with good error isolation. The TUI implementation follows React patterns correctly with proper cleanup of all intervals and event listeners (no memory leaks detected). Test coverage is comprehensive at ~450 tests with real infrastructure E2E tests.

The three medium-severity issues are all test-quality concerns, not production code bugs. Issue #1 (consumer pipeline bypass) and Issue #3 (timing-sensitive waits) should be addressed to improve CI reliability. Issue #2 (shared fixture mutation) should be fixed to prevent future test pollution. The production code itself is clean, type-safe (with minor `any` casts at boundaries), and follows the spec consistently.

Compared to Phase 3 (10 issues, 3 medium), Phase 4 has a similar issue profile (10 issues, 3 medium) despite being significantly larger (~20K lines vs ~9K lines). The issues are concentrated in test infrastructure rather than production logic, which is a positive signal for code quality.
