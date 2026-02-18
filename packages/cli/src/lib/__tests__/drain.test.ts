/**
 * Tests for the queue drainer module.
 *
 * All tests use temporary directories and mock API clients to avoid
 * touching real filesystem paths or making real HTTP requests.
 *
 * Test coverage:
 *   - Successful drain with mocked API → all events drained, queue empty
 *   - Dead backend (API throws) → 0 drained, events remain in queue
 *   - Corrupted queue file → moved to dead-letter, others still drain
 *   - Event with _attempts >= 100 → moved to dead-letter
 *   - addAttempt correctly increments attempt count
 *   - Empty queue returns zero counts
 *   - Lockfile prevents concurrent drains; stale lockfile cleaned up
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { NetworkError, type Event, type IngestResponse } from "@fuel-code/shared";
import type { ApiClient } from "../api-client.js";
import type { FuelCodeConfig } from "../config.js";
import { drainQueue, addAttempt } from "../drain.js";
import { acquireLock, releaseLock } from "../drain-background.js";
import { enqueueEvent } from "../queue.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Create a minimal valid Event for testing */
function makeEvent(id: string): Event {
  return {
    id,
    type: "git.commit",
    timestamp: new Date().toISOString(),
    device_id: "test-device-001",
    workspace_id: "test-workspace",
    session_id: null,
    data: { message: "test commit", sha: "abc123" },
    ingested_at: null,
    blob_refs: [],
  };
}

/** Create a mock FuelCodeConfig for testing */
function makeConfig(overrides?: Partial<FuelCodeConfig>): FuelCodeConfig {
  return {
    backend: {
      url: "http://localhost:3000",
      api_key: "test-api-key",
    },
    device: {
      id: "test-device-001",
      name: "test-machine",
      type: "local",
    },
    pipeline: {
      queue_path: "/tmp/test-queue",
      drain_interval_seconds: 30,
      batch_size: 50,
      post_timeout_ms: 2000,
    },
    ...overrides,
  };
}

/**
 * Create a mock API client that returns a successful IngestResponse.
 * Tracks the events that were "ingested" for assertions.
 */
function makeSuccessClient(ingestedEvents: Event[][] = []): ApiClient {
  return {
    async ingest(events: Event[]): Promise<IngestResponse> {
      ingestedEvents.push([...events]);
      return {
        ingested: events.length,
        duplicates: 0,
      };
    },
    async health(): Promise<boolean> {
      return true;
    },
  };
}

/**
 * Create a mock API client that reports some events as duplicates.
 */
function makeDuplicateClient(duplicateCount: number): ApiClient {
  return {
    async ingest(events: Event[]): Promise<IngestResponse> {
      const ingested = events.length - duplicateCount;
      return {
        ingested: Math.max(0, ingested),
        duplicates: Math.min(duplicateCount, events.length),
      };
    },
    async health(): Promise<boolean> {
      return true;
    },
  };
}

/**
 * Create a mock API client that always throws a network error.
 */
function makeFailingClient(error?: Error): ApiClient {
  return {
    async ingest(): Promise<IngestResponse> {
      throw error ?? new NetworkError(
        "Connection refused",
        "NETWORK_INGEST_FAILED",
        { url: "http://localhost:3000/api/events/ingest" },
      );
    },
    async health(): Promise<boolean> {
      return false;
    },
  };
}

/**
 * Create a mock API client that throws a 401 error (invalid API key).
 */
function make401Client(): ApiClient {
  return {
    async ingest(): Promise<IngestResponse> {
      throw new NetworkError(
        "Ingest returned HTTP 401: Unauthorized",
        "NETWORK_INGEST_HTTP_ERROR",
        { url: "http://localhost:3000/api/events/ingest", status: 401, body: "Unauthorized" },
      );
    },
    async health(): Promise<boolean> {
      return false;
    },
  };
}

/**
 * Create a mock API client that throws a 503 error (service unavailable).
 */
