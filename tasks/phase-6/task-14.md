# Task 14: Phase 6 E2E Integration Tests

## Parallel Group: F

## Dependencies: Tasks 5, 6, 7, 8, 9, 10, 11, 12, 13

## Description

Write end-to-end integration tests that verify all Phase 6 features work together as a cohesive system. These tests exercise the full stack — CLI commands calling the API, the API calling services with retries, queue operations, archival with S3 interaction, and EC2 orphan detection. All external services (AWS EC2, S3, external network) are mocked at the boundary, but the tests run through the real code paths from CLI command to database.

The tests are organized into test suites by feature area, each verifying cross-cutting concerns like retry behavior under failure, error message formatting, progress output, and Ctrl-C handling.

### Test Infrastructure

```typescript
// packages/e2e/src/helpers/test-server.ts (extend existing E2E helpers)

// Start a real Express server with mock AWS clients
export async function createTestServer(): Promise<{
  url: string;
  sql: postgres.Sql;
  mockEc2: MockEc2Client;
  mockS3: MockS3Client;
  close: () => Promise<void>;
}>;

// Create a temporary queue directory for testing
export async function createTestQueue(): Promise<{
  queueDir: string;
  deadLetterDir: string;
  cleanup: () => Promise<void>;
}>;

// Capture CLI output (stdout, stderr) for assertion
export async function runCli(args: string[], options?: {
  env?: Record<string, string>;
  stdin?: string;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;
```

### Test Suite 1: Retry Integration

```
retry-integration.test.ts:

1. HTTP transport retries on 503, succeeds on second attempt.
   Setup: Start test server that returns 503 once then 200.
   Execute: Call any API endpoint via CLI.
   Verify: Command succeeds, retry logged at debug level.

2. HTTP transport retries exhausted → queue fallback for events.
   Setup: Start test server that always returns 503.
   Execute: Emit an event via CLI.
   Verify: Event appears in local queue, not in Postgres.

3. HTTP transport retries exhausted → error message for non-event endpoints.
   Setup: Start test server that always returns 503.
   Execute: `fuel-code session ls`.
   Verify: Error output matches Error/Cause/Fix format.

4. EC2 client retries on ThrottlingException.
   Setup: MockEc2Client returns ThrottlingException once then success.
   Execute: Trigger provisioning via API.
   Verify: Provisioning succeeds, retry logged.

5. S3 client retries on InternalError.
   Setup: MockS3Client returns InternalError once then success.
   Execute: Trigger archival.
   Verify: Archival succeeds.
```

### Test Suite 2: Queue Drain Robustness

```
queue-drain-e2e.test.ts:

6. Mixed batch: 2 accepted, 1 rejected → 2 removed, 1 retried.
   Setup: Queue 3 events. Server accepts events 1 and 3, rejects event 2.
   Execute: `fuel-code drain`.
   Verify: Queue has 1 event, 2 were sent to Postgres.

7. Corrupt event in queue → moved to dead-letter, others processed.
   Setup: Queue 3 events, one with invalid JSON.
   Execute: `fuel-code drain`.
   Verify: Corrupt event in dead-letter with envelope metadata. Other 2 in Postgres.

8. Event exceeds max attempts → dead-lettered with envelope.
   Setup: Queue 1 event with _attempts = 9. Server rejects it.
   Execute: `fuel-code drain`.
   Verify: Event in dead-letter with envelope showing attempts=10, lastError.

9. `fuel-code queue inspect` shows dead-lettered events.
   Setup: Dead-letter directory has 2 enveloped events.
   Execute: `fuel-code queue inspect`.
   Verify: Output shows table with ID, Type, Attempts, Error, Timestamp.

10. `fuel-code queue retry --all` moves events back to queue.
    Setup: Dead-letter has 2 events.
    Execute: `fuel-code queue retry --all`.
    Verify: Main queue has 2 events, dead-letter is empty.

11. `fuel-code queue purge --all` deletes dead-letter events.
    Setup: Dead-letter has 2 events.
    Execute: `fuel-code queue purge --all`.
    Verify: Dead-letter directory is empty.
```

### Test Suite 3: Error Message Formatting

```
error-messages-e2e.test.ts:

12. Network error → Error/Cause/Fix format in TTY mode.
    Setup: Server not running.
    Execute: `fuel-code session ls` (with TTY mock).
    Verify: stderr contains "Error:", "Cause:", "Fix:" on separate lines.

13. Auth error → correct error code and fix message.
    Setup: Server running, invalid API key.
    Execute: `fuel-code session ls`.
    Verify: Output mentions checking API key.

14. Error in piped mode → single-line pipe-delimited format.
    Setup: Server not running.
    Execute: `fuel-code session ls` (non-TTY).
    Verify: stderr is single line with pipe-delimited fields, no ANSI codes.

15. Error in JSON mode → structured JSON error.
    Setup: Server not running.
    Execute: `fuel-code session ls --json`.
    Verify: stderr is valid JSON with error.message, error.code, error.cause, error.fix.
```

### Test Suite 4: Session Archival End-to-End

