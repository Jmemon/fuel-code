# Task 4: Redis Client and Stream Abstraction

## Parallel Group: C

## Description

Create the Redis connection management and Redis Streams abstraction layer. This provides: connection setup with reconnection handling, stream publishing (XADD), consumer group management, stream reading (XREADGROUP), and acknowledgment (XACK). Used by the ingest endpoint (producer) and the event consumer (reader).

### Dependencies to install
```bash
cd packages/server && bun add ioredis
```

### Files to Create

**`packages/server/src/redis/client.ts`**:
- `createRedisClient(url: string): Redis`:
  - Wraps `new Redis(url)` from ioredis.
  - Config: `maxRetriesPerRequest: 3`, `retryStrategy(times)`: exponential backoff — `Math.min(times * 100, 3000)` (100ms, 200ms, 400ms... capped at 3s). Return `null` after 20 retries to stop.
  - `connectTimeout: 5000`, `lazyConnect: true`.
  - Attach event listeners:
    - `connect`: log info "Redis connected"
    - `error`: log error "Redis error: {message}"
    - `close`: log warn "Redis connection closed"
    - `reconnecting`: log warn "Redis reconnecting (attempt {times})"
  - If `url` is empty/undefined, throw `StorageError` with code `STORAGE_REDIS_URL_MISSING`.
- `checkRedisHealth(redis: Redis): Promise<{ ok: boolean; latency_ms: number; error?: string }>`:
  - Run `PING` with 3-second timeout. Return `{ ok: true, latency_ms }` or `{ ok: false, error }`.

**`packages/server/src/redis/stream.ts`**:

Constants:
- `EVENTS_STREAM = "events:incoming"`
- `CONSUMER_GROUP = "event-processors"`
- `CONSUMER_NAME` — derived from `os.hostname() + "-" + process.pid` for uniqueness across Railway replicas

Functions:
- `ensureConsumerGroup(redis: Redis): Promise<void>`:
  - `redis.xgroup("CREATE", EVENTS_STREAM, CONSUMER_GROUP, "$", "MKSTREAM")`
  - Catch error where message includes `BUSYGROUP` — silently ignore (group already exists, expected on restart).
  - Any other error: rethrow as `StorageError`.

- `publishToStream(redis: Redis, event: Event): Promise<string>`:
  - `redis.xadd(EVENTS_STREAM, "*", "event", JSON.stringify(event))`
  - Returns the Redis stream entry ID.
  - On error: wrap in `StorageError` with context `{ eventId: event.id, eventType: event.type }`.

- `publishBatchToStream(redis: Redis, events: Event[]): Promise<BatchPublishResult>`:
  - `BatchPublishResult = { succeeded: Array<{ eventId: string; streamId: string }>; failed: Array<{ eventId: string; error: string }> }`
  - Use ioredis pipeline for efficiency: `redis.pipeline()`, add all XADD commands, `exec()`.
  - Parse pipeline results: each result is `[error, streamId]`. Separate into succeeded/failed.
  - If a single event fails to serialize (e.g., circular JSON), catch per-event, don't fail the batch.

- `readFromStream(redis: Redis, count: number, blockMs: number): Promise<StreamEntry[]>`:
  - `StreamEntry = { streamId: string; event: Event }`
  - `redis.xreadgroup("GROUP", CONSUMER_GROUP, CONSUMER_NAME, "COUNT", count, "BLOCK", blockMs, "STREAMS", EVENTS_STREAM, ">")`
  - Parse the nested ioredis response format into `StreamEntry[]`.
  - Return empty array if XREADGROUP returns null (no new messages within block timeout).
  - On parse failure for an individual entry: log warning, skip that entry, still return others.

- `acknowledgeEntry(redis: Redis, streamId: string): Promise<void>`:
  - `redis.xack(EVENTS_STREAM, CONSUMER_GROUP, streamId)`

- `claimPendingEntries(redis: Redis, minIdleMs: number, count: number): Promise<StreamEntry[]>`:
  - Used on consumer startup to reclaim entries from crashed consumers.
  - `redis.xautoclaim(EVENTS_STREAM, CONSUMER_GROUP, CONSUMER_NAME, minIdleMs, "0-0", "COUNT", count)`
  - Parse results into `StreamEntry[]`.
  - If XAUTOCLAIM is not available (older Redis), fall back to XPENDING + XCLAIM.

### Tests

**`packages/server/src/redis/__tests__/stream.test.ts`**:
- Publish event, verify stream length increases
- Publish batch of 5, verify all in stream
- Read after publish returns the events
- Acknowledge removes from pending
- Ensure consumer group is idempotent (call twice, no error)
- Batch with one bad event: 4 succeed, 1 reported as failed

## Relevant Files
- `packages/server/src/redis/client.ts` (create)
- `packages/server/src/redis/stream.ts` (create)
- `packages/server/src/redis/__tests__/stream.test.ts` (create)

## Success Criteria
1. `publishToStream(redis, event)` adds a message to `events:incoming`. Verifiable: `redis.xlen("events:incoming")` increases by 1.
2. `publishBatchToStream` with 5 valid events produces 5 stream entries.
3. `readFromStream` after publishing returns the published events with correct `streamId` and parsed `event`.
4. `acknowledgeEntry` removes the entry from the pending list (`XPENDING` count decreases).
5. `ensureConsumerGroup` called twice does not error.
6. When Redis is unreachable, `publishToStream` throws `StorageError` within 5 seconds.
7. `checkRedisHealth` returns `{ ok: false }` when Redis is down.
8. `publishBatchToStream` with one malformed event succeeds for the others and reports the failure.
9. `claimPendingEntries` reclaims entries idle for > N ms.
10. The consumer name includes hostname and PID (unique per process).
11. Redis connection URL is not logged (only connection status).
