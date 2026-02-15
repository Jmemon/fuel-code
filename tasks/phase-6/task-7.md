# Task 7: Queue Drain Robustness: Batch Isolation + Dead Letter Diagnostics

## Parallel Group: B

## Dependencies: Tasks 1, 2

## Description

Harden the CLI's local event queue drain process. The current drainer stops on the first batch failure, meaning one bad event can block the entire queue. Phase 6 introduces per-event batch isolation (using the server's per-event response to selectively remove only accepted events), dead-letter metadata envelopes with diagnostic information, and new `fuel-code queue retry` and `fuel-code queue purge` subcommands for managing problematic events.

### Current Behavior (Phase 1)

```
drain():
  1. Read batch of events from queue (up to 50)
  2. POST /api/events/ingest { events: [...] }
  3. If 200 → remove all events from queue
  4. If error → increment _attempts on all events, stop draining
  5. If any event has _attempts >= 100 → move to dead-letter
```

### New Behavior (Phase 6)

```
drain():
  1. Read batch of events from queue (up to 50)
  2. POST /api/events/ingest { events: [...] }
     Server response: { results: [{ index, status, error? }, ...] }
  3. For each result:
     - If status='accepted' → remove that event from queue
     - If status='rejected' → increment that event's _attempts
       - If _attempts >= maxAttempts (default 10, down from 100) → move to dead-letter with envelope
  4. Continue to next batch (do NOT stop on partial failure)
  5. Stop when queue is empty or all remaining events are at max attempts
```

### Dead-Letter Metadata Envelope

When an event is moved to dead-letter, wrap it in a metadata envelope:

```typescript
// packages/cli/src/lib/queue.ts

export interface DeadLetterEnvelope {
  // The original event payload
  event: FuelCodeEvent;
  // Metadata about the failure
  meta: {
    // Number of attempts before dead-lettering
    attempts: number;
    // Error message from the last failed attempt
    lastError: string;
    // Timestamp of first attempt (ISO 8601)
    firstAttemptAt: string;
    // Timestamp of dead-lettering (ISO 8601)
    deadLetteredAt: string;
    // Event file name in the queue (for traceability)
    queueFile: string;
  };
}
```

Dead-letter files change from raw event JSON to the envelope format:
- Before: `~/.fuel-code/dead-letter/{ulid}.json` containing the raw event
- After: `~/.fuel-code/dead-letter/{ulid}.json` containing a `DeadLetterEnvelope`

### Corruption Recovery

Add a pre-drain validation step that handles corrupt queue files:

```typescript
// Before processing a batch, validate each event file
for (const file of batchFiles) {
  try {
    const content = await readFile(file, 'utf-8');
    JSON.parse(content);  // Validate JSON
    // Also validate against event schema if possible
  } catch (e) {
    // Corrupt file — move to dead-letter immediately
    await moveToDeadLetter(file, {
      attempts: 0,
      lastError: `Corrupt event file: ${e.message}`,
      firstAttemptAt: new Date().toISOString(),
      deadLetteredAt: new Date().toISOString(),
      queueFile: path.basename(file),
    });
  }
}
```

### Retry with withRetry

