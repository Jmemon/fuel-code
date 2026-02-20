# Phase 3 Downstream Impact Review

> **Reviewed by**: Agent team (phase-4-reviewer, phase-5-reviewer, phase-6-reviewer, phase-7-reviewer)
> **Scope**: Phase 3 — Git Activity Tracking
> **Codebase state**: Phases 1 through 3 implemented
> **Review target**: Impact on Phases 4 through 7

## Purpose

Determine whether Phase 3's implementation (as-built vs as-planned) breaks assumptions, prerequisites, or implicit contracts in downstream phases. Each finding compares:
  - The downstream phase's **spec claim** (DAG line, task file quote)
  - Phase 3's **actual implementation** (file path + line number)
  - The **delta** between planned and actual that causes the break

---

## Phase 4: CLI + TUI

### Schema & Migration Assumptions

| ID | Claimed Artifact | Source (DAG/task line) | Phase 3 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 4.S.1 | `git_activity` table with all expected columns | Task 1 workspace detail SQL, Task 5 session --git, Task 9 sidebar | `003_create_git_activity.sql` — all columns present (id, workspace_id, device_id, session_id, type, branch, commit_sha, message, files_changed, insertions, deletions, timestamp, data, created_at) | OK |
| 4.S.2 | `workspace_devices.pending_git_hooks_prompt` and `git_hooks_prompted` | Task 6 status command, DAG "What Already Exists" | `004_add_git_hooks_prompt_columns.sql` — both columns exist | OK |
| 4.S.3 | `workspace_devices.git_hooks_installed` column | Task 1 workspace detail, Task 6 status hooks check | Phase 1 `001_initial.sql` — pre-existing | OK |
| 4.S.4 | `git_activity.branch` is a top-level column | Task 1 SQL: `array_agg(DISTINCT branch)` | `branch TEXT` at line 11 of 003 migration | OK |
| 4.S.5 | `git_activity` has `insertions` and `deletions` columns | Task 5 --git flag, Task 9 git tab | Both `INTEGER` columns exist (lines 15-16) | OK |

#### Findings

No schema findings. All Phase 4 assumptions about Phase 3 schema artifacts match the implementation.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 4.C.1 | `GitActivity` type in `@fuel-code/shared` | Task 3 line 357: `import type { ... GitActivity ... }` | **No `GitActivity` type exists in `packages/shared/src/types/`** | BROKEN |
| 4.C.2 | Handler registry with 6 handlers | Task 2 line 459: "event processor calls broadcaster" | `packages/core/src/handlers/index.ts` — all 6 handlers registered | OK |
| 4.C.3 | Payload Zod schemas for git events | DAG "What Already Exists", Task 3 relies on validated payloads | `payload-registry.ts` — all 4 git schemas registered | OK |
| 4.C.4 | `GET /api/sessions/:id/git` returns git activity | Task 3 api-client, Task 5 --git, Task 9 sidebar | Endpoint exists at `sessions.ts:444`, returns `{ git_activity }` with LIMIT 500 | OK |
| 4.C.5 | Timeline API at `GET /api/timeline` | Task 3 api-client, Task 4 timeline command | Endpoint exists at `timeline.ts`, mounted in `app.ts:122` | OK |
| 4.C.6 | Prompts API endpoints | Task 6 status command | `GET /api/prompts/pending` and `POST /api/prompts/dismiss` exist at `prompts.ts` | OK |
| 4.C.7 | Consumer accepts `broadcaster` dependency | Task 2 line 440: "Pass broadcaster to consumer" | `ConsumerDeps` has no `broadcaster` field | NEEDS REWORK |

#### Findings

##### [3->4.C.1] Missing `GitActivity` type in shared package — Severity: MEDIUM

**Spec claim**: Phase 4 Task 3 (api-client.ts, line 357) imports `GitActivity` from `@fuel-code/shared`. Tasks 5, 8, 9, and 10 all reference this type for formatting git data.

**Actual state**: `packages/shared/src/types/index.ts` exports from `event.ts`, `workspace.ts`, `device.ts`, `session.ts`, `transcript.ts` — there is no `git-activity.ts` file and no `GitActivity` type. Phase 3 created the `git_activity` Postgres table and Zod payload schemas but did not create a corresponding TypeScript interface for the row shape.

**Impact**: Phase 4 Task 3 will fail to compile when importing `GitActivity` from shared. Every downstream reference (Tasks 5, 8, 9, 10) will also fail.

