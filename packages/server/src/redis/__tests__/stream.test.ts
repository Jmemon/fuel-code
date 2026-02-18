/**
 * Unit tests for the Redis client and stream abstraction layer.
 *
 * These tests do NOT require a live Redis instance. They verify:
 *   - createRedisClient throws StorageError for empty URLs
 *   - Stream constants have the expected values
 *   - CONSUMER_NAME includes the hostname
 *   - All public functions are exported with correct types
 *   - publishToStream wraps errors in StorageError
 *   - publishBatchToStream handles empty input gracefully
 *   - ensureConsumerGroup silently ignores BUSYGROUP errors
 */

import { describe, test, expect, mock } from "bun:test";
import { hostname } from "os";
import { StorageError } from "@fuel-code/shared";
import type { Event } from "@fuel-code/shared";

import { createRedisClient } from "../client.js";
import {
  EVENTS_STREAM,
  CONSUMER_GROUP,
  CONSUMER_NAME,
  ensureConsumerGroup,
  publishToStream,
  publishBatchToStream,
  readFromStream,
  acknowledgeEntry,
  claimPendingEntries,
} from "../stream.js";
import { checkRedisHealth } from "../client.js";
import type { StreamEntry, BatchPublishResult } from "../stream.js";
import type { RedisHealthResult } from "../client.js";

// ---------------------------------------------------------------------------
// Helper: create a mock Event for tests that need one
// ---------------------------------------------------------------------------

function makeMockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "01H0000000000000000000TEST",
    type: "session.start",
    timestamp: "2025-01-01T00:00:00.000Z",
    device_id: "device-1",
    workspace_id: "ws-1",
    session_id: "session-1",
    data: { prompt: "hello" },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createRedisClient — URL validation
// ---------------------------------------------------------------------------

