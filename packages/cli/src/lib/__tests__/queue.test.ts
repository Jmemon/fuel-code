/**
 * Tests for the local event queue module.
 *
 * All tests use a temporary directory to avoid touching the real
 * ~/.fuel-code/queue/ directory. Queue and dead-letter paths are
 * passed explicitly via the optional queueDir/deadLetterDir parameters.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Event } from "@fuel-code/shared";
import {
  enqueueEvent,
  listQueuedEvents,
  readQueuedEvent,
  removeQueuedEvent,
  moveToDeadLetter,
  getQueueDepth,
  getDeadLetterDepth,
} from "../queue.js";

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

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let queueDir: string;
let deadLetterDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-queue-test-"));
  queueDir = path.join(tmpDir, "queue");
  deadLetterDir = path.join(tmpDir, "dead-letter");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: enqueueEvent + readQueuedEvent round-trip
// ---------------------------------------------------------------------------

describe("enqueueEvent + readQueuedEvent round-trip", () => {
  it("writes an event to disk and reads it back with identical fields", () => {
    const event = makeEvent("01HZTEST00000000000000AAAA");
    const filePath = enqueueEvent(event, queueDir);

    expect(filePath).not.toBe("");
    expect(fs.existsSync(filePath)).toBe(true);

    const readBack = readQueuedEvent(filePath);
    expect(readBack).not.toBeNull();
    expect(readBack!.id).toBe(event.id);
    expect(readBack!.type).toBe(event.type);
    expect(readBack!.timestamp).toBe(event.timestamp);
    expect(readBack!.device_id).toBe(event.device_id);
    expect(readBack!.workspace_id).toBe(event.workspace_id);
    expect(readBack!.session_id).toBe(event.session_id);
    expect(readBack!.data).toEqual(event.data);
    expect(readBack!.ingested_at).toBeNull();
    expect(readBack!.blob_refs).toEqual([]);
  });

  it("creates the queue directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "queue");
    expect(fs.existsSync(nestedDir)).toBe(false);

    const event = makeEvent("01HZTEST00000000000000BBBB");
    const filePath = enqueueEvent(event, nestedDir);

    expect(filePath).not.toBe("");
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it("never throws even when the queue directory is not writable", () => {
    // Point to a path that cannot be created (nested under a file, not a dir)
    const blockingFile = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(blockingFile, "blocker", "utf-8");
    const impossibleDir = path.join(blockingFile, "queue");

    const event = makeEvent("01HZTEST00000000000000CCCC");
    // Should return empty string, not throw
    const result = enqueueEvent(event, impossibleDir);
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: listQueuedEvents
// ---------------------------------------------------------------------------

describe("listQueuedEvents", () => {
  it("returns sorted file paths by ULID filename", () => {
    // Create events with ULIDs that have known sort order
    // (lexicographic ULID order = chronological order)
    const eventA = makeEvent("01HZTEST00000000000000AAAA");
    const eventB = makeEvent("01HZTEST00000000000000BBBB");
    const eventC = makeEvent("01HZTEST00000000000000CCCC");

    // Enqueue in reverse order to verify sorting
    enqueueEvent(eventC, queueDir);
    enqueueEvent(eventA, queueDir);
    enqueueEvent(eventB, queueDir);

    const listed = listQueuedEvents(queueDir);
    expect(listed).toHaveLength(3);

    // Should be sorted: AAAA < BBBB < CCCC
    expect(path.basename(listed[0])).toBe("01HZTEST00000000000000AAAA.json");
    expect(path.basename(listed[1])).toBe("01HZTEST00000000000000BBBB.json");
    expect(path.basename(listed[2])).toBe("01HZTEST00000000000000CCCC.json");
  });

  it("returns empty array when queue directory does not exist", () => {
    const nonExistent = path.join(tmpDir, "does-not-exist");
    const listed = listQueuedEvents(nonExistent);
    expect(listed).toEqual([]);
  });

  it("ignores non-.json files", () => {
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, "readme.txt"), "not an event");
    fs.writeFileSync(path.join(queueDir, ".tmp.json.abc"), "temp file");

    const event = makeEvent("01HZTEST00000000000000DDDD");
    enqueueEvent(event, queueDir);

    const listed = listQueuedEvents(queueDir);
    expect(listed).toHaveLength(1);
    expect(path.basename(listed[0])).toBe("01HZTEST00000000000000DDDD.json");
  });
});

// ---------------------------------------------------------------------------
// Tests: removeQueuedEvent
// ---------------------------------------------------------------------------

describe("removeQueuedEvent", () => {
  it("deletes the file from disk", () => {
    const event = makeEvent("01HZTEST00000000000000EEEE");
    const filePath = enqueueEvent(event, queueDir);
    expect(fs.existsSync(filePath)).toBe(true);

    removeQueuedEvent(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("does not throw when file does not exist", () => {
    const fakePath = path.join(queueDir, "nonexistent.json");
    // Should not throw
    removeQueuedEvent(fakePath);
  });
});

// ---------------------------------------------------------------------------
// Tests: moveToDeadLetter
// ---------------------------------------------------------------------------

describe("moveToDeadLetter", () => {
  it("moves the file from queue to dead-letter directory", () => {
    const event = makeEvent("01HZTEST00000000000000FFFF");
    const filePath = enqueueEvent(event, queueDir);
    expect(fs.existsSync(filePath)).toBe(true);

    moveToDeadLetter(filePath, deadLetterDir);

    // Original file should be gone
    expect(fs.existsSync(filePath)).toBe(false);

    // File should exist in dead-letter
    const dlPath = path.join(deadLetterDir, "01HZTEST00000000000000FFFF.json");
    expect(fs.existsSync(dlPath)).toBe(true);

    // Content should be preserved
    const readBack = readQueuedEvent(dlPath);
    expect(readBack).not.toBeNull();
    expect(readBack!.id).toBe(event.id);
  });

  it("creates the dead-letter directory if it does not exist", () => {
    expect(fs.existsSync(deadLetterDir)).toBe(false);

    const event = makeEvent("01HZTEST00000000000000GGGG");
    const filePath = enqueueEvent(event, queueDir);
    moveToDeadLetter(filePath, deadLetterDir);

    expect(fs.existsSync(deadLetterDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: getQueueDepth
// ---------------------------------------------------------------------------

describe("getQueueDepth", () => {
  it("returns 0 when queue directory does not exist", () => {
    expect(getQueueDepth(path.join(tmpDir, "nope"))).toBe(0);
  });

  it("returns correct count of .json files", () => {
    enqueueEvent(makeEvent("01HZTEST00000000000000HH01"), queueDir);
    enqueueEvent(makeEvent("01HZTEST00000000000000HH02"), queueDir);
    enqueueEvent(makeEvent("01HZTEST00000000000000HH03"), queueDir);

    expect(getQueueDepth(queueDir)).toBe(3);
  });

  it("does not count non-.json files", () => {
    enqueueEvent(makeEvent("01HZTEST00000000000000II01"), queueDir);
    fs.writeFileSync(path.join(queueDir, "notes.txt"), "not an event");

    expect(getQueueDepth(queueDir)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: getDeadLetterDepth
// ---------------------------------------------------------------------------

describe("getDeadLetterDepth", () => {
  it("returns 0 when dead-letter directory does not exist", () => {
    expect(getDeadLetterDepth(path.join(tmpDir, "nope"))).toBe(0);
  });

  it("returns correct count of files", () => {
    // Move some events to dead-letter
    const e1 = makeEvent("01HZTEST00000000000000JJ01");
    const e2 = makeEvent("01HZTEST00000000000000JJ02");
    const p1 = enqueueEvent(e1, queueDir);
    const p2 = enqueueEvent(e2, queueDir);
    moveToDeadLetter(p1, deadLetterDir);
    moveToDeadLetter(p2, deadLetterDir);

    expect(getDeadLetterDepth(deadLetterDir)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: Atomic write (no .tmp files persist)
// ---------------------------------------------------------------------------

describe("atomic write", () => {
  it("does not leave .tmp files in the queue directory after enqueue", () => {
    const event = makeEvent("01HZTEST00000000000000KKKK");
    enqueueEvent(event, queueDir);

    const allFiles = fs.readdirSync(queueDir);
    const tmpFiles = allFiles.filter((f) => f.includes(".tmp"));

    expect(tmpFiles).toHaveLength(0);
    // Only the final .json file should be present
    expect(allFiles).toHaveLength(1);
    expect(allFiles[0]).toBe("01HZTEST00000000000000KKKK.json");
  });
});

// ---------------------------------------------------------------------------
// Tests: readQueuedEvent edge cases
// ---------------------------------------------------------------------------

describe("readQueuedEvent", () => {
  it("returns null for a file that does not exist", () => {
    const result = readQueuedEvent(path.join(tmpDir, "ghost.json"));
    expect(result).toBeNull();
  });

  it("returns null for a file with invalid JSON", () => {
    fs.mkdirSync(queueDir, { recursive: true });
    const badFile = path.join(queueDir, "bad.json");
    fs.writeFileSync(badFile, "this is not json{{{", "utf-8");

    const result = readQueuedEvent(badFile);
    expect(result).toBeNull();
  });
});
