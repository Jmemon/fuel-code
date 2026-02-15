# Task 12: Progress Integration for Long Operations

## Parallel Group: D

## Dependencies: Tasks 4, 6

## Description

Integrate the progress indicator utility (Task 4) into all long-running CLI commands: `remote up` (provisioning), `drain` (queue processing), `backfill` (transcript parsing), and `session archive` (archival). Each command uses `createProgressReporter()` to show appropriate feedback for its operation. The progress reporter auto-detects the output mode (spinner, log, or silent) based on the terminal context.

### remote up: Provisioning Progress

Replace the existing inline polling with elapsed time with the shared progress reporter. The provisioning flow has distinct stages:

```typescript
// packages/cli/src/commands/remote-up.ts

const progress = createProgressReporter();

progress.start('Creating remote environment...');

const env = await apiClient.provisionRemote(blueprint);
progress.update('Launching EC2 instance...');

// Poll for status changes
let lastStatus = 'provisioning';
while (true) {
  const current = await apiClient.getRemoteEnv(env.id);

  if (current.status === 'ready') {
    progress.succeed(`Remote environment ready (${formatElapsed(progress.elapsedMs)})`);
    break;
  }
  if (current.status === 'error') {
    progress.fail(`Provisioning failed: ${current.metadata?.error || 'unknown error'}`);
    break;
  }

  // Update label on status change
  if (current.status !== lastStatus) {
    const labels: Record<string, string> = {
      provisioning: 'Provisioning instance...',
      // Add more status-based labels as needed
    };
    progress.update(labels[current.status] || `Status: ${current.status}...`);
    lastStatus = current.status;
  }

  // Check for shutdown signal
  if (shutdownManager.isShuttingDown) {
    progress.fail('Provisioning cancelled');
    break;
  }

  await sleep(3000); // Poll every 3 seconds
}
```

### drain: Queue Processing Progress

```typescript
// packages/cli/src/commands/drain.ts

const progress = createProgressReporter();
const { main, deadLetter } = await queue.depths();

if (main === 0) {
  console.log('Queue is empty, nothing to drain.');
  return;
}

progress.start(`Draining ${main} queued events...`);

let processed = 0;
const result = await drainWithBackoff(apiClient, queue, logger, {
  onBatchComplete: (batchResult) => {
    processed += batchResult.accepted;
    progress.update(`Draining events... ${processed}/${main} processed`);
  },
});

if (result.stoppedEarly) {
  progress.fail(`Drain stopped early: ${processed}/${main} processed, server unreachable`);
} else {
  progress.succeed(`Drain complete: ${result.accepted} accepted, ${result.deadLettered} dead-lettered`);
}
```

### backfill: Transcript Parsing Progress

```typescript
// packages/cli/src/commands/backfill.ts

const progress = createProgressReporter();
const sessions = await getSessionsNeedingBackfill();

if (sessions.length === 0) {
  console.log('No sessions need backfilling.');
  return;
}

progress.start(`Backfilling ${sessions.length} sessions...`);

let completed = 0;
for (const session of sessions) {
  await backfillSession(session);
  completed++;
  progress.update(`Backfilling sessions... ${completed}/${sessions.length}`);
}

progress.succeed(`Backfill complete: ${completed} sessions processed`);
```

### session archive: Archival Progress

This is wired in Task 13, but the progress integration pattern is defined here:

```typescript
// Used by the archival CLI command (Task 13)
export function createArchivalProgress(totalSessions: number): {
  progress: ProgressReporter;
  onSessionArchived: (sessionId: string, index: number) => void;
  onSessionSkipped: (sessionId: string, reason: string) => void;
  onSessionError: (sessionId: string, error: string) => void;
  finish: (result: BatchArchiveResult) => void;
};
```

### Callback Integration with Drain

The drain function needs a callback hook for progress updates. Add an optional `onBatchComplete` callback to the drain options:

```typescript
// packages/cli/src/lib/drain.ts

export interface DrainOptions {
  // Called after each batch is processed
  onBatchComplete?: (result: {
    accepted: number;
    rejected: number;
    deadLettered: number;
  }) => void;
}

export async function drainWithBackoff(
  apiClient: ApiClient,
  queue: Queue,
  logger: pino.Logger,
  options?: DrainOptions,
): Promise<DrainResult>;
```

### Relevant Files

**Modify:**
- `packages/cli/src/commands/remote-up.ts` — replace inline polling display with progress reporter
- `packages/cli/src/commands/drain.ts` — add progress reporter, pass `onBatchComplete` callback
- `packages/cli/src/commands/backfill.ts` — add progress reporter (if backfill command exists)
- `packages/cli/src/lib/drain.ts` — add `onBatchComplete` callback option to `drainWithBackoff`

**Create:**
- `packages/cli/src/lib/archival-progress.ts` — progress helpers for archival (used by Task 13)

### Tests

`remote-up.test.ts` updates (bun:test):

1. Provisioning shows progress with spinner (mock TTY).
2. Progress updates label on status change from polling.
3. Progress shows success message with elapsed time when ready.
4. Progress shows failure message when provisioning errors.
5. Shutdown signal → progress shows cancellation message.

`drain.test.ts` updates (bun:test):

6. Drain shows progress with event count.
7. Progress updates after each batch.
8. Progress shows completion summary (accepted, dead-lettered).
9. Early stop → progress shows failure with partial count.
10. Empty queue → no progress shown, just "nothing to drain" message.
11. `onBatchComplete` callback is called after each batch with correct counts.

`backfill.test.ts` updates (bun:test):

12. Backfill shows progress with session count.
13. Progress updates after each session.
14. No sessions to backfill → "nothing to backfill" message, no progress.

General progress tests:

15. JSON mode (--json) → no progress output (silent mode).
16. Piped output → timestamped log lines instead of spinner.
17. Progress reporter `stop()` is called in all code paths (success, failure, cancellation).

### Success Criteria

1. `remote up` shows spinner with provisioning stage labels and elapsed time.
2. `drain` shows progress with processed/total event counts.
3. `backfill` shows progress with processed/total session counts.
4. All progress output goes to stderr (doesn't interfere with piped stdout).
5. TTY mode shows animated spinner; non-TTY shows timestamped lines; `--json` is silent.
6. Progress `succeed()` and `fail()` show final status with elapsed time.
7. The drain function supports an `onBatchComplete` callback for progress updates.
8. Archival progress helpers are exported for Task 13 to consume.
9. All commands properly stop the progress reporter in every code path.
10. Existing command behavior is preserved — progress adds visual feedback without changing logic.
