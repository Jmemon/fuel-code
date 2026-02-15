# Task 8: Event Ingest Endpoint

## Parallel Group: E

## Description

Implement `POST /api/events/ingest` — the HTTP endpoint that receives events from the CLI. It validates the event envelope with Zod, validates type-specific payloads, publishes to the Redis Stream, and returns quickly. This is the front door of the pipeline.

### Files to Create

**`packages/server/src/routes/events.ts`**:

`POST /api/events/ingest`:

Request body: `{ events: Event[] }` — validated by `ingestRequestSchema` from `@fuel-code/shared`.

Processing flow:
1. Parse request body with `ingestRequestSchema.parse(req.body)`. On ZodError: return `400 { error: "Validation failed", details: zodError.issues }`.
2. For each event in the batch:
   a. Validate the type-specific payload using `validateEventPayload(event.type, event.data)`.
   b. If the event type has a registered schema and validation fails: mark that event as rejected (do NOT reject the entire batch).
   c. If the event type has no registered schema: accept (forward-compatible).
   d. Set `event.ingested_at = new Date().toISOString()`.
3. Separate events into `valid` and `rejected` arrays.
4. If `valid.length > 0`: call `publishBatchToStream(redis, valid)`.
   - If Redis publish fails entirely: return `503 { error: "Event pipeline temporarily unavailable", retry_after_seconds: 30 }`.
   - If some events in the batch fail to publish (per-event failures from pipeline): add those to `rejected`.
5. Return `202`:
   ```json
   {
     "ingested": <number of successfully published>,
     "duplicates": 0,
     "rejected": <number rejected>,
     "errors": [
       { "index": 2, "error": "session.start payload validation failed: missing field 'cwd'" }
     ]
   }
   ```
   - `duplicates` is always 0 at this layer. Dedup happens downstream at Postgres INSERT (ON CONFLICT DO NOTHING). The response is optimistic.

Mount the route on the Express app in `packages/server/src/app.ts`.

**Router structure** in `events.ts`:
```typescript
import { Router } from "express";
export function createEventsRouter(deps: { redis: Redis }): Router {
  const router = Router();
  router.post("/events/ingest", async (req, res, next) => { ... });
  return router;
}
```

The router receives Redis as a dependency (injected by `app.ts`). This enables testing with mock Redis.

### Edge Cases to Handle
- Empty `events` array: rejected by `ingestRequestSchema.min(1)` → 400.
- More than 100 events: rejected by `ingestRequestSchema.max(100)` → 400.
- Event with an unknown `type` (e.g., `"custom.event"`): rejected by `eventSchema.type` enum validation → 400 for that event. **Wait — reconsider**: the EventType enum includes all known types. An unknown type fails the enum. This is correct for Phase 1. If we want forward-compatible unknown types, we'd need to relax the enum. Per CORE.md, the defined types ARE the complete list, so strict enum is correct.
- Valid event envelope but invalid type-specific payload: event is rejected, others in batch still processed.
- Redis completely unreachable: 503 for the entire batch.

### Tests

**`packages/server/src/routes/__tests__/events.test.ts`**:
Use the `createApp()` from Task 6 with a test Redis and supertest (or direct fetch against the app).
- Valid single event → 202 `{ ingested: 1, duplicates: 0 }`
- Valid batch of 5 → 202 `{ ingested: 5 }`
- Empty events array → 400
- 101 events → 400
- Event with invalid ULID id → 400
- `session.start` event with valid payload → 202
- `session.start` event with missing `cwd` in data → 202 with `rejected: 1`
- No auth header → 401
- After successful ingest, Redis stream length increases

## Relevant Files
- `packages/server/src/routes/events.ts` (create)
- `packages/server/src/app.ts` (modify — mount events router)
- `packages/server/src/routes/__tests__/events.test.ts` (create)

## Success Criteria
1. `POST /api/events/ingest` with valid auth and valid body returns 202.
2. Response includes `ingested` count matching number of valid events.
3. Response includes `rejected` count for events with invalid type-specific payloads.
4. Response includes `errors` array with index and error message for each rejected event.
5. Empty events array returns 400 (Zod min(1)).
6. More than 100 events returns 400 (Zod max(100)).
7. Event with invalid ULID id returns 400.
8. No auth header returns 401.
9. When Redis is down, returns 503 with `retry_after_seconds: 30`.
10. After successful ingest, `XLEN events:incoming` shows the events in the stream.
11. Mixed batch (2 valid + 1 invalid payload) returns 202 with `ingested: 2, rejected: 1`.
12. `duplicates` field is always 0 at this layer (dedup is downstream).
