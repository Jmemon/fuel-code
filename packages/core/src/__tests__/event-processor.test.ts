/**
 * Tests for the event processor, handler registry, and session handlers.
 *
 * All database interactions are mocked via a custom sql tagged template function.
 * The mock tracks every SQL call (template strings + interpolated values) so tests
 * can assert on what queries were issued and with what parameters.
 *
 * Logger is a no-op mock (all methods are spies) so handler log calls don't error.
 */

import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { Event, EventType } from "@fuel-code/shared";
import {
  processEvent,
  EventHandlerRegistry,
  type EventHandler,
  type ProcessResult,
} from "../event-processor.js";
import { handleSessionStart } from "../handlers/session-start.js";
import { handleSessionEnd } from "../handlers/session-end.js";
import { createHandlerRegistry } from "../handlers/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A captured SQL call — template strings and interpolated values */
interface SqlCall {
  strings: string[];
  values: unknown[];
}

/**
 * Create a mock sql tagged template function.
 *
 * The mock can return different result sets for different calls (FIFO order).
 * If only one result set is provided, every call returns it.
 *
 * @param resultSets - Array of result sets, one per call in order. Each result
 *   set is an array of row objects. Optionally add a `.count` property for
 *   UPDATE-style results.
 */
function createMockSql(resultSets: (Record<string, unknown>[] & { count?: number })[]) {
  const calls: SqlCall[] = [];
  let callIndex = 0;

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });

    // Return the next result set in order; if we've exhausted the list,
    // keep returning the last one (or empty array).
    const idx = Math.min(callIndex, resultSets.length - 1);
    callIndex++;
    const result = resultSets[idx] ?? [];
    return Promise.resolve(result);
  };

  return { sql: sqlFn as any, calls };
}

/**
 * Create a no-op Pino-like logger whose methods are all bun:test mocks.
 * This prevents "logger.info is not a function" errors in the processor.
 */
function createMockLogger() {
  const logFn = mock(() => {});
  const logger: any = {
    info: logFn,
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    trace: mock(() => {}),
    fatal: mock(() => {}),
    // child() returns the same mock logger (scoped loggers in pino)
    child: mock(() => logger),
  };
  return logger;
}