function make503Client(): ApiClient {
  return {
    async ingest(): Promise<IngestResponse> {
      throw new NetworkError(
        "Ingest returned HTTP 503: Service Unavailable",
        "NETWORK_INGEST_HTTP_ERROR",
        { url: "http://localhost:3000/api/events/ingest", status: 503, body: "Service Unavailable" },
      );
    },
    async health(): Promise<boolean> {
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let queueDir: string;
let deadLetterDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-drain-test-"));
  queueDir = path.join(tmpDir, "queue");
  deadLetterDir = path.join(tmpDir, "dead-letter");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: drainQueue — successful drain
// ---------------------------------------------------------------------------

describe("drainQueue — successful drain", () => {
  it("drains all queued events and removes files from queue", async () => {
    const config = makeConfig();
    const ingestedBatches: Event[][] = [];
    const client = makeSuccessClient(ingestedBatches);

    // Enqueue 3 events
    enqueueEvent(makeEvent("01DRAIN0000000000000AAAA"), queueDir);
    enqueueEvent(makeEvent("01DRAIN0000000000000BBBB"), queueDir);
    enqueueEvent(makeEvent("01DRAIN0000000000000CCCC"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify all events were sent in one batch (batch_size=50, 3 events)
    expect(ingestedBatches).toHaveLength(1);
    expect(ingestedBatches[0]).toHaveLength(3);

    // Verify queue directory is empty
    const remaining = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(remaining).toHaveLength(0);
  });

  it("batches events according to config batch_size", async () => {
    const config = makeConfig({
      pipeline: {
        queue_path: "/tmp/test",
        drain_interval_seconds: 30,
        batch_size: 2, // Small batch size to test batching
        post_timeout_ms: 2000,
      },
    });

    const ingestedBatches: Event[][] = [];
    const client = makeSuccessClient(ingestedBatches);

    // Enqueue 5 events
    enqueueEvent(makeEvent("01BATCH000000000000000001"), queueDir);
    enqueueEvent(makeEvent("01BATCH000000000000000002"), queueDir);
    enqueueEvent(makeEvent("01BATCH000000000000000003"), queueDir);
    enqueueEvent(makeEvent("01BATCH000000000000000004"), queueDir);
    enqueueEvent(makeEvent("01BATCH000000000000000005"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(5);
    expect(result.remaining).toBe(0);

    // Should have 3 batches: [2, 2, 1]
    expect(ingestedBatches).toHaveLength(3);
    expect(ingestedBatches[0]).toHaveLength(2);
    expect(ingestedBatches[1]).toHaveLength(2);
    expect(ingestedBatches[2]).toHaveLength(1);
  });

  it("reports duplicates from the backend response", async () => {
    const config = makeConfig();
    const client = makeDuplicateClient(1);

    enqueueEvent(makeEvent("01DUPL0000000000000AAAA"), queueDir);
    enqueueEvent(makeEvent("01DUPL0000000000000BBBB"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    // 2 events, 1 duplicate: ingested=1, duplicates=1
    expect(result.drained).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: drainQueue — empty queue
// ---------------------------------------------------------------------------

describe("drainQueue — empty queue", () => {
  it("returns zero counts when queue directory does not exist", async () => {
    const config = makeConfig();
    const client = makeSuccessClient();

    const result = await drainQueue(config, {
      queueDir: path.join(tmpDir, "nonexistent"),
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns zero counts when queue directory is empty", async () => {
    const config = makeConfig();
    const client = makeSuccessClient();

    fs.mkdirSync(queueDir, { recursive: true });

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(0);
    expect(result.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: drainQueue — dead backend
// ---------------------------------------------------------------------------

describe("drainQueue — dead backend", () => {
  it("returns 0 drained with error when API throws network error", async () => {
    const config = makeConfig();
    const client = makeFailingClient();

    enqueueEvent(makeEvent("01FAIL0000000000000AAAA"), queueDir);
    enqueueEvent(makeEvent("01FAIL0000000000000BBBB"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(0);
    expect(result.remaining).toBe(2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Network error");

    // Events should still be in queue (not removed)
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
  });

  it("stops processing and reports error on 401 (invalid API key)", async () => {
    const config = makeConfig({
      pipeline: {
        queue_path: "/tmp/test",
        drain_interval_seconds: 30,
        batch_size: 2,
        post_timeout_ms: 2000,
      },
    });
    const client = make401Client();

    // Enqueue 4 events (2 batches with batch_size=2)
    enqueueEvent(makeEvent("01AUTH0000000000000AAAA"), queueDir);
    enqueueEvent(makeEvent("01AUTH0000000000000BBBB"), queueDir);
    enqueueEvent(makeEvent("01AUTH0000000000000CCCC"), queueDir);
    enqueueEvent(makeEvent("01AUTH0000000000000DDDD"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(0);
    expect(result.errors).toContain("Invalid API key.");
    // Should stop after the first batch fails, so remaining includes all events
    expect(result.remaining).toBe(4);
  });

  it("stops processing and reports error on 503 (service unavailable)", async () => {
    const config = makeConfig();
    const client = make503Client();

    enqueueEvent(makeEvent("01SVC0000000000000AAAA"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    expect(result.drained).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Backend unavailable");
    expect(result.remaining).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: drainQueue — corrupted queue files
// ---------------------------------------------------------------------------

describe("drainQueue — corrupted queue files", () => {
  it("moves corrupted files to dead-letter and drains the rest", async () => {
    const config = makeConfig();
    const ingestedBatches: Event[][] = [];
    const client = makeSuccessClient(ingestedBatches);

    // Enqueue a good event
    enqueueEvent(makeEvent("01CORR0000000000000AAAA"), queueDir);

    // Write a corrupted file directly (not valid JSON)
    fs.writeFileSync(
      path.join(queueDir, "01CORR0000000000000BBBB.json"),
      "this is not valid json {{{",
      "utf-8",
    );

    // Enqueue another good event
    enqueueEvent(makeEvent("01CORR0000000000000CCCC"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    // 2 good events drained, 1 corrupted moved to dead-letter
    expect(result.drained).toBe(2);
    expect(result.deadLettered).toBe(1);
    expect(result.remaining).toBe(0);

    // Verify the corrupted file is in dead-letter
    const dlFiles = fs.readdirSync(deadLetterDir);
    expect(dlFiles).toHaveLength(1);
    expect(dlFiles[0]).toBe("01CORR0000000000000BBBB.json");
  });
});

// ---------------------------------------------------------------------------
// Tests: drainQueue — events exceeding max attempts
// ---------------------------------------------------------------------------

describe("drainQueue — max attempts exceeded", () => {
  it("moves events with _attempts >= 100 to dead-letter", async () => {
    const config = makeConfig();
    const client = makeSuccessClient();

    // Write an event file with _attempts = 100 directly
    fs.mkdirSync(queueDir, { recursive: true });
    const event = makeEvent("01MAXAT000000000000AAAA");
    const eventWithAttempts = { ...event, _attempts: 100 };
    fs.writeFileSync(
      path.join(queueDir, "01MAXAT000000000000AAAA.json"),
      JSON.stringify(eventWithAttempts, null, 2),
      "utf-8",
    );

    // Also enqueue a fresh event
    enqueueEvent(makeEvent("01MAXAT000000000000BBBB"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    // 1 fresh event drained, 1 moved to dead-letter
    expect(result.drained).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect(result.remaining).toBe(0);

    // Verify the max-attempts file is in dead-letter
    const dlFiles = fs.readdirSync(deadLetterDir);
    expect(dlFiles).toContain("01MAXAT000000000000AAAA.json");
  });
});

// ---------------------------------------------------------------------------
// Tests: addAttempt
// ---------------------------------------------------------------------------

describe("addAttempt", () => {
  it("increments _attempts from 0 to 1 on first call", () => {
    const event = makeEvent("01ATTMP000000000000AAAA");
    const filePath = enqueueEvent(event, queueDir);

    const newCount = addAttempt(filePath);
    expect(newCount).toBe(1);

    // Verify the file was updated
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw._attempts).toBe(1);
  });

  it("increments _attempts correctly on successive calls", () => {
    const event = makeEvent("01ATTMP000000000000BBBB");
    const filePath = enqueueEvent(event, queueDir);

    expect(addAttempt(filePath)).toBe(1);
    expect(addAttempt(filePath)).toBe(2);
    expect(addAttempt(filePath)).toBe(3);

    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw._attempts).toBe(3);
  });

  it("preserves the original event data when incrementing", () => {
    const event = makeEvent("01ATTMP000000000000CCCC");
    const filePath = enqueueEvent(event, queueDir);

    addAttempt(filePath);

    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.id).toBe("01ATTMP000000000000CCCC");
    expect(raw.type).toBe("git.commit");
    expect(raw.device_id).toBe("test-device-001");
    expect(raw._attempts).toBe(1);
  });

  it("handles an event file that already has _attempts set", () => {
    fs.mkdirSync(queueDir, { recursive: true });
    const event = makeEvent("01ATTMP000000000000DDDD");
    const eventWithAttempts = { ...event, _attempts: 42 };
    const filePath = path.join(queueDir, "01ATTMP000000000000DDDD.json");
    fs.writeFileSync(filePath, JSON.stringify(eventWithAttempts, null, 2), "utf-8");

    const newCount = addAttempt(filePath);
    expect(newCount).toBe(43);
  });

  it("returns 1 for an unreadable file (best effort)", () => {
    const fakePath = path.join(tmpDir, "nonexistent.json");
    const count = addAttempt(fakePath);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: maxBatches option
// ---------------------------------------------------------------------------

describe("drainQueue — maxBatches option", () => {
  it("limits the number of batches processed", async () => {
    const config = makeConfig({
      pipeline: {
        queue_path: "/tmp/test",
        drain_interval_seconds: 30,
        batch_size: 1, // 1 event per batch
        post_timeout_ms: 2000,
      },
    });

    const ingestedBatches: Event[][] = [];
    const client = makeSuccessClient(ingestedBatches);

    // Enqueue 5 events — with batch_size=1, that's 5 batches
    enqueueEvent(makeEvent("01LIMIT000000000000000A"), queueDir);
    enqueueEvent(makeEvent("01LIMIT000000000000000B"), queueDir);
    enqueueEvent(makeEvent("01LIMIT000000000000000C"), queueDir);
    enqueueEvent(makeEvent("01LIMIT000000000000000D"), queueDir);
    enqueueEvent(makeEvent("01LIMIT000000000000000E"), queueDir);

    const result = await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
      maxBatches: 2, // Only process 2 of the 5 batches
    });

    expect(result.drained).toBe(2);
    expect(result.remaining).toBe(3);
    expect(ingestedBatches).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: drainQueue — attempt increment on failure
// ---------------------------------------------------------------------------

describe("drainQueue — attempt tracking on failure", () => {
  it("increments _attempts for events in failed batches", async () => {
    const config = makeConfig();
    const client = makeFailingClient();

    enqueueEvent(makeEvent("01INCR0000000000000AAAA"), queueDir);

    await drainQueue(config, {
      queueDir,
      deadLetterDir,
      apiClient: client,
    });

    // Read the event file and check _attempts was incremented
    const filePath = path.join(queueDir, "01INCR0000000000000AAAA.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw._attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: lockfile — acquireLock / releaseLock
// ---------------------------------------------------------------------------

describe("lockfile — acquireLock / releaseLock", () => {
  it("acquires lock when no lockfile exists", () => {
    const lockPath = path.join(tmpDir, ".drain.lock");
    const acquired = acquireLock(lockPath);
    expect(acquired).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);

    // Lockfile should contain the current PID
    const pid = fs.readFileSync(lockPath, "utf-8").trim();
    expect(pid).toBe(String(process.pid));

    releaseLock(lockPath);
  });

  it("prevents concurrent lock acquisition (same PID means running)", () => {
    const lockPath = path.join(tmpDir, ".drain.lock");

    // First acquisition succeeds
    const first = acquireLock(lockPath);
    expect(first).toBe(true);

    // Second acquisition fails because the PID (our own) is still running
    const second = acquireLock(lockPath);
    expect(second).toBe(false);

    releaseLock(lockPath);
  });

  it("cleans up stale lockfile with dead PID and acquires", () => {
    const lockPath = path.join(tmpDir, ".drain.lock");

    // Write a lockfile with a PID that doesn't exist (99999999 is very unlikely)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "99999999", "utf-8");

    // Should detect stale lockfile, clean it up, and acquire
    const acquired = acquireLock(lockPath);
    expect(acquired).toBe(true);

    // Lockfile should now contain current PID
    const pid = fs.readFileSync(lockPath, "utf-8").trim();
    expect(pid).toBe(String(process.pid));

    releaseLock(lockPath);
  });

  it("releaseLock removes the lockfile", () => {
    const lockPath = path.join(tmpDir, ".drain.lock");
    acquireLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releaseLock does not throw when lockfile is already gone", () => {
    const lockPath = path.join(tmpDir, ".drain.lock");
    // Should not throw
    releaseLock(lockPath);
  });

  it("handles corrupt lockfile (non-numeric PID) as stale", () => {
    const lockPath = path.join(tmpDir, ".drain.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "not-a-pid", "utf-8");

    // NaN PID should be treated as dead — acquire should succeed
    const acquired = acquireLock(lockPath);
    expect(acquired).toBe(true);

    releaseLock(lockPath);
  });
});
