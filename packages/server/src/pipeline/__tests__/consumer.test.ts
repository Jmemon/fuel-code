/**
 * Unit tests for the Redis Stream consumer loop.
 *
 * All tests are mock-based — no live Redis or Postgres needed. The consumer
 * accepts a ConsumerOverrides parameter that replaces the real stream/processor
 * functions with test mocks.
 *
 * IMPORTANT: readFromStream mocks must always include a small delay (setTimeout)
 * so the consumer loop yields to the macrotask queue. Without this, the tight
 * while-loop on synchronously-resolved promises starves setTimeout callbacks
 * (like sleep()) and tests hang indefinitely.
 */

import { describe, test, expect, mock } from "bun:test";
import type { Event } from "@fuel-code/shared";
import type { ProcessResult, EventHandlerRegistry } from "@fuel-code/core";
import type { StreamEntry } from "../../redis/stream.js";
import {
  startConsumer,
  type ConsumerDeps,
  type ConsumerOverrides,
} from "../consumer.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock Event */
function makeMockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt-test-001",
    type: "session.start",
    timestamp: "2025-01-01T00:00:00.000Z",
    device_id: "device-1",
    workspace_id: "ws-1",
    session_id: "session-1",
    data: { cwd: "/test" },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/** Create a no-op Pino-like logger with mock spy methods */
function createMockLogger() {
  const logger: any = {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
    fatal: mock(() => {}),
    child: mock(() => logger),
  };
  return logger;
}

/** Build ConsumerDeps with stub dependencies */
function createDeps(loggerOverride?: any): ConsumerDeps {
  return {
    redis: {} as any,
    sql: {} as any,
    registry: {
      listRegisteredTypes: () => ["session.start", "session.end"],
    } as unknown as EventHandlerRegistry,
    logger: loggerOverride ?? createMockLogger(),
  };
}

/** Small delay to yield to the event loop */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns a readFromStream-shaped promise that resolves after a small delay.
 * This prevents the consumer loop from spinning on synchronous microtasks.
 */
function delayedResolve<T>(value: T, ms = 15): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Create a standard set of mock overrides.
 * readFromStream always includes a small delay to prevent busy loops.
 */
function createOverrides() {
  const _ensureConsumerGroup = mock(() => Promise.resolve());
  const _readFromStream = mock(() => delayedResolve([] as StreamEntry[]));
  const _acknowledgeEntry = mock(() => Promise.resolve());
  const _claimPendingEntries = mock(() => Promise.resolve([] as StreamEntry[]));
  const _processEvent = mock(() =>
    Promise.resolve({
      eventId: "test",
      status: "processed" as const,
      handlerResults: [],
    } as ProcessResult),
  );

  return {
    ensureConsumerGroup: _ensureConsumerGroup as any,
    readFromStream: _readFromStream as any,
    acknowledgeEntry: _acknowledgeEntry as any,
    claimPendingEntries: _claimPendingEntries as any,
    processEvent: _processEvent as any,
    reconnectDelayMs: 30,
    statsIntervalMs: 80,
    // Expose raw mocks for assertions
    _ensureConsumerGroup,
    _readFromStream,
    _acknowledgeEntry,
    _claimPendingEntries,
    _processEvent,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consumer — entry processing", () => {
  test("processes entries returned by readFromStream and acknowledges them", async () => {
    const event = makeMockEvent({ id: "evt-1" });
    const overrides = createOverrides();
    let callCount = 0;

    overrides._readFromStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return delayedResolve([{ streamId: "1000-0", event }] as StreamEntry[]);
      }
      return delayedResolve([] as StreamEntry[]);
    });

    overrides._processEvent.mockImplementation(() =>
      Promise.resolve({
        eventId: "evt-1",
        status: "processed" as const,
        handlerResults: [],
      }),
    );

    const deps = createDeps();
    const consumer = startConsumer(deps, overrides);

    await sleep(200);
    await consumer.stop();

    // processEvent should have been called with the event
    expect(overrides._processEvent).toHaveBeenCalled();
    const processCall = overrides._processEvent.mock.calls[0];
    expect(processCall[1]).toEqual(event);

    // acknowledgeEntry should have been called with the stream ID
    expect(overrides._acknowledgeEntry).toHaveBeenCalled();
    const ackCall = overrides._acknowledgeEntry.mock.calls[0];
    expect(ackCall[1]).toBe("1000-0");
  });

  test("duplicate events (processEvent returns 'duplicate') are still acknowledged", async () => {
    const event = makeMockEvent({ id: "evt-dup" });
    const overrides = createOverrides();
    let callCount = 0;

    overrides._readFromStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return delayedResolve([{ streamId: "2000-0", event }] as StreamEntry[]);
      }
      return delayedResolve([] as StreamEntry[]);
    });

    overrides._processEvent.mockImplementation(() =>
      Promise.resolve({
        eventId: "evt-dup",
        status: "duplicate" as const,
        handlerResults: [],
      }),
    );

    const deps = createDeps();
    const consumer = startConsumer(deps, overrides);

    await sleep(200);
    await consumer.stop();

    expect(overrides._acknowledgeEntry).toHaveBeenCalled();
    const ackCall = overrides._acknowledgeEntry.mock.calls[0];
    expect(ackCall[1]).toBe("2000-0");
  });
});