describe("createRedisClient", () => {
  test("throws StorageError when URL is empty string", () => {
    expect(() => createRedisClient("")).toThrow(StorageError);
  });

  test("throws StorageError when URL is whitespace-only", () => {
    expect(() => createRedisClient("   ")).toThrow(StorageError);
  });

  test("thrown error has code STORAGE_REDIS_URL_MISSING", () => {
    try {
      createRedisClient("");
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("STORAGE_REDIS_URL_MISSING");
    }
  });

  test("returns a Redis instance for a valid URL", () => {
    // We pass a URL but use lazyConnect so no actual connection is made
    const redis = createRedisClient("redis://localhost:6379");
    expect(redis).toBeDefined();
    expect(typeof redis.ping).toBe("function");
    // Clean up: disconnect to prevent the test from hanging
    redis.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Stream constants
// ---------------------------------------------------------------------------

describe("stream constants", () => {
  test("EVENTS_STREAM equals 'events:incoming'", () => {
    expect(EVENTS_STREAM).toBe("events:incoming");
  });

  test("CONSUMER_GROUP equals 'event-processors'", () => {
    expect(CONSUMER_GROUP).toBe("event-processors");
  });

  test("CONSUMER_NAME includes the OS hostname", () => {
    expect(CONSUMER_NAME).toContain(hostname());
  });

  test("CONSUMER_NAME includes the process PID", () => {
    expect(CONSUMER_NAME).toContain(String(process.pid));
  });

  test("CONSUMER_NAME format is hostname-pid", () => {
    expect(CONSUMER_NAME).toBe(`${hostname()}-${process.pid}`);
  });
});

// ---------------------------------------------------------------------------
// Type exports — verify types are importable and have correct shape
// ---------------------------------------------------------------------------

describe("type exports", () => {
  test("StreamEntry type has expected shape", () => {
    // Compile-time check — if this compiles, the types are correct
    const entry: StreamEntry = {
      streamId: "1234567890-0",
      event: makeMockEvent(),
    };
    expect(entry.streamId).toBe("1234567890-0");
    expect(entry.event.id).toBe("01H0000000000000000000TEST");
  });

  test("BatchPublishResult type has expected shape", () => {
    const result: BatchPublishResult = {
      succeeded: [{ eventId: "e1", streamId: "s1" }],
      failed: [{ eventId: "e2", error: "boom" }],
    };
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  test("RedisHealthResult type has expected shape", () => {
    const healthy: RedisHealthResult = { ok: true, latency_ms: 1 };
    expect(healthy.ok).toBe(true);
    const unhealthy: RedisHealthResult = { ok: false, latency_ms: 0, error: "timeout" };
    expect(unhealthy.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Function exports — verify all public functions exist and are callable
// ---------------------------------------------------------------------------

describe("function exports", () => {
  test("createRedisClient is a function", () => {
    expect(typeof createRedisClient).toBe("function");
  });

  test("checkRedisHealth is a function", () => {
    expect(typeof checkRedisHealth).toBe("function");
  });

  test("ensureConsumerGroup is a function", () => {
    expect(typeof ensureConsumerGroup).toBe("function");
  });

  test("publishToStream is a function", () => {
    expect(typeof publishToStream).toBe("function");
  });

  test("publishBatchToStream is a function", () => {
    expect(typeof publishBatchToStream).toBe("function");
  });

  test("readFromStream is a function", () => {
    expect(typeof readFromStream).toBe("function");
  });

  test("acknowledgeEntry is a function", () => {
    expect(typeof acknowledgeEntry).toBe("function");
  });

  test("claimPendingEntries is a function", () => {
    expect(typeof claimPendingEntries).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Mock-based behavior tests (no real Redis required)
// ---------------------------------------------------------------------------

describe("publishToStream — error handling", () => {
  test("wraps xadd errors in StorageError", async () => {
    // Create a mock Redis that throws on xadd
    const mockRedis = {
      xadd: mock(() => Promise.reject(new Error("connection refused"))),
    } as unknown as import("ioredis").default;

    const event = makeMockEvent();

    try {
      await publishToStream(mockRedis, event);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("STORAGE_REDIS_XADD");
      expect((err as StorageError).message).toContain(event.id);
    }
  });
});

describe("publishBatchToStream — edge cases", () => {
  test("returns empty result for empty events array", async () => {
    // Mock Redis — pipeline should not even be called
    const mockRedis = {
      pipeline: mock(() => ({ xadd: mock(), exec: mock(() => Promise.resolve([])) })),
    } as unknown as import("ioredis").default;

    const result = await publishBatchToStream(mockRedis, []);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test("handles pipeline null response by marking all as failed", async () => {
    const mockPipeline = {
      xadd: mock(() => mockPipeline), // chainable
      exec: mock(() => Promise.resolve(null)),
    };
    const mockRedis = {
      pipeline: mock(() => mockPipeline),
    } as unknown as import("ioredis").default;

    const events = [makeMockEvent({ id: "e1" }), makeMockEvent({ id: "e2" })];
    const result = await publishBatchToStream(mockRedis, events);
    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].eventId).toBe("e1");
    expect(result.failed[1].eventId).toBe("e2");
  });

  test("correctly reports per-event success and failure", async () => {
    const mockPipeline = {
      xadd: mock(() => mockPipeline),
      exec: mock(() =>
        Promise.resolve([
          [null, "1234-0"],              // first event succeeds
          [new Error("disk full"), null], // second event fails
        ]),
      ),
    };
    const mockRedis = {
      pipeline: mock(() => mockPipeline),
    } as unknown as import("ioredis").default;

    const events = [makeMockEvent({ id: "ok-event" }), makeMockEvent({ id: "bad-event" })];
    const result = await publishBatchToStream(mockRedis, events);
    expect(result.succeeded).toHaveLength(1);
    expect(result.succeeded[0]).toEqual({ eventId: "ok-event", streamId: "1234-0" });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].eventId).toBe("bad-event");
    expect(result.failed[0].error).toContain("disk full");
  });
});

describe("ensureConsumerGroup — error handling", () => {
  test("silently ignores BUSYGROUP error", async () => {
    const mockRedis = {
      xgroup: mock(() => Promise.reject(new Error("BUSYGROUP Consumer Group name already exists"))),
    } as unknown as import("ioredis").default;

    // Should not throw
    await ensureConsumerGroup(mockRedis);
  });

  test("throws StorageError for non-BUSYGROUP errors", async () => {
    const mockRedis = {
      xgroup: mock(() => Promise.reject(new Error("WRONGTYPE Operation"))),
    } as unknown as import("ioredis").default;

    try {
      await ensureConsumerGroup(mockRedis);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("STORAGE_REDIS_XGROUP");
    }
  });
});

describe("acknowledgeEntry — error handling", () => {
  test("wraps xack errors in StorageError", async () => {
    const mockRedis = {
      xack: mock(() => Promise.reject(new Error("stream gone"))),
    } as unknown as import("ioredis").default;

    try {
      await acknowledgeEntry(mockRedis, "1234-0");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("STORAGE_REDIS_XACK");
    }
  });
});

describe("readFromStream — edge cases", () => {
  test("returns empty array when xreadgroup returns null (timeout)", async () => {
    const mockRedis = {
      xreadgroup: mock(() => Promise.resolve(null)),
    } as unknown as import("ioredis").default;

    const entries = await readFromStream(mockRedis, 10, 1000);
    expect(entries).toEqual([]);
  });

  test("wraps xreadgroup errors in StorageError", async () => {
    const mockRedis = {
      xreadgroup: mock(() => Promise.reject(new Error("NOGROUP"))),
    } as unknown as import("ioredis").default;

    try {
      await readFromStream(mockRedis, 10, 1000);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("STORAGE_REDIS_XREADGROUP");
    }
  });
});

describe("checkRedisHealth — mock tests", () => {
  test("returns ok:true when PING responds with PONG", async () => {
    const mockRedis = {
      ping: mock(() => Promise.resolve("PONG")),
    } as unknown as import("ioredis").default;

    const result = await checkRedisHealth(mockRedis);
    expect(result.ok).toBe(true);
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  test("returns ok:false when PING throws", async () => {
    const mockRedis = {
      ping: mock(() => Promise.reject(new Error("connection refused"))),
    } as unknown as import("ioredis").default;

    const result = await checkRedisHealth(mockRedis);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
  });
});
