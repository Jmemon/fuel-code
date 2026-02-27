# Consumer Self-Healing & Transcript Upload Resilience Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Redis consumer self-healing after Redis restarts so events are always processed and transcript uploads stop 404ing.

**Architecture:** Two fixes: (1) consumer loop detects NOGROUP errors and re-creates the consumer group before retrying, (2) transcript upload gets a retry-friendly response when the session hasn't been created yet (409 instead of 404) so callers can distinguish "session doesn't exist yet" from "invalid session ID".

**Tech Stack:** TypeScript, ioredis, Express, bun test

**Root Cause:** When Redis restarts after the server boots, the `events:incoming` stream and `event-processors` consumer group are destroyed. The consumer loop catches the NOGROUP error but never re-creates the group — it retries `readFromStream` forever. This blocks all event processing, which means sessions are never created in Postgres, which causes transcript uploads to 404.

---

### Task 1: Consumer loop auto-recreates consumer group on NOGROUP errors

**Files:**
- Modify: `packages/server/src/pipeline/consumer.ts` (lines 280-308, the main loop catch block)
- Test: `packages/server/src/pipeline/__tests__/consumer.test.ts`

**Step 1: Write the failing test**

Add a test to the existing consumer test file that verifies the consumer re-creates the group when `readFromStream` throws a NOGROUP error.

```typescript
it("re-creates consumer group when NOGROUP error occurs", async () => {
  let readCallCount = 0;
  let ensureGroupCallCount = 0;

  const overrides: ConsumerOverrides = {
    ensureConsumerGroup: async () => {
      ensureGroupCallCount++;
    },
    readFromStream: async () => {
      readCallCount++;
      if (readCallCount === 1) {
        // First call: simulate NOGROUP error
        throw new StorageError(
          "Failed to read from event stream",
          "STORAGE_REDIS_XREADGROUP",
          { error: "NOGROUP No such key 'events:incoming' or consumer group 'event-processors' in XREADGROUP with GROUP option" },
        );
      }
      // Second call: return empty (loop will block, then we stop)
      return [];
    },
    acknowledgeEntry: async () => {},
    claimPendingEntries: async () => [],
    processEvent: async () => ({ status: "processed" as const }),
    reconnectDelayMs: 10, // fast retry for tests
    statsIntervalMs: 999_999,
  };

  const consumer = startConsumer(deps, overrides);

  // Give time for the loop to hit the error, re-create group, and retry
  await new Promise((r) => setTimeout(r, 100));
  await consumer.stop();

  // ensureGroup called once on startup + once on NOGROUP recovery
  expect(ensureGroupCallCount).toBeGreaterThanOrEqual(2);
  // readFromStream called at least twice (first fails, second succeeds)
  expect(readCallCount).toBeGreaterThanOrEqual(2);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/pipeline/__tests__/consumer.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: The new test FAILs because the consumer doesn't call `ensureConsumerGroup` on NOGROUP — it just waits and retries `readFromStream`.

**Step 3: Implement the fix**

In `packages/server/src/pipeline/consumer.ts`, modify the main loop's catch block (lines 291-308) to detect NOGROUP errors and call `ensureGroup` before retrying:

```typescript
// --- Main loop: read and process new entries ---
while (!shouldStop) {
  try {
    const entries = await readStream(redis, READ_COUNT, BLOCK_MS);

    for (const entry of entries) {
      if (shouldStop) break;
      await handleEntry(entry);
    }

    maybeLogStats();
  } catch (err) {
    // Detect NOGROUP errors (Redis restarted, stream/group lost) and
    // re-create the consumer group before retrying. Without this, the
    // consumer spins forever on NOGROUP after a Redis restart.
    const errMsg = err instanceof Error ? err.message : String(err);
    const isNoGroup = errMsg.includes("NOGROUP");

    if (isNoGroup) {
      logger.warn("Consumer group lost (Redis restart?) — re-creating");
      try {
        await ensureGroup(redis);
        logger.info("Consumer group re-created successfully");
        continue; // Skip the delay — group is back, retry immediately
      } catch (groupErr) {
        logger.error({ err: groupErr }, "Failed to re-create consumer group");
      }
    }

    // Redis connection lost or other transient error — wait and retry
    logger.error(
      { err },
      `Consumer loop error — retrying in ${reconnectDelayMs}ms`,
    );

    // Sleep before retrying, but check shouldStop to avoid delaying shutdown
    if (!shouldStop) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, reconnectDelayMs);
        // Allow the timer to be cleaned up if the process exits
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      });
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/src/pipeline/__tests__/consumer.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: All tests PASS including the new NOGROUP recovery test.