**Recommended fix**: Create `packages/shared/src/types/git-activity.ts` with a `GitActivity` interface matching the `git_activity` table columns. Export from `types/index.ts`. ~20 lines. Must be done before Phase 4 starts.

##### [3->4.C.2] Consumer does not accept broadcaster dependency — Severity: LOW

**Spec claim**: Phase 4 Task 2 (line 440-445) says to modify `consumer.ts` to accept a `broadcaster` parameter and call `broadcaster.broadcastEvent()` after processing.

**Actual state**: `packages/server/src/pipeline/consumer.ts` `ConsumerDeps` interface (line 35-46) has no `broadcaster` field.

**Impact**: Expected — Task 2 explicitly says "Modify `packages/server/src/pipeline/consumer.ts`" as part of its implementation. This is Phase 4's responsibility.

**Recommended fix**: No Phase 3 fix needed. Phase 4 Task 2 will extend `ConsumerDeps` with an optional `broadcaster` field.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 4.A.1 | Timeline returns `{ items, next_cursor, has_more }` | Task 3 api-client `getTimeline()` | Returns `{ items: [...], next_cursor, has_more }` | DRIFT |
| 4.A.2 | Timeline item shape is flat `{ type, timestamp, workspace_id, workspace_name, data }` | Task 3 `TimelineEntry` interface (line 434-441) | Items are structured union: session items + orphan items | BROKEN |
| 4.A.3 | `GET /api/sessions/:id/git` returns `{ git_activity }` | Task 3 `getSessionGit` | Returns `{ git_activity: [...] }` at sessions.ts:467 | OK |
| 4.A.4 | Prompts API filtered by `device_id` | Task 6, DAG | Returns `{ prompts: [...] }` with type, workspace fields | OK |

#### Findings

##### [3->4.A.1] Timeline API response shape mismatch — Severity: HIGH

**Spec claim**: Phase 4 Task 3 defines `TimelineEntry` as a flat object (line 434-441):
```typescript
export interface TimelineEntry {
  type: string;
  timestamp: string;
  workspace_id: string;
  workspace_name: string;
  data: Record<string, unknown>;
}
```
Task 4 `getTimeline()` (line 234) expects `{ timeline: TimelineEntry[] }` from the API.

**Actual state**: The timeline API at `packages/server/src/routes/timeline.ts` returns:
```json
{
  "items": [
    {
      "type": "session",
      "session": { "id": "...", "workspace_name": "...", ... },
      "git_activity": [ { "type": "commit", "branch": "...", ... } ]
    },
    {
      "type": "git_activity",
      "workspace_id": "...", "device_id": "...",
      "git_activity": [ ... ],
      "started_at": "..."
    }
  ],
  "next_cursor": "...",
  "has_more": true
}
```

Key differences:
1. **Top-level key**: API returns `items`, spec expects `timeline`
2. **Item shape**: API returns discriminated union, spec expects flat objects
3. **Session items** embed full session object + nested `git_activity` array
4. **Orphan items** group by workspace+device with git event arrays

**Impact**: Phase 4 Tasks 3, 4, and 8 (TUI dashboard) are all built around the wrong response shape. The `TimelineEntry` type must be completely redesigned.

**Recommended fix**: Update Phase 4 Task 3's `TimelineEntry` type to a discriminated union matching the actual API response. Read from `items` not `timeline`. Update Tasks 4 and 8 rendering accordingly.

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 3 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 4.B.1 | Git-session correlation assigns session_id | Tasks 1, 5, 9 | Implemented in `git-correlator.ts` — finds active session by workspace+device+timestamp | OK |
| 4.B.2 | Orphan git events have `session_id IS NULL` | Task 4 timeline, Task 8 TUI | Confirmed: nullable session_id, orphan events served via timeline | OK |
| 4.B.3 | Timeline orphan events are unbounded | Phase 3 review Issue #7 | Orphan query at timeline.ts:278-290 has no LIMIT | DRIFT |
| 4.B.4 | Hook installer sets `core.hooksPath` | Task 6 status command | Confirmed: installs to `~/.fuel-code/git-hooks/` | OK |
| 4.B.5 | Per-repo hook status NOT detected | Phase 3 review Issue #6 | `getGitHookStatus()` only checks global `core.hooksPath` | DRIFT |

#### Findings