The HTTP call within drain now uses `withRetry` (from Task 6's hardened ApiClient). But the drain itself also has batch-level retry awareness: if the entire HTTP call fails (network down), the drain pauses with backoff before trying the next batch, rather than hammering the server.

```typescript
// Batch-level flow control
async function drainWithBackoff(apiClient: ApiClient, queue: Queue, logger: pino.Logger): Promise<DrainResult> {
  let consecutiveFailures = 0;
  const maxConsecutiveFailures = 3;

  while (true) {
    const batch = await queue.readBatch(50);
    if (batch.length === 0) break;

    try {
      const result = await apiClient.ingestEvents(batch.map(b => b.event));
      consecutiveFailures = 0;
      // Process per-event results...
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        logger.warn('Drain stopped: server unreachable after 3 consecutive batch failures');
        break;
      }
      // Wait before next batch (exponential: 2s, 4s, 8s)
      await sleep(2000 * 2 ** (consecutiveFailures - 1));
    }
  }
}
```

### New CLI Subcommands

```typescript
// fuel-code queue retry [--all]
// Re-queues dead-lettered events back into the main queue for re-processing.
// --all: retry all dead-lettered events
// Without --all: interactive selection (or error if not TTY)

// fuel-code queue purge [--all] [--older-than <duration>]
// Permanently deletes dead-lettered events.
// --all: purge all dead-lettered events
// --older-than 7d: purge dead-lettered events older than 7 days
// Without flags: interactive selection (or error if not TTY)

// fuel-code queue inspect
// Lists dead-lettered events with their metadata envelopes.
// Output: table with columns: ID, Event Type, Attempts, Last Error, Dead-Lettered At
```

### DrainResult

```typescript
export interface DrainResult {
  // Events successfully sent and removed from queue
  accepted: number;
  // Events that failed and were re-queued for retry
  retried: number;
  // Events moved to dead-letter
  deadLettered: number;
  // Events that were corrupt and moved to dead-letter
  corrupt: number;
  // Whether drain stopped due to consecutive failures
  stoppedEarly: boolean;
}
```

### Error Formatting Integration

When events are dead-lettered, the drain command logs a structured warning using the error formatter:

```
⚠ 3 events moved to dead-letter queue
  Run `fuel-code queue inspect` to see details.
  Run `fuel-code queue retry` to re-process them.
```

### Relevant Files

**Modify:**
- `packages/cli/src/lib/drain.ts` — per-event batch isolation, corruption recovery, backoff on consecutive failures
- `packages/cli/src/lib/queue.ts` — `DeadLetterEnvelope` type, `moveToDeadLetter` with envelope metadata, `readDeadLetter`, `retryDeadLetter`, `purgeDeadLetter`
- `packages/cli/src/commands/queue.ts` — add `retry`, `purge`, `inspect` subcommands

**Create:**
- `packages/cli/src/lib/__tests__/drain.test.ts` (new tests for batch isolation)
- `packages/cli/src/commands/__tests__/queue-commands.test.ts` (tests for new subcommands)

### Tests

`drain.test.ts` (bun:test):

1. Batch with all events accepted → all removed from queue, `DrainResult.accepted` matches.
2. Batch with mixed results (2 accepted, 1 rejected) → 2 removed, 1 incremented `_attempts`.
3. Rejected event at max attempts → moved to dead-letter with envelope metadata.
4. Drain continues to next batch after partial failure (does not stop).
5. Three consecutive total batch failures → drain stops, `stoppedEarly: true`.
6. Backoff between consecutive failures: delays increase (verify with mock timers).
7. Corrupt event file (invalid JSON) → moved to dead-letter with `lastError: 'Corrupt event file: ...'`.
8. Corrupt event file does not block processing of valid events in same batch.
9. Empty queue → drain returns immediately with all counts at 0.
10. Dead-letter envelope contains all metadata: attempts, lastError, firstAttemptAt, deadLetteredAt, queueFile.
11. Max attempts is 10 (down from 100).

`queue.test.ts` (bun:test):

12. `moveToDeadLetter` writes `DeadLetterEnvelope` JSON (not raw event).
13. `readDeadLetter` parses envelope and returns typed `DeadLetterEnvelope`.
14. `retryDeadLetter` moves event from dead-letter back to main queue, resets attempts.
15. `purgeDeadLetter` permanently deletes the dead-letter file.
16. `queue.depths()` returns correct counts for both main queue and dead-letter.

`queue-commands.test.ts` (bun:test):

17. `fuel-code queue inspect` lists dead-lettered events with ID, type, attempts, error, timestamp.
18. `fuel-code queue retry --all` moves all dead-letter events back to queue.
19. `fuel-code queue purge --all` deletes all dead-letter events.
20. `fuel-code queue purge --older-than 7d` only deletes events dead-lettered more than 7 days ago.
21. Retry/purge with no flags and non-TTY → prints error message asking to use `--all`.

### Success Criteria

1. Drain processes events individually — accepted events removed, rejected events retried independently.
2. One bad event does not block the entire queue (per-event isolation).
3. Dead-lettered events have metadata envelopes with attempt count, last error, and timestamps.
4. Corrupt event files are detected pre-drain and moved to dead-letter without blocking.
5. Three consecutive total batch failures cause the drain to pause (not infinite loop).
6. `fuel-code queue inspect` provides visibility into dead-lettered events.
7. `fuel-code queue retry` allows re-processing of dead-lettered events.
8. `fuel-code queue purge` allows cleanup of old dead-letter events.
9. Max attempts reduced from 100 to 10 (events fail faster, don't clog the queue).
10. Drain result provides full accounting: accepted, retried, dead-lettered, corrupt, stoppedEarly.
