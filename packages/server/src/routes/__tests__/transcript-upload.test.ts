/**
 * Integration tests for POST /api/sessions/:id/transcript/upload.
 *
 * Creates a real Express app via createApp() with mocked sql, redis, s3,
 * and pipelineDeps. Tests the transcript upload endpoint end-to-end:
 *
 * Test coverage:
 *   1. Upload for non-existent session: 404
 *   2. Upload when transcript already exists: 200 "already_uploaded"
 *   3. Upload for a "detected" session: stores in S3, does NOT trigger pipeline
 *   4. Upload for an "ended" session: stores in S3, triggers pipeline
 *   5. No auth header: 401
 *   6. Empty body: 400
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test";
import type { Server } from "node:http";
import { createApp } from "../../app.js";
import type { AppDeps } from "../../app.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = "fc_test_key_for_transcript_upload";
const AUTH_HEADER = `Bearer ${TEST_API_KEY}`;

// Fake IDs used across tests
const SESSION_ID_NONEXISTENT = "sess-nonexistent-000";
const SESSION_ID_ALREADY = "sess-already-uploaded";
const SESSION_ID_DETECTED = "sess-detected-lifecycle";
const SESSION_ID_ENDED = "sess-ended-lifecycle";
const WORKSPACE_ID = "ws-001";
const CANONICAL_ID = "github.com/user/repo";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

/** Session rows returned by the mock SQL client for different session IDs */
const SESSION_DB: Record<string, Record<string, unknown>> = {
  [SESSION_ID_ALREADY]: {
    id: SESSION_ID_ALREADY,
    lifecycle: "ended",
    workspace_id: WORKSPACE_ID,
    transcript_s3_key: "transcripts/github.com/user/repo/sess-already-uploaded/raw.jsonl",
  },
  [SESSION_ID_DETECTED]: {
    id: SESSION_ID_DETECTED,
    lifecycle: "detected",
    workspace_id: WORKSPACE_ID,
    transcript_s3_key: null,
  },
  [SESSION_ID_ENDED]: {
    id: SESSION_ID_ENDED,
    lifecycle: "ended",
    workspace_id: WORKSPACE_ID,
    transcript_s3_key: null,
  },
};

/** Workspace rows returned by the mock SQL client */
const WORKSPACE_DB: Record<string, Record<string, unknown>> = {
  [WORKSPACE_ID]: {
    canonical_id: CANONICAL_ID,
  },
};

/**
 * Create a mock SQL tagged template function.
 *
 * The mock inspects the query string to decide which result to return.
 * It handles:
 *   - SELECT ... FROM sessions WHERE id = $1 — returns session row or empty
 *   - SELECT ... FROM workspaces WHERE id = $1 — returns workspace row
 *   - UPDATE sessions SET ... — returns empty (side effect only)
 *   - SELECT 1 — health check
 */
function createMockSql() {
  // Track UPDATE calls so tests can verify S3 key was set
  const updateCalls: Array<{ sessionId: string; s3Key: string }> = [];

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");

    // Session lookup
    if (query.includes("FROM sessions") && query.includes("WHERE id")) {
      const sessionId = String(values[0]);
      const session = SESSION_DB[sessionId];
      return Promise.resolve(session ? [session] : []);
    }

    // Workspace lookup
    if (query.includes("FROM workspaces") && query.includes("WHERE id")) {
      const workspaceId = String(values[0]);
      const workspace = WORKSPACE_DB[workspaceId];
      return Promise.resolve(workspace ? [workspace] : []);
    }

    // Session update (transcript_s3_key)
    if (query.includes("UPDATE sessions") && query.includes("transcript_s3_key")) {
      updateCalls.push({
        s3Key: String(values[0]),
        sessionId: String(values[1]),
      });
      return Promise.resolve([]);
    }

    // Health check fallback
    return Promise.resolve([{ "?column?": 1 }]);
  };

  // Make it work as both a tagged template and a function
  const proxy = new Proxy(sqlFn, {
    apply: (_target, _thisArg, args) => {
      if (Array.isArray(args[0]) && "raw" in args[0]) {
        // Tagged template call
        return sqlFn(args[0] as unknown as TemplateStringsArray, ...args.slice(1));
      }
      // Direct function call (health check)
      return Promise.resolve([{ "?column?": 1 }]);
    },
  });

  return { sql: proxy, updateCalls };
}

/**
 * Create a mock Redis that satisfies health checks.
 */
function createMockRedis() {
  const mockPipeline = {
    xadd: mock(function (this: typeof mockPipeline) { return this; }),
    exec: mock(() => Promise.resolve([] as Array<[null, string]>)),
  };

  return {
    pipeline: mock(() => mockPipeline),
    ping: mock(() => Promise.resolve("PONG")),
    _mockPipeline: mockPipeline,
  };
}

/**
 * Create a mock S3 client that tracks upload calls.
 */
