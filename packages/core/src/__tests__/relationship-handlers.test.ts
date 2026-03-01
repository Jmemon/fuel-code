/**
 * Unit tests for Phase 4-2 relationship event handlers.
 *
 * Tests each handler using mock SQL (matching the pattern in git-handlers.test.ts):
 *   - subagent.start: creates subagent row with status='running', upserts on duplicate
 *   - subagent.stop: updates to status='completed', handles stop-before-start
 *   - team.create: inserts team, updates session team_name/team_role
 *   - team.message: increments metadata.message_count, warns if team missing
 *   - skill.invoke: inserts session_skills row
 *   - worktree.create: inserts session_worktrees row
 *   - worktree.remove: updates existing row, inserts if no prior create
 *
 * Also tests handler registration for all 13 event types in the registry.
 */

import { describe, expect, test, mock } from "bun:test";
import type { Event } from "@fuel-code/shared";
import { handleSubagentStart } from "../handlers/subagent-start.js";
import { handleSubagentStop } from "../handlers/subagent-stop.js";
import { handleTeamCreate } from "../handlers/team-create.js";
import { handleTeamMessage } from "../handlers/team-message.js";
import { handleSkillInvoke } from "../handlers/skill-invoke.js";
import { handleWorktreeCreate } from "../handlers/worktree-create.js";
import { handleWorktreeRemove } from "../handlers/worktree-remove.js";
import { createHandlerRegistry } from "../handlers/index.js";

// ---------------------------------------------------------------------------
// Test helpers (same pattern as git-handlers.test.ts)
// ---------------------------------------------------------------------------

interface SqlCall {
  strings: string[];
  values: unknown[];
}

