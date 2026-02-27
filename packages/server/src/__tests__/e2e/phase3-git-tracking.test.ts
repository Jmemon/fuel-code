/**
 * End-to-end integration tests for Phase 3: Git Tracking pipeline.
 *
 * Verifies the complete flow:
 *   POST git.* events → Redis Stream → Consumer → processEvent()
 *   → git handler → git_activity table + session correlation
 *   → Timeline API (session-grouped + orphan git events)
 *   → Auto-prompt flow for git hook installation
 *
 * Also verifies:
 *   - Git event → session correlation (active session vs orphan)
 *   - Multiple git event types (commit, push, checkout, merge)
 *   - Session end breaks correlation (no retroactive linking)
 *   - Timeline API: sessions with git highlights, orphan events, filtering, pagination
 *   - Auto-prompt: flagging, already-installed skip, dismiss flow
 *   - Duplicate event idempotency
 *   - Handler registry completeness
 *
 * Requires REAL Postgres and Redis via docker-compose.test.yml (ports 5433, 6380).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "../../app.js";
import { createDb } from "../../db/postgres.js";
import { runMigrations } from "../../db/migrator.js";
import { createRedisClient } from "../../redis/client.js";
import { ensureConsumerGroup, EVENTS_STREAM } from "../../redis/stream.js";
import { startConsumer, type ConsumerHandle } from "../../pipeline/consumer.js";
import { createEventHandler } from "../../pipeline/wire.js";
import { logger } from "../../logger.js";
import { generateId } from "@fuel-code/shared";
import { createHandlerRegistry } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Configuration — test-specific env vars for isolated Postgres and Redis
// ---------------------------------------------------------------------------

const DATABASE_URL = "postgresql://test:test@localhost:5433/fuel_code_test";
const REDIS_URL = "redis://localhost:6380";
const API_KEY = "test-api-key-123";

/** Path to the SQL migrations directory */
const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

/** postgres.js connection pool */
let sql: ReturnType<typeof createDb>;

/** ioredis client for app operations (health checks, XADD) — non-blocking */
let redis: ReturnType<typeof createRedisClient>;

/** ioredis client for consumer (XREADGROUP BLOCK) — dedicated blocking connection */
let redisConsumer: ReturnType<typeof createRedisClient>;

/** Consumer handle (stop() for graceful shutdown) */
let consumer: ConsumerHandle;

/** Express HTTP server listening on a random port */
let server: Server;

/** Base URL for fetch() calls (e.g., "http://127.0.0.1:12345") */
let baseUrl: string;

// ---------------------------------------------------------------------------
// waitFor helper — polls Postgres until a condition is met
// ---------------------------------------------------------------------------

/**
 * Poll an async function until it returns a non-null value or times out.
 * Used to wait for the async consumer to process events into Postgres.
 *
 * @param fn - Async function that returns T when the condition is met, or null to keep polling
 * @param timeoutMs - Maximum time to wait before throwing (default 10s)
 * @param intervalMs - Polling interval (default 200ms)
 * @returns The non-null result of fn()
 * @throws Error if the timeout is reached without fn() returning non-null
 */
async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number = 10_000,
  intervalMs: number = 200,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Create database connection pool
  sql = createDb(DATABASE_URL, { max: 5 });

  // 2. Run all SQL migrations to create the schema (Phase 1 + 2 + 3 tables)
  const migrationResult = await runMigrations(sql, MIGRATIONS_DIR);
  if (migrationResult.errors.length > 0) {
    throw new Error(
      `Migration errors: ${migrationResult.errors.map((e) => `${e.name}: ${e.error}`).join(", ")}`,
    );
  }

  // 3. Create two Redis clients: one for the app (non-blocking), one for the
  //    consumer (blocking XREADGROUP). Sharing a single client causes health
  //    check PINGs to queue behind the blocked XREADGROUP command.
  redis = createRedisClient(REDIS_URL);
  redisConsumer = createRedisClient(REDIS_URL);
  await Promise.all([redis.connect(), redisConsumer.connect()]);

  // 4. Delete the event stream to ensure clean state (targeted, not flushall)
  await redis.del(EVENTS_STREAM);

  // 5. Set up the consumer group on the events stream
  await ensureConsumerGroup(redis);

  // 6. Wire up the event handler registry and start the consumer
  //    Consumer uses its own dedicated Redis client for blocking reads.
  const { registry } = createEventHandler(sql, logger);
  consumer = startConsumer({ redis: redisConsumer, sql, registry, logger });

  // 7. Create the Express app and start an HTTP server on a random port
  const app = createApp({ sql, redis, apiKey: API_KEY });
  server = app.listen(0); // port 0 = OS picks a random available port
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  // Tear down in reverse order to avoid dangling references

  // 1. Stop the consumer loop
  if (consumer) {
    await consumer.stop();
  }

  // 2. Close the HTTP server
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // 3. Disconnect both Redis clients
  if (redisConsumer) {
    await redisConsumer.quit();
  }
  if (redis) {
    await redis.quit();
  }

  // 4. Close the Postgres connection pool
  if (sql) {
    await sql.end();
  }
}, 15_000);

