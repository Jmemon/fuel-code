/**
 * Tests for git event handlers (git.commit, git.push, git.checkout, git.merge).
 *
 * Uses mock SQL to test handler logic without a real database.
 * Each handler is tested for:
 *   - Correct field extraction and insertion into git_activity
 *   - Session correlation (with and without active sessions)
 *   - Idempotency (ON CONFLICT DO NOTHING)
 *   - Event session_id update when correlation found
 *
 * Also tests handler registration in the registry.
 */

import { describe, expect, test, mock } from "bun:test";
import type { Event } from "@fuel-code/shared";
import { handleGitCommit } from "../handlers/git-commit.js";
import { handleGitPush } from "../handlers/git-push.js";
import { handleGitCheckout } from "../handlers/git-checkout.js";
import { handleGitMerge } from "../handlers/git-merge.js";
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
 * Returns result sets in FIFO order; cycles through them for each call.
 *
 * Also provides a sql.begin(callback) method that mimics postgres.js transactions.
 * The callback receives the same mock sql function as `tx`, so inner tagged-template
 * calls are captured in the same `calls` array.
 */
function createMockSql(resultSets: Record<string, unknown>[][]) {
  const calls: SqlCall[] = [];
  let callIndex = 0;

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    const idx = Math.min(callIndex, resultSets.length - 1);
    callIndex++;
    return Promise.resolve(resultSets[idx] ?? []);
  };

  // Simulate postgres.js sql.begin(async (tx) => { ... })
  // Passes the same mock sql function as the transaction client so
  // inner queries are recorded in the shared calls array.
  sqlFn.begin = async (cb: (tx: any) => Promise<void>) => {
    await cb(sqlFn);
  };

  return { sql: sqlFn as any, calls };
}