/**
 * Create a mock sql tagged template function that captures all calls.
 * Returns result sets in FIFO order for each invocation.
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

  sqlFn.begin = async (cb: (tx: any) => Promise<void>) => {
    await cb(sqlFn);
  };

  return { sql: sqlFn as any, calls };
}

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

// Shared session row returned by resolveSessionByCC
const SESSION_ROW = { id: "sess-abc-123", workspace_id: "ws-001", device_id: "dev-001" };

/** Build a Phase 4-2 event with CC hook data structure */
function makeEvent(type: string, data: Record<string, unknown>, overrides?: Partial<Event>): Event {
  return {
    id: `evt-${type.replace(".", "-")}-001`,
    type: type as Event["type"],
    timestamp: "2025-07-01T10:00:00.000Z",
    device_id: "dev-001",
    workspace_id: "ws-001",
    session_id: null,
    data,
    ingested_at: null,
    blob_refs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleSubagentStart
// ---------------------------------------------------------------------------

describe("handleSubagentStart", () => {
  test("creates subagent row with status='running' when session found", async () => {
    const event = makeEvent("subagent.start", {
      session_id: "sess-abc-123",
      agent_id: "agent-x1",
      agent_type: "code",
      agent_name: "code-worker",
      model: "claude-sonnet-4-6",
      team_name: "api-team",
      isolation: "worktree",
      run_in_background: true,
    });
    const logger = createMockLogger();
    // Result sets: 1) resolveSessionByCC finds session, 2) INSERT
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleSubagentStart({ sql, event, workspaceId: "ws-001", logger });

    // 2 SQL calls: SELECT session + INSERT subagent
    expect(calls).toHaveLength(2);

    const insertCall = calls[1];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("INSERT INTO subagents");
    expect(queryText).toContain("ON CONFLICT");

    // Verify key values in the INSERT
    expect(insertCall.values).toContain("sess-abc-123"); // session_id
    expect(insertCall.values).toContain("agent-x1"); // agent_id
    expect(insertCall.values).toContain("code"); // agent_type
    expect(insertCall.values).toContain("code-worker"); // agent_name
    expect(insertCall.values).toContain("claude-sonnet-4-6"); // model
    expect(insertCall.values).toContain("running"); // status
    expect(insertCall.values).toContain("api-team"); // team_name
    expect(insertCall.values).toContain("worktree"); // isolation
    expect(insertCall.values).toContain(true); // run_in_background
  });

  test("skips when session not found", async () => {
    const event = makeEvent("subagent.start", {
      session_id: "nonexistent",
      agent_id: "agent-x1",
      agent_type: "code",
    });
    const logger = createMockLogger();
    // resolveSessionByCC returns empty
    const { sql, calls } = createMockSql([[]]);

    await handleSubagentStart({ sql, event, workspaceId: "ws-001", logger });

    // Only the session lookup query
    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("upsert on duplicate (session_id, agent_id) uses COALESCE for optional fields", async () => {
    const event = makeEvent("subagent.start", {
      session_id: "sess-abc-123",
      agent_id: "agent-x1",
      agent_type: "code",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleSubagentStart({ sql, event, workspaceId: "ws-001", logger });

    const insertCall = calls[1];
    const queryText = insertCall.strings.join("$");
    // Verify the upsert uses COALESCE for optional fields
    expect(queryText).toContain("ON CONFLICT (session_id, agent_id) DO UPDATE");
    expect(queryText).toContain("COALESCE");
  });
});

// ---------------------------------------------------------------------------
// handleSubagentStop
// ---------------------------------------------------------------------------

describe("handleSubagentStop", () => {
  test("updates existing subagent to status='completed' with ended_at", async () => {
    const event = makeEvent("subagent.stop", {
      session_id: "sess-abc-123",
      agent_id: "agent-x1",
      agent_type: "code",
      agent_transcript_path: "transcripts/sub/agent-x1.jsonl",
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) UPDATE returns 1 row (existing row found)
    const { sql, calls } = createMockSql([[SESSION_ROW], [{ id: "sub-row-1" }]]);

    await handleSubagentStop({ sql, event, workspaceId: "ws-001", logger });

    // 2 calls: session lookup + UPDATE
    expect(calls).toHaveLength(2);

    const updateCall = calls[1];
    const queryText = updateCall.strings.join("$");
    expect(queryText).toContain("UPDATE subagents");
    // "completed" is a parameterized value, not in the query template
    expect(updateCall.values).toContain("completed");
    expect(updateCall.values).toContain("agent-x1");
  });

  test("inserts complete row when stop arrives before start (no existing row)", async () => {
    const event = makeEvent("subagent.stop", {
      session_id: "sess-abc-123",
      agent_id: "agent-new",
      agent_type: "researcher",
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) UPDATE returns empty (no existing row), 3) INSERT
    const { sql, calls } = createMockSql([[SESSION_ROW], [], []]);

    await handleSubagentStop({ sql, event, workspaceId: "ws-001", logger });

    // 3 calls: session lookup + UPDATE (no match) + INSERT
    expect(calls).toHaveLength(3);

    const insertCall = calls[2];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("INSERT INTO subagents");
    expect(queryText).toContain("ON CONFLICT");
    expect(insertCall.values).toContain("completed");
    expect(insertCall.values).toContain("agent-new");
    expect(insertCall.values).toContain("researcher");
  });

  test("skips when session not found", async () => {
    const event = makeEvent("subagent.stop", {
      session_id: "nonexistent",
      agent_id: "agent-x1",
      agent_type: "code",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleSubagentStop({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleTeamCreate
// ---------------------------------------------------------------------------

describe("handleTeamCreate", () => {
  test("creates team row and sets session team_name/team_role", async () => {
    const event = makeEvent("team.create", {
      session_id: "sess-abc-123",
      team_name: "auth-team",
      description: "Authentication module team",
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) INSERT team, 3) UPDATE session
    const { sql, calls } = createMockSql([[SESSION_ROW], [], []]);

    await handleTeamCreate({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(3);

    // Verify team INSERT
    const insertCall = calls[1];
    const insertQuery = insertCall.strings.join("$");
    expect(insertQuery).toContain("INSERT INTO teams");
    expect(insertQuery).toContain("ON CONFLICT (team_name)");
    expect(insertCall.values).toContain("auth-team");
    expect(insertCall.values).toContain("Authentication module team");

    // Verify session UPDATE
    const updateCall = calls[2];
    const updateQuery = updateCall.strings.join("$");
    expect(updateQuery).toContain("UPDATE sessions");
    expect(updateCall.values).toContain("auth-team");
    expect(updateCall.values).toContain("lead");
    expect(updateCall.values).toContain("sess-abc-123");
  });

  test("upsert on duplicate team_name uses COALESCE for description", async () => {
    const event = makeEvent("team.create", {
      session_id: "sess-abc-123",
      team_name: "dup-team",
      description: "second description",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[SESSION_ROW], [], []]);

    await handleTeamCreate({ sql, event, workspaceId: "ws-001", logger });

    const insertCall = calls[1];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("ON CONFLICT (team_name) DO UPDATE");
    expect(queryText).toContain("COALESCE");
  });

  test("skips when session not found", async () => {
    const event = makeEvent("team.create", {
      session_id: "nonexistent",
      team_name: "ghost-team",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleTeamCreate({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleTeamMessage
// ---------------------------------------------------------------------------

describe("handleTeamMessage", () => {
  test("increments message_count in team metadata JSONB", async () => {
    const event = makeEvent("team.message", {
      session_id: "sess-abc-123",
      team_name: "auth-team",
      message_type: "task",
      from: "lead",
      to: "worker-1",
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) UPDATE team metadata (returns row = team found)
    const { sql, calls } = createMockSql([[SESSION_ROW], [{ id: "team-row-1" }]]);

    await handleTeamMessage({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(2);

    const updateCall = calls[1];
    const queryText = updateCall.strings.join("$");
    expect(queryText).toContain("UPDATE teams");
    expect(queryText).toContain("jsonb_set");
    expect(queryText).toContain("message_count");
    expect(updateCall.values).toContain("auth-team");
  });

  test("warns when team not found (no row updated)", async () => {
    const event = makeEvent("team.message", {
      session_id: "sess-abc-123",
      team_name: "nonexistent-team",
      message_type: "status",
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) UPDATE returns empty (team not found)
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleTeamMessage({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("skips when session not found", async () => {
    const event = makeEvent("team.message", {
      session_id: "nonexistent",
      team_name: "auth-team",
      message_type: "task",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleTeamMessage({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleSkillInvoke
// ---------------------------------------------------------------------------

describe("handleSkillInvoke", () => {
  test("inserts session_skills row with all fields", async () => {
    const event = makeEvent("skill.invoke", {
      session_id: "sess-abc-123",
      skill_name: "commit",
      args: "-m 'Fix bug'",
      invoked_by: "user",
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) INSERT
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleSkillInvoke({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(2);

    const insertCall = calls[1];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("INSERT INTO session_skills");
    expect(insertCall.values).toContain("sess-abc-123");
    expect(insertCall.values).toContain("commit");
    expect(insertCall.values).toContain("-m 'Fix bug'");
    expect(insertCall.values).toContain("user");
  });

  test("inserts with null args and invoked_by when not provided", async () => {
    const event = makeEvent("skill.invoke", {
      session_id: "sess-abc-123",
      skill_name: "pdf",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleSkillInvoke({ sql, event, workspaceId: "ws-001", logger });

    const insertCall = calls[1];
    // args and invoked_by should be null
    expect(insertCall.values).toContain(null); // args
    expect(insertCall.values).toContain(null); // invoked_by
  });

  test("multiple invocations create separate rows (no upsert)", async () => {
    const event1 = makeEvent("skill.invoke", {
      session_id: "sess-abc-123",
      skill_name: "commit",
    });
    const event2 = makeEvent("skill.invoke", {
      session_id: "sess-abc-123",
      skill_name: "review-pr",
    }, { id: "evt-skill-invoke-002" });
    const logger = createMockLogger();

    // Each invocation gets its own INSERT
    const { sql: sql1, calls: calls1 } = createMockSql([[SESSION_ROW], []]);
    await handleSkillInvoke({ sql: sql1, event: event1, workspaceId: "ws-001", logger });

    const { sql: sql2, calls: calls2 } = createMockSql([[SESSION_ROW], []]);
    await handleSkillInvoke({ sql: sql2, event: event2, workspaceId: "ws-001", logger });

    // Both should produce INSERT calls
    const q1 = calls1[1].strings.join("$");
    const q2 = calls2[1].strings.join("$");
    expect(q1).toContain("INSERT INTO session_skills");
    expect(q2).toContain("INSERT INTO session_skills");

    // No ON CONFLICT — each invocation is unique
    expect(q1).not.toContain("ON CONFLICT");
  });

  test("skips when session not found", async () => {
    const event = makeEvent("skill.invoke", {
      session_id: "nonexistent",
      skill_name: "commit",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleSkillInvoke({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleWorktreeCreate
// ---------------------------------------------------------------------------

describe("handleWorktreeCreate", () => {
  test("inserts session_worktrees row with name and branch", async () => {
    const event = makeEvent("worktree.create", {
      session_id: "sess-abc-123",
      worktree_name: "feature-x",
      branch: "feat/feature-x",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleWorktreeCreate({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(2);

    const insertCall = calls[1];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("INSERT INTO session_worktrees");
    expect(insertCall.values).toContain("sess-abc-123");
    expect(insertCall.values).toContain("feature-x");
    expect(insertCall.values).toContain("feat/feature-x");
  });

  test("handles null worktree_name and branch", async () => {
    const event = makeEvent("worktree.create", {
      session_id: "sess-abc-123",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[SESSION_ROW], []]);

    await handleWorktreeCreate({ sql, event, workspaceId: "ws-001", logger });

    const insertCall = calls[1];
    // worktree_name and branch should both be null
    const nullCount = insertCall.values.filter((v) => v === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
  });

  test("skips when session not found", async () => {
    const event = makeEvent("worktree.create", {
      session_id: "nonexistent",
      worktree_name: "ghost-wt",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleWorktreeCreate({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleWorktreeRemove
// ---------------------------------------------------------------------------

describe("handleWorktreeRemove", () => {
  test("updates existing worktree row with removed_at and had_changes", async () => {
    const event = makeEvent("worktree.remove", {
      session_id: "sess-abc-123",
      worktree_name: "feature-x",
      had_changes: true,
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) UPDATE returns row (existing worktree found)
    const { sql, calls } = createMockSql([[SESSION_ROW], [{ id: "wt-row-1" }]]);

    await handleWorktreeRemove({ sql, event, workspaceId: "ws-001", logger });

    // 2 calls: session lookup + UPDATE (found match)
    expect(calls).toHaveLength(2);

    const updateCall = calls[1];
    const queryText = updateCall.strings.join("$");
    expect(queryText).toContain("UPDATE session_worktrees");
    expect(queryText).toContain("removed_at");
    expect(queryText).toContain("had_changes");
    expect(updateCall.values).toContain("feature-x");
    expect(updateCall.values).toContain(true); // had_changes
  });

  test("inserts complete row when remove arrives before create", async () => {
    const event = makeEvent("worktree.remove", {
      session_id: "sess-abc-123",
      worktree_name: "orphan-wt",
      had_changes: false,
    });
    const logger = createMockLogger();
    // 1) session lookup, 2) UPDATE returns empty (no matching create), 3) INSERT
    const { sql, calls } = createMockSql([[SESSION_ROW], [], []]);

    await handleWorktreeRemove({ sql, event, workspaceId: "ws-001", logger });

    // 3 calls: session lookup + UPDATE (no match) + INSERT
    expect(calls).toHaveLength(3);

    const insertCall = calls[2];
    const queryText = insertCall.strings.join("$");
    expect(queryText).toContain("INSERT INTO session_worktrees");
    expect(insertCall.values).toContain("orphan-wt");
    expect(insertCall.values).toContain(false); // had_changes
  });

  test("skips when session not found", async () => {
    const event = makeEvent("worktree.remove", {
      session_id: "nonexistent",
      worktree_name: "ghost-wt",
    });
    const logger = createMockLogger();
    const { sql, calls } = createMockSql([[]]);

    await handleWorktreeRemove({ sql, event, workspaceId: "ws-001", logger });

    expect(calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Handler registry includes all Phase 4-2 event types
// ---------------------------------------------------------------------------

describe("Handler registry includes all Phase 4-2 event types", () => {
  test("createHandlerRegistry registers all 13 event types (2 session + 4 git + 7 CC hook)", () => {
    const registry = createHandlerRegistry();
    const types = registry.listRegisteredTypes();

    // Session lifecycle (Phase 1)
    expect(types).toContain("session.start");
    expect(types).toContain("session.end");

    // Git events (Phase 3)
    expect(types).toContain("git.commit");
    expect(types).toContain("git.push");
    expect(types).toContain("git.checkout");
    expect(types).toContain("git.merge");

    // CC hook events (Phase 4-2)
    expect(types).toContain("subagent.start");
    expect(types).toContain("subagent.stop");
    expect(types).toContain("team.create");
    expect(types).toContain("team.message");
    expect(types).toContain("skill.invoke");
    expect(types).toContain("worktree.create");
    expect(types).toContain("worktree.remove");

    expect(types).toHaveLength(13);
  });

  test("registry maps handlers to correct functions", () => {
    const registry = createHandlerRegistry();

    expect(registry.getHandler("subagent.start")).toBe(handleSubagentStart);
    expect(registry.getHandler("subagent.stop")).toBe(handleSubagentStop);
    expect(registry.getHandler("team.create")).toBe(handleTeamCreate);
    expect(registry.getHandler("team.message")).toBe(handleTeamMessage);
    expect(registry.getHandler("skill.invoke")).toBe(handleSkillInvoke);
    expect(registry.getHandler("worktree.create")).toBe(handleWorktreeCreate);
    expect(registry.getHandler("worktree.remove")).toBe(handleWorktreeRemove);
  });
});