afterEach(async () => {
  // 1. Delete just the event stream (not flushall) so the consumer group
  //    disappears with it — but we immediately recreate it below, so the
  //    consumer loop never sees a missing group (no NOGROUP errors).
  await redis.del(EVENTS_STREAM);

  // 2. Recreate consumer group on a fresh empty stream right away.
  await ensureConsumerGroup(redis);

  // 3. Brief pause to let any in-flight consumer processing finish its
  //    Postgres transaction. Without this, TRUNCATE can deadlock against
  //    the consumer's open transaction (TRUNCATE needs ACCESS EXCLUSIVE lock).
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 4. Truncate all data tables between tests to isolate them.
  //    CASCADE handles FK constraints. Schema (tables, indexes) is preserved.
  //    IMPORTANT: includes git_activity from Phase 3.
  await sql`TRUNCATE events, sessions, workspace_devices, workspaces, devices, git_activity CASCADE`;
});

// ---------------------------------------------------------------------------
// Helpers — construct valid event payloads
// ---------------------------------------------------------------------------

/**
 * Build a valid session.start event with unique IDs.
 * workspace_id is a canonical string (e.g., "github.com/user/repo")
 * which the processor will resolve to a ULID.
 */
function makeSessionStartEvent(overrides?: {
  id?: string;
  device_id?: string;
  workspace_id?: string;
  cc_session_id?: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    id: overrides?.id ?? generateId(),
    type: "session.start",
    timestamp: overrides?.timestamp ?? new Date().toISOString(),
    device_id: overrides?.device_id ?? `device-${generateId()}`,
    workspace_id: overrides?.workspace_id ?? "github.com/test-user/test-repo",
    session_id: null,
    data: {
      cc_session_id: overrides?.cc_session_id ?? `cc-sess-${generateId()}`,
      cwd: "/home/user/test-repo",
      git_branch: "main",
      git_remote: "https://github.com/test-user/test-repo.git",
      cc_version: "1.0.0",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: `s3://transcripts/test-${generateId()}.json`,
    },
    blob_refs: [],
  };
}

/**
 * Build a valid session.end event that references an existing session.
 * Must use the same cc_session_id, device_id, and workspace_id as the
 * corresponding session.start event.
 */
function makeSessionEndEvent(params: {
  device_id: string;
  workspace_id: string;
  cc_session_id: string;
  session_id?: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "session.end",
    timestamp: params.timestamp ?? new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    session_id: params.session_id ?? null,
    data: {
      cc_session_id: params.cc_session_id,
      duration_ms: 60_000,
      end_reason: "exit",
      transcript_path: `s3://transcripts/${params.cc_session_id}.json`,
    },
    blob_refs: [],
  };
}

/**
 * Build a valid git.commit event payload.
 * Includes all required fields from the gitCommitPayloadSchema.
 */
function makeGitCommitEvent(params: {
  device_id: string;
  workspace_id: string;
  hash?: string;
  message?: string;
  branch?: string;
  author_name?: string;
  author_email?: string;
  files_changed?: number;
  insertions?: number;
  deletions?: number;
  file_list?: Array<{ path: string; status: string }>;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "git.commit",
    timestamp: params.timestamp ?? new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    session_id: null,
    data: {
      hash: params.hash ?? `abc${generateId().substring(0, 37)}`,
      message: params.message ?? "test commit",
      branch: params.branch ?? "main",
      author_name: params.author_name ?? "Test User",
      author_email: params.author_email ?? "test@example.com",
      files_changed: params.files_changed ?? 1,
      insertions: params.insertions ?? 10,
      deletions: params.deletions ?? 5,
      file_list: params.file_list ?? [{ path: "src/index.ts", status: "M" }],
    },
    blob_refs: [],
  };
}