function createMockS3() {
  const uploads: Array<{ key: string; size: number; contentType: string }> = [];

  return {
    client: {
      upload: mock(async (key: string, body: Buffer | string, contentType?: string) => {
        const size = Buffer.byteLength(body);
        uploads.push({ key, size, contentType: contentType ?? "application/octet-stream" });
        return { key, size };
      }),
      // uploadStream: accepts a Readable stream and streams directly to S3
      uploadStream: mock(async (key: string, _stream: any, contentLength: number, contentType?: string) => {
        uploads.push({ key, size: contentLength, contentType: contentType ?? "application/octet-stream" });
        return { key, size: contentLength };
      }),
      uploadFile: mock(async () => ({ key: "mock", size: 0 })),
      download: mock(async () => ""),
      downloadStream: mock(async () => new ReadableStream()),
      presignedUrl: mock(async () => "https://mock-url"),
      headObject: mock(async () => ({ exists: false })),
      delete: mock(async () => {}),
      healthCheck: mock(async () => ({ ok: true })),
    },
    uploads,
  };
}

/**
 * Create mock pipeline dependencies.
 */
function createMockPipelineDeps(sql: unknown, s3: unknown) {
  return {
    sql,
    s3,
    summaryConfig: { enabled: false, provider: "anthropic" as const, model: "test", maxTokens: 100 },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => createMockPipelineDeps(sql, s3).logger,
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Test server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let mockSqlResult: ReturnType<typeof createMockSql>;
let mockS3Result: ReturnType<typeof createMockS3>;

beforeAll(async () => {
  const mockRedis = createMockRedis();
  mockSqlResult = createMockSql();
  mockS3Result = createMockS3();

  const mockPipelineDeps = createMockPipelineDeps(
    mockSqlResult.sql,
    mockS3Result.client,
  );

  const app = createApp({
    sql: mockSqlResult.sql as unknown as AppDeps["sql"],
    redis: mockRedis as unknown as AppDeps["redis"],
    apiKey: TEST_API_KEY,
    s3: mockS3Result.client as unknown as AppDeps["s3"],
    pipelineDeps: mockPipelineDeps as unknown as AppDeps["pipelineDeps"],
  });

  // Start on port 0 to get an OS-assigned free port
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

// ---------------------------------------------------------------------------
// Helper: send a POST to /api/sessions/:id/transcript/upload
// ---------------------------------------------------------------------------

async function uploadTranscript(
  sessionId: string,
  body: Buffer | string = Buffer.from('{"type":"test"}\n'),
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/sessions/${sessionId}/transcript/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      Authorization: AUTH_HEADER,
      ...headers,
    },
    body: body as BodyInit,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/sessions/:id/transcript/upload", () => {
  test("non-existent session returns 404", async () => {
    const res = await uploadTranscript(SESSION_ID_NONEXISTENT);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  test("already-uploaded transcript returns 200 with existing key", async () => {
    const res = await uploadTranscript(SESSION_ID_ALREADY);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("already_uploaded");
    expect(body.s3_key).toContain("raw.jsonl");
  });

  test("upload for detected session: stores in S3, pipeline NOT triggered", async () => {
    const transcriptData = '{"role":"human","content":"hello"}\n{"role":"assistant","content":"hi"}\n';

    const res = await uploadTranscript(SESSION_ID_DETECTED, Buffer.from(transcriptData));
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.status).toBe("uploaded");
    expect(body.s3_key).toContain("raw.jsonl");
    expect(body.pipeline_triggered).toBe(false);

    // Verify S3 upload was called
    expect(mockS3Result.uploads.length).toBeGreaterThan(0);
    const lastUpload = mockS3Result.uploads[mockS3Result.uploads.length - 1];
    expect(lastUpload.contentType).toBe("application/x-ndjson");

    // Verify session was updated with the S3 key
    expect(mockSqlResult.updateCalls.length).toBeGreaterThan(0);
    const lastUpdate = mockSqlResult.updateCalls[mockSqlResult.updateCalls.length - 1];
    expect(lastUpdate.sessionId).toBe(SESSION_ID_DETECTED);
    expect(lastUpdate.s3Key).toContain("raw.jsonl");
  });

  test("upload for ended session: stores in S3, pipeline IS triggered", async () => {
    const transcriptData = '{"role":"human","content":"test"}\n';

    const res = await uploadTranscript(SESSION_ID_ENDED, Buffer.from(transcriptData));
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.status).toBe("uploaded");
    expect(body.pipeline_triggered).toBe(true);
  });

  test("no auth header returns 401", async () => {
    const res = await fetch(
      `${baseUrl}/api/sessions/${SESSION_ID_DETECTED}/transcript/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body: Buffer.from("test data"),
      },
    );

    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  test("empty body returns 400", async () => {
    const res = await uploadTranscript(SESSION_ID_DETECTED, Buffer.alloc(0));
    expect(res.status).toBe(400);

    const body = await res.json();
    // With streaming upload, empty body is caught via Content-Length check
    expect(body.error).toContain("Content-Length");
  });
});