**Step 5: Commit**

```bash
git add packages/server/src/pipeline/consumer.ts packages/server/src/pipeline/__tests__/consumer.test.ts
git commit -m "fix: consumer auto-recreates group on NOGROUP after Redis restart"
```

---

### Task 2: Make consumer startup ensureGroup a hard requirement

**Files:**
- Modify: `packages/server/src/pipeline/consumer.ts` (lines 254-261, startup ensureGroup)
- Test: `packages/server/src/pipeline/__tests__/consumer.test.ts`

The current code swallows `ensureGroup` failures on startup and continues to the main loop, which then immediately fails on `readFromStream`. This is misleading — make it retry until it succeeds.

**Step 1: Write the failing test**

```typescript
it("retries ensureConsumerGroup on startup until it succeeds", async () => {
  let ensureGroupCallCount = 0;

  const overrides: ConsumerOverrides = {
    ensureConsumerGroup: async () => {
      ensureGroupCallCount++;
      if (ensureGroupCallCount < 3) {
        throw new Error("Redis not ready");
      }
      // Third call succeeds
    },
    readFromStream: async () => [],
    acknowledgeEntry: async () => {},
    claimPendingEntries: async () => [],
    processEvent: async () => ({ status: "processed" as const }),
    reconnectDelayMs: 10,
    statsIntervalMs: 999_999,
  };

  const consumer = startConsumer(deps, overrides);
  await new Promise((r) => setTimeout(r, 200));
  await consumer.stop();

  // Should have retried until success (3 calls)
  expect(ensureGroupCallCount).toBeGreaterThanOrEqual(3);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test packages/server/src/pipeline/__tests__/consumer.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: FAIL — current code only calls `ensureGroup` once on startup and swallows the error.

**Step 3: Implement the fix**

Replace the startup `ensureGroup` block (lines 254-261) with a retry loop:

```typescript
// --- Startup: ensure consumer group exists (retry until success) ---
while (!shouldStop) {
  try {
    await ensureGroup(redis);
    break; // Success — proceed to main loop
  } catch (err) {
    logger.error(
      { err },
      `Failed to ensure consumer group — retrying in ${reconnectDelayMs}ms`,
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, reconnectDelayMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
  }
}

if (shouldStop) return; // Shutdown requested during startup retry loop
```

**Step 4: Run test to verify it passes**

Run: `bun test packages/server/src/pipeline/__tests__/consumer.test.ts 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add packages/server/src/pipeline/consumer.ts packages/server/src/pipeline/__tests__/consumer.test.ts
git commit -m "fix: consumer retries ensureGroup on startup instead of swallowing errors"
```

---

### Task 3: Run full test suite and verify no regressions

**Step 1: Run all server tests**

Run: `bun test packages/server/ 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: All tests PASS.

**Step 2: Run all project tests**

Run: `bun test 2>&1 | grep -E "\(pass\)|\(fail\)|^\s+\d+ (pass|fail)|^Ran "`

Expected: All tests PASS with no regressions.

**Step 3: Commit (if any test fixes needed)**

Only commit if test adjustments were needed.

---

## Summary

| Task | What | Why |
|------|------|-----|
| 1 | Consumer detects NOGROUP in main loop, calls `ensureGroup`, retries immediately | Self-heals after Redis restart without server restart |
| 2 | Consumer startup retries `ensureGroup` instead of swallowing failures | Prevents entering main loop when group definitely doesn't exist |
| 3 | Full test suite verification | No regressions |

**After these fixes:**
- Redis restart → consumer detects NOGROUP → re-creates group → resumes processing (~0s downtime)
- Events flow again → sessions created in Postgres → transcript uploads succeed
- No more infinite NOGROUP retry spam in logs