/**
 * Build a valid git.push event payload.
 * Includes all required fields from the gitPushPayloadSchema.
 */
function makeGitPushEvent(params: {
  device_id: string;
  workspace_id: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "git.push",
    timestamp: params.timestamp ?? new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    session_id: null,
    data: {
      remote: "origin",
      branch: "main",
      commit_count: 3,
    },
    blob_refs: [],
  };
}

/**
 * Build a valid git.checkout event payload.
 * Includes all required fields from the gitCheckoutPayloadSchema.
 */
function makeGitCheckoutEvent(params: {
  device_id: string;
  workspace_id: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "git.checkout",
    timestamp: params.timestamp ?? new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    session_id: null,
    data: {
      from_branch: "main",
      to_branch: "feature/test",
      from_ref: "abc123",
      to_ref: "def456",
    },
    blob_refs: [],
  };
}

/**
 * Build a valid git.merge event payload.
 * Includes all required fields from the gitMergePayloadSchema.
 */
function makeGitMergeEvent(params: {
  device_id: string;
  workspace_id: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "git.merge",
    timestamp: params.timestamp ?? new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    session_id: null,
    data: {
      merged_branch: "feature/test",
      into_branch: "main",
      merge_commit: "merge123abc",
      message: "Merge branch feature/test into main",
      files_changed: 3,
      had_conflicts: false,
    },
    blob_refs: [],
  };
}

/**
 * POST events to the ingest endpoint.
 * Returns the raw Response for the caller to inspect status/body.
 */
