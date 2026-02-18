# Phase 1 Downstream Impact Review

A rigorous analysis of whether Phase 1's implementation will cause breakage, require rework, or create friction in Phases 2-7. Each finding includes evidence and severity.

---

## Critical Issues (Will Break Downstream)

### 1. Phase 3 Assumes `git_activity` Table Exists — It Does NOT

**Severity**: CRITICAL (Phase 3 Task 3 will fail)

**Evidence**: Phase 3 DAG line: _"`git_activity` table (exists but empty — no handlers populate it yet)"_. However, `001_initial.sql` contains only 5 tables: `workspaces`, `devices`, `workspace_devices`, `sessions`, `events`. There is NO `git_activity` table.

**What will break**: Phase 3 Task 3 (Git Event Handlers) expects to INSERT INTO `git_activity`. Phase 3 Task 5 (Timeline API) expects to query from it. Both will fail with missing table errors.

**Fix required**: Either:
- (a) Phase 3 Task 1 must create a migration for `git_activity`, OR
- (b) The Phase 3 DAG needs updating to remove the claim that this table exists, OR
- (c) A new Phase 1 migration should add the `git_activity` table retroactively before Phase 3 starts.

**Recommendation**: Option (a) is cleanest — Phase 3 should own its own migration. But the task specs need to be updated to not assume it already exists. Phase 3's "What Already Exists" section is wrong and must be corrected.

---

### 2. Phase 3 Assumes All Git Event Zod Schemas Exist — Verify Carefully

**Severity**: HIGH (may partially break Phase 3 Task 1/3)

**Evidence**: Phase 3 DAG line: _"All git event Zod schemas defined in `shared/schemas/`"_. Phase 1 only defined payload schemas for `session.start` and `session.end` (in `session-start.ts` and `session-end.ts`). The payload registry (`payload-registry.ts`) only registers those two types.

**What will break**: If Phase 3 Task 3 expects pre-existing Zod schemas for `git.commit`, `git.push`, `git.checkout`, `git.merge`, they won't exist. The handler registry pattern works (Phase 3 can register new handlers), but Phase 3 must also create the payload schemas.

**Mitigation**: Phase 1's event types DO include all 14 types in `EVENT_TYPES` (including all git.* types), and the ingest endpoint accepts any of these types. Events with unregistered payload types PASS through validation (forward-compatible — `packages/server/src/routes/events.ts` line 91). So git events can be ingested without schemas. But they won't be payload-validated until Phase 3 adds the schemas.

**Fix required**: Phase 3 task specs should explicitly include creating Zod schemas for git event payloads. This may already be in the Phase 3 task files — but the DAG's "already exists" claim is misleading.

---

### 3. Phase 2 Audit Note: Ingest Response Format — Already Done

**Severity**: NONE (already resolved)

**Evidence**: Phase 2 DAG Audit Note #2 says: _"Phase 1's `POST /api/events/ingest` returns `{ ingested: number, duplicates: number }`. This is a breaking API change."_ and recommends extending the response with per-event `results`.

**Actual state**: Phase 1's ingest endpoint (`events.ts`) already returns per-event results:
```json
{ "ingested": N, "duplicates": 0, "rejected": N, "results": [{ "index": 0, "status": "accepted" }, ...], "errors": [...] }
```
This was built correctly in Task 8. The audit note is now outdated — no change needed.

---

## High-Risk Issues (May Require Rework)

### 4. Phase 4 Assumes `packages/server/src/ws/` Directory Exists — It Does NOT

**Severity**: MEDIUM (Phase 4 Task 2 needs to create from scratch)

**Evidence**: Phase 4 DAG line: _"`packages/server/src/ws/` directory exists (empty placeholder)"_. The directory does not exist in the current codebase (confirmed via Glob).

**Impact**: Phase 4 Task 2 (WebSocket Server) will need to create the directory. This is trivial but the task spec may not account for it if it assumes the directory is pre-existing.

**Fix**: Update Phase 4 DAG or ensure Phase 4 Task 2 explicitly creates the directory.

---

### 5. Phase 4 Assumes `packages/cli/src/lib/api-client.ts` Needs Replacement

**Severity**: MEDIUM (requires careful migration)

**Evidence**: Phase 4 DAG says under "NOT yet built": _"`packages/cli/src/lib/api-client.ts`"_, implying it doesn't exist. But Phase 1 Task 10 CREATED `api-client.ts` (117 lines) with `createApiClient()` and an `ingest()` method.

**Impact**: Phase 4 Task 3 wants to build a comprehensive `ApiClient` class. It needs to either extend the existing `api-client.ts` or replace it. The existing `emit` command, `drain.ts`, and other Phase 1 code imports from this file.