/** Build a minimal valid session.start event for testing */
function makeSessionStartEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-start-001",
    type: "session.start",
    timestamp: "2024-06-15T10:00:00.000Z",
    device_id: "device-abc",
    workspace_id: "github.com/user/repo",
    session_id: "sess-001",
    data: {
      cc_session_id: "cc-sess-001",
      cwd: "/home/user/repo",
      git_branch: "main",
      git_remote: "https://github.com/user/repo.git",
      cc_version: "1.0.0",
      model: "claude-sonnet-4-20250514",
      source: "startup",
      transcript_path: "s3://transcripts/cc-sess-001.json",
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/** Build a minimal valid session.end event for testing */
function makeSessionEndEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-end-001",
    type: "session.end",
    timestamp: "2024-06-15T11:30:00.000Z",
    device_id: "device-abc",
    workspace_id: "github.com/user/repo",
    session_id: "sess-001",
    data: {
      cc_session_id: "cc-sess-001",
      duration_ms: 5400000,
      end_reason: "exit",
      transcript_path: "s3://transcripts/cc-sess-001.json",
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/**
 * Build the standard mock result sets for the processEvent flow.
 *
 * The processor makes these SQL calls in order:
 *   1. resolveOrCreateWorkspace -> returns workspace ULID
 *   2. resolveOrCreateDevice -> returns device ID
 *   3. ensureWorkspaceDeviceLink -> returns nothing
 *   4. INSERT event -> returns event id (or empty for duplicate)
 *   5. (handler SQL calls, if any)
 *
 * @param eventInsertResult - What the event INSERT returns (empty = duplicate)
 * @param extraResults - Additional result sets for handler SQL calls
 */
function standardResultSets(
  eventInsertResult: Record<string, unknown>[] = [{ id: "evt-start-001" }],
  ...extraResults: Record<string, unknown>[][]
): Record<string, unknown>[][] {
  return [
    [{ id: "ws-ulid-001" }],  // 1. resolveOrCreateWorkspace
    [{ id: "device-abc" }],    // 2. resolveOrCreateDevice
    [],                        // 3. ensureWorkspaceDeviceLink
    eventInsertResult,         // 4. INSERT event
    ...extraResults,           // 5+ handler SQL calls
  ];
}

// ---------------------------------------------------------------------------
// EventHandlerRegistry tests
// ---------------------------------------------------------------------------

describe("EventHandlerRegistry", () => {
  test("register and retrieve a handler", () => {
    const registry = new EventHandlerRegistry();
    const handler: EventHandler = async () => {};

    registry.register("session.start", handler);

    expect(registry.getHandler("session.start")).toBe(handler);
  });

  test("getHandler returns undefined for unregistered type", () => {
    const registry = new EventHandlerRegistry();

    expect(registry.getHandler("git.commit")).toBeUndefined();
  });

  test("register overwrites previous handler for same type", () => {
    const registry = new EventHandlerRegistry();
    const handler1: EventHandler = async () => {};
    const handler2: EventHandler = async () => {};

    registry.register("session.start", handler1);
    registry.register("session.start", handler2);

    expect(registry.getHandler("session.start")).toBe(handler2);
    expect(registry.getHandler("session.start")).not.toBe(handler1);
  });

  test("listRegisteredTypes returns all registered types", () => {
    const registry = new EventHandlerRegistry();
    registry.register("session.start", async () => {});
    registry.register("session.end", async () => {});
    registry.register("git.commit", async () => {});

    const types = registry.listRegisteredTypes();

    expect(types).toHaveLength(3);
    expect(types).toContain("session.start");
    expect(types).toContain("session.end");
    expect(types).toContain("git.commit");
  });

  test("listRegisteredTypes returns empty array when nothing registered", () => {
    const registry = new EventHandlerRegistry();

    expect(registry.listRegisteredTypes()).toEqual([]);
  });

  test("register logs at info level when logger provided", () => {
    const registry = new EventHandlerRegistry();
    const logger = createMockLogger();

    registry.register("session.start", async () => {}, logger);

    expect(logger.info).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createHandlerRegistry tests
// ---------------------------------------------------------------------------

describe("createHandlerRegistry", () => {
  test("creates registry with session.start and session.end handlers", () => {
    const registry = createHandlerRegistry();

    const types = registry.listRegisteredTypes();
    expect(types).toContain("session.start");
    expect(types).toContain("session.end");
    expect(types).toHaveLength(2);
  });

  test("session.start handler is the handleSessionStart function", () => {
    const registry = createHandlerRegistry();

    // The registered handler should be the actual function from handlers/session-start.ts
    expect(registry.getHandler("session.start")).toBe(handleSessionStart);
  });

  test("session.end handler is the handleSessionEnd function", () => {
    const registry = createHandlerRegistry();

    expect(registry.getHandler("session.end")).toBe(handleSessionEnd);
  });
});

// ---------------------------------------------------------------------------
// processEvent tests
// ---------------------------------------------------------------------------

describe("processEvent", () => {
  test("processes session.start event: resolves entities, inserts event, calls handler", async () => {
    const event = makeSessionStartEvent();
    const registry = createHandlerRegistry();
    const logger = createMockLogger();

    // Result sets: workspace resolve, device resolve, ws-device link,
    // event insert (returns id = new), handler session insert
    const { sql, calls } = createMockSql([
      ...standardResultSets([{ id: event.id }], []),
    ]);

    const result = await processEvent(sql, event, registry, logger);

    // Should return processed status
    expect(result.status).toBe("processed");
    expect(result.eventId).toBe(event.id);
    expect(result.handlerResults).toHaveLength(1);
    expect(result.handlerResults[0].type).toBe("session.start");
    expect(result.handlerResults[0].success).toBe(true);

    // Should have made 5 SQL calls total:
    //   1. resolveOrCreateWorkspace
    //   2. resolveOrCreateDevice
    //   3. ensureWorkspaceDeviceLink
    //   4. INSERT event
    //   5. INSERT session (from handler)
    expect(calls).toHaveLength(5);

    // Verify workspace resolve got the canonical ID and hint
    expect(calls[0].values).toContain("github.com/user/repo");

    // Verify device resolve got the device ID
    expect(calls[1].values[0]).toBe("device-abc");

    // Verify workspace-device link got the resolved ULID (not canonical string)
    expect(calls[2].values[0]).toBe("ws-ulid-001");
    expect(calls[2].values[1]).toBe("device-abc");
    expect(calls[2].values[2]).toBe("/home/user/repo");

    // Verify event INSERT used the resolved workspace ULID
    const eventInsertCall = calls[3];
    expect(eventInsertCall.values[0]).toBe(event.id);         // id
    expect(eventInsertCall.values[1]).toBe("session.start");   // type
    expect(eventInsertCall.values[4]).toBe("ws-ulid-001");     // workspace_id = resolved ULID

    // Verify session INSERT from handler
    const sessionInsertCall = calls[4];
    expect(sessionInsertCall.values[0]).toBe("cc-sess-001");   // cc_session_id as PK
    expect(sessionInsertCall.values[1]).toBe("ws-ulid-001");   // workspace_id = resolved ULID
    expect(sessionInsertCall.values[2]).toBe("device-abc");    // device_id
    expect(sessionInsertCall.values[3]).toBe("detected");      // lifecycle
  });

  test("duplicate event returns status 'duplicate' and skips handler", async () => {
    const event = makeSessionStartEvent();
    const registry = createHandlerRegistry();
    const logger = createMockLogger();

    // Event INSERT returns empty array (ON CONFLICT DO NOTHING, no RETURNING)
    const { sql, calls } = createMockSql(standardResultSets([]));

    const result = await processEvent(sql, event, registry, logger);

    expect(result.status).toBe("duplicate");
    expect(result.eventId).toBe(event.id);
    expect(result.handlerResults).toHaveLength(0);

    // Should have made exactly 4 SQL calls (no handler call)
    expect(calls).toHaveLength(4);
  });

  test("processes session.end after start: handler updates session", async () => {
    const event = makeSessionEndEvent();
    const registry = createHandlerRegistry();
    const logger = createMockLogger();

    // The UPDATE result needs a `.count` property to indicate rows affected
    const updateResult = Object.assign([], { count: 1 });

    const { sql, calls } = createMockSql([
      [{ id: "ws-ulid-001" }],   // resolveOrCreateWorkspace
      [{ id: "device-abc" }],     // resolveOrCreateDevice
      [],                         // ensureWorkspaceDeviceLink
      [{ id: event.id }],         // INSERT event (new)
      updateResult,               // UPDATE session (handler)
    ]);

    const result = await processEvent(sql, event, registry, logger);

    expect(result.status).toBe("processed");
    expect(result.handlerResults).toHaveLength(1);
    expect(result.handlerResults[0].type).toBe("session.end");
    expect(result.handlerResults[0].success).toBe(true);

    // Verify UPDATE SQL call from handler
    const updateCall = calls[4];
    const queryText = updateCall.strings.join("$");
    expect(queryText).toContain("UPDATE sessions");
    expect(queryText).toContain("lifecycle");
    expect(queryText).toContain("ended");

    // Verify the values passed to UPDATE
    expect(updateCall.values[0]).toBe(event.timestamp);       // ended_at
    expect(updateCall.values[1]).toBe("exit");                 // end_reason
    expect(updateCall.values[2]).toBe(5400000);                // duration_ms
    expect(updateCall.values[3]).toBe("cc-sess-001");          // WHERE id
  });

  test("unknown event type: event row created, no handler error", async () => {
    // Use a type that has no handler registered (git.commit, for example)
    const event: Event = {
      id: "evt-git-001",
      type: "git.commit",
      timestamp: "2024-06-15T12:00:00.000Z",
      device_id: "device-abc",
      workspace_id: "github.com/user/repo",
      session_id: null,
      data: { cwd: "/home/user/repo", sha: "abc123", message: "fix bug" },
      ingested_at: null,
      blob_refs: [],
    };

    const registry = createHandlerRegistry(); // only session.start and session.end
    const logger = createMockLogger();

    const { sql, calls } = createMockSql(standardResultSets([{ id: event.id }]));

    const result = await processEvent(sql, event, registry, logger);

    // Event should be processed (inserted), but no handler results
    expect(result.status).toBe("processed");
    expect(result.handlerResults).toHaveLength(0);

    // 4 SQL calls: workspace, device, link, event INSERT. No handler call.
    expect(calls).toHaveLength(4);

    // Debug log should have been called for the missing handler
    expect(logger.child).toHaveBeenCalled();
  });

  test("handler error is swallowed: event row still persists, result reports error", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // Create a registry with a handler that throws
    const registry = new EventHandlerRegistry();
    const failingHandler: EventHandler = async () => {
      throw new Error("Database connection lost");
    };
    registry.register("session.start", failingHandler);

    const { sql, calls } = createMockSql(standardResultSets([{ id: event.id }]));

    const result = await processEvent(sql, event, registry, logger);

    // Event should still be "processed" (row was inserted before handler ran)
    expect(result.status).toBe("processed");
    expect(result.eventId).toBe(event.id);

    // Handler result should report the error
    expect(result.handlerResults).toHaveLength(1);
    expect(result.handlerResults[0].success).toBe(false);
    expect(result.handlerResults[0].error).toBe("Database connection lost");

    // Event INSERT still happened (call index 3)
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  test("workspace_id in event row is the resolved ULID, not canonical string", async () => {
    const event = makeSessionStartEvent({
      workspace_id: "github.com/some-org/some-repo",
    });
    const registry = new EventHandlerRegistry(); // no handlers needed for this test
    const logger = createMockLogger();

    const { sql, calls } = createMockSql([
      [{ id: "ws-ulid-resolved" }],  // workspace resolve returns specific ULID
      [{ id: "device-abc" }],
      [],
      [{ id: event.id }],
    ]);

    await processEvent(sql, event, registry, logger);

    // The event INSERT call (index 3) should use the resolved ULID
    const eventInsertCall = calls[3];
    expect(eventInsertCall.values[4]).toBe("ws-ulid-resolved");
    // NOT the canonical string
    expect(eventInsertCall.values[4]).not.toBe("github.com/some-org/some-repo");
  });

  test("extracts default_branch hint from session.start git_branch", async () => {
    const event = makeSessionStartEvent({
      data: {
        ...makeSessionStartEvent().data,
        git_branch: "develop",
      },
    });
    const registry = new EventHandlerRegistry();
    const logger = createMockLogger();

    const { sql, calls } = createMockSql(standardResultSets([{ id: event.id }]));

    await processEvent(sql, event, registry, logger);

    // The workspace resolve call should include the branch hint.
    // resolveOrCreateWorkspace receives (sql, canonicalId, hints).
    // In the workspace-resolver, hints.default_branch becomes the 4th value.
    const workspaceCall = calls[0];
    // The hints are passed as the 4th positional value in the INSERT
    expect(workspaceCall.values[3]).toBe("develop");
  });

  test("uses 'unknown' for local path when event.data.cwd is missing", async () => {
    const event = makeSessionStartEvent({
      data: {
        cc_session_id: "cc-sess-001",
        // no cwd field
        git_branch: "main",
        git_remote: null,
        cc_version: "1.0.0",
        model: null,
        source: "startup",
        transcript_path: "s3://path",
      },
    });
    const registry = new EventHandlerRegistry();
    const logger = createMockLogger();

    const { sql, calls } = createMockSql(standardResultSets([{ id: event.id }]));

    await processEvent(sql, event, registry, logger);

    // workspace-device link call (index 2) should use "unknown" for local_path
    const linkCall = calls[2];
    expect(linkCall.values[2]).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// handleSessionStart tests (isolated)
// ---------------------------------------------------------------------------

describe("handleSessionStart", () => {
  test("inserts session with correct fields from event data", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(1);

    const [call] = calls;
    // Values: cc_session_id, workspace_id, device_id, lifecycle, started_at,
    //         git_branch, model, source, metadata
    expect(call.values[0]).toBe("cc-sess-001");             // id = cc_session_id
    expect(call.values[1]).toBe("ws-ulid-001");             // workspace_id
    expect(call.values[2]).toBe("device-abc");              // device_id
    expect(call.values[3]).toBe("detected");                // lifecycle
    expect(call.values[4]).toBe("2024-06-15T10:00:00.000Z"); // started_at
    expect(call.values[5]).toBe("main");                    // git_branch
    expect(call.values[6]).toBe("claude-sonnet-4-20250514");       // model
    expect(call.values[7]).toBe("startup");                 // source
    expect(call.values[8]).toBe("{}");                      // metadata

    // SQL should contain ON CONFLICT for idempotency
    const queryText = call.strings.join("$");
    expect(queryText).toContain("sessions");
    expect(queryText).toContain("ON CONFLICT");
  });

  test("handles null git_branch and model gracefully", async () => {
    const event = makeSessionStartEvent({
      data: {
        cc_session_id: "cc-sess-002",
        cwd: "/tmp/no-git",
        git_branch: null,
        git_remote: null,
        cc_version: "1.0.0",
        model: null,
        source: "resume",
        transcript_path: "s3://transcripts/cc-sess-002.json",
      },
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-002",
      logger,
    });

    const [call] = calls;
    expect(call.values[5]).toBeNull(); // git_branch
    expect(call.values[6]).toBeNull(); // model
  });
});

// ---------------------------------------------------------------------------
// handleSessionEnd tests (isolated)
// ---------------------------------------------------------------------------

describe("handleSessionEnd", () => {
  test("updates session with ended lifecycle and duration", async () => {
    const event = makeSessionEndEvent();
    const logger = createMockLogger();

    const updateResult = Object.assign([], { count: 1 });
    const { sql, calls } = createMockSql([updateResult]);

    await handleSessionEnd({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(1);

    const [call] = calls;
    // Values: ended_at, end_reason, duration_ms, session_id
    expect(call.values[0]).toBe("2024-06-15T11:30:00.000Z"); // ended_at = event.timestamp
    expect(call.values[1]).toBe("exit");                       // end_reason
    expect(call.values[2]).toBe(5400000);                      // duration_ms
    expect(call.values[3]).toBe("cc-sess-001");                // WHERE id

    // SQL should restrict to valid pre-end states
    const queryText = call.strings.join("$");
    expect(queryText).toContain("UPDATE sessions");
    expect(queryText).toContain("detected");
    expect(queryText).toContain("capturing");
  });

  test("logs warning when no session rows were updated", async () => {
    const event = makeSessionEndEvent();
    const logger = createMockLogger();

    // count=0 means the WHERE clause matched nothing
    const updateResult = Object.assign([], { count: 0 });
    const { sql } = createMockSql([updateResult]);

    await handleSessionEnd({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have logged a warning
    expect(logger.warn).toHaveBeenCalled();
  });

  test("does not warn when session was successfully updated", async () => {
    const event = makeSessionEndEvent();
    const logger = createMockLogger();

    const updateResult = Object.assign([], { count: 1 });
    const { sql } = createMockSql([updateResult]);

    await handleSessionEnd({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should NOT have logged a warning
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
