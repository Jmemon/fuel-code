# Task 12: Queue Drainer

## Parallel Group: F

## Description

Build the queue drainer that flushes locally queued events to the backend. Two modes: foreground (user runs `fuel-code queue drain`) and background (spawned by `fuel-code emit` after queuing an event). Handles batch posting, retry tracking, dead-lettering, and concurrent drain prevention via lockfile.

### Files to Create

**`packages/cli/src/lib/drain.ts`**:

```typescript
interface DrainResult {
  drained: number;
  duplicates: number;
  remaining: number;
  deadLettered: number;
  errors: string[];
}

interface DrainOptions {
  foreground?: boolean;  // if true, log progress to stdout
  maxBatches?: number;   // limit number of batches (for testing)
}
```

- `drainQueue(config: FuelCodeConfig, options?: DrainOptions): Promise<DrainResult>`:
  1. Read all queued events via `listQueuedEvents()`. If empty: return `{ drained: 0, ... }`.
  2. Create API client from config.
  3. Batch into groups of `config.pipeline.batch_size` (default 50).
  4. For each batch:
     a. Read each event file via `readQueuedEvent()`. Skip corrupted files (null return) — move to dead letter immediately.
     b. POST batch to `/api/events/ingest` with 10-second timeout (drainer is not latency-sensitive).
     c. On 202: delete each successfully ingested event file. Track `drained` and `duplicates` from response.
     d. On 503/timeout: stop processing. Return with remaining count and error.
     e. On 401: stop processing. Return error "Invalid API key."
     f. On network error: stop processing. Return error.
  5. **Attempt tracking**: Each event JSON file may have an `_attempts` field. On failed drain (per-event, not per-batch), increment `_attempts` by rewriting the file. If `_attempts >= 100`: move to dead-letter directory.
  6. If `foreground`: print progress to stdout (`Draining: 5/23 events...`).

- `addAttempt(filePath: string): number`:
  - Read event JSON, increment `_attempts` (default 0 → 1), rewrite file atomically.
  - Return new attempt count.

**`packages/cli/src/lib/drain-background.ts`**:

- `spawnBackgroundDrain(config: FuelCodeConfig): void`:
  - Called by `fuel-code emit` after queuing an event.
  - Uses `Bun.spawn` to start a detached background process.
  - The background process: wait 1 second (debounce — accumulate a few events if hooks fire rapidly), then call `drainQueue`, then exit.
  - **Lockfile**: `~/.fuel-code/.drain.lock` prevents concurrent drains.
    - Before draining: check if lockfile exists and contains a valid PID (process is still running). If so, skip (another drain is running).
    - If lockfile exists but PID is dead (stale): remove lockfile and proceed.
    - Create lockfile with current PID before draining. Remove after.
  - **Silent**: redirect stdout and stderr to `/dev/null` (or `~/.fuel-code/drain.log`). The background process must not produce output that could confuse CC hooks.

**`packages/cli/src/commands/queue.ts`**:

`fuel-code queue` command group:

- `fuel-code queue status`:
  - Print queue depth (`getQueueDepth()`).
  - Print dead-letter depth (`getDeadLetterDepth()`).
  - Print oldest event timestamp (from ULID of first file).
  - Example output:
    ```
    Queue:       3 events pending
    Dead letter: 0 events
    Oldest:      2 minutes ago
    ```

- `fuel-code queue drain`:
  - Run `drainQueue(config, { foreground: true })`.
  - Print results:
    ```
    Drained: 5 events (2 duplicates)
    Remaining: 0
    Dead-lettered: 1
    ```

- `fuel-code queue dead-letter`:
  - List files in dead-letter directory.
  - For each: print event ID, type, timestamp, and attempt count.

### Tests

**`packages/cli/src/lib/__tests__/drain.test.ts`**:
- Drain with 5 queued events + running backend: all 5 drained, queue empty
- Drain with dead backend: 0 drained, all remain in queue
- Corrupted queue file: moved to dead-letter, others still drain
- Event with 100 attempts: moved to dead-letter
- Lockfile prevents concurrent drains

## Relevant Files
- `packages/cli/src/lib/drain.ts` (create)
- `packages/cli/src/lib/drain-background.ts` (create)
- `packages/cli/src/commands/queue.ts` (create)
- `packages/cli/src/index.ts` (modify — register queue command)
- `packages/cli/src/lib/__tests__/drain.test.ts` (create)

## Success Criteria
1. Queuing 5 events offline, then `fuel-code queue drain` with running backend: 5 drained, 0 remaining, queue dir empty.
2. `fuel-code queue drain` with dead backend: 0 drained, 5 remaining, error message.
3. Corrupted queue file (invalid JSON): moved to dead-letter, other events still drain.
4. Event with `_attempts >= 100`: moved to dead-letter on next drain attempt.
5. `fuel-code queue status` shows correct counts.
6. `spawnBackgroundDrain` starts a process and returns immediately (< 100ms).
7. Two simultaneous `spawnBackgroundDrain` calls: only one drains (lockfile prevents second).
8. Background drain produces no stdout/stderr output.
9. Lockfile with dead PID (stale) is cleaned up and drain proceeds.
10. `fuel-code queue dead-letter` lists dead-lettered events with their metadata.
11. Partial batch drain: if 3 of 5 events succeed and 2 fail, only the 3 are removed from queue.
12. Attempt counter increments on each failed drain pass.
