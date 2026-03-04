/**
 * E2E tests for team detection and teammate extraction.
 *
 * Tests the full flow of extracting teams and teammates from parsed content
 * blocks, including multi-team scenarios, deduplication, and edge cases.
 * All tests are pure logic — no database required.
 *
 * These tests complement the unit tests in reconcile/__tests__/team-detection.test.ts
 * and reconcile/__tests__/teammate-mapping.test.ts by focusing on integrated
 * scenarios that exercise multiple functions together.
 *
 * Test scenarios:
 *   1. extractTeamIntervals with TeamCreate block -> returns team intervals
 *   2. extractTeamIntervals with no team blocks -> returns empty array
 *   3. extractTeammates with Agent tool_use -> returns teammate entries
 *   4. Multiple teams in one session -> all detected with correct boundaries
 *   5. Full pipeline: extractTeamIntervals -> extractTeammates integration
 *   6. Team create/delete/re-create cycle -> two intervals
 *   7. Mixed team and non-team content -> only team blocks extracted
 *   8. Teammate deduplication across multiple Agent blocks
 *   9. Teammate extraction with no matching teams -> empty result
 *  10. extractTeammateMapping combined extraction
 */

import { describe, expect, test } from "bun:test";
import {
  extractTeamIntervals,
  extractTeammates,
  type TeamInterval,
  type PersistedTeam,
} from "../reconcile/team-detection.js";
import {
  extractTeammateName,
  extractTeamName,
  extractTeammateMapping,
} from "../reconcile/teammate-mapping.js";
import type { ParsedContentBlock, TranscriptMessage, ParseResult } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Helpers — shared across all tests
// ---------------------------------------------------------------------------

let blockOrderCounter = 0;

function resetCounter() {
  blockOrderCounter = 0;
}