##### [3->4.B.1] Unbounded orphan git activity in timeline — Severity: LOW

**Spec claim**: Phase 4 Task 8 (TUI Dashboard) and Task 4 (timeline command) render timeline data including orphan git events.

**Actual state**: Phase 3 orphan query in timeline.ts has no LIMIT. A workspace with heavy standalone git activity could produce an unbounded response.

**Impact**: Performance concern for TUI rendering and long CLI output, not a correctness issue.

**Recommended fix**: Add LIMIT to orphan query (e.g., 100 events), or Phase 4 caps rendered orphan items.

##### [3->4.B.2] Per-repo hook status invisible to status command — Severity: LOW

**Spec claim**: Phase 4 Task 6 checks `git config --global core.hooksPath` to determine hook installation status.

**Actual state**: `getGitHookStatus()` only checks global `core.hooksPath`. Per-repo installs via `--per-repo` are not detected.

**Impact**: Misleading "Not installed" status for per-repo users. Hooks still function correctly.

**Recommended fix**: Extend `getGitHookStatus()` to check `.git/hooks/` as fallback, or document limitation.

---

## Phase 5: Remote Dev Environments

### Schema & Migration Assumptions

| ID | Claimed Artifact | Source (DAG/task line) | Phase 3 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 5.S.1 | `git_activity` table exists | Phase 5 DAG implied prerequisite | Created in `003_create_git_activity.sql` | OK |
| 5.S.2 | Migration numbering convention (NNN prefix) | Task 6: `NNNN_create_remote_envs.sql` | Phase 3 uses `003_` and `004_` prefix — consistent | OK |

#### Findings

No schema findings. Phase 3 migrations do not conflict with Phase 5's planned migration.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 5.C.1 | `createHandlerRegistry()` returns extensible registry | Task 7: `registerRemoteHandlers(registry, deps)` | Closed factory in `handlers/index.ts:28-42` — hardcodes 6 handlers, but `registry.register()` is public | NEEDS REWORK |
| 5.C.2 | `EventHandlerContext` carries handler deps | Task 7: handlers need `sshKeyManager`, `broadcaster` | Context has `sql`, `event`, `workspaceId`, `logger`, `pipelineDeps?` — no remote deps | NEEDS REWORK |
| 5.C.3 | `wire.ts` accepts additional deps | Task 7: inject remote handler deps | `createEventHandler(sql, logger, pipelineDeps?)` — no remote dep params | NEEDS REWORK |
| 5.C.4 | `EventHandler` type signature | Task 7: remote handlers | `(ctx: EventHandlerContext) => Promise<void>` — confirmed | OK |
| 5.C.5 | `processEvent()` dispatches to registered handlers | Task 7: remote events use same pipeline | Dispatches via `registry.getHandler(event.type)` — no type filtering | OK |
| 5.C.6 | Payload registry accepts new schema entries | Task 7: add remote.* schemas | `PAYLOAD_SCHEMAS` is `Partial<Record<EventType, z.ZodSchema>>` — extensible | OK |
| 5.C.7 | `EventType` includes `remote.*` types | Task 7: register remote handlers | All 4 remote types in `EventType` union (Phase 1) | OK |

#### Findings

##### [3->5.C.1] Handler registry is a closed factory — Phase 5 must register handlers post-creation — Severity: HIGH

**Spec claim**: Phase 5 Task 7 specifies `registerRemoteHandlers(registry, deps)` to add remote handlers externally.

**Actual state**: `packages/core/src/handlers/index.ts:28-42` — `createHandlerRegistry()` hardcodes all 6 handlers (2 session + 4 git) and returns the populated registry. However, `registry.register()` is public and mutates the internal handler map.

**Impact**: No breakage — Phase 5 can call `registry.register()` on the returned object. The `process()` function in `wire.ts` looks up handlers at dispatch time via `registry.getHandler()`, so handlers registered after creation are visible. The approach works:
```typescript
const { registry, process } = createEventHandler(sql, logger, pipelineDeps);
registerRemoteHandlers(registry, { sql, sshKeyManager, broadcaster, logger });
```

**Recommended fix**: No Phase 3 fix needed. Phase 5 wire.ts modification is straightforward.

##### [3->5.C.2] EventHandlerContext lacks remote handler deps — Severity: MEDIUM

**Spec claim**: Phase 5 Task 7 remote handlers need `sshKeyManager` (SSH key cleanup) and `broadcaster` (WebSocket updates).