describe("consumer — retry and dead-letter", () => {
  test("retries failed entries up to 3 times then acknowledges (dead-letter)", async () => {
    const event = makeMockEvent({ id: "evt-fail" });
    const overrides = createOverrides();
    let readCount = 0;

    // Return the same failing entry 3 times, then empty
    overrides._readFromStream.mockImplementation(() => {
      readCount++;
      if (readCount <= 3) {
        return delayedResolve([{ streamId: "3000-0", event }] as StreamEntry[]);
      }
      return delayedResolve([] as StreamEntry[]);
    });

    overrides._processEvent.mockImplementation(() =>
      Promise.reject(new Error("db connection lost")),
    );

    const logger = createMockLogger();
    const deps = createDeps(logger);
    const consumer = startConsumer(deps, overrides);

    await sleep(400);
    await consumer.stop();

    // processEvent should have been called 3 times
    expect(overrides._processEvent.mock.calls.length).toBeGreaterThanOrEqual(3);

    // After 3 failures, acknowledgeEntry should be called (dead-letter ack)
    expect(overrides._acknowledgeEntry).toHaveBeenCalled();

    // Should have logged a permanent failure error
    const errorCalls = logger.error.mock.calls;
    const permanentFailLog = errorCalls.find(
      (call: any[]) =>
        typeof call[1] === "string" && call[1].includes("permanently failed"),
    );
    expect(permanentFailLog).toBeDefined();
  });

  test("failed entries are NOT acknowledged before reaching max retries", async () => {
    const event = makeMockEvent({ id: "evt-retry" });
    const overrides = createOverrides();
    let readCount = 0;

    // Return the entry once, then empty
    overrides._readFromStream.mockImplementation(() => {
      readCount++;
      if (readCount === 1) {
        return delayedResolve([{ streamId: "4000-0", event }] as StreamEntry[]);
      }
      return delayedResolve([] as StreamEntry[]);
    });

    overrides._processEvent.mockImplementation(() =>
      Promise.reject(new Error("transient error")),
    );

    const logger = createMockLogger();
    const deps = createDeps(logger);
    const consumer = startConsumer(deps, overrides);

    await sleep(200);
    await consumer.stop();

    // Should NOT have acknowledged (only 1 failure, max is 3)
    expect(overrides._acknowledgeEntry).not.toHaveBeenCalled();

    // Should have logged a warning about the transient failure
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("consumer — stop()", () => {
  test("stop() causes consumer to exit the loop", async () => {
    const overrides = createOverrides();

    overrides._readFromStream.mockImplementation(
      () => delayedResolve([] as StreamEntry[], 20),
    );

    const deps = createDeps();
    const consumer = startConsumer(deps, overrides);

    await sleep(80);

    const stopStart = Date.now();
    await consumer.stop();
    const stopDuration = Date.now() - stopStart;

    // Should complete quickly (well under the 10s max timeout)
    expect(stopDuration).toBeLessThan(5000);
  });
});

describe("consumer — Redis error resilience", () => {
  test("consumer survives readFromStream throwing (retries after delay)", async () => {
    const overrides = createOverrides();
    let callCount = 0;

    overrides._readFromStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call throws (simulating Redis connection loss)
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      // Subsequent calls succeed (Redis reconnected)
      return delayedResolve([] as StreamEntry[]);
    });

    const logger = createMockLogger();
    const deps = createDeps(logger);
    const consumer = startConsumer(deps, overrides);

    // Wait for error + reconnect delay (30ms) + another read
    await sleep(300);
    await consumer.stop();

    // readFromStream should have been called at least twice
    expect(overrides._readFromStream.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Should have logged the error
    const errorCalls = logger.error.mock.calls;
    const reconnectLog = errorCalls.find(
      (call: any[]) =>
        typeof call[1] === "string" && call[1].includes("Consumer loop error"),
    );
    expect(reconnectLog).toBeDefined();
  });
});

describe("consumer — pending entry reclamation on startup", () => {
  test("consumer reclaims pending entries on startup", async () => {
    const pendingEvent = makeMockEvent({ id: "evt-pending" });
    const overrides = createOverrides();

    overrides._claimPendingEntries.mockImplementation(() =>
      Promise.resolve([{ streamId: "5000-0", event: pendingEvent }] as StreamEntry[]),
    );

    overrides._processEvent.mockImplementation(() =>
      Promise.resolve({
        eventId: "evt-pending",
        status: "processed" as const,
        handlerResults: [],
      }),
    );

    overrides._readFromStream.mockImplementation(
      () => delayedResolve([] as StreamEntry[]),
    );

    const logger = createMockLogger();
    const deps = createDeps(logger);
    const consumer = startConsumer(deps, overrides);

    await sleep(200);
    await consumer.stop();

    // claimPendingEntries should have been called
    expect(overrides._claimPendingEntries).toHaveBeenCalled();

    // The reclaimed entry should have been processed
    expect(overrides._processEvent).toHaveBeenCalled();
    const processCall = overrides._processEvent.mock.calls[0];
    expect(processCall[1]).toEqual(pendingEvent);

    // And acknowledged
    expect(overrides._acknowledgeEntry).toHaveBeenCalled();

    // Should have logged the reclamation count
    const infoCalls = logger.info.mock.calls;
    const reclaimLog = infoCalls.find(
      (call: any[]) =>
        typeof call[1] === "string" && call[1].includes("Reclaimed"),
    );
    expect(reclaimLog).toBeDefined();
  });
});

describe("consumer — periodic stats logging", () => {
  test("periodic stats are logged after the stats interval", async () => {
    const overrides = createOverrides();
    let callCount = 0;

    const event1 = makeMockEvent({ id: "evt-s1" });
    const event2 = makeMockEvent({ id: "evt-s2" });

    overrides._readFromStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return delayedResolve([{ streamId: "6000-0", event: event1 }] as StreamEntry[]);
      }
      if (callCount === 2) {
        return delayedResolve([{ streamId: "6000-1", event: event2 }] as StreamEntry[]);
      }
      return delayedResolve([] as StreamEntry[]);
    });

    overrides._processEvent.mockImplementation((_sql: any, event: Event) =>
      Promise.resolve({
        eventId: event.id,
        status: "processed" as const,
        handlerResults: [],
      }),
    );

    const logger = createMockLogger();
    const deps = createDeps(logger);
    // statsIntervalMs is 80ms in overrides
    const consumer = startConsumer(deps, overrides);

    // Wait long enough for stats interval to fire
    await sleep(500);
    await consumer.stop();

    // Check that a "Consumer stats" log was emitted
    const infoCalls = logger.info.mock.calls;
    const statsLog = infoCalls.find(
      (call: any[]) =>
        typeof call[1] === "string" && call[1].includes("Consumer stats"),
    );
    expect(statsLog).toBeDefined();

    // The stats object should report processed events
    if (statsLog) {
      expect(statsLog[0].processed).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("consumer — ensureConsumerGroup on startup", () => {
  test("calls ensureConsumerGroup during startup", async () => {
    const overrides = createOverrides();

    overrides._readFromStream.mockImplementation(
      () => delayedResolve([] as StreamEntry[]),
    );

    const deps = createDeps();
    const consumer = startConsumer(deps, overrides);

    await sleep(100);
    await consumer.stop();

    expect(overrides._ensureConsumerGroup).toHaveBeenCalled();
  });

  test("continues running even if ensureConsumerGroup fails", async () => {
    const overrides = createOverrides();

    overrides._ensureConsumerGroup.mockImplementation(() =>
      Promise.reject(new Error("group creation failed")),
    );

    overrides._readFromStream.mockImplementation(
      () => delayedResolve([] as StreamEntry[]),
    );

    const logger = createMockLogger();
    const deps = createDeps(logger);
    const consumer = startConsumer(deps, overrides);

    await sleep(200);
    await consumer.stop();

    // Should have logged the error but continued
    expect(logger.error).toHaveBeenCalled();

    // readFromStream should still have been called (loop continued past error)
    expect(overrides._readFromStream).toHaveBeenCalled();
  });
});

describe("consumer — multiple entries in a single read", () => {
  test("processes all entries from a single readFromStream batch", async () => {
    const events = [
      makeMockEvent({ id: "evt-batch-1" }),
      makeMockEvent({ id: "evt-batch-2" }),
      makeMockEvent({ id: "evt-batch-3" }),
    ];
    const overrides = createOverrides();
    let callCount = 0;

    overrides._readFromStream.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return delayedResolve(
          events.map((event, i) => ({ streamId: `7000-${i}`, event })) as StreamEntry[],
        );
      }
      return delayedResolve([] as StreamEntry[]);
    });

    overrides._processEvent.mockImplementation((_sql: any, event: Event) =>
      Promise.resolve({
        eventId: event.id,
        status: "processed" as const,
        handlerResults: [],
      }),
    );

    const deps = createDeps();
    const consumer = startConsumer(deps, overrides);

    await sleep(250);
    await consumer.stop();

    // All 3 entries should have been processed
    expect(overrides._processEvent.mock.calls.length).toBeGreaterThanOrEqual(3);

    // All 3 should have been acknowledged
    expect(overrides._acknowledgeEntry.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Verify correct stream IDs were acknowledged
    const ackedIds = overrides._acknowledgeEntry.mock.calls.map(
      (call: any[]) => call[1],
    );
    expect(ackedIds).toContain("7000-0");
    expect(ackedIds).toContain("7000-1");
    expect(ackedIds).toContain("7000-2");
  });
});

describe("consumer — claimPendingEntries failure", () => {
  test("continues to main loop even if claimPendingEntries throws", async () => {
    const overrides = createOverrides();

    overrides._claimPendingEntries.mockImplementation(() =>
      Promise.reject(new Error("XCLAIM failed")),
    );

    let readCalled = false;
    overrides._readFromStream.mockImplementation(() => {
      readCalled = true;
      return delayedResolve([] as StreamEntry[]);
    });

    const logger = createMockLogger();
    const deps = createDeps(logger);
    const consumer = startConsumer(deps, overrides);

    await sleep(200);
    await consumer.stop();

    // Should have logged the claim error
    expect(logger.error).toHaveBeenCalled();

    // But still entered the main loop
    expect(readCalled).toBe(true);
  });
});