/**
 * Create a no-op Pino-like logger whose methods are all bun:test mocks.
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
    child: mock(() => logger),
  };
  return logger;
}

/** Build a minimal valid git.commit event for testing */
function makeGitCommitEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-git-commit-001",
    type: "git.commit",
    timestamp: "2024-06-15T12:00:00.000Z",
    device_id: "device-abc",
    workspace_id: "ws-ulid-001",
    session_id: null,
    data: {
      hash: "abc123def456",
      message: "fix: resolve null pointer in parser",
      author_name: "John Doe",
      author_email: "john@example.com",
      branch: "main",
      files_changed: 3,
      insertions: 15,
      deletions: 5,
      file_list: [
        { path: "src/parser.ts", status: "M" },
        { path: "src/utils.ts", status: "A" },
        { path: "tests/parser.test.ts", status: "M" },
      ],
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/** Build a minimal valid git.push event for testing */
function makeGitPushEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-git-push-001",
    type: "git.push",
    timestamp: "2024-06-15T12:05:00.000Z",
    device_id: "device-abc",
    workspace_id: "ws-ulid-001",
    session_id: null,
    data: {
      branch: "main",
      remote: "origin",
      commit_count: 2,
      commits: ["abc123", "def456"],
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/** Build a minimal valid git.checkout event for testing */
function makeGitCheckoutEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-git-checkout-001",
    type: "git.checkout",
    timestamp: "2024-06-15T12:10:00.000Z",
    device_id: "device-abc",
    workspace_id: "ws-ulid-001",
    session_id: null,
    data: {
      from_ref: "abc123",
      to_ref: "def456",
      from_branch: "main",
      to_branch: "feature/login",
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

/** Build a minimal valid git.merge event for testing */
function makeGitMergeEvent(overrides?: Partial<Event>): Event {
  return {
    id: "evt-git-merge-001",
    type: "git.merge",
    timestamp: "2024-06-15T12:15:00.000Z",
    device_id: "device-abc",
    workspace_id: "ws-ulid-001",
    session_id: null,
    data: {
      merge_commit: "merge123abc",
      message: "Merge branch 'feature/login' into main",
      merged_branch: "feature/login",
      into_branch: "main",
      files_changed: 7,
      had_conflicts: false,
    },
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleGitCommit tests
// ---------------------------------------------------------------------------

describe("handleGitCommit", () => {
  test("inserts correct fields into git_activity", async () => {
    const event = makeGitCommitEvent();
    const logger = createMockLogger();
    // Result sets: 1) correlator query (no session), 2) git_activity INSERT
    const { sql, calls } = createMockSql([[], []]);

    await handleGitCommit({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have 2 SQL calls: correlator SELECT + git_activity INSERT
    expect(calls).toHaveLength(2);

    // Verify the git_activity INSERT call (second call)
    const insertCall = calls[1];
    expect(insertCall.values[0]).toBe("evt-git-commit-001");   // id
    expect(insertCall.values[1]).toBe("ws-ulid-001");          // workspace_id
    expect(insertCall.values[2]).toBe("device-abc");           // device_id
    expect(insertCall.values[3]).toBeNull();                    // session_id (no correlation)
    expect(insertCall.values[4]).toBe("commit");               // type
    expect(insertCall.values[5]).toBe("main");                 // branch
    expect(insertCall.values[6]).toBe("abc123def456");         // commit_sha
    expect(insertCall.values[7]).toBe("fix: resolve null pointer in parser"); // message
    expect(insertCall.values[8]).toBe(3);                      // files_changed
    expect(insertCall.values[9]).toBe(15);                     // insertions
    expect(insertCall.values[10]).toBe(5);                     // deletions
    expect(insertCall.values[11]).toBe("2024-06-15T12:00:00.000Z"); // timestamp

    // Verify data JSONB contains author info and file list
    const dataJson = JSON.parse(insertCall.values[12] as string);
    expect(dataJson.author_name).toBe("John Doe");
    expect(dataJson.author_email).toBe("john@example.com");
    expect(dataJson.file_list).toHaveLength(3);

    // SQL should contain ON CONFLICT for idempotency
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("git_activity");
    expect(queryText).toContain("ON CONFLICT");
  });

  test("sets session_id when active session found", async () => {
    const event = makeGitCommitEvent();
    const logger = createMockLogger();
    // Result sets: 1) correlator returns session, 2) git_activity INSERT, 3) events UPDATE
    const { sql, calls } = createMockSql([
      [{ id: "sess-active-001" }],  // correlator found a session
      [],                            // git_activity INSERT
      [],                            // events UPDATE
    ]);

    await handleGitCommit({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have 3 SQL calls: correlator + INSERT + UPDATE events
    expect(calls).toHaveLength(3);

    // git_activity INSERT should have session_id set
    const insertCall = calls[1];
    expect(insertCall.values[3]).toBe("sess-active-001");

    // events UPDATE should set session_id
    const updateCall = calls[2];
    expect(updateCall.values[0]).toBe("sess-active-001");
    expect(updateCall.values[1]).toBe("evt-git-commit-001");
    const updateQueryText = updateCall.strings.join("$");
    expect(updateQueryText).toContain("UPDATE events");
    expect(updateQueryText).toContain("session_id");
  });

  test("session_id is NULL when no active session", async () => {
    const event = makeGitCommitEvent();
    const logger = createMockLogger();
    // Result sets: 1) correlator returns empty, 2) git_activity INSERT
    const { sql, calls } = createMockSql([[], []]);

    await handleGitCommit({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have only 2 SQL calls (no events UPDATE when no session)
    expect(calls).toHaveLength(2);

    // session_id should be null
    const insertCall = calls[1];
    expect(insertCall.values[3]).toBeNull();
  });

  test("duplicate event is handled by ON CONFLICT DO NOTHING", async () => {
    const event = makeGitCommitEvent();
    const logger = createMockLogger();
    // Even with a duplicate, the INSERT just silently does nothing
    const { sql, calls } = createMockSql([[], []]);

    await handleGitCommit({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Verify the INSERT contains ON CONFLICT
    const insertCall = calls[1];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("ON CONFLICT");
    expect(queryText).toContain("DO NOTHING");
  });
});

// ---------------------------------------------------------------------------
// handleGitPush tests
// ---------------------------------------------------------------------------

describe("handleGitPush", () => {
  test("inserts correct fields into git_activity", async () => {
    const event = makeGitPushEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[], []]);

    await handleGitPush({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(2);

    const insertCall = calls[1];
    expect(insertCall.values[0]).toBe("evt-git-push-001");     // id
    expect(insertCall.values[1]).toBe("ws-ulid-001");          // workspace_id
    expect(insertCall.values[2]).toBe("device-abc");           // device_id
    expect(insertCall.values[3]).toBeNull();                    // session_id
    expect(insertCall.values[4]).toBe("push");                 // type
    expect(insertCall.values[5]).toBe("main");                 // branch
    expect(insertCall.values[6]).toBe("2024-06-15T12:05:00.000Z"); // timestamp

    // Verify data JSONB contains remote, commit_count, and commits
    const dataJson = JSON.parse(insertCall.values[7] as string);
    expect(dataJson.remote).toBe("origin");
    expect(dataJson.commit_count).toBe(2);
    expect(dataJson.commits).toEqual(["abc123", "def456"]);

    // Verify ON CONFLICT
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("ON CONFLICT");
  });

  test("updates events.session_id when correlation found", async () => {
    const event = makeGitPushEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([
      [{ id: "sess-push-001" }],  // correlator
      [],                          // git_activity INSERT
      [],                          // events UPDATE
    ]);

    await handleGitPush({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(3);

    // events UPDATE should set session_id
    const updateCall = calls[2];
    expect(updateCall.values[0]).toBe("sess-push-001");
  });
});

// ---------------------------------------------------------------------------
// handleGitCheckout tests
// ---------------------------------------------------------------------------

describe("handleGitCheckout", () => {
  test("inserts correct fields into git_activity", async () => {
    const event = makeGitCheckoutEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[], []]);

    await handleGitCheckout({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(2);

    const insertCall = calls[1];
    expect(insertCall.values[0]).toBe("evt-git-checkout-001"); // id
    expect(insertCall.values[4]).toBe("checkout");             // type
    expect(insertCall.values[5]).toBe("feature/login");        // branch = to_branch
    expect(insertCall.values[6]).toBe("2024-06-15T12:10:00.000Z"); // timestamp

    // Verify data JSONB contains ref details
    const dataJson = JSON.parse(insertCall.values[7] as string);
    expect(dataJson.from_ref).toBe("abc123");
    expect(dataJson.to_ref).toBe("def456");
    expect(dataJson.from_branch).toBe("main");
    expect(dataJson.to_branch).toBe("feature/login");
  });

  test("uses to_ref as branch for detached HEAD (to_branch is null)", async () => {
    const event = makeGitCheckoutEvent({
      data: {
        from_ref: "abc123",
        to_ref: "deadbeef",
        from_branch: "main",
        to_branch: null,  // detached HEAD
      },
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[], []]);

    await handleGitCheckout({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Branch should fall back to to_ref when to_branch is null
    const insertCall = calls[1];
    expect(insertCall.values[5]).toBe("deadbeef"); // branch = to_ref (fallback)

    const dataJson = JSON.parse(insertCall.values[7] as string);
    expect(dataJson.to_branch).toBeNull();
  });

  test("updates events.session_id when correlation found", async () => {
    const event = makeGitCheckoutEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([
      [{ id: "sess-checkout-001" }],
      [],
      [],
    ]);

    await handleGitCheckout({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(3);
    const updateCall = calls[2];
    expect(updateCall.values[0]).toBe("sess-checkout-001");
  });
});

// ---------------------------------------------------------------------------
// handleGitMerge tests
// ---------------------------------------------------------------------------

describe("handleGitMerge", () => {
  test("inserts correct fields into git_activity", async () => {
    const event = makeGitMergeEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[], []]);

    await handleGitMerge({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(2);

    const insertCall = calls[1];
    expect(insertCall.values[0]).toBe("evt-git-merge-001");    // id
    expect(insertCall.values[4]).toBe("merge");                // type
    expect(insertCall.values[5]).toBe("main");                 // branch = into_branch
    expect(insertCall.values[6]).toBe("merge123abc");          // commit_sha = merge_commit
    expect(insertCall.values[7]).toBe("Merge branch 'feature/login' into main"); // message
    expect(insertCall.values[8]).toBe(7);                      // files_changed
    expect(insertCall.values[9]).toBe("2024-06-15T12:15:00.000Z"); // timestamp

    // Verify data JSONB contains merge details
    const dataJson = JSON.parse(insertCall.values[10] as string);
    expect(dataJson.merged_branch).toBe("feature/login");
    expect(dataJson.had_conflicts).toBe(false);

    // Verify ON CONFLICT
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("ON CONFLICT");
  });

  test("updates events.session_id when correlation found", async () => {
    const event = makeGitMergeEvent();
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([
      [{ id: "sess-merge-001" }],
      [],
      [],
    ]);

    await handleGitMerge({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    expect(calls).toHaveLength(3);
    const updateCall = calls[2];
    expect(updateCall.values[0]).toBe("sess-merge-001");
  });
});

// ---------------------------------------------------------------------------
// All handlers: shared behavior tests
// ---------------------------------------------------------------------------

describe("All git handlers: ON CONFLICT prevents duplicates", () => {
  test("all INSERT queries contain ON CONFLICT DO NOTHING", async () => {
    const logger = createMockLogger();

    // Test each handler and verify ON CONFLICT is present
    const handlers = [
      { fn: handleGitCommit, event: makeGitCommitEvent() },
      { fn: handleGitPush, event: makeGitPushEvent() },
      { fn: handleGitCheckout, event: makeGitCheckoutEvent() },
      { fn: handleGitMerge, event: makeGitMergeEvent() },
    ];

    for (const { fn, event } of handlers) {
      const { sql, calls } = createMockSql([[], []]);

      await fn({
        sql,
        event,
        workspaceId: "ws-ulid-001",
        logger,
      });

      // The INSERT call is the second call (after correlator)
      const insertCall = calls[1];
      const queryText = insertCall.strings.join("$");
      expect(queryText).toContain("ON CONFLICT");
      expect(queryText).toContain("DO NOTHING");
    }
  });
});

describe("All git handlers: events.session_id updated on correlation", () => {
  test("all handlers update events.session_id when session found", async () => {
    const logger = createMockLogger();

    const handlers = [
      { fn: handleGitCommit, event: makeGitCommitEvent() },
      { fn: handleGitPush, event: makeGitPushEvent() },
      { fn: handleGitCheckout, event: makeGitCheckoutEvent() },
      { fn: handleGitMerge, event: makeGitMergeEvent() },
    ];

    for (const { fn, event } of handlers) {
      const { sql, calls } = createMockSql([
        [{ id: "sess-correlated" }],  // correlator returns session
        [],                            // git_activity INSERT
        [],                            // events UPDATE
      ]);

      await fn({
        sql,
        event,
        workspaceId: "ws-ulid-001",
        logger,
      });

      // Should have 3 calls (correlator + INSERT + UPDATE)
      expect(calls).toHaveLength(3);

      // The UPDATE should reference the correlated session
      const updateCall = calls[2];
      expect(updateCall.values[0]).toBe("sess-correlated");
      const updateQuery = updateCall.strings.join("$");
      expect(updateQuery).toContain("UPDATE events");
    }
  });

  test("no handlers update events.session_id when no session found", async () => {
    const logger = createMockLogger();

    const handlers = [
      { fn: handleGitCommit, event: makeGitCommitEvent() },
      { fn: handleGitPush, event: makeGitPushEvent() },
      { fn: handleGitCheckout, event: makeGitCheckoutEvent() },
      { fn: handleGitMerge, event: makeGitMergeEvent() },
    ];

    for (const { fn, event } of handlers) {
      const { sql, calls } = createMockSql([[], []]);

      await fn({
        sql,
        event,
        workspaceId: "ws-ulid-001",
        logger,
      });

      // Should have only 2 calls (correlator + INSERT, no UPDATE)
      expect(calls).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Handler registration tests
// ---------------------------------------------------------------------------

describe("Handler registration includes all git types", () => {
  test("createHandlerRegistry registers all 4 git event types", () => {
    const registry = createHandlerRegistry();
    const types = registry.listRegisteredTypes();

    expect(types).toContain("git.commit");
    expect(types).toContain("git.push");
    expect(types).toContain("git.checkout");
    expect(types).toContain("git.merge");
  });

  test("createHandlerRegistry registers correct handler functions", () => {
    const registry = createHandlerRegistry();

    expect(registry.getHandler("git.commit")).toBe(handleGitCommit);
    expect(registry.getHandler("git.push")).toBe(handleGitPush);
    expect(registry.getHandler("git.checkout")).toBe(handleGitCheckout);
    expect(registry.getHandler("git.merge")).toBe(handleGitMerge);
  });

  test("registry has 6 total handlers (2 session + 4 git)", () => {
    const registry = createHandlerRegistry();
    const types = registry.listRegisteredTypes();

    expect(types).toHaveLength(6);
  });
});
