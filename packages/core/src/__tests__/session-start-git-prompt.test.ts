/**
 * Tests for the git hooks prompt detection in the session.start handler.
 *
 * When a session.start event is processed for a workspace that is a git repo
 * but doesn't have git hooks installed, the handler flags the workspace_devices
 * row with pending_git_hooks_prompt=true. The CLI then picks this up on the
 * next interactive command.
 *
 * Test coverage:
 *   1. Git repo workspace without hooks: sets pending_git_hooks_prompt=true
 *   2. Same workspace+device again (already pending): doesn't re-flag
 *   3. _unassociated workspace: no prompt flag set
 *   4. git_hooks_installed=true: no prompt flag set
 *   5. git_hooks_prompted=true (user declined): no prompt flag set
 */

import { describe, expect, test, mock } from "bun:test";
import type { Event } from "@fuel-code/shared";
import { handleSessionStart } from "../handlers/session-start.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A captured SQL call — template strings and interpolated values */
interface SqlCall {
  strings: string[];
  values: unknown[];
}

/**
 * Create a mock sql tagged template function that returns different results
 * for each call in FIFO order.
 *
 * The handleSessionStart function now makes up to 4 SQL calls:
 *   1. INSERT INTO sessions ... (session creation)
 *   2. SELECT canonical_id FROM workspaces ... (prompt check: get workspace)
 *   3. SELECT git_hooks_installed, git_hooks_prompted FROM workspace_devices ... (prompt check: get status)
 *   4. UPDATE workspace_devices SET pending_git_hooks_prompt=true ... (prompt check: flag)
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

  return { sql: sqlFn as any, calls };
}

/** Create a no-op mock logger */
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

/** Build a minimal session.start event for testing */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleSessionStart — git hooks prompt detection", () => {
  test("git repo workspace without hooks: sets pending_git_hooks_prompt=true", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // SQL call sequence:
    //   1. INSERT session -> []
    //   2. SELECT workspace canonical_id -> git repo (not _unassociated)
    //   3. SELECT workspace_device status -> hooks not installed, not prompted
    //   4. UPDATE workspace_devices -> set pending flag
    const { sql, calls } = createMockSql([
      [],                                                  // 1. session insert
      [{ canonical_id: "github.com/user/repo" }],         // 2. workspace lookup
      [{ git_hooks_installed: false, git_hooks_prompted: false }], // 3. wd status
      [],                                                  // 4. update flag
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have made 4 SQL calls (session insert + 3 prompt check calls)
    expect(calls).toHaveLength(4);

    // Call 4 is the UPDATE that sets the pending flag
    const updateCall = calls[3];
    const queryText = updateCall.strings.join("$");
    expect(queryText).toContain("workspace_devices");
    expect(queryText).toContain("pending_git_hooks_prompt");

    // Verify it targets the correct workspace+device
    expect(updateCall.values).toContain("ws-ulid-001");
    expect(updateCall.values).toContain("device-abc");
  });

  test("already pending prompt: does not re-flag (git_hooks_prompted still false)", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // workspace_devices already has pending_git_hooks_prompt=true from a previous session.start.
    // But git_hooks_prompted is still false, so the handler will try to UPDATE again.
    // This is idempotent since it just sets the same value.
    const { sql, calls } = createMockSql([
      [],                                                  // 1. session insert
      [{ canonical_id: "github.com/user/repo" }],         // 2. workspace lookup
      [{ git_hooks_installed: false, git_hooks_prompted: false }], // 3. wd status
      [],                                                  // 4. update flag (idempotent)
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // 4 calls expected — the UPDATE is idempotent (sets true on already-true)
    expect(calls).toHaveLength(4);
  });

  test("_unassociated workspace: no prompt flag set", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // _unassociated workspace means no git remote was detected — skip prompt
    const { sql, calls } = createMockSql([
      [],                                      // 1. session insert
      [{ canonical_id: "_unassociated" }],     // 2. workspace lookup: _unassociated
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have made exactly 2 SQL calls — stopped after seeing _unassociated
    expect(calls).toHaveLength(2);
  });

  test("git_hooks_installed=true: no prompt flag set", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // Hooks already installed — no need to prompt
    const { sql, calls } = createMockSql([
      [],                                                  // 1. session insert
      [{ canonical_id: "github.com/user/repo" }],         // 2. workspace lookup
      [{ git_hooks_installed: true, git_hooks_prompted: false }], // 3. already installed
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have made exactly 3 SQL calls — stopped after seeing installed=true
    expect(calls).toHaveLength(3);
  });

  test("git_hooks_prompted=true (user declined): no prompt flag set", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // User was already prompted and declined — don't ask again
    const { sql, calls } = createMockSql([
      [],                                                  // 1. session insert
      [{ canonical_id: "github.com/user/repo" }],         // 2. workspace lookup
      [{ git_hooks_installed: false, git_hooks_prompted: true }], // 3. already prompted
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have made exactly 3 SQL calls — stopped after seeing prompted=true
    expect(calls).toHaveLength(3);
  });

  test("workspace not found in DB: no prompt flag set", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // Workspace not found — shouldn't happen in practice but handle gracefully
    const { sql, calls } = createMockSql([
      [],  // 1. session insert
      [],  // 2. workspace lookup returns empty
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have made exactly 2 SQL calls
    expect(calls).toHaveLength(2);
  });

  test("workspace_device link not found: no prompt flag set", async () => {
    const event = makeSessionStartEvent();
    const logger = createMockLogger();

    // workspace_device row doesn't exist yet (edge case)
    const { sql, calls } = createMockSql([
      [],                                              // 1. session insert
      [{ canonical_id: "github.com/user/repo" }],     // 2. workspace lookup
      [],                                              // 3. wd status returns empty
    ]);

    await handleSessionStart({
      sql,
      event,
      workspaceId: "ws-ulid-001",
      logger,
    });

    // Should have made exactly 3 SQL calls
    expect(calls).toHaveLength(3);
  });
});