```
archival-e2e.test.ts:

16. Archive a summarized session → data removed from Postgres, backup in S3.
    Setup: Create session, add transcript messages, mark as summarized.
    Execute: `fuel-code session archive --session <id>`.
    Verify: Session lifecycle is 'archived'. transcript_messages count is 0. S3 has parsed.json.

17. Restore an archived session → data re-inserted from S3.
    Setup: Archive a session (from test 16 state).
    Execute: `fuel-code session <id> --restore`.
    Verify: Session lifecycle is 'summarized'. transcript_messages count matches original.

18. Archive with integrity mismatch → aborted, data preserved.
    Setup: Session with 10 messages. S3 backup has 8 messages (simulate corruption).
    Execute: `fuel-code session archive --session <id>`.
    Verify: Error about integrity mismatch. Session still 'summarized'. All 10 messages still in Postgres.

19. Batch archive → processes multiple sessions.
    Setup: 3 summarized sessions older than 30 days, 1 younger.
    Execute: `fuel-code session archive --min-age 30`.
    Verify: 3 archived, 1 untouched. Output shows progress and summary.

20. Archived session in `session ls` → hidden by default, visible with --all.
    Setup: Mix of active, summarized, and archived sessions.
    Execute: `fuel-code session ls` then `fuel-code session ls --all`.
    Verify: First command excludes archived. Second includes them with distinct display.

21. Archived session detail → shows archive notice.
    Execute: `fuel-code session <archived-id>`.
    Verify: Output includes "This session is archived" and restore hint.
```

### Test Suite 5: EC2 Orphan Detection

```
orphan-detection-e2e.test.ts:

22. Instance passes all 5 checks → terminated as orphan.
    Setup: MockEc2 has instance with valid tags, >15min old, no DB record.
    Execute: Trigger orphan sweep via lifecycle enforcer.
    Verify: Instance terminated, logged as orphan.

23. Instance within grace period → not terminated.
    Setup: MockEc2 has instance with fuel-code:created-at = 5 minutes ago.
    Execute: Trigger orphan sweep.
    Verify: Instance NOT terminated, logged as skipped.

24. Instance with active session → not terminated.
    Setup: MockEc2 has instance. DB has matching env with active session.
    Execute: Trigger orphan sweep.
    Verify: Instance NOT terminated.

25. Instance with invalid ULID tag → skipped.
    Setup: MockEc2 has instance with fuel-code:remote-env-id = 'not-a-ulid'.
    Execute: Trigger orphan sweep.
    Verify: Instance NOT terminated, warning logged.

26. Atomic tagging: launched instance has all tags from birth.
    Setup: Provision a remote env via API.
    Verify: MockEc2 received RunInstances with TagSpecifications containing all 5 tags.
```

### Test Suite 6: Ctrl-C / Shutdown

```
shutdown-e2e.test.ts:

27. Ctrl-C during `remote up` → environment terminated, cleanup message shown.
    Setup: Start provisioning. Mock EC2 to delay in waitForRunning.
    Execute: `fuel-code remote up`, send SIGINT during polling.
    Verify: Terminate endpoint called. stderr shows "Shutting down..." and cleanup messages.

28. Ctrl-C during `drain` → drain stops, lock released.
    Setup: Queue 100 events. Start drain.
    Execute: Send SIGINT during drain.
    Verify: Drain stops. Lock file removed. Partially processed events removed from queue.

29. Double Ctrl-C → force exit.
    Setup: Start provisioning with slow cleanup mock.
    Execute: Send SIGINT, then SIGINT again during cleanup.
    Verify: Process exits immediately.
```

### Test Suite 7: Cost + Progress Integration

```
cost-progress-e2e.test.ts:

30. `blueprint show` includes cost estimate.
    Setup: Blueprint with t3.xlarge.
    Execute: `fuel-code blueprint show`.
    Verify: Output contains "~$0.17/hr" and 8hr/24hr estimates.

31. `remote ls` includes cost columns.
    Setup: Running remote env with t3.xlarge, 2 hours uptime.
    Execute: `fuel-code remote ls`.
    Verify: Output contains Rate and Accrued columns with correct values.

32. Progress spinner in TTY mode.
    Execute: `fuel-code drain` with TTY mock and events in queue.
    Verify: stderr contains spinner characters and elapsed time formatting.

33. Progress log lines in piped mode.
    Execute: `fuel-code drain` (non-TTY) with events in queue.
    Verify: stderr contains timestamped lines like "[HH:MM:SS] Draining events..."
```

### Relevant Files

**Create:**
- `packages/e2e/src/phase-6/retry-integration.test.ts`
- `packages/e2e/src/phase-6/queue-drain-e2e.test.ts`
- `packages/e2e/src/phase-6/error-messages-e2e.test.ts`
- `packages/e2e/src/phase-6/archival-e2e.test.ts`
- `packages/e2e/src/phase-6/orphan-detection-e2e.test.ts`
- `packages/e2e/src/phase-6/shutdown-e2e.test.ts`
- `packages/e2e/src/phase-6/cost-progress-e2e.test.ts`

**Modify:**
- `packages/e2e/src/helpers/test-server.ts` — add MockS3Client setup, archival engine wiring
- `packages/e2e/src/helpers/test-queue.ts` — create temporary queue/dead-letter directories (if not already)

### Tests

All 33 test cases listed above.

### Success Criteria

1. All 33 E2E tests pass with mocked AWS services and a real Postgres database.
2. Retry integration tests verify end-to-end retry behavior from CLI through to service layer.
3. Queue drain tests verify per-event isolation, corruption recovery, and dead-letter management.
4. Error message tests verify the Error/Cause/Fix format in all three output modes.
5. Archival tests verify the full archive → restore lifecycle with integrity verification.
6. Orphan detection tests verify all 5 checks prevent false-positive termination.
7. Shutdown tests verify Ctrl-C cleanup and double-Ctrl-C force quit.
8. Cost and progress tests verify user-facing output formatting.
9. Tests are organized by feature area for maintainability.
10. No tests depend on real AWS credentials — all AWS interactions are mocked.