**Actual state**: `EventHandlerContext` (`event-processor.ts:31-42`) only has `sql`, `event`, `workspaceId`, `logger`, `pipelineDeps?`.

**Impact**: Remote handlers cannot access their required deps through the context. Phase 5 should use **closure captures** — handlers close over `deps` when registered via `registerRemoteHandlers(registry, deps)`. The handler conforms to `EventHandler = (ctx) => Promise<void>` while using captured deps internally.

**Recommended fix**: No Phase 3 change needed. Phase 5 Task 7 spec should clarify the closure-capture pattern.

##### [3->5.C.3] wire.ts needs extension for remote handler deps — Severity: MEDIUM

**Spec claim**: Phase 5 tasks reference injecting deps into handlers via the wiring layer.

**Actual state**: `wire.ts:35-49` — `createEventHandler(sql, logger, pipelineDeps?)` only accepts 3 params.

**Impact**: Phase 5 must either extend the function signature or register remote handlers separately after calling `createEventHandler()`. The latter is cleaner.

**Recommended fix**: No Phase 3 change needed. Phase 5 extends wire.ts at implementation time.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 5.A.1 | Ingest accepts `remote.*` event types | Phase 5 DAG | Phase 1 endpoint, not Phase 3. `EVENT_TYPES` includes remote types. | OK |
| 5.A.2 | Payload validation passes unregistered types | Phase 5 DAG | `payload-registry.ts:52-54` — returns success for unregistered types | OK |

#### Findings

No API contract issues. Phase 3 did not modify the ingest endpoint.

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 3 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 5.B.1 | processEvent dispatches by type, catches errors | Task 7 | Confirmed: `event-processor.ts:182-203` | OK |
| 5.B.2 | Handler errors don't fail the event | Task 7: handlers must be resilient | Confirmed: errors caught, event row persisted | OK |
| 5.B.3 | Consumer passes all events without type filtering | Task 7 | Confirmed: `consumer.ts:159` — no type filter | OK |
| 5.B.4 | processEvent runs workspace resolution on ALL events | Task 8: provisioner emits remote.* events | `event-processor.ts:141-153` — resolves workspace for all types | DRIFT |

#### Findings

##### [3->5.B.1] processEvent runs workspace resolution on remote.* events — Severity: LOW

**Spec claim**: Phase 5 provisioner emits `remote.*` events with `{ remote_env_id }` data.

**Actual state**: `processEvent()` calls `resolveOrCreateWorkspace()` and `resolveOrCreateDevice()` for every event, including remote.*. It also extracts `event.data.cwd` (defaults to `"unknown"` for remote events).

**Impact**: Minor — auto-creates device rows eagerly, `cwd = "unknown"` is harmless for remote events. Idempotent.

**Recommended fix**: Informational. Phase 5 should ensure remote.* events carry valid workspace_id and device_id.

---

## Phase 6: Hardening

### Schema & Migration Assumptions

