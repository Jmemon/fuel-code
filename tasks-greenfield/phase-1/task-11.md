# Task 11: Wire Redis Consumer to Event Processor

## Parallel Group: F

## Description

Create the consumer loop that reads events from the Redis Stream and dispatches them to the event processor. Wire it into the server's startup sequence so it starts automatically on boot. This is the bridge between "event published to Redis" and "event processed into Postgres."

### Files to Create

**`packages/server/src/pipeline/consumer.ts`**:

```typescript
interface ConsumerDeps {
  redis: Redis;
  sql: postgres.Sql;
  registry: EventHandlerRegistry;
  logger: pino.Logger;
}

interface ConsumerHandle {
  stop(): Promise<void>;
}
```

- `startConsumer(deps: ConsumerDeps): ConsumerHandle`:
  - Creates the consumer loop. Returns a handle with `stop()` for graceful shutdown.

  **Startup**:
  1. Call `ensureConsumerGroup(redis)` (idempotent).
  2. Reclaim pending entries from crashed consumers: call `claimPendingEntries(redis, 60_000, 100)` — claim entries idle for > 60 seconds. Process these first before reading new ones.

  **Main loop**:
  1. `readFromStream(redis, count=10, blockMs=5000)` — read up to 10 new messages, block for 5s if none.
  2. For each `StreamEntry`:
     a. Parse the event from the stream entry.
     b. Call `processEvent(sql, event, registry, logger)`.
     c. On success: `acknowledgeEntry(redis, entry.streamId)`.
     d. On error:
        - Log the error with full context (event ID, type, error message).
        - Track failure count per stream entry (in-memory map).
        - If failed < 3 times: do NOT acknowledge. The entry stays pending and will be retried (via the claim logic on next restart, or on the next loop iteration if we add pending re-read).
        - If failed >= 3 times: acknowledge the entry (prevent infinite retry loop) and log at error level: "Event {id} permanently failed after 3 attempts: {error}". The event is lost from the stream but was likely never persisted to Postgres.
  3. Check `shouldStop` flag. If true, exit loop.
  4. If `readFromStream` returns empty (no new messages), loop back (the BLOCK handles the wait).

  **Periodic logging** (every 60 seconds):
  - Log at info level: "Consumer stats: {processed} processed, {duplicates} duplicates, {errors} errors, {pending} pending"

  **`stop()` method**:
  - Sets `shouldStop = true`.
  - Waits for the current loop iteration to complete (up to 10 seconds).
  - Returns once the loop has exited.

  **Error handling in the loop itself** (not per-event, but the loop crashing):
  - If `readFromStream` throws (Redis connection lost): log error, wait 5 seconds, retry.
  - The loop must not crash the server process. All errors are caught and retried.

**`packages/server/src/pipeline/wire.ts`**:

- `createEventHandler(sql: postgres.Sql, logger: pino.Logger): { registry: EventHandlerRegistry; process: (event: Event) => Promise<ProcessResult> }`:
  - Creates the handler registry via `createHandlerRegistry()` from `@fuel-code/core`.
  - Returns a wrapped `process` function that calls `processEvent` with all dependencies.
  - This indirection keeps the consumer decoupled from core internals.

**Modify `packages/server/src/index.ts`** (from Task 6):
- After migrations and Redis setup:
  ```typescript
  // Start event processor consumer
  const { registry } = createEventHandler(sql, logger);
  const consumer = startConsumer({ redis, sql, registry, logger });
  logger.info({ registeredHandlers: registry.listRegisteredTypes() }, "Event consumer started");
  ```
- In shutdown handler: `await consumer.stop()`.

### Tests

**`packages/server/src/pipeline/__tests__/consumer.test.ts`** (requires Redis + Postgres):
- Publish event to stream → consumer processes it → event appears in Postgres events table
- Publish `session.start` → session row created in sessions table
- Publish duplicate event → only one row in events table
- `stop()` causes consumer to exit within 10 seconds
- Consumer survives a temporary Redis disconnection (reconnects and continues)

## Relevant Files
- `packages/server/src/pipeline/consumer.ts` (create)
- `packages/server/src/pipeline/wire.ts` (create)
- `packages/server/src/index.ts` (modify — start consumer on boot, stop on shutdown)
- `packages/server/src/pipeline/__tests__/consumer.test.ts` (create)

## Success Criteria
1. Server boots and consumer starts reading from Redis stream. Log message: "Event consumer started".
2. Publishing an event to the Redis stream results in a new row in the `events` table within 10 seconds.
3. A `session.start` event creates both an event row AND a session row.
4. Duplicate events (same ULID) result in exactly one row in events (consumer returns `duplicate`).
5. If Postgres is temporarily down, the consumer retries without crashing. Events are processed once Postgres recovers.
6. If a handler throws, the event is persisted but the handler error is logged.
7. `consumer.stop()` causes the loop to exit cleanly within 10 seconds.
8. After 3 failures for the same stream entry, it is acknowledged (not infinite retry).
9. On startup, pending entries from crashed consumers are reclaimed and reprocessed.
10. Consumer survives Redis reconnection (ioredis auto-reconnects, consumer resumes).
11. Periodic stats are logged every 60 seconds.
12. Registered handler types are logged on startup.
