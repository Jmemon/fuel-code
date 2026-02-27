# Task 9: Event Processor with Handler Registry

## Parallel Group: E

## Description

Build the event processor — the core function that the Redis consumer calls for each event. It resolves workspace/device, inserts the event into Postgres, and dispatches to type-specific handlers via an extensible registry. Phase 1 registers `session.start` and `session.end` handlers.

The handler registry pattern is critical: Phase 2+ adds new handlers (git.commit, session.compact, etc.) by calling `registry.register(type, handler)` — no refactoring of the processor itself.

### Files to Create

**`packages/core/src/event-processor.ts`**:

Types:
```typescript
/** Context passed to every event handler */
interface EventHandlerContext {
  sql: postgres.Sql;
  event: Event;
  workspaceId: string;  // resolved ULID (not canonical string)
  logger: pino.Logger;
}

/** An event handler function */
type EventHandler = (ctx: EventHandlerContext) => Promise<void>;

/** Result of processing a single event */
interface ProcessResult {
  eventId: string;
  status: "processed" | "duplicate" | "error";
  handlerResults: Array<{ type: string; success: boolean; error?: string }>;
}
```

**`EventHandlerRegistry` class**:
- `register(eventType: EventType, handler: EventHandler): void` — registers a handler for a type. Only one handler per type (overwrites). Log at info level: "Registered handler for {type}".
- `getHandler(eventType: EventType): EventHandler | undefined` — returns the registered handler, or undefined.
- `listRegisteredTypes(): EventType[]` — for diagnostics/logging.

**`processEvent` function**:
```typescript
async function processEvent(
  sql: postgres.Sql,
  event: Event,
  registry: EventHandlerRegistry,
  logger: pino.Logger
): Promise<ProcessResult>
```

Steps:
1. **Resolve workspace**: `event.workspace_id` is a canonical string from the CLI. Call `resolveOrCreateWorkspace(sql, event.workspace_id, extractHints(event))`. Get back the ULID.
   - `extractHints(event)`: if event is `session.start`, extract `default_branch` from `data.git_branch`.
2. **Resolve device**: Call `resolveOrCreateDevice(sql, event.device_id)`. The device ID is already a ULID from the CLI.
3. **Link workspace-device**: Call `ensureWorkspaceDeviceLink(sql, resolvedWorkspaceId, event.device_id, event.data.cwd || "unknown")`.
4. **Insert event row**:
   ```sql
   INSERT INTO events (id, type, timestamp, device_id, workspace_id, session_id, data, blob_refs, ingested_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
   ON CONFLICT (id) DO NOTHING
   ```
   - **CRITICAL**: Store the resolved workspace ULID in the events row, NOT the canonical string.
   - If ON CONFLICT hits (duplicate): return `{ status: "duplicate" }` immediately. No further processing.
5. **Dispatch to type handler**: Look up `registry.getHandler(event.type)`.
   - If handler exists: call it with the context. If it throws, log the error but do NOT fail the overall processing (the event is already persisted). Record the error in `handlerResults`.
   - If no handler: log at debug level "No handler for {type}", continue (expected for event types not yet implemented).
6. Return `ProcessResult`.

**IMPORTANT**: Wrap the entire function in try/catch. On infrastructure error (Postgres down, etc.), rethrow — the consumer handles retries. On handler error, swallow and log — the event is persisted.

**`packages/core/src/handlers/session-start.ts`**:

`handleSessionStart(ctx: EventHandlerContext): Promise<void>`:
- Extract from `ctx.event.data`: `cc_session_id`, `git_branch`, `model`, `source`, `transcript_path`
- Insert session record:
  ```sql
  INSERT INTO sessions (id, workspace_id, device_id, lifecycle, started_at, git_branch, model, source, metadata)
  VALUES ($1, $2, $3, 'detected', $4, $5, $6, $7, $8)
  ON CONFLICT (id) DO NOTHING
  ```
  - Session `id` = `cc_session_id` (Claude Code's own session ID)
  - `workspace_id` = `ctx.workspaceId` (resolved ULID)
  - `started_at` = `ctx.event.timestamp`
- Log: "Session detected: {cc_session_id} in workspace {workspaceId}"

**`packages/core/src/handlers/session-end.ts`**:

`handleSessionEnd(ctx: EventHandlerContext): Promise<void>`:
- Extract: `cc_session_id`, `duration_ms`, `end_reason`, `transcript_path`
- Update session:
  ```sql
  UPDATE sessions SET
    lifecycle = 'ended',
    ended_at = $1,
    end_reason = $2,
    duration_ms = $3,
    updated_at = now()
  WHERE id = $4 AND lifecycle IN ('detected', 'capturing')
  ```
- If no rows updated (session doesn't exist or already ended): log warning "Session end received but no active session found for {cc_session_id}". This handles out-of-order events (end arrives before start, or duplicate end).
- Log: "Session ended: {cc_session_id}, duration: {duration_ms}ms, reason: {end_reason}"

**`packages/core/src/handlers/index.ts`**:
- `createHandlerRegistry(): EventHandlerRegistry`:
  - Creates a new registry
  - Registers: `session.start` → `handleSessionStart`
  - Registers: `session.end` → `handleSessionEnd`
  - Returns the registry
  - Phase 2 will add more registrations here

### Tests

**`packages/core/src/__tests__/event-processor.test.ts`** (requires test Postgres):
- Process `session.start` event: creates workspace, device, event row, session row with lifecycle=`detected`
- Process same event again: returns `{ status: "duplicate" }`, no duplicate rows
- Process `session.end` after `session.start`: session lifecycle updates to `ended`
- Process `session.end` without prior `session.start`: warning logged, no crash
- Process unknown event type (e.g., `system.heartbeat`): event row created, no handler error
- Handler error is swallowed: event row still persists

## Relevant Files
- `packages/core/src/event-processor.ts` (create)
- `packages/core/src/handlers/session-start.ts` (create)
- `packages/core/src/handlers/session-end.ts` (create)
- `packages/core/src/handlers/index.ts` (create)
- `packages/core/src/__tests__/event-processor.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export processor and registry)

## Success Criteria
1. Processing a `session.start` event with a new workspace canonical ID creates: workspace row, device row, workspace_devices link, event row, session row with `lifecycle = "detected"`.
2. Processing the same event ID again returns `{ status: "duplicate" }` with no duplicate rows anywhere.
3. Processing `session.end` after `session.start` (same session ID) updates session to `lifecycle = "ended"` with correct `ended_at`, `duration_ms`, `end_reason`.
4. Processing `session.end` before `session.start` (out of order) logs a warning but does not crash or throw.
5. Processing an unregistered event type (e.g., `system.heartbeat`) inserts the event row but does not call any handler.
6. If a handler throws, the event is still persisted. The error is captured in `ProcessResult.handlerResults`.
7. The events table stores the RESOLVED workspace ULID, not the canonical string.
8. `createHandlerRegistry()` returns a registry with `session.start` and `session.end` registered.
9. `registry.listRegisteredTypes()` returns `["session.start", "session.end"]`.
10. Adding a new handler is a one-line change: `registry.register("git.commit", handleGitCommit)`.