| ID | Claimed Artifact | Source (DAG/task line) | Phase 3 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 6.S.1 | `git_activity` table with indexes | Task 7, Task 14 E2E | `003_create_git_activity.sql` — 5 indexes, no `device_id` index (Issue #8) | OK |
| 6.S.2 | `workspace_devices` prompt columns | Task 7 (drain processes session.start events) | `004_add_git_hooks_prompt_columns.sql` exists | OK |

#### Findings

No schema findings.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 6.C.1 | `FuelCodeError` constructor: `(message, options?: { cause?, code? })` | Task 2 spec | Actual: `(message, code, context)` — `code` is required positional, not optional | DRIFT |
| 6.C.2 | Handler registry with 6 handlers | Task 7, Task 14 | All 6 handlers registered | OK |
| 6.C.3 | `processEvent` does NOT call `validateEventPayload()` | Phase 3 Issue #9, Task 2 error catalog | `event-processor.ts:180-199` — no validation before dispatch | DRIFT |
| 6.C.4 | Git handlers use `as` type casts, no runtime validation | Phase 3 Issue #9 | `git-commit.ts:30-38` — bare `as string`/`as number` casts | OK |
| 6.C.5 | Prompt dismiss bug (Phase 3 Issue #5) | Task 6 error handling | `git-hooks-prompt.ts:58-66` — dismiss always runs as "accepted" | DRIFT |
| 6.C.6 | Timeline orphan query has no LIMIT (Phase 3 Issue #7) | Task 6 HTTP timeout/retry | `timeline.ts:278-290` — no LIMIT clause | DRIFT |
| 6.C.7 | `validateEventPayload()` exists and is exported | Task 7 corruption recovery | `payload-registry.ts:46-63` — exists, functional | OK |

#### Findings

##### [3->6.C.1] FuelCodeError constructor signature mismatch with Task 2 spec — Severity: HIGH

**Spec claim**: Phase 6 Task 2 says: "Extend the existing FuelCodeError base class... Add an optional `code` field: `constructor(message: string, options?: { cause?: unknown; code?: string })`"

**Actual state**: `packages/shared/src/errors.ts:27-36` — constructor is `(message: string, code: string, context: Record<string, unknown> = {})`. `code` is a **required** positional parameter. Existing error codes use UPPERCASE format (`NETWORK_INGEST_FAILED`, `CONFIG_MISSING`), while Task 2 uses dot-separated (`network.connection_refused`).

**Impact**: Task 2's constructor change would be a **breaking API change** affecting all existing call sites across Phases 1-3. Not caused by Phase 3 (Phase 3 didn't modify errors.ts), but the spec-reality gap exists.

**Recommended fix**: Phase 6 Task 2 must either: (a) keep existing `(message, code, context)` signature and add `cause` to the context bag, or (b) include full migration of all call sites in Task 2 scope.

##### [3->6.C.2] Prompt dismiss bug persists into Phase 6 — Severity: MEDIUM

**Spec claim**: Phase 6 aims to make all CLI operations robust with structured error handling.

**Actual state**: `packages/cli/src/lib/git-hooks-prompt.ts:58-66` — when `installGitHooks()` throws, catch prints error but `dismissPrompt(config, prompt.workspaceId, "accepted")` runs unconditionally. Permanently suppresses prompt even on failed install.

**Impact**: Phase 6's error framework won't retroactively fix this independent code path. Bug persists.

**Recommended fix**: Fix before Phase 6: move dismiss inside try block, or dismiss as "declined" in catch.

##### [3->6.C.3] Unbounded orphan query affects retry/timeout assumptions — Severity: MEDIUM

**Spec claim**: Phase 6 Task 6 increases per-request timeout from 2s to 10s with 3 retries.

**Actual state**: `timeline.ts:278-290` — orphan query has no LIMIT. High-orphan workspaces produce slow queries.

**Impact**: Phase 6 retry logic (10s timeout + 3 retries) would amplify load on structurally slow timeline queries. Retries assume timeouts are transient, but this timeout is structural.

**Recommended fix**: Add `LIMIT 200` to orphan query. One-line fix.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 6.A.1 | Timeline endpoint exists | Task 14 E2E | `GET /api/timeline` — exists | OK |
| 6.A.2 | Session list supports lifecycle filtering | Task 13 | Phase 1/2 endpoint, not modified by Phase 3 | OK |
| 6.A.3 | Ingest returns per-event `results` array | Task 7 queue drain | Phase 1 endpoint returns results. Phase 3 unchanged. | OK |
| 6.A.4 | Prompts API endpoints | Task 6 HTTP retry | Both endpoints exist | OK |

#### Findings

No API contract issues. Phase 6 prompt checker (`prompt-checker.ts`) uses independent `fetch()` with 2s timeout, bypassing Phase 6's hardened ApiClient. This is by design (best-effort).

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 3 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 6.B.1 | Handler errors caught, don't crash server | Task 7, Task 2 | `event-processor.ts:194-199` — errors caught, logged | OK |
| 6.B.2 | Git handlers wrap DB ops in transactions | Task 8 archival pattern | `git-commit.ts:55-86` — all use `sql.begin()` | OK |
| 6.B.3 | Three-layer idempotency for events | Task 7 drain retry | processEvent dedup -> handler ON CONFLICT DO NOTHING -> correlation guard | OK |
| 6.B.4 | Queue drain can resubmit events safely | Task 7 batch isolation | All idempotency layers confirmed | OK |
| 6.B.5 | processEvent skips payload validation | Phase 3 Issue #9, Task 7 | No `validateEventPayload()` call before dispatch | DRIFT |

#### Findings

##### [3->6.B.1] processEvent lacks payload validation — degraded dead-letter diagnostics — Severity: LOW

**Spec claim**: Phase 6 Task 7 expects graceful per-event error handling in queue drain.

**Actual state**: `validateEventPayload()` exists and works but is not called by `processEvent`. Malformed payloads hit Postgres type errors instead of descriptive validation failures.

**Impact**: Dead-letter envelopes get cryptic Postgres errors instead of clean "validation failed" messages.

**Recommended fix**: Wire `validateEventPayload()` into `processEvent` before handler dispatch. 5-line change, can be done pre-Phase 6 or as part of Task 7.

---

## Phase 7: Slack Integration + Change Orchestration

### Schema & Migration Assumptions

| ID | Claimed Artifact | Source (DAG/task line) | Phase 3 Actual State | Status |
|----|-----------------|----------------------|---------------------|--------|
| 7.S.1 | `events.type` accepts any string | Task 1: change.* events stored in events table | TEXT column, no CHECK constraint. Constraint is at Zod layer. | OK |

#### Findings

No schema findings. Phase 7's `change_requests` table is independent of Phase 3 artifacts.

---

### Code Artifact Assumptions

| ID | Claimed Artifact | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 7.C.1 | `EVENT_TYPES` array accepts new types | Task 1: "add change.* types" | `as const satisfies readonly EventType[]` — both union and array need update | OK |
| 7.C.2 | `PAYLOAD_SCHEMAS` registry accepts new entries | Task 1: register change schemas | `Partial<Record<EventType, z.ZodSchema>>` — extensible | OK |
| 7.C.3 | `createHandlerRegistry()` supports adding change.* handlers | Task 3: register change handlers | Hardcoded factory, but `registry.register()` is public | DRIFT |
| 7.C.4 | `EventHandlerRegistry.register()` accepts `EventType` | Task 3: register change handlers | `register(eventType: EventType, handler, logger?)` — requires EventType update first | OK |
| 7.C.5 | `processEvent()` dispatches without type filtering | Task 3: change events flow through pipeline | Dispatches via `registry.getHandler(event.type)` — any registered handler fires | OK |
| 7.C.6 | `validateEventPayload()` passes unregistered types | Task 1: change schemas registered separately | Returns success for unregistered types (line 53) | OK |

#### Findings

##### [3->7.C.1] Handler registry wiring is hardcoded pattern — Severity: MEDIUM

**Spec claim**: Phase 7 Task 3 says "Register handlers for change.* events in the event handler registry."

**Actual state**: `packages/core/src/handlers/index.ts:28-42` — `createHandlerRegistry()` hardcodes all 6 handler registrations. Phase 3 added 4 git.* handlers to this same function.

**Impact**: No breakage. Phase 7 must follow the same pattern: create handler files in `packages/core/src/handlers/`, import in `index.ts`, add `registry.register("change.*", handler)` calls in `createHandlerRegistry()`. Clear, consistent, but not a plugin pattern.

**Recommended fix**: Update Phase 7 Task 3 spec to explicitly reference the `createHandlerRegistry()` pattern. Alternatively, Phase 7 could use the same post-creation registration approach as Phase 5 if change handlers need extra deps.

##### [3->7.C.2] EVENT_TYPES requires coordinated dual update — Severity: LOW

**Spec claim**: Task 1 says "add all 7 change.* types to EVENT_TYPES array."

**Actual state**: `EventType` union and `EVENT_TYPES` array must be updated in lockstep. The `satisfies` constraint ensures a partial update fails at compile time.

**Impact**: None — compile-time safety via `satisfies` guard makes this safe.

**Recommended fix**: Informational.

---

### API Contract Assumptions

| ID | Claimed Contract | Source | Phase 3 Actual State | Status |
|----|-----------------|--------|---------------------|--------|
| 7.A.1 | Ingest accepts change.* after EVENT_TYPES update | Phase 7 DAG | `z.enum(EVENT_TYPES)` rejects unknown types. Task 1 updates EVENT_TYPES. | OK |
| 7.A.2 | Timeline API serves change.* events | Phase 7 DAG (implicit) | Timeline only queries `sessions` and `git_activity` — NOT `events` table generically | DRIFT |

#### Findings

##### [3->7.A.1] Timeline API does not serve change events — Severity: LOW

**Spec claim**: Phase 7 DAG references Phase 3 git tracking: "Phase 7 leverages existing git.push tracking when CC pushes branches."

**Actual state**: `timeline.ts` queries sessions + git_activity only. Change.* events in the `events` table would NOT appear in the timeline. However:
- Phase 7 has its own `GET /api/changes` endpoint for change request visibility
- Git.push events from headless CC WILL appear via git_activity (if hooks fire on remote)

**Impact**: Low. Change events have their own API. Timeline is a session+git view.

**Recommended fix**: Informational. If a unified timeline is desired later, add `change_requests` as a third data source.

---

### Behavioral / Semantic Assumptions

| ID | Claimed Behavior | Source | Phase 3 Actual Behavior | Status |
|----|-----------------|--------|------------------------|--------|
| 7.B.1 | Git hooks fire on remote env when headless CC pushes | Task 4: git commit + push on remote | Hooks installed via `core.hooksPath` on local machine only — but remote provisioning (Phase 5) should install hooks into the remote repo at setup time. | OK |
| 7.B.2 | Git-session correlation works for headless CC | DAG: "Session-git correlation" | Correlator queries by workspace+device+lifecycle+timestamp. Works if device_id matches. | OK |
| 7.B.3 | Payload validation passes for change.* before registration | Task 1 | `validateEventPayload()` returns success for unregistered types | OK |
| 7.B.4 | Handler errors don't crash pipeline | Task 3: observability handlers | Handler dispatch wrapped in try/catch | OK |
| 7.B.5 | Event deduplication works for change.* | Task 8: E2E tests | `ON CONFLICT (id) DO NOTHING` — by event ULID, not type | OK |

#### Findings

##### ~~[3->7.B.1]~~ RETRACTED — Git hooks on remote environments

**Original finding**: Flagged that git hooks wouldn't fire on remote EC2 environments because Phase 3 hooks are local-only.

**Correction**: Remote provisioning (Phase 5) should install git hooks into the remote repo as part of environment setup. When a remote session is launched, the provisioner installs fuel-code and configures git hooks on the remote machine, so git.commit/push/checkout/merge events fire normally through the hook pathway. This is not a Phase 3 issue — it's Phase 5's provisioning responsibility.

**Status**: NOT A FINDING. Retracted.

---

## Cross-Phase Concerns

Findings that affect multiple downstream phases simultaneously.

| Finding | Affected Phases | Description | Severity |
|---------|----------------|-------------|----------|
| Missing `GitActivity` type in shared | 4, 5, 6, 7 | No TypeScript interface for the `git_activity` row shape despite table existing. Any phase importing `GitActivity` from shared will fail. | MEDIUM |
| Timeline API shape mismatch with Phase 4 specs | 4 (directly), 5 (if consuming timeline) | Response uses structured `items` array with discriminated union, not flat `timeline` array. | HIGH |
| Handler registry is a closed factory | 5, 7 (both register new handlers) | `createHandlerRegistry()` hardcodes all handlers. Extensions must use `registry.register()` post-creation or modify the factory directly. Pattern is clear but must be documented. | MEDIUM |
| EventHandlerContext lacks extra deps | 5, 6, 7 (all may need handler-specific deps) | Handlers needing deps beyond sql/event/logger must use closure captures. The `pipelineDeps` precedent exists but a more generic pattern may be needed. | MEDIUM |
| FuelCodeError constructor mismatch | 6 (Task 2 directly), 4, 5 (if they throw errors) | Phase 6 Task 2 specs a different constructor than what exists. Not caused by Phase 3 — spec-reality gap from Phase 1. | HIGH |
| No runtime payload validation in processEvent | 6 (dead-letter diagnostics), all (error quality) | `validateEventPayload()` exists but isn't wired in. Degrades error diagnostics for malformed payloads. | LOW |
| ~~Git hooks not on remote environments~~ | ~~5, 7~~ | ~~RETRACTED~~ — Remote provisioning (Phase 5) installs hooks on the remote. Not a Phase 3 issue. | N/A |

---

## Summary Table

| ID | Downstream Phase | Section | Severity | Title | Requires Fix Before That Phase? |
|----|-----------------|---------|----------|-------|---------------------------------|
| [3->4.C.1] | 4 | Code | MEDIUM | Missing `GitActivity` type in shared | **Yes** |
| [3->4.C.2] | 4 | Code | LOW | Consumer lacks broadcaster dep | No (Phase 4 adds it) |
| [3->4.A.1] | 4 | API | **HIGH** | Timeline API response shape mismatch | **Yes** (update Phase 4 specs) |
| [3->4.B.1] | 4 | Behavioral | LOW | Unbounded orphan query in timeline | No (performance, not correctness) |
| [3->4.B.2] | 4 | Behavioral | LOW | Per-repo hook status invisible | No (cosmetic) |
| [3->5.C.1] | 5 | Code | HIGH | Handler registry is a closed factory | No (registry.register() is public) |
| [3->5.C.2] | 5 | Code | MEDIUM | EventHandlerContext lacks remote deps | No (closure capture works) |
| [3->5.C.3] | 5 | Code | MEDIUM | wire.ts needs extension for remote deps | No (straightforward at Phase 5 time) |
| [3->5.B.1] | 5 | Behavioral | LOW | processEvent resolves workspace for remote.* | No (harmless defaults) |
| [3->6.C.1] | 6 | Code | **HIGH** | FuelCodeError constructor mismatch | **Yes** (update Task 2 spec) |
| [3->6.C.2] | 6 | Code | MEDIUM | Prompt dismiss bug persists | Recommended |
| [3->6.C.3] | 6 | Code | MEDIUM | Unbounded orphan query affects retry | Recommended |
| [3->6.B.1] | 6 | Behavioral | LOW | processEvent lacks payload validation | No (can fix during Phase 6) |
| [3->7.C.1] | 7 | Code | MEDIUM | Handler registry hardcoded pattern | No (informational) |
| [3->7.C.2] | 7 | Code | LOW | EVENT_TYPES dual update requirement | No (compile-time safe) |
| [3->7.A.1] | 7 | API | LOW | Timeline doesn't serve change events | No (Phase 7 has own API) |
| ~~[3->7.B.1]~~ | 7 | Behavioral | ~~MEDIUM~~ | ~~Git hooks not on remote environments~~ | **RETRACTED** — Phase 5 provisioning installs hooks |

---

## Verdict

**STATUS**: READY WITH FIXES

Phase 3's implementation is solid and well-architected. The handler registry pattern, payload registry, event pipeline, and git-session correlation all work correctly and are extensible. The issues found are primarily **spec-reality gaps in downstream phases** — downstream task specs make assumptions that don't match Phase 3's actual output format or patterns.

### Must Fix Before Downstream Phases Start

1. **[3->4.C.1] Create `GitActivity` type**: Add `packages/shared/src/types/git-activity.ts` matching the `git_activity` table columns. Export from `types/index.ts`. ~20 lines. Blocks Phase 4 compilation.

2. **[3->4.A.1] Update Phase 4 specs for timeline API shape**: The timeline API returns `{ items: [...], next_cursor, has_more }` with a discriminated union of session and orphan-git items — not `{ timeline: TimelineEntry[] }` with flat objects. Phase 4 Tasks 3, 4, and 8 must be updated.

3. **[3->6.C.1] Update Phase 6 Task 2 spec for FuelCodeError constructor**: The actual constructor is `(message, code, context)` not `(message, options?)`. Task 2 must reconcile. Not caused by Phase 3 but flagged here because the gap exists.

4. ~~**[3->7.B.1]**~~ **RETRACTED** — Remote provisioning (Phase 5) installs git hooks on remote environments. Not a Phase 3 issue.

### Recommended Fixes (Not Blocking)

5. **[3->6.C.2] Fix prompt dismiss bug**: Move dismiss inside try block in `git-hooks-prompt.ts:58-66`, or dismiss as "declined" in catch.

6. **[3->6.C.3] Add LIMIT to orphan timeline query**: Add `LIMIT 200` to `timeline.ts:278-290`. One-line fix that prevents timeout amplification in Phase 6 retry logic.

7. **[3->6.B.1] Wire validateEventPayload()**: Add payload validation call in `processEvent` before handler dispatch. Improves error diagnostics for all downstream phases.

### Can Fix During Downstream Phases

8. **[3->5.C.1-3]** Handler registry, context, and wire.ts extensions — all straightforward at Phase 5 implementation time.

9. **[3->4.B.2]** Per-repo hook status detection — cosmetic, fix in Phase 4 Task 6.

### Informational Only

10. **[3->7.C.2]** EVENT_TYPES dual update is compile-time safe via `satisfies` constraint.
11. **[3->7.A.1]** Timeline is session+git only; change events have own API.
12. **[3->5.B.1]** processEvent workspace resolution on remote.* events is harmless.
13. **[3->4.C.2]** Consumer broadcaster is explicitly Phase 4 Task 2 scope.
