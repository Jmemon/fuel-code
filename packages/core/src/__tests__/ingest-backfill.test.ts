/**
 * Unit tests for ingestBackfillSessions (direct DB+S3 path).
 *
 * Mocks the postgres `sql` client and S3 client to verify:
 *   - Dedup via alreadyIngested set
 *   - Dedup via DB SELECT (session already exists)
 *   - Session row creation at 'detected' state
 *   - Lifecycle transitions (detected -> ended -> transcript_ready)
 *   - Transcript upload to S3 and transcript_s3_key update
 *   - Live session handling (detected row only, no end/upload)
 *   - Progress callback accuracy
 *   - Partial failure handling
 *   - Concurrent ingestion
 *
 * Each test creates temporary JSONL files for transcriptPath fields
 * and tears them down in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ingestBackfillSessions } from "../session-backfill.js";
import type { DiscoveredSession, IngestDeps, BackfillProgress, BackfillS3Client } from "../session-backfill.js";

// ---------------------------------------------------------------------------
// Temp directory setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-ingest-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal JSONL transcript file and return its absolute path. */
function createTranscript(sessionId: string, lines = 2): string {
  const filePath = path.join(tmpDir, `${sessionId}.jsonl`);
  const content = Array.from({ length: lines }, (_, i) =>
    JSON.stringify({
      type: i === 0 ? "user" : "assistant",
      timestamp: `2025-06-01T10:0${i}:00.000Z`,
      message: { role: i === 0 ? "user" : "assistant", content: `msg-${i}` },
    }),
  ).join("\n") + "\n";
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Build a DiscoveredSession fixture with a real transcript file on disk. */
function makeSession(overrides: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const sessionId = overrides.sessionId ?? crypto.randomUUID();
  const transcriptPath = overrides.transcriptPath ?? createTranscript(sessionId);
  const fileSizeBytes = overrides.fileSizeBytes ?? fs.statSync(transcriptPath).size;

  return {
    sessionId,
    transcriptPath,
    projectDir: "-Users-test-Desktop-proj",
    resolvedCwd: "/Users/test/Desktop/proj",
    workspaceCanonicalId: "github.com/test/proj",
    gitBranch: "main",
    firstPrompt: "Hello",
    firstTimestamp: "2025-06-01T10:00:00.000Z",
    lastTimestamp: "2025-06-01T10:05:00.000Z",
    fileSizeBytes,
    messageCount: 2,
    ...overrides,
  };
}

/**
 * Create a mock SQL client that tracks queries and returns configurable results.
 * Uses a Map of session IDs that "exist" in the DB to simulate dedup checks.
 */
function createMockSql(existingSessions: Set<string> = new Set()) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const insertedSessions: string[] = [];
  const updatedSessions: Map<string, Record<string, unknown>> = new Map();

  // The mock sql tagged template function. It inspects the query text to
  // determine the appropriate mock response.
  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$?");
    queries.push({ text, values });

    // Device upsert (resolveOrCreateDevice)
    if (text.includes("INSERT INTO devices")) {
      return Promise.resolve([{ id: values[0] }]);
    }

    // Workspace upsert (resolveOrCreateWorkspace)
    if (text.includes("INSERT INTO workspaces")) {
      return Promise.resolve([{ id: "ws-" + String(values[1]).slice(0, 8) }]);
    }

    // Session dedup check: SELECT id FROM sessions WHERE id = $1
    if (text.includes("SELECT id FROM sessions WHERE id")) {
      const sessionId = values[0] as string;
      if (existingSessions.has(sessionId)) {
        return Promise.resolve([{ id: sessionId }]);
      }
      return Promise.resolve([]);
    }

    // Session insert (ensureSessionRow)
    if (text.includes("INSERT INTO sessions")) {
      const sessionId = values[0] as string;
      insertedSessions.push(sessionId);
      existingSessions.add(sessionId);
      return Promise.resolve([]);
    }

    // Session lifecycle transition (transitionSession uses sql.unsafe)
    // For the tagged template version (UPDATE sessions SET transcript_s3_key)
    if (text.includes("UPDATE sessions") && text.includes("transcript_s3_key")) {
      const s3Key = values[0] as string;
      const sessionId = values[1] as string;
      if (!updatedSessions.has(sessionId)) updatedSessions.set(sessionId, {});
      updatedSessions.get(sessionId)!.transcript_s3_key = s3Key;
      return Promise.resolve([]);
    }

    // Default: return empty array
    return Promise.resolve([]);
  };

  // transitionSession uses sql.unsafe for dynamic SET clause
  sqlFn.unsafe = (query: string, values?: unknown[]) => {
    queries.push({ text: query, values });

    // Lifecycle transition: UPDATE sessions SET lifecycle = $1 WHERE id = $2 AND lifecycle = ANY($3)
    if (query.includes("UPDATE sessions") && query.includes("lifecycle")) {
      const newLifecycle = values?.[0] as string;
      const sessionId = values?.[1] as string;
      if (!updatedSessions.has(sessionId)) updatedSessions.set(sessionId, {});
      updatedSessions.get(sessionId)!.lifecycle = newLifecycle;
      return Promise.resolve([{ lifecycle: newLifecycle }]);
    }

    return Promise.resolve([]);
  };

  return {
    sql: sqlFn as unknown as IngestDeps["sql"],
    queries,
    insertedSessions,
    updatedSessions,
  };
}