**Fix**: Phase 4 Task 3 should extend the existing api-client rather than creating a new one. The existing imports in `emit.ts` and `drain.ts` must continue to work.

---

### 6. Phase 5 Assumes `remote_envs` and `blueprints` Tables Exist in Schema

**Severity**: MEDIUM (only matters if Phase 5 Task 6 doesn't create its own migration)

**Evidence**: Phase 5 DAG mentions under "Database": _"`remote_envs` table [...] `blueprints` table [...]"_ and under "Infrastructure": _"`infra/sql/schema.sql` — includes `remote_envs` and `blueprints` tables"_. Neither exists in the Phase 1 schema.

**Impact**: Phase 5 Task 6 is specifically titled "Remote API Endpoints + DB Queries + **Migration**", so it should create these tables. But if the task spec assumes they already exist, it will need adjustment.

**Fix**: Verify Phase 5 Task 6 explicitly includes the migration SQL. Also, Phase 1's sessions table already has `remote_env_id TEXT` (no FK) with a comment: _"FK to remote_envs added in Phase 5 migration"_. Phase 5 must add the ALTER TABLE for this FK.

---

### 7. Phase 2 Needs `transcript_messages` and `content_blocks` Tables

**Severity**: LOW (Phase 2 Task 1 is explicitly "Phase 2 Database Migration")

**Evidence**: Phase 6 DAG references _"`transcript_messages` and `content_blocks` with ON DELETE CASCADE"_. These don't exist in Phase 1's schema. Phase 2 Task 1 is specifically "Phase 2 Database Migration" which should create them.

**Impact**: None if Phase 2 Task 1 is implemented correctly.

---

### 8. Session `lifecycle` Values Need Expansion in Later Phases

**Severity**: LOW (CHECK constraint will block new values)

**Evidence**: Phase 1's sessions table has:
```sql
CHECK (lifecycle IN ('detected', 'capturing', 'ended', 'parsed', 'summarized', 'archived', 'failed'))
```

Phase 2 introduces `capturing` as a live state (session.start → hook detects transcript writing), which is already in the CHECK. Phase 6 introduces `archived → summarized` reverse transition. All required lifecycle values are already in the CHECK constraint.

**Impact**: None — the CHECK constraint was designed with forward-looking values. No ALTER TABLE needed for lifecycle states.

---

## Design Pattern Considerations

### 9. Handler Registry Pattern — Extensible as Expected

**Status**: GOOD (no changes needed)

Phase 1 created `EventHandlerRegistry` in `packages/core/src/event-processor.ts` with `register(eventType, handler)`. Phase 3 needs to register `git.commit`, `git.push`, etc. Phase 5 needs `remote.provision.*`. Phase 7 needs `change.*`.

The registry pattern works perfectly for this. Each phase creates its handlers and registers them in `createHandlerRegistry()` (`packages/core/src/handlers/index.ts`). The only change needed is adding `import` and `register()` calls in the handler index file.

**Caveat**: Phase 7 introduces event types NOT in the current `EVENT_TYPES` array (`change.requested`, etc.). These must be added to `packages/shared/src/types/event.ts` and the Zod enum. The ingest endpoint rejects events with unknown types (strict Zod enum validation).

---

### 10. `EVENT_TYPES` Enum is Closed — New Types Need Schema Changes

**Severity**: MEDIUM (affects Phase 7 specifically)

**Evidence**: `eventSchema` in `event-base.ts` uses `z.enum(EVENT_TYPES)` which is a closed enum of 14 types. Phase 7 introduces 7 new event types (`change.*`).

**What will break**: If Phase 7 events are sent through the existing ingest endpoint without updating the enum, they'll fail Zod validation with a 400 error.

**Fix required**: Phase 7 must update `EVENT_TYPES` in `shared/src/types/event.ts` and the corresponding `EventType` union type. This is a breaking change to the shared package — all consumers will see the new types. This is by design (centralized type definitions) but must be done in the correct order.

---

### 11. `workspace_devices.local_path` is NOT NULL — May Cause Issues

**Severity**: LOW-MEDIUM

**Evidence**: `workspace_devices` has `local_path TEXT NOT NULL`. In `event-processor.ts` line 146-147:
```typescript
const localPath = typeof event.data.cwd === "string" ? event.data.cwd : "unknown";
```

If the event has no `cwd` field, "unknown" is stored. This won't crash, but it means workspace-device records may have unhelpful path data.

**Downstream impact**: Phase 4's `fuel-code workspaces` command will display "unknown" as the local path for some workspace-device pairs. Phase 3's auto-prompt for git hook installation checks `workspace_devices.git_hooks_installed` — the path is informational but "unknown" might confuse users.

---

### 12. Device Resolution Creates Minimal Records

**Severity**: LOW

**Evidence**: `resolveOrCreateDevice()` creates devices with `name = "unknown-device"`, `type = "local"` when hints aren't provided. The emit command doesn't pass device hints — it uses `config.device.id` but doesn't send name/type/hostname/os/arch.

**Downstream impact**: Phase 4's device listing will show many "unknown-device" records unless `fuel-code init` was run first (which sets up the device with proper metadata). Phase 5's remote devices will have proper metadata since the server creates them.

**Fix recommendation**: Consider having the emit command pass device hints from the config file, or have the hooks pass `os.hostname()` and `os.platform()`.

---

### 13. Session ID is `cc_session_id` (Claude Code's ID), NOT a ULID

**Severity**: LOW (by design, but worth noting)

**Evidence**: `handleSessionStart` uses `event.data.cc_session_id` as the sessions PK (`sessions.id`). This is Claude Code's session identifier, not a fuel-code ULID.

**Downstream impact**: Phase 2 (session lifecycle), Phase 4 (session queries), and Phase 7 (headless CC sessions) all use this ID. It works because cc_session_id is unique across sessions. But it means fuel-code doesn't control session ID format — if CC's ID format changes, fuel-code must adapt.

**For Phase 7**: Headless CC (`claude --task`) also generates a session ID. The task spec should verify this ID is available in the hook context.

---

## Dependency Graph Accuracy

### 14. Phase 2 Task 7: "Session.end Handler Upgrade"

Phase 2 Task 7 wants to upgrade the `handleSessionEnd` handler to trigger the transcript pipeline. Phase 1's handler (`session-end.ts`) only updates `lifecycle` to `ended`. Phase 2 will need to either modify or replace this handler.

**The existing handler registration pattern supports this** — Phase 2 can re-register `session.end` with a new handler that calls the original logic plus the pipeline trigger.

---

### 15. Phase 6 Task 6/7: Queue Drain Hardening

Phase 6 wants to harden the queue drain with per-event batch isolation. This requires the ingest endpoint to return per-event results (which it does — see Finding #3). Phase 6 also wants the drainer to use individual event results. Phase 1's drainer (`drain.ts`) currently does batch-level success/failure, not per-event.

**This is expected** — Phase 6 explicitly plans to rework the drainer. Phase 1's implementation is sufficient for Phase 1 and Phase 6 will enhance it.

---

### 16. Phase 4 Task 2: WebSocket Server Hooks Into Event Processor

Phase 4 wants the WS server to be called by the event processor after each event is handled. Phase 1's `processEvent()` does NOT have a WS broadcast hook. Phase 4 will need to either:
- Add a callback/hook to `processEvent()`, or
- Have the consumer call the broadcaster after `processEvent()` returns, or
- Modify `wire.ts` to inject a broadcaster

All options are feasible with the current architecture. The DI pattern makes this straightforward.

---

## Summary: What Must Be Fixed Before Each Phase

### Before Phase 2
- Nothing blocking. Phase 2 Task 1 creates its own migration. The existing schema is compatible.

### Before Phase 3
- **CRITICAL**: Update Phase 3 DAG/tasks to NOT assume `git_activity` table exists. Phase 3 must create it.
- **HIGH**: Verify Phase 3 tasks explicitly create Zod schemas for git event payloads. Don't assume they exist.

### Before Phase 4
- **MEDIUM**: Update Phase 4 DAG to note `ws/` directory doesn't exist (needs creation).
- **MEDIUM**: Update Phase 4 Task 3 to extend existing `api-client.ts`, not replace it.

### Before Phase 5
- **MEDIUM**: Verify Phase 5 Task 6 creates `remote_envs` and `blueprints` tables (not assumed pre-existing).
- **MEDIUM**: Phase 5 migration must ALTER TABLE sessions ADD CONSTRAINT for `remote_env_id` FK.

### Before Phase 7
- **MEDIUM**: Phase 7 must add `change.*` event types to `EVENT_TYPES` and `EventType` before ingesting change events.

---

## Overall Assessment

Phase 1's implementation is **solid and well-architected**. The core patterns (handler registry, DI, workspace resolution, event pipeline, atomic queue) are all designed for extensibility. The biggest risk is **incorrect assumptions in downstream task specs** about what Phase 1 created (specifically the `git_activity` table and git Zod schemas). The implementation itself has no architectural issues that would require rework.

The one genuine shortcut was the **missing CLI E2E tests** (Tests 8-11 from Task 14). These would have validated the offline queue path end-to-end. This gap means the full resilience path (emit → queue → drain → Postgres) is only tested at the unit level, not as an integrated flow. This should be addressed before Phase 2 starts, or at minimum acknowledged as a known gap.