/** Create a minimal ParsedContentBlock for a TeamCreate tool call. */
function makeTeamCreateBlock(
  messageId: string,
  teamName: string,
  opts?: { description?: string; blockOrder?: number },
): ParsedContentBlock {
  blockOrderCounter++;
  return {
    id: `block-e2e-create-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-e2e",
    teammate_id: null,
    block_order: opts?.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: "TeamCreate",
    tool_use_id: `tu-e2e-create-${blockOrderCounter}`,
    tool_input: {
      team_name: teamName,
      ...(opts?.description ? { description: opts.description } : {}),
    },
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

/** Create a minimal ParsedContentBlock for a TeamDelete tool call. */
function makeTeamDeleteBlock(
  messageId: string,
  teamName: string,
  opts?: { blockOrder?: number },
): ParsedContentBlock {
  blockOrderCounter++;
  return {
    id: `block-e2e-delete-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-e2e",
    teammate_id: null,
    block_order: opts?.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: "TeamDelete",
    tool_use_id: `tu-e2e-delete-${blockOrderCounter}`,
    tool_input: { team_name: teamName },
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

/** Create an Agent tool_use content block with team affiliation. */
function makeAgentBlock(
  messageId: string,
  opts: { name?: string; team_name?: string; blockOrder?: number },
): ParsedContentBlock {
  blockOrderCounter++;
  return {
    id: `block-e2e-agent-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-e2e",
    teammate_id: null,
    block_order: opts.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: "Agent",
    tool_use_id: `tu-e2e-agent-${blockOrderCounter}`,
    tool_input: {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.team_name ? { team_name: opts.team_name } : {}),
      prompt: "do work",
    },
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

/** Create a non-team content block (e.g., Bash tool call). */
function makeOtherBlock(
  messageId: string,
  toolName: string,
  opts?: { blockOrder?: number },
): ParsedContentBlock {
  blockOrderCounter++;
  return {
    id: `block-e2e-other-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-e2e",
    teammate_id: null,
    block_order: opts?.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: toolName,
    tool_use_id: `tu-e2e-other-${blockOrderCounter}`,
    tool_input: { command: "ls" },
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

/** Create a minimal TranscriptMessage with a timestamp. */
function makeMessage(id: string, timestamp: string | null): TranscriptMessage {
  return {
    id,
    session_id: "sess-e2e",
    teammate_id: null,
    line_number: 1,
    ordinal: 1,
    message_type: "assistant",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    cost_usd: null,
    compact_sequence: 0,
    is_compacted: false,
    timestamp,
    raw_message: null,
    metadata: {},
    has_text: false,
    has_thinking: false,
    has_tool_use: true,
    has_tool_result: false,
  };
}

/** Create a minimal PersistedTeam for testing teammate extraction. */
function makePersistedTeam(teamName: string, id?: string): PersistedTeam {
  return {
    id: id ?? `team-e2e-${teamName}`,
    session_id: "sess-e2e",
    team_name: teamName,
    description: null,
    created_at: "2026-03-03T10:00:00Z",
  };
}

/** Create a minimal ParseResult for extractTeammateName/extractTeamName tests. */
function makeParseResult(overrides?: Partial<ParseResult>): ParseResult {
  return {
    messages: [],
    contentBlocks: [],
    stats: {
      total_messages: 0,
      user_messages: 0,
      assistant_messages: 0,
      tool_use_count: 0,
      thinking_blocks: 0,
      subagent_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_estimate_usd: 0,
      duration_ms: 0,
      initial_prompt: null,
    },
    errors: [],
    metadata: {
      sessionId: null,
      cwd: null,
      version: null,
      gitBranch: null,
      firstTimestamp: null,
      lastTimestamp: null,
    },
    subagents: [],
    teams: [],
    skills: [],
    worktrees: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E2E tests
// ---------------------------------------------------------------------------

describe("team detection E2E", () => {
  // -----------------------------------------------------------------------
  // 1. extractTeamIntervals with TeamCreate block -> returns team intervals
  // -----------------------------------------------------------------------

  test("extractTeamIntervals with TeamCreate block returns team interval", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "backend-team", {
        description: "Backend API refactoring",
        blockOrder: 1,
      }),
    ];
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const intervals = extractTeamIntervals(blocks, messages);

    expect(intervals).toHaveLength(1);
    expect(intervals[0].teamName).toBe("backend-team");
    expect(intervals[0].description).toBe("Backend API refactoring");
    expect(intervals[0].createdAt).toBe("2026-03-03T10:00:00Z");
    expect(intervals[0].endedAt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 2. extractTeamIntervals with no team blocks -> returns empty array
  // -----------------------------------------------------------------------

  test("extractTeamIntervals with no team blocks returns empty array", () => {
    resetCounter();
    const blocks = [
      makeOtherBlock("msg-1", "Bash", { blockOrder: 1 }),
      makeOtherBlock("msg-1", "Read", { blockOrder: 2 }),
      makeOtherBlock("msg-2", "Edit", { blockOrder: 3 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:01:00Z"),
    ];

    const intervals = extractTeamIntervals(blocks, messages);

    expect(intervals).toEqual([]);
  });

  test("extractTeamIntervals with empty inputs returns empty array", () => {
    resetCounter();
    expect(extractTeamIntervals([], [])).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 3. extractTeammates with Agent tool_use -> returns teammate entries
  // -----------------------------------------------------------------------

  test("extractTeammates with Agent tool_use returns teammate entries with implicit lead", () => {
    resetCounter();
    const blocks = [
      makeAgentBlock("msg-1", { name: "alice", team_name: "research-team", blockOrder: 1 }),
    ];
    const teams = [makePersistedTeam("research-team")];

    const teammates = extractTeammates(blocks, teams);

    // Should have alice (member) + implicit lead
    expect(teammates).toHaveLength(2);

    const alice = teammates.find(t => t.entityName === "alice");
    expect(alice).toBeDefined();
    expect(alice!.role).toBe("member");
    expect(alice!.entityType).toBe("agent");
    expect(alice!.teamName).toBe("research-team");

    const lead = teammates.find(t => t.role === "lead");
    expect(lead).toBeDefined();
    expect(lead!.entityName).toBe("lead");
    expect(lead!.entityType).toBe("human");
  });

  // -----------------------------------------------------------------------
  // 4. Multiple teams in one session -> all detected
  // -----------------------------------------------------------------------

  test("multiple teams in one session are all detected with correct intervals", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "frontend-team", {
        description: "UI work",
        blockOrder: 1,
      }),
      makeTeamCreateBlock("msg-2", "backend-team", {
        description: "API work",
        blockOrder: 2,
      }),
      makeTeamCreateBlock("msg-3", "testing-team", {
        description: "E2E testing",
        blockOrder: 3,
      }),
      makeTeamDeleteBlock("msg-4", "frontend-team", { blockOrder: 10 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:05:00Z"),
      makeMessage("msg-3", "2026-03-03T10:10:00Z"),
      makeMessage("msg-4", "2026-03-03T11:00:00Z"),
    ];

    const intervals = extractTeamIntervals(blocks, messages);

    expect(intervals).toHaveLength(3);

    // Intervals are sorted by createdAt
    expect(intervals[0].teamName).toBe("frontend-team");
    expect(intervals[0].description).toBe("UI work");
    expect(intervals[0].endedAt).toBe("2026-03-03T11:00:00Z"); // paired with delete

    expect(intervals[1].teamName).toBe("backend-team");
    expect(intervals[1].description).toBe("API work");
    expect(intervals[1].endedAt).toBeNull(); // no delete

    expect(intervals[2].teamName).toBe("testing-team");
    expect(intervals[2].description).toBe("E2E testing");
    expect(intervals[2].endedAt).toBeNull(); // no delete
  });

  // -----------------------------------------------------------------------
  // 5. Full pipeline: extractTeamIntervals -> simulate persist -> extractTeammates
  // -----------------------------------------------------------------------

  test("full pipeline: team intervals feed into teammate extraction", () => {
    resetCounter();

    // Step 1: Create team blocks and agent blocks
    const blocks = [
      makeTeamCreateBlock("msg-1", "dev-team", { description: "Dev work", blockOrder: 1 }),
      makeAgentBlock("msg-2", { name: "alice", team_name: "dev-team", blockOrder: 2 }),
      makeAgentBlock("msg-3", { name: "bob", team_name: "dev-team", blockOrder: 3 }),
      makeAgentBlock("msg-4", { name: "carol", team_name: "dev-team", blockOrder: 4 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:01:00Z"),
      makeMessage("msg-3", "2026-03-03T10:02:00Z"),
      makeMessage("msg-4", "2026-03-03T10:03:00Z"),
    ];

    // Step 2: Extract team intervals
    const intervals = extractTeamIntervals(blocks, messages);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].teamName).toBe("dev-team");

    // Step 3: Simulate persistence by creating a PersistedTeam from the interval
    const persistedTeams: PersistedTeam[] = intervals.map((interval, i) => ({
      id: `team-persisted-${i}`,
      session_id: "sess-e2e",
      team_name: interval.teamName,
      description: interval.description,
      created_at: interval.createdAt,
    }));

    // Step 4: Extract teammates using the persisted teams
    const teammates = extractTeammates(blocks, persistedTeams);

    // 3 members (alice, bob, carol) + 1 implicit lead = 4
    expect(teammates).toHaveLength(4);

    const memberNames = teammates
      .filter(t => t.role === "member")
      .map(t => t.entityName)
      .sort();
    expect(memberNames).toEqual(["alice", "bob", "carol"]);

    const leads = teammates.filter(t => t.role === "lead");
    expect(leads).toHaveLength(1);
    expect(leads[0].teamName).toBe("dev-team");
    expect(leads[0].entityType).toBe("human");
  });

  // -----------------------------------------------------------------------
  // 6. Team create/delete/re-create cycle -> two intervals
  // -----------------------------------------------------------------------

  test("team create/delete/re-create produces two separate intervals", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "ops", { description: "First run", blockOrder: 1 }),
      makeTeamDeleteBlock("msg-2", "ops", { blockOrder: 3 }),
      makeTeamCreateBlock("msg-3", "ops", { description: "Second run", blockOrder: 5 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:30:00Z"),
      makeMessage("msg-3", "2026-03-03T11:00:00Z"),
    ];

    const intervals = extractTeamIntervals(blocks, messages);

    expect(intervals).toHaveLength(2);

    // First interval: created then deleted
    expect(intervals[0].teamName).toBe("ops");
    expect(intervals[0].description).toBe("First run");
    expect(intervals[0].createdAt).toBe("2026-03-03T10:00:00Z");
    expect(intervals[0].endedAt).toBe("2026-03-03T10:30:00Z");

    // Second interval: re-created, still open
    expect(intervals[1].teamName).toBe("ops");
    expect(intervals[1].description).toBe("Second run");
    expect(intervals[1].createdAt).toBe("2026-03-03T11:00:00Z");
    expect(intervals[1].endedAt).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 7. Mixed team and non-team content -> only team blocks extracted
  // -----------------------------------------------------------------------

  test("mixed content: non-team blocks are ignored during extraction", () => {
    resetCounter();
    const blocks = [
      makeOtherBlock("msg-1", "Bash", { blockOrder: 1 }),
      makeTeamCreateBlock("msg-2", "mixed-team", { blockOrder: 2 }),
      makeOtherBlock("msg-3", "Read", { blockOrder: 3 }),
      makeOtherBlock("msg-4", "Grep", { blockOrder: 4 }),
      makeTeamDeleteBlock("msg-5", "mixed-team", { blockOrder: 5 }),
      makeOtherBlock("msg-6", "Edit", { blockOrder: 6 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:01:00Z"),
      makeMessage("msg-3", "2026-03-03T10:02:00Z"),
      makeMessage("msg-4", "2026-03-03T10:03:00Z"),
      makeMessage("msg-5", "2026-03-03T10:04:00Z"),
      makeMessage("msg-6", "2026-03-03T10:05:00Z"),
    ];

    const intervals = extractTeamIntervals(blocks, messages);

    expect(intervals).toHaveLength(1);
    expect(intervals[0].teamName).toBe("mixed-team");
    expect(intervals[0].createdAt).toBe("2026-03-03T10:01:00Z");
    expect(intervals[0].endedAt).toBe("2026-03-03T10:04:00Z");
  });

  // -----------------------------------------------------------------------
  // 8. Teammate deduplication: same agent spawned multiple times
  // -----------------------------------------------------------------------

  test("teammate deduplication: same agent in same team is counted once", () => {
    resetCounter();
    const blocks = [
      makeAgentBlock("msg-1", { name: "alice", team_name: "ops", blockOrder: 1 }),
      makeAgentBlock("msg-2", { name: "alice", team_name: "ops", blockOrder: 2 }),
      makeAgentBlock("msg-3", { name: "alice", team_name: "ops", blockOrder: 3 }),
      makeAgentBlock("msg-4", { name: "bob", team_name: "ops", blockOrder: 4 }),
    ];
    const teams = [makePersistedTeam("ops")];

    const teammates = extractTeammates(blocks, teams);

    // alice (1) + bob (1) + lead (1) = 3
    const members = teammates.filter(t => t.role === "member");
    expect(members).toHaveLength(2);
    expect(members.map(t => t.entityName).sort()).toEqual(["alice", "bob"]);
  });

  test("same agent in different teams gets separate entries", () => {
    resetCounter();
    const blocks = [
      makeAgentBlock("msg-1", { name: "alice", team_name: "team-a", blockOrder: 1 }),
      makeAgentBlock("msg-2", { name: "alice", team_name: "team-b", blockOrder: 2 }),
    ];
    const teams = [
      makePersistedTeam("team-a"),
      makePersistedTeam("team-b"),
    ];

    const teammates = extractTeammates(blocks, teams);

    // alice in team-a + alice in team-b + lead in team-a + lead in team-b = 4
    const alices = teammates.filter(t => t.entityName === "alice");
    expect(alices).toHaveLength(2);
    expect(alices.map(t => t.teamName).sort()).toEqual(["team-a", "team-b"]);
  });

  // -----------------------------------------------------------------------
  // 9. Teammate extraction with no matching teams -> empty result
  // -----------------------------------------------------------------------

  test("teammates referencing non-persisted teams are excluded", () => {
    resetCounter();
    const blocks = [
      makeAgentBlock("msg-1", { name: "alice", team_name: "phantom-team", blockOrder: 1 }),
    ];
    // No persisted teams
    const teams: PersistedTeam[] = [];

    const teammates = extractTeammates(blocks, teams);

    expect(teammates).toEqual([]);
  });

  test("teammates with no team_name in input are excluded", () => {
    resetCounter();
    // Agent block without team_name — not a team-affiliated spawn
    const blocks = [
      makeAgentBlock("msg-1", { name: "solo-agent", blockOrder: 1 }),
    ];
    const teams = [makePersistedTeam("some-team")];

    const teammates = extractTeammates(blocks, teams);

    expect(teammates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Teammate mapping E2E tests
// ---------------------------------------------------------------------------

describe("teammate mapping E2E", () => {
  // -----------------------------------------------------------------------
  // 10. extractTeammateMapping combined extraction
  // -----------------------------------------------------------------------

  test("extracts both teammate name and team name from a subagent transcript", () => {
    // Simulate a subagent transcript with routing.sender and metadata.teamName
    const routingBlock: ParsedContentBlock = {
      id: "block-routing",
      message_id: "msg-1",
      session_id: "sess-e2e",
      teammate_id: null,
      block_order: 1,
      block_type: "tool_result",
      content_text: null,
      thinking_text: null,
      tool_name: null,
      tool_use_id: null,
      tool_input: null,
      tool_result_id: "tu-sm-1",
      is_error: false,
      result_text: JSON.stringify({
        routing: { sender: "alice", recipient: "bob" },
        type: "message_sent",
      }),
      result_s3_key: null,
      metadata: {},
    };

    const teamMsg: TranscriptMessage = {
      id: "msg-team",
      session_id: "sess-e2e",
      teammate_id: null,
      line_number: 1,
      ordinal: 1,
      message_type: "user",
      role: "user",
      model: null,
      tokens_in: null,
      tokens_out: null,
      cache_read: null,
      cache_write: null,
      cost_usd: null,
      compact_sequence: 0,
      is_compacted: false,
      timestamp: "2026-03-03T10:00:00Z",
      raw_message: { role: "user", content: "hello" },
      metadata: { teamName: "api-team" },
      has_text: true,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };

    const pr = makeParseResult({
      contentBlocks: [routingBlock],
      messages: [teamMsg],
    });

    const mapping = extractTeammateMapping(pr);
    expect(mapping.teammateName).toBe("alice");
    expect(mapping.teamName).toBe("api-team");
  });

  test("returns null for both when subagent has no team context", () => {
    const pr = makeParseResult({
      messages: [{
        id: "msg-plain",
        session_id: "sess-e2e",
        teammate_id: null,
        line_number: 1,
        ordinal: 1,
        message_type: "assistant",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        tokens_in: 100,
        tokens_out: 50,
        cache_read: null,
        cache_write: null,
        cost_usd: null,
        compact_sequence: 0,
        is_compacted: false,
        timestamp: "2026-03-03T10:00:00Z",
        raw_message: { role: "assistant", content: "Just a normal message" },
        metadata: {},
        has_text: true,
        has_thinking: false,
        has_tool_use: false,
        has_tool_result: false,
      }],
    });

    const mapping = extractTeammateMapping(pr);
    expect(mapping.teammateName).toBeNull();
    expect(mapping.teamName).toBeNull();
  });

  test("extractTeammateName from XML in user message", () => {
    const xmlMsg: TranscriptMessage = {
      id: "msg-xml",
      session_id: "sess-e2e",
      teammate_id: null,
      line_number: 1,
      ordinal: 1,
      message_type: "user",
      role: "user",
      model: null,
      tokens_in: null,
      tokens_out: null,
      cache_read: null,
      cache_write: null,
      cost_usd: null,
      compact_sequence: 0,
      is_compacted: false,
      timestamp: "2026-03-03T10:00:00Z",
      raw_message: {
        role: "user",
        content: '<teammate-message teammate_id="bob" color="green" summary="Bob says hello">\nHello from Bob\n</teammate-message>',
      },
      metadata: {},
      has_text: false,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };

    const pr = makeParseResult({ messages: [xmlMsg] });
    const name = extractTeammateName(pr);
    expect(name).toBe("bob");
  });

  test("extractTeamName from teams array fallback", () => {
    const pr = makeParseResult({
      teams: [{ team_name: "infra-team", message_count: 10 }],
    });
    const name = extractTeamName(pr);
    expect(name).toBe("infra-team");
  });

  test("extractTeamName returns null for empty parse result", () => {
    const pr = makeParseResult();
    const name = extractTeamName(pr);
    expect(name).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Multi-team teammate distribution
  // -----------------------------------------------------------------------

  test("teammates across multiple teams get correct team associations", () => {
    resetCounter();
    const blocks = [
      makeAgentBlock("msg-1", { name: "alice", team_name: "frontend", blockOrder: 1 }),
      makeAgentBlock("msg-2", { name: "bob", team_name: "frontend", blockOrder: 2 }),
      makeAgentBlock("msg-3", { name: "carol", team_name: "backend", blockOrder: 3 }),
      makeAgentBlock("msg-4", { name: "dave", team_name: "backend", blockOrder: 4 }),
    ];
    const teams = [
      makePersistedTeam("frontend", "team-fe"),
      makePersistedTeam("backend", "team-be"),
    ];

    const teammates = extractTeammates(blocks, teams);

    // Frontend: alice + bob + lead = 3
    // Backend: carol + dave + lead = 3
    // Total = 6
    expect(teammates).toHaveLength(6);

    const frontendMembers = teammates
      .filter(t => t.teamName === "frontend" && t.role === "member")
      .map(t => t.entityName)
      .sort();
    expect(frontendMembers).toEqual(["alice", "bob"]);

    const backendMembers = teammates
      .filter(t => t.teamName === "backend" && t.role === "member")
      .map(t => t.entityName)
      .sort();
    expect(backendMembers).toEqual(["carol", "dave"]);

    // Each team should have exactly one lead
    const frontendLeads = teammates.filter(t => t.teamName === "frontend" && t.role === "lead");
    expect(frontendLeads).toHaveLength(1);

    const backendLeads = teammates.filter(t => t.teamName === "backend" && t.role === "lead");
    expect(backendLeads).toHaveLength(1);
  });
});
