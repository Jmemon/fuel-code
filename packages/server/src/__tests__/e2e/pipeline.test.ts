/**
 * End-to-end integration tests for the Phase 1 event pipeline.
 *
 * Verifies the complete flow:
 *   POST /api/events/ingest → Zod validation → Redis Stream (XADD)
 *   → Consumer Loop (XREADGROUP) → processEvent() → Postgres INSERT
 *
 * These tests require REAL Postgres and Redis instances running via
 * docker-compose.test.yml (ports 5433 and 6380 respectively).
 *
 * Each test uses fetch() against a local HTTP server and waits for async
 * consumer processing via a polling waitFor() helper.
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

  // 2. Run all SQL migrations to create the schema
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
}, 30_000); // 30s timeout for setup — includes migrations and container readiness

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

  // 2. Recreate consumer group on a fresh empty stream right away,
  //    before the consumer's next XREADGROUP call can hit a gap.
  await ensureConsumerGroup(redis);

  // 3. Brief pause to let any in-flight consumer processing finish its
  //    Postgres transaction. Without this, TRUNCATE can deadlock against
  //    the consumer's open transaction (TRUNCATE needs ACCESS EXCLUSIVE lock).
  await new Promise((resolve) => setTimeout(resolve, 500));

  // 4. Truncate all data tables between tests to isolate them.
  //    CASCADE handles FK constraints. Schema (tables, indexes) is preserved.
  await sql`TRUNCATE events, sessions, workspace_devices, workspaces, devices CASCADE`;
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
}): Record<string, unknown> {
  return {
    id: overrides?.id ?? generateId(),
    type: "session.start",
    timestamp: new Date().toISOString(),
    device_id: overrides?.device_id ?? `device-${generateId()}`,
    workspace_id: overrides?.workspace_id ?? "github.com/test-user/test-repo",
    session_id: null, // null because the session row doesn't exist yet
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
}): Record<string, unknown> {
  return {
    id: generateId(),
    type: "session.end",
    timestamp: new Date().toISOString(),
    device_id: params.device_id,
    workspace_id: params.workspace_id,
    // session.end can reference the session now that session.start created it
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

describe("E2E Pipeline", () => {
  // -----------------------------------------------------------------------
  // Test 0: Health endpoint — run first before data processing tests
  //         so cleanup state doesn't interfere with health checks
  // -----------------------------------------------------------------------
  test("Test 0: GET /api/health returns 200 with status ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    // Health check should report both DB and Redis as healthy
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.redis.ok).toBe(true);
  }, 10_000);

  // -----------------------------------------------------------------------
  // Test 1: Happy path — session.start flows through the full pipeline
  // -----------------------------------------------------------------------
  test("Test 1: session.start event flows through pipeline to Postgres", async () => {
    const event = makeSessionStartEvent();
    const eventId = event.id as string;
    const deviceId = event.device_id as string;
    const workspaceCanonical = event.workspace_id as string;
    const ccSessionId = (event.data as Record<string, unknown>).cc_session_id as string;

    // POST the event to the ingest endpoint
    const res = await postEvents([event]);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBeGreaterThanOrEqual(1);

    // Wait for the consumer to process the event into Postgres
    const eventRow = await waitFor(async () => {
      const rows = await sql`SELECT * FROM events WHERE id = ${eventId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Assert: event row has correct type and device_id
    expect(eventRow.type).toBe("session.start");
    expect(eventRow.device_id).toBe(deviceId);

    // Assert: workspace_id in events table is a ULID (not the canonical string)
    // ULIDs are 26 chars, uppercase Crockford Base32
    expect(eventRow.workspace_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(eventRow.workspace_id).not.toBe(workspaceCanonical);

    // Assert: workspace row exists with correct canonical_id and display_name
    const workspaceRows = await sql`
      SELECT * FROM workspaces WHERE id = ${eventRow.workspace_id}
    `;
    expect(workspaceRows.length).toBe(1);
    expect(workspaceRows[0].canonical_id).toBe("github.com/test-user/test-repo");
    expect(workspaceRows[0].display_name).toBe("test-repo");

    // Assert: device row exists
    const deviceRows = await sql`SELECT * FROM devices WHERE id = ${deviceId}`;
    expect(deviceRows.length).toBe(1);

    // Assert: workspace_devices junction row exists
    const linkRows = await sql`
      SELECT * FROM workspace_devices
      WHERE workspace_id = ${eventRow.workspace_id} AND device_id = ${deviceId}
    `;
    expect(linkRows.length).toBe(1);

    // Assert: session row exists with lifecycle = 'detected'
    const sessionRows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
    expect(sessionRows.length).toBe(1);
    expect(sessionRows[0].lifecycle).toBe("detected");
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 2: Session lifecycle — start then end
  // -----------------------------------------------------------------------
  test("Test 2: session lifecycle — start then end updates session row", async () => {
    // Use consistent IDs across start and end events
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test-user/lifecycle-repo";
    const ccSessionId = `cc-sess-${generateId()}`;

    // POST session.start
    const startEvent = makeSessionStartEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    const startRes = await postEvents([startEvent]);
    expect(startRes.status).toBe(202);

    // Wait for session.start to be processed (session row created)
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // POST session.end with same session, device, and workspace
    const endEvent = makeSessionEndEvent({
      device_id: deviceId,
      workspace_id: workspaceCanonical,
      cc_session_id: ccSessionId,
    });
    const endRes = await postEvents([endEvent]);
    expect(endRes.status).toBe(202);

    // Wait for session lifecycle to be updated to 'ended'
    const endedSession = await waitFor(async () => {
      const rows = await sql`SELECT * FROM sessions WHERE id = ${ccSessionId}`;
      if (rows.length > 0 && rows[0].lifecycle === "ended") {
        return rows[0];
      }
      return null;
    });

    // Assert: session.ended_at is set (not null)
    expect(endedSession.ended_at).not.toBeNull();

    // Assert: two events in events table (start + end)
    // Both events share the same device_id
    const eventRows = await sql`SELECT * FROM events WHERE device_id = ${deviceId}`;
    expect(eventRows.length).toBe(2);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 3: Duplicate event deduplication
  // -----------------------------------------------------------------------
  test("Test 3: duplicate event is deduplicated — only one row in Postgres", async () => {
    // Construct an event with a specific ULID
    const event = makeSessionStartEvent();
    const eventId = event.id as string;

    // POST it twice
    const res1 = await postEvents([event]);
    expect(res1.status).toBe(202);

    const res2 = await postEvents([event]);
    expect(res2.status).toBe(202);

    // Wait for processing — at least one event should land in Postgres
    await waitFor(async () => {
      const rows = await sql`SELECT * FROM events WHERE id = ${eventId}`;
      return rows.length > 0 ? rows[0] : null;
    });

    // Give extra time for any second processing to complete
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    // Assert: exactly ONE row in events table with that ID
    const eventRows = await sql`SELECT * FROM events WHERE id = ${eventId}`;
    expect(eventRows.length).toBe(1);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 4: Batch ingest — 10 events in a single POST
  // -----------------------------------------------------------------------
  test("Test 4: batch of 10 events all processed into Postgres", async () => {
    const deviceId = `device-${generateId()}`;
    const workspaceCanonical = "github.com/test-user/batch-repo";

    // Construct 10 events with different ULIDs but same device/workspace
    const events: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(
        makeSessionStartEvent({
          device_id: deviceId,
          workspace_id: workspaceCanonical,
          // Each event needs a unique cc_session_id
          cc_session_id: `cc-batch-${generateId()}`,
        }),
      );
    }

    // POST as a single batch
    const res = await postEvents(events);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.ingested).toBeGreaterThanOrEqual(10);

    // Wait for all 10 to appear in Postgres
    const allEvents = await waitFor(
      async () => {
        const rows = await sql`SELECT * FROM events WHERE device_id = ${deviceId}`;
        return rows.length >= 10 ? rows : null;
      },
      15_000, // allow more time for batch processing
      300,
    );

    expect(allEvents.length).toBe(10);
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test 5: Invalid payload rejection
  // -----------------------------------------------------------------------
  test("Test 5: invalid session.start payload is rejected", async () => {
    // session.start requires cc_session_id, cwd, etc. — sending empty data
    const event = {
      id: generateId(),
      type: "session.start",
      timestamp: new Date().toISOString(),
      device_id: `device-${generateId()}`,
      workspace_id: "github.com/test-user/invalid-repo",
      session_id: null,
      data: {}, // missing required fields
      blob_refs: [],
    };

    const res = await postEvents([event]);
    expect(res.status).toBe(202);

    const body = await res.json();
    // The event should be rejected (invalid payload) but the request succeeds (202)
    expect(body.rejected).toBeGreaterThan(0);
  }, 10_000);

  // -----------------------------------------------------------------------
  // Test 6: Auth failure
  // -----------------------------------------------------------------------
  test("Test 6: missing auth returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: [makeSessionStartEvent()] }),
    });

    expect(res.status).toBe(401);
  }, 10_000);

  test("Test 6b: wrong API key returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/events/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key-456",
      },
      body: JSON.stringify({ events: [makeSessionStartEvent()] }),
    });

    expect(res.status).toBe(401);
  }, 10_000);

});