async function postEvents(
  events: Record<string, unknown>[],
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/events/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
    body: JSON.stringify({ events }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 3 E2E: Git Tracking Pipeline", () => {
  // -----------------------------------------------------------------------
  // Test 1: Full pipeline — git.commit flows through pipeline with session correlation
  //
  // Verifies: session.start creates session -> git.commit with same workspace+device
  // -> git_activity row created with correct fields -> session_id set on both
  // git_activity and events rows
  // -----------------------------------------------------------------------
  test("Test 1: git.commit event flows through pipeline with session correlation", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/fixture-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // Step 1: POST session.start and wait for session to be created
    const startEvent = makeSessionStartEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    const startRes = await postEvents([startEvent]);
    expect(startRes.status).toBe(202);

    // Wait for session to appear with lifecycle='detected'
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Step 2: POST git.commit with same workspace + device
    const commitHash = `abc${generateId().substring(0, 37)}`;
    const commitEvent = makeGitCommitEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      hash: commitHash,
      message: "feat: add user authentication",
      branch: "feature/auth",
      author_name: "Test User",
      author_email: "test@example.com",
      files_changed: 3,
      insertions: 42,
      deletions: 7,
      file_list: [
        { path: "src/auth.ts", status: "A" },
        { path: "src/middleware.ts", status: "M" },
        { path: "tests/auth.test.ts", status: "A" },
      ],
    });
    const commitEventId = commitEvent.id as string;
    const commitRes = await postEvents([commitEvent]);
    expect(commitRes.status).toBe(202);

    // Step 3: Wait for git_activity row to appear
    const gitRow = await waitFor(async () => {
      const rows = await sql`SELECT * FROM git_activity WHERE id = ${commitEventId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Step 4: Assert git_activity has correct fields
    expect(gitRow.type).toBe("commit");
    expect(gitRow.commit_sha).toBe(commitHash);
    expect(gitRow.branch).toBe("feature/auth");
    expect(gitRow.message).toBe("feat: add user authentication");
    expect(gitRow.files_changed).toBe(3);
    expect(gitRow.insertions).toBe(42);
    expect(gitRow.deletions).toBe(7);

    // Step 5: Assert session_id is set (correlated to the active session)
    expect(gitRow.session_id).toBe(ccSessionId);

    // Step 6: Assert events.session_id is also set for the git.commit event row
    const eventRow = await sql`SELECT * FROM events WHERE id = ${commitEventId}`;
    expect(eventRow.length).toBe(1);
    expect(eventRow[0].session_id).toBe(ccSessionId);

    // Step 7: Assert data JSONB contains author info and file list
    // postgres.js auto-parses JSONB columns into JS objects
    const data = typeof gitRow.data === "string" ? JSON.parse(gitRow.data) : gitRow.data;
    expect(data.author_name).toBe("Test User");
    expect(data.author_email).toBe("test@example.com");
    expect(data.file_list).toBeDefined();
    expect(data.file_list.length).toBe(3);
    expect(data.file_list[0].path).toBe("src/auth.ts");
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 2: Git commit without active session -> orphan (session_id = NULL)
  //
  // Verifies: git.commit sent without any prior session.start results in
  // git_activity row with session_id IS NULL
  // -----------------------------------------------------------------------
  test("Test 2: git.commit without active session creates orphan activity", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/orphan-repo";

    // POST git.commit without any session.start
    const commitEvent = makeGitCommitEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      message: "orphan commit with no session",
    });
    const commitEventId = commitEvent.id as string;
    await postEvents([commitEvent]);

    // Wait for git_activity row
    const gitRow = await waitFor(async () => {
      const rows = await sql`SELECT * FROM git_activity WHERE id = ${commitEventId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Assert: session_id is NULL (orphan)
    expect(gitRow.session_id).toBeNull();
    expect(gitRow.type).toBe("commit");
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 3: Multiple git event types — commit, checkout, merge, push
  //
  // Verifies: all 4 git event types are processed correctly, all correlated
  // to the same session, and /sessions/:id/git returns all of them
  // -----------------------------------------------------------------------
  test("Test 3: multiple git event types all processed and correlated", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/multi-git-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // Start a session
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // POST all 4 git event types, stagger timestamps by 1 second each
    const now = Date.now();
    const commitEvent = makeGitCommitEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      timestamp: new Date(now + 1000).toISOString(),
    });
    const checkoutEvent = makeGitCheckoutEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      timestamp: new Date(now + 2000).toISOString(),
    });
    const mergeEvent = makeGitMergeEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      timestamp: new Date(now + 3000).toISOString(),
    });
    const pushEvent = makeGitPushEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      timestamp: new Date(now + 4000).toISOString(),
    });

    await postEvents([commitEvent, checkoutEvent, mergeEvent, pushEvent]);

    // Wait for all 4 git_activity rows
    const allGitRows = await waitFor(
      async () => {
        const rows = await sql`
          SELECT * FROM git_activity WHERE session_id = ${ccSessionId} ORDER BY timestamp ASC
        `;
        return rows.length >= 4 ? rows : null;
      },
      15_000,
      300,
    );

    // Assert: 4 rows with correct types
    expect(allGitRows.length).toBe(4);
    const types = allGitRows.map((r: any) => r.type);
    expect(types).toContain("commit");
    expect(types).toContain("checkout");
    expect(types).toContain("merge");
    expect(types).toContain("push");

    // Assert: all correlated to the same session
    for (const row of allGitRows) {
      expect(row.session_id).toBe(ccSessionId);
    }

    // Assert: GET /api/sessions/:id/git returns all 4 items
    const gitRes = await fetch(`${baseUrl}/api/sessions/${ccSessionId}/git`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(gitRes.status).toBe(200);
    const gitBody = await gitRes.json();
    expect(gitBody.git_activity.length).toBe(4);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 4: Session ends, then commit -> no correlation
  //
  // Verifies: after session.end transitions lifecycle to 'ended',
  // subsequent git events are NOT correlated (session_id = NULL)
  // -----------------------------------------------------------------------
  test("Test 4: git.commit after session ends has no session correlation", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/ended-session-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // Step 1: POST session.start, wait for session
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Step 2: POST session.end, wait for lifecycle='ended'
    await postEvents([
      makeSessionEndEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 && rows[0].lifecycle === "ended" ? rows[0] : null;
    });

    // Step 3: POST git.commit for same workspace+device AFTER session ended
    const commitEvent = makeGitCommitEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      message: "commit after session ended",
    });
    const commitEventId = commitEvent.id as string;
    await postEvents([commitEvent]);

    // Wait for git_activity row
    const gitRow = await waitFor(async () => {
      const rows = await sql`SELECT * FROM git_activity WHERE id = ${commitEventId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Assert: session_id is NULL — session was already ended
    expect(gitRow.session_id).toBeNull();
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 5: Timeline API — sessions with git highlights
  //
  // Verifies: creating 3 sessions where session 2 has 2 git commits,
  // then GET /api/timeline returns session items with embedded git_activity
  // -----------------------------------------------------------------------
  test("Test 5: timeline API returns sessions with embedded git activity", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/timeline-repo";
    const now = Date.now();

    // Create 3 sessions with staggered timestamps (oldest first)
    const sessionIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ccSessionId = `cc-sess-${generateId()}`;
      sessionIds.push(ccSessionId);

      await postEvents([
        makeSessionStartEvent({
          device_id: deviceId,
          workspace_id: workspaceCanonical,
          cc_session_id: ccSessionId,
          timestamp: new Date(now + i * 2000).toISOString(),
        }),
      ]);
      await waitFor(async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
        return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
      });
    }

    // Add 2 git.commit events to session 2 (index 1), with timestamps
    // that fall within session 2's timeframe
    const session2Ts = now + 1 * 2000; // same base as session 2
    for (let j = 0; j < 2; j++) {
      const commitEvent = makeGitCommitEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        message: `timeline commit ${j}`,
        timestamp: new Date(session2Ts + (j + 1) * 100).toISOString(),
      });
      await postEvents([commitEvent]);
    }

    // Wait for both git_activity rows to appear
    await waitFor(
      async () => {
        const rows = await sql`
          SELECT * FROM git_activity WHERE session_id = ${sessionIds[1]}
        `;
        return rows.length >= 2 ? rows : null;
      },
      15_000,
      300,
    );

    // GET /api/timeline
    const timelineRes = await fetch(`${baseUrl}/api/timeline`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(timelineRes.status).toBe(200);
    const timelineBody = await timelineRes.json();

    // Find session 2's item and verify it has 2 git_activity entries
    const session2Item = timelineBody.items.find(
      (item: any) => item.type === "session" && item.session.id === sessionIds[1],
    );
    expect(session2Item).toBeTruthy();
    expect(session2Item.git_activity.length).toBe(2);

    // Other sessions should have empty git_activity arrays
    const session1Item = timelineBody.items.find(
      (item: any) => item.type === "session" && item.session.id === sessionIds[0],
    );
    const session3Item = timelineBody.items.find(
      (item: any) => item.type === "session" && item.session.id === sessionIds[2],
    );
    expect(session1Item).toBeTruthy();
    expect(session3Item).toBeTruthy();
    expect(session1Item.git_activity.length).toBe(0);
    expect(session3Item.git_activity.length).toBe(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 6: Timeline API — orphan git events interspersed with sessions
  //
  // Verifies: orphan git events (no active session) appear as separate
  // timeline items between sessions, ordered by timestamp
  // -----------------------------------------------------------------------
  test("Test 6: timeline API shows orphan git events between sessions", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/orphan-timeline-repo";
    const now = Date.now();

    // Create session at T (oldest)
    const ccSessionOldest = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionOldest,
        timestamp: new Date(now).toISOString(),
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionOldest}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // End the oldest session so git events at T+1 won't correlate to it
    await postEvents([
      makeSessionEndEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionOldest,
        timestamp: new Date(now + 500).toISOString(),
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionOldest}`;
      return rows.length > 0 && rows[0].lifecycle === "ended" ? rows[0] : null;
    });

    // POST orphan git.commit at T+1 (no active session)
    const orphanCommit = makeGitCommitEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      message: "orphan commit between sessions",
      timestamp: new Date(now + 1000).toISOString(),
    });
    const orphanId = orphanCommit.id as string;
    await postEvents([orphanCommit]);

    // Wait for orphan git_activity to appear
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM git_activity WHERE id = ${orphanId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Create session at T+2 (newest)
    const ccSessionNewest = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionNewest,
        timestamp: new Date(now + 2000).toISOString(),
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionNewest}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // GET /api/timeline — expect: [T+2 session, T+1 orphan git, T session]
    const timelineRes = await fetch(`${baseUrl}/api/timeline`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(timelineRes.status).toBe(200);
    const timelineBody = await timelineRes.json();

    // Should have 3 items: 2 sessions + 1 orphan git event group
    expect(timelineBody.items.length).toBe(3);

    // Verify ordering: newest first (T+2 session, T+1 orphan, T session)
    expect(timelineBody.items[0].type).toBe("session");
    expect(timelineBody.items[0].session.id).toBe(ccSessionNewest);

    expect(timelineBody.items[1].type).toBe("git_activity");
    expect(timelineBody.items[1].git_activity.length).toBe(1);
    expect(timelineBody.items[1].git_activity[0].message).toBe("orphan commit between sessions");

    expect(timelineBody.items[2].type).toBe("session");
    expect(timelineBody.items[2].session.id).toBe(ccSessionOldest);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 7: Timeline API — filtering by workspace_id and types
  //
  // Verifies: workspace_id filter scopes results, types filter scopes
  // git_activity types included in the response
  // -----------------------------------------------------------------------
  test("Test 7: timeline API filtering by workspace_id and types", async () => {
    const deviceId = `device-${generateId()}`;
    const wsA = "github.com/test/filter-ws-a";
    const wsB = "github.com/test/filter-ws-b";
    const now = Date.now();

    // Create session in workspace A
    const ccSessionA = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: wsA,
        cc_session_id: ccSessionA,
        timestamp: new Date(now).toISOString(),
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionA}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Create session in workspace B
    const ccSessionB = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: wsB,
        cc_session_id: ccSessionB,
        timestamp: new Date(now + 1000).toISOString(),
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionB}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Resolve workspace A's ULID for filtering
    const wsARows = await sql`SELECT id FROM workspaces WHERE canonical_id = ${wsA}`;
    const wsAId = wsARows[0].id;

    // Filter by workspace_id: should only return session A
    const wsFilterRes = await fetch(
      `${baseUrl}/api/timeline?workspace_id=${wsAId}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(wsFilterRes.status).toBe(200);
    const wsFilterBody = await wsFilterRes.json();
    expect(wsFilterBody.items.length).toBe(1);
    expect(wsFilterBody.items[0].session.id).toBe(ccSessionA);

    // Add git.commit + git.push to session B for type filtering
    await postEvents([
      makeGitCommitEvent({
        device_id: deviceId,
        workspace_id: wsB,
        message: "typed commit",
        timestamp: new Date(now + 1100).toISOString(),
      }),
      makeGitPushEvent({
        device_id: deviceId,
        workspace_id: wsB,
        timestamp: new Date(now + 1200).toISOString(),
      }),
    ]);

    // Wait for both git_activity rows
    await waitFor(
      async () => {
        const rows = await sql`
          SELECT * FROM git_activity WHERE session_id = ${ccSessionB}
        `;
        return rows.length >= 2 ? rows : null;
      },
      15_000,
      300,
    );

    // Filter by types=commit — should only show commit-type git_activity
    const typesRes = await fetch(`${baseUrl}/api/timeline?types=commit`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(typesRes.status).toBe(200);
    const typesBody = await typesRes.json();

    // Find session B's item
    const sessionBItem = typesBody.items.find(
      (item: any) => item.type === "session" && item.session.id === ccSessionB,
    );
    expect(sessionBItem).toBeTruthy();
    // Only commit types should be in git_activity, not push
    for (const ga of sessionBItem.git_activity) {
      expect(ga.type).toBe("commit");
    }

    // Filter by after=<timestamp>: only sessions AFTER the cutoff should appear.
    // Session A is at `now`, session B is at `now + 1000`. Use `now + 500` as cutoff.
    const afterTs = new Date(now + 500).toISOString();
    const afterRes = await fetch(
      `${baseUrl}/api/timeline?after=${encodeURIComponent(afterTs)}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(afterRes.status).toBe(200);
    const afterBody = await afterRes.json();
    // Only session B (started at now+1000) should appear; session A (at now) is before cutoff
    const afterSessionIds = afterBody.items
      .filter((item: any) => item.type === "session")
      .map((item: any) => item.session.id);
    expect(afterSessionIds).toContain(ccSessionB);
    expect(afterSessionIds).not.toContain(ccSessionA);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 8: Timeline API — pagination
  //
  // Verifies: cursor-based pagination returns stable, non-overlapping pages
  // with correct has_more flags and total item count
  // -----------------------------------------------------------------------
  test("Test 8: timeline API pagination works correctly", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/pagination-repo";
    const now = Date.now();

    // Create 5 sessions with distinct timestamps (spread 2 seconds apart)
    const sessionIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ccSessionId = `cc-sess-${generateId()}`;
      sessionIds.push(ccSessionId);
      await postEvents([
        makeSessionStartEvent({
          device_id: deviceId,
          workspace_id: workspaceCanonical,
          cc_session_id: ccSessionId,
          timestamp: new Date(now + i * 2000).toISOString(),
        }),
      ]);
      await waitFor(async () => {
        const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
        return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
      });
    }

    // Page 1: limit=2 -> 2 items + cursor + has_more=true
    const page1Res = await fetch(`${baseUrl}/api/timeline?limit=2`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.items.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    // Page 2: follow cursor -> next 2 items
    const page2Res = await fetch(
      `${baseUrl}/api/timeline?limit=2&cursor=${page1.next_cursor}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    expect(page2.items.length).toBe(2);
    expect(page2.has_more).toBe(true);
    expect(page2.next_cursor).toBeTruthy();

    // Page 3: follow cursor -> 1 item + has_more=false
    const page3Res = await fetch(
      `${baseUrl}/api/timeline?limit=2&cursor=${page2.next_cursor}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(page3Res.status).toBe(200);
    const page3 = await page3Res.json();
    expect(page3.items.length).toBe(1);
    expect(page3.has_more).toBe(false);

    // Total across all pages = 5, no duplicates
    const allPageIds = [
      ...page1.items.map((i: any) => i.session.id),
      ...page2.items.map((i: any) => i.session.id),
      ...page3.items.map((i: any) => i.session.id),
    ];
    expect(allPageIds.length).toBe(5);
    expect(new Set(allPageIds).size).toBe(5);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 9: Auto-prompt — session.start flags workspace for git hooks prompt
  //
  // Verifies: when a session.start creates a workspace_devices row for a
  // non-unassociated workspace, pending_git_hooks_prompt is set to true
  // and the pending prompt appears in GET /api/prompts/pending
  // -----------------------------------------------------------------------
  test("Test 9: session.start flags workspace for git hooks prompt", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/prompt-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // POST session.start
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId,
      }),
    ]);

    // Wait for session to be created
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Resolve workspace ULID
    const wsRows = await sql`SELECT id FROM workspaces WHERE canonical_id = ${workspaceCanonical}`;
    const wsId = wsRows[0].id;

    // Query workspace_devices: pending_git_hooks_prompt should be true
    const wdRows = await waitFor(async () => {
      const rows = await sql`
        SELECT * FROM workspace_devices WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
      `;
      return rows.length > 0 && rows[0].pending_git_hooks_prompt === true ? rows[0] : null;
    });
    expect(wdRows.pending_git_hooks_prompt).toBe(true);
    expect(wdRows.git_hooks_installed).toBe(false);
    expect(wdRows.git_hooks_prompted).toBe(false);

    // GET /api/prompts/pending?device_id=X should return the prompt
    const promptsRes = await fetch(
      `${baseUrl}/api/prompts/pending?device_id=${deviceId}`,
      { headers: { Authorization: `Bearer ${API_KEY}` } },
    );
    expect(promptsRes.status).toBe(200);
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts.length).toBeGreaterThanOrEqual(1);
    const prompt = promptsBody.prompts.find(
      (p: any) => p.workspace_canonical_id === workspaceCanonical,
    );
    expect(prompt).toBeTruthy();
    expect(prompt.type).toBe("git_hooks_install");
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 10: Auto-prompt — already installed workspace not re-prompted
  //
  // Verifies: if git_hooks_installed=true on workspace_devices, a subsequent
  // session.start does NOT re-flag pending_git_hooks_prompt
  // -----------------------------------------------------------------------
  test("Test 10: already-installed workspace not prompted again", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/already-installed-repo";
    const ccSessionId1 = `cc-sess-${generateId()}`;

    // First session.start to create the workspace_devices row
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId1,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId1}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Resolve workspace ULID
    const wsRows = await sql`SELECT id FROM workspaces WHERE canonical_id = ${workspaceCanonical}`;
    const wsId = wsRows[0].id;

    // Wait for the workspace_devices row to appear and be flagged
    await waitFor(async () => {
      const rows = await sql`
        SELECT * FROM workspace_devices WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
      `;
      return rows.length > 0 ? rows[0] : null;
    });

    // Manually set git_hooks_installed=true (simulating user accepted + installed)
    await sql`
      UPDATE workspace_devices
      SET git_hooks_installed = true, pending_git_hooks_prompt = false, git_hooks_prompted = true
      WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
    `;

    // Create a NEW session.start with DIFFERENT cc_session_id but SAME workspace+device
    const ccSessionId2 = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId2,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId2}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Brief pause for any async processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Assert: pending_git_hooks_prompt should still be false (not re-flagged)
    const wdRows = await sql`
      SELECT * FROM workspace_devices WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
    `;
    expect(wdRows[0].pending_git_hooks_prompt).toBe(false);
    expect(wdRows[0].git_hooks_installed).toBe(true);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 11: Auto-prompt — dismiss prompt (declined) prevents re-prompting
  //
  // Verifies: POST /api/prompts/dismiss with action="declined" clears the
  // pending flag, sets git_hooks_prompted=true, and subsequent session.start
  // does NOT re-flag
  // -----------------------------------------------------------------------
  test("Test 11: dismiss prompt prevents re-prompting", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/dismiss-repo";
    const ccSessionId1 = `cc-sess-${generateId()}`;

    // Step 1: Create pending prompt via session.start
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId1,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId1}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Resolve workspace ULID
    const wsRows = await sql`SELECT id FROM workspaces WHERE canonical_id = ${workspaceCanonical}`;
    const wsId = wsRows[0].id;

    // Wait for prompt to be flagged
    await waitFor(async () => {
      const rows = await sql`
        SELECT * FROM workspace_devices WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
      `;
      return rows.length > 0 && rows[0].pending_git_hooks_prompt === true ? rows[0] : null;
    });

    // Step 2: POST /api/prompts/dismiss with action="declined"
    const dismissRes = await fetch(`${baseUrl}/api/prompts/dismiss`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        workspace_id: wsId,
        device_id: deviceId,
        action: "declined",
      }),
    });
    expect(dismissRes.status).toBe(200);

    // Step 3: Assert: pending_git_hooks_prompt=false, git_hooks_prompted=true
    const afterDismiss = await sql`
      SELECT * FROM workspace_devices WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
    `;
    expect(afterDismiss[0].pending_git_hooks_prompt).toBe(false);
    expect(afterDismiss[0].git_hooks_prompted).toBe(true);

    // Step 4: POST another session.start — pending_git_hooks_prompt should NOT be re-set
    const ccSessionId2 = `cc-sess-${generateId()}`;
    await postEvents([
      makeSessionStartEvent({
        device_id: deviceId,
        workspace_id: workspaceCanonical,
        cc_session_id: ccSessionId2,
      }),
    ]);
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId2}`;
      return rows.length > 0 && rows[0].lifecycle === "detected" ? rows[0] : null;
    });

    // Brief pause for async processing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Assert: still not re-flagged
    const afterSecondStart = await sql`
      SELECT * FROM workspace_devices WHERE workspace_id = ${wsId} AND device_id = ${deviceId}
    `;
    expect(afterSecondStart[0].pending_git_hooks_prompt).toBe(false);
    expect(afterSecondStart[0].git_hooks_prompted).toBe(true);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 12: Duplicate git.commit event handling (idempotency)
  //
  // Verifies: sending the same git.commit event twice (same event ID)
  // results in only 1 git_activity row (ON CONFLICT DO NOTHING)
  // -----------------------------------------------------------------------
  test("Test 12: duplicate git.commit event is deduplicated", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test/dedup-repo";

    // Create a git.commit event with a specific ID
    const commitEvent = makeGitCommitEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      message: "duplicate test commit",
    });
    const commitEventId = commitEvent.id as string;

    // POST the same event twice
    const res1 = await postEvents([commitEvent]);
    expect(res1.status).toBe(202);
    const res2 = await postEvents([commitEvent]);
    expect(res2.status).toBe(202);

    // Wait for at least one git_activity row to appear
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM git_activity WHERE id = ${commitEventId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Give extra time for any second processing to complete
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    // Assert: exactly ONE git_activity row
    const gitRows = await sql`SELECT * FROM git_activity WHERE id = ${commitEventId}`;
    expect(gitRows.length).toBe(1);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 13: Handler registration verification
  //
  // Verifies: createHandlerRegistry() registers all expected event types
  // including Phase 1 (session.*) and Phase 3 (git.*) handlers
  // -----------------------------------------------------------------------
  test("Test 13: handler registry includes all Phase 1 + Phase 3 types", async () => {
    // Import and create the registry — this is a pure unit check
    const registry = createHandlerRegistry();
    const registeredTypes = registry.listRegisteredTypes();

    // Phase 1: session lifecycle handlers
    expect(registeredTypes).toContain("session.start");
    expect(registeredTypes).toContain("session.end");

    // Phase 3: git event handlers
    expect(registeredTypes).toContain("git.commit");
    expect(registeredTypes).toContain("git.push");
    expect(registeredTypes).toContain("git.checkout");
    expect(registeredTypes).toContain("git.merge");

    // Total should be at least 6
    expect(registeredTypes.length).toBeGreaterThanOrEqual(6);
  }, 10_000);
});