/** Create a mock S3 client that records uploads in memory. */
function createMockS3(): { s3: BackfillS3Client; uploads: Array<{ key: string; size: number }> } {
  const uploads: Array<{ key: string; size: number }> = [];
  const s3: BackfillS3Client = {
    upload: async (key: string, body: Buffer | string) => {
      const size = typeof body === "string" ? Buffer.byteLength(body) : body.length;
      uploads.push({ key, size });
      return { key, size };
    },
  };
  return { s3, uploads };
}

/** Default deps with mock SQL and S3 for testing. */
function makeDeps(
  overrides: Partial<IngestDeps> = {},
  mockSql?: ReturnType<typeof createMockSql>,
  mockS3?: ReturnType<typeof createMockS3>,
): IngestDeps {
  const { sql } = mockSql ?? createMockSql();
  const { s3 } = mockS3 ?? createMockS3();

  return {
    sql,
    s3,
    deviceId: "test-device",
    concurrency: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ingestBackfillSessions", () => {
  // -----------------------------------------------------------------------
  // 1. Session dedup via alreadyIngested set
  // -----------------------------------------------------------------------
  it("skips sessions present in alreadyIngested set without DB writes", async () => {
    const s1 = makeSession();
    const s2 = makeSession();

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [s1, s2],
      makeDeps(
        { alreadyIngested: new Set([s1.sessionId, s2.sessionId]) },
        mockSqlResult,
        mockS3Result,
      ),
    );

    expect(result.skipped).toBe(2);
    expect(result.ingested).toBe(0);
    expect(result.failed).toBe(0);
    // No session inserts should have been made
    expect(mockSqlResult.insertedSessions).toHaveLength(0);
    // No S3 uploads
    expect(mockS3Result.uploads).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 2. Session dedup via DB check (session already exists in DB)
  // -----------------------------------------------------------------------
  it("skips sessions that already exist in the database", async () => {
    const s1 = makeSession();

    // Pre-populate the mock DB with this session
    const mockSqlResult = createMockSql(new Set([s1.sessionId]));
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [s1],
      makeDeps({}, mockSqlResult, mockS3Result),
    );

    expect(result.skipped).toBe(1);
    expect(result.ingested).toBe(0);
    // No inserts should have been made
    expect(mockSqlResult.insertedSessions).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 3. Successful ingestion flow
  // -----------------------------------------------------------------------
  it("ingests a session: inserts DB row, uploads to S3, transitions lifecycle", async () => {
    const s1 = makeSession({ fileSizeBytes: 1234 });

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [s1],
      makeDeps({}, mockSqlResult, mockS3Result),
    );

    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.totalSizeBytes).toBe(1234);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.errors).toEqual([]);

    // Session should have been inserted
    expect(mockSqlResult.insertedSessions).toContain(s1.sessionId);

    // Transcript should have been uploaded to S3
    expect(mockS3Result.uploads).toHaveLength(1);
    expect(mockS3Result.uploads[0].key).toContain(s1.sessionId);
    expect(mockS3Result.uploads[0].key).toContain("raw.jsonl");

    // Session should have been transitioned through lifecycle states
    const updates = mockSqlResult.updatedSessions.get(s1.sessionId);
    expect(updates).toBeDefined();
    expect(updates?.transcript_s3_key).toContain(s1.sessionId);
  });

  // -----------------------------------------------------------------------
  // 4. AbortSignal cancellation
  // -----------------------------------------------------------------------
  it("stops processing remaining sessions when abort signal fires", async () => {
    const sessions = Array.from({ length: 20 }, () => makeSession());
    const controller = new AbortController();

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    let insertCount = 0;
    // Override the sql to abort after a few inserts
    const origSql = mockSqlResult.sql;
    const wrappedSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$?");
      if (text.includes("INSERT INTO sessions")) {
        insertCount++;
        if (insertCount >= 3) {
          controller.abort();
        }
      }
      return (origSql as any)(strings, ...values);
    }) as unknown as IngestDeps["sql"];
    (wrappedSql as any).unsafe = (origSql as any).unsafe;

    const result = await ingestBackfillSessions(
      sessions,
      makeDeps({ signal: controller.signal, concurrency: 2, sql: wrappedSql }, undefined, mockS3Result),
    );

    // Not all sessions should have been processed
    const totalProcessed = result.ingested + result.skipped + result.failed;
    expect(totalProcessed).toBeLessThan(sessions.length);
  });

  // -----------------------------------------------------------------------
  // 5. Resume with alreadyIngested set (mix of ingested and new)
  // -----------------------------------------------------------------------
  it("processes only non-ingested sessions when alreadyIngested is partial", async () => {
    const s1 = makeSession();
    const s2 = makeSession();
    const s3 = makeSession();

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [s1, s2, s3],
      makeDeps(
        { alreadyIngested: new Set([s1.sessionId]) },
        mockSqlResult,
        mockS3Result,
      ),
    );

    // s1 skipped via alreadyIngested, s2 and s3 ingested
    expect(result.skipped).toBe(1);
    expect(result.ingested).toBe(2);
    expect(result.failed).toBe(0);

    // Only s2 and s3 should have been inserted
    expect(mockSqlResult.insertedSessions).not.toContain(s1.sessionId);
    expect(mockSqlResult.insertedSessions).toContain(s2.sessionId);
    expect(mockSqlResult.insertedSessions).toContain(s3.sessionId);
  });

  // -----------------------------------------------------------------------
  // 6. Progress callback accuracy
  // -----------------------------------------------------------------------
  it("calls onProgress with accurate total/completed/skipped counts", async () => {
    const s1 = makeSession();
    const s2 = makeSession();

    // s1 already exists in DB, s2 is new
    const mockSqlResult = createMockSql(new Set([s1.sessionId]));
    const mockS3Result = createMockS3();

    const progressCalls: BackfillProgress[] = [];

    const result = await ingestBackfillSessions(
      [s1, s2],
      makeDeps(
        {
          onProgress: (p) => progressCalls.push({ ...p }),
          concurrency: 1, // serialize for deterministic progress
        },
        mockSqlResult,
        mockS3Result,
      ),
    );

    expect(result.skipped).toBe(1);
    expect(result.ingested).toBe(1);

    // Progress should have been called at least once
    expect(progressCalls.length).toBeGreaterThan(0);

    // All progress calls should report total = 2
    for (const p of progressCalls) {
      expect(p.total).toBe(2);
    }

    // The final progress call should reflect all sessions processed
    const last = progressCalls[progressCalls.length - 1];
    expect(last.completed).toBe(2); // 1 skipped + 1 ingested
    expect(last.skipped).toBe(1);
  });

  // -----------------------------------------------------------------------
  // 7. Partial failure (some sessions fail, others succeed)
  // -----------------------------------------------------------------------
  it("records correct counts when some sessions fail and others succeed", async () => {
    const sGood = makeSession();
    const sBad = makeSession();

    const mockSqlResult = createMockSql();
    // S3 that fails for the bad session
    const uploads: Array<{ key: string; size: number }> = [];
    const s3: BackfillS3Client = {
      upload: async (key: string, body: Buffer | string) => {
        if (key.includes(sBad.sessionId)) {
          throw new Error("S3 upload failed: simulated error");
        }
        const size = typeof body === "string" ? Buffer.byteLength(body) : body.length;
        uploads.push({ key, size });
        return { key, size };
      },
    };

    const result = await ingestBackfillSessions(
      [sGood, sBad],
      makeDeps({ concurrency: 1, s3 }, mockSqlResult),
    );

    expect(result.ingested).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].sessionId).toBe(sBad.sessionId);
    expect(result.errors[0].error).toContain("S3 upload failed");
  });

  // -----------------------------------------------------------------------
  // Live session handling
  // -----------------------------------------------------------------------

  it("live session gets only a 'detected' row — no end, no transcript upload", async () => {
    const liveSession = makeSession({ isLive: true });

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();
    const onSessionIngested = mock((_id: string) => {});

    const result = await ingestBackfillSessions(
      [liveSession],
      makeDeps({ onSessionIngested }, mockSqlResult, mockS3Result),
    );

    // Session row was inserted (detected state)
    expect(mockSqlResult.insertedSessions).toContain(liveSession.sessionId);
    // No S3 upload for live sessions
    expect(mockS3Result.uploads).toHaveLength(0);
    // onSessionIngested must NOT be called — live sessions are NOT tracked
    expect(onSessionIngested).not.toHaveBeenCalled();
    // liveStarted counter reflects exactly one live session
    expect(result.liveStarted).toBe(1);
    // ingested (fully-completed sessions) must be 0
    expect(result.ingested).toBe(0);
    // No lifecycle transitions beyond 'detected' for live sessions
    expect(mockSqlResult.updatedSessions.has(liveSession.sessionId)).toBe(false);
  });

  it("skips live session when it already exists in DB", async () => {
    const liveSession = makeSession({ isLive: true });

    // Pre-populate the mock DB
    const mockSqlResult = createMockSql(new Set([liveSession.sessionId]));
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [liveSession],
      makeDeps({}, mockSqlResult, mockS3Result),
    );

    expect(result.skipped).toBe(1);
    expect(result.liveStarted).toBe(0);
    // No inserts
    expect(mockSqlResult.insertedSessions).toHaveLength(0);
  });

  it("returns zero counts for an empty sessions array", async () => {
    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [],
      makeDeps({}, mockSqlResult, mockS3Result),
    );

    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.totalSizeBytes).toBe(0);
  });

  it("accumulates totalSizeBytes across multiple ingested sessions", async () => {
    const s1 = makeSession({ fileSizeBytes: 1000 });
    const s2 = makeSession({ fileSizeBytes: 2000 });

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      [s1, s2],
      makeDeps({}, mockSqlResult, mockS3Result),
    );

    expect(result.ingested).toBe(2);
    expect(result.totalSizeBytes).toBe(3000);
  });

  it("handles concurrent ingestion with concurrency > 1", async () => {
    const sessions = Array.from({ length: 8 }, () => makeSession());

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result = await ingestBackfillSessions(
      sessions,
      makeDeps({ concurrency: 4 }, mockSqlResult, mockS3Result),
    );

    expect(result.ingested).toBe(8);
    expect(result.failed).toBe(0);

    // All sessions should have been inserted
    expect(mockSqlResult.insertedSessions).toHaveLength(8);
    // All sessions should have S3 uploads
    expect(mockS3Result.uploads).toHaveLength(8);
  });

  // -----------------------------------------------------------------------
  // Idempotency: re-running backfill for already-ingested sessions
  // -----------------------------------------------------------------------
  it("is idempotent: re-running backfill for already-ingested sessions is a no-op", async () => {
    const s1 = makeSession();

    // First run: session does not exist
    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();

    const result1 = await ingestBackfillSessions(
      [s1],
      makeDeps({}, mockSqlResult, mockS3Result),
    );
    expect(result1.ingested).toBe(1);

    // Second run: session now exists in DB (was added by first run)
    const result2 = await ingestBackfillSessions(
      [s1],
      makeDeps({}, mockSqlResult, mockS3Result),
    );
    expect(result2.skipped).toBe(1);
    expect(result2.ingested).toBe(0);

    // Only one S3 upload total (from first run)
    expect(mockS3Result.uploads).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // enqueueReconcile callback
  // -----------------------------------------------------------------------
  it("calls enqueueReconcile for successfully ingested non-live sessions", async () => {
    const s1 = makeSession();
    const s2 = makeSession({ isLive: true });

    const mockSqlResult = createMockSql();
    const mockS3Result = createMockS3();
    const enqueueReconcile = mock((_id: string) => {});

    await ingestBackfillSessions(
      [s1, s2],
      makeDeps({ enqueueReconcile }, mockSqlResult, mockS3Result),
    );

    // Only s1 (non-live) should be enqueued for reconcile
    expect(enqueueReconcile).toHaveBeenCalledTimes(1);
    expect(enqueueReconcile).toHaveBeenCalledWith(s1.sessionId);
  });
});
