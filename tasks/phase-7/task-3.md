# Task 3: Server API Endpoints for Changes

## Parallel Group: B

## Dependencies: Task 1

## Description

Build the REST API endpoints for change request management: create, read, list, approve, and reject. These endpoints are called by the Slack bot (Task 6), the CLI (Task 7), and potentially a future web UI.

### Files to Create

**`packages/server/src/routes/changes.ts`**:

```typescript
function createChangesRouter(deps: {
  sql: postgres.Sql;
  changeQueries: ChangeRequestQueries;
  orchestrator: ChangeOrchestrator;
  logger: pino.Logger;
}): Router
```

---

**`POST /api/changes`** — Create a new change request.

Request body (validated with `createChangeRequestSchema`):
```json
{
  "workspace_id": "01JMF3...",
  "request_text": "Add a loading spinner to the dashboard",
  "source": "slack",
  "requester_name": "John",
  "target_branch": "main",
  "preview_port": 3000,
  "slack_channel_id": "C0123456789",
  "slack_thread_ts": "1234567890.123456",
  "idempotency_key": "evt_abc123"
}
```

Flow:
1. Validate request body with Zod schema.
2. If `idempotency_key` provided: check for existing CR with same key.
   - If found: return `200 { change_request: existingCR, deduplicated: true }`.
3. Generate ULID for the new CR.
4. Insert via `changeQueries.create()`.
5. Trigger orchestrator asynchronously: `orchestrator.execute(crId).catch(err => logger.error(...))`.
6. Return `202 { change_request: newCR }`.

---

**`GET /api/changes`** — List change requests with pagination.

Query parameters:
- `workspace_id` — filter by workspace
- `status` — comma-separated statuses (e.g., "pending,implementing,deployed")
- `limit` — max results, default 50, max 250
- `cursor` — opaque pagination cursor

Response:
```json
{
  "change_requests": [...],
  "next_cursor": "base64..." | null,
  "has_more": true | false
}
```

---

**`GET /api/changes/:id`** — Get a single change request with full detail.

Response: `200 { change_request: { ...full record... } }`
Not found: `404 { error: "Change request not found" }`

---

**`POST /api/changes/:id/approve`** — Approve a deployed change request.

Flow:
1. Get CR. If not found: 404.
2. If status is not 'deployed': `409 { error: "Change request is not awaiting approval", status: cr.status }`.
3. Transition to 'approved' via `changeQueries.transition()`.
4. Trigger merge: `orchestrator.merge(crId).catch(err => logger.error(...))`.
5. Return `202 { change_request: updatedCR, message: "Merge initiated" }`.

---

**`POST /api/changes/:id/reject`** — Reject a deployed change request.

Flow:
1. Get CR. If not found: 404.
2. If status is not 'deployed': `409 { error: "Change request is not awaiting approval", status: cr.status }`.
3. Transition to 'rejected' via `changeQueries.transition()`. Set `completed_at`.
4. Cleanup: `orchestrator.handleRejection(crId).catch(err => logger.error(...))`.
5. Return `200 { change_request: updatedCR, message: "Change rejected" }`.

---

**`POST /api/changes/:id/cancel`** — Cancel a change request at any non-terminal stage.

Flow:
1. Get CR. If not found: 404.
2. If status is 'merged', 'rejected', or 'failed': `409 { error: "Change request already completed" }`.
3. Call `orchestrator.cancel(crId)`.
4. Return `200 { change_request: updatedCR, message: "Change request cancelled" }`.

---

**`POST /api/changes/:id/retry`** — Retry a failed change request.

Flow:
1. Get CR. If not found: 404.
2. If status is not 'failed': `409 { error: "Only failed change requests can be retried" }`.
3. Transition to 'pending'.
4. Trigger orchestrator: `orchestrator.execute(crId).catch(err => logger.error(...))`.
5. Return `202 { change_request: updatedCR, message: "Retry initiated" }`.

---

### Change Event Handlers

**`packages/core/src/handlers/change-events.ts`**:

Register handlers for change.* events in the event handler registry:

```typescript
// change.requested — when a new change request is created
// change.implementing — when CC starts working
// change.deployed — when preview is ready
// change.approved — when user approves
// change.rejected — when user rejects
// change.merged — when branch is merged
// change.failed — when something goes wrong
```

Each handler:
1. Finds the change request by ID in event data.
2. Logs the event.
3. Broadcasts via WebSocket for live TUI updates (if connected).

These are observability handlers — the actual state transitions happen in the orchestrator. Events are emitted by the orchestrator after each transition for audit trail and real-time updates.

### Mount in Server

**Modify `packages/server/src/app.ts`**: Mount `/api/changes` router with auth middleware.

**Modify `packages/server/src/index.ts`**:
- Create change request queries from sql pool.
- Create change orchestrator with all deps.
- Pass to changes router.

### Tests

**`packages/server/src/routes/__tests__/changes.test.ts`** (requires Postgres):

1. `POST /api/changes` creates a CR with status 'pending', returns 202.
2. `POST /api/changes` with same idempotency_key: returns 200 with existing CR.
3. `POST /api/changes` with invalid body: 400.
4. `GET /api/changes` returns list in created_at DESC order.
5. `GET /api/changes?status=deployed` filters correctly.
6. `GET /api/changes` with pagination: limit + cursor works.
7. `GET /api/changes/:id` returns full CR detail.
8. `GET /api/changes/:id` with invalid ID: 404.
9. `POST /api/changes/:id/approve` on deployed CR: transitions to 'approved', returns 202.
10. `POST /api/changes/:id/approve` on non-deployed CR: 409.
11. `POST /api/changes/:id/reject` on deployed CR: transitions to 'rejected', returns 200.
12. `POST /api/changes/:id/reject` on non-deployed CR: 409.
13. `POST /api/changes/:id/cancel` on in-progress CR: transitions to 'failed', returns 200.
14. `POST /api/changes/:id/cancel` on terminal CR: 409.
15. `POST /api/changes/:id/retry` on failed CR: transitions to 'pending', returns 202.
16. `POST /api/changes/:id/retry` on non-failed CR: 409.
17. Auth required on all endpoints: 401 without Bearer token.

## Relevant Files
- `packages/server/src/routes/changes.ts` (create)
- `packages/core/src/handlers/change-events.ts` (create)
- `packages/server/src/app.ts` (modify — mount changes router)
- `packages/server/src/index.ts` (modify — create orchestrator + queries, wire deps)
- `packages/core/src/index.ts` (modify — re-export change event handlers)
- `packages/server/src/routes/__tests__/changes.test.ts` (create)

## Success Criteria
1. `POST /api/changes` creates a CR and triggers the orchestrator asynchronously.
2. Idempotency key prevents duplicate CRs (returns existing on match).
3. `GET /api/changes` supports filtering by workspace_id and status, with cursor pagination.
4. `POST /api/changes/:id/approve` only works on 'deployed' CRs.
5. `POST /api/changes/:id/reject` only works on 'deployed' CRs.
6. `POST /api/changes/:id/cancel` works on any non-terminal CR.
7. `POST /api/changes/:id/retry` only works on 'failed' CRs.
8. All endpoints return appropriate HTTP status codes (202 for async, 200 for sync, 404/409 for errors).
9. Change event handlers are registered and broadcast via WebSocket.
10. Auth required on all endpoints.
