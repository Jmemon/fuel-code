/**
 * Unit tests for team detection — extractTeamIntervals().
 *
 * Tests the pure function that extracts team intervals from content blocks
 * and transcript messages. No database required — this is pure logic.
 *
 * Covers:
 *   1. Single team create (no delete) -> open-ended interval
 *   2. Single team create + delete -> bounded interval
 *   3. Multiple teams -> separate intervals
 *   4. Same team created, deleted, re-created -> two intervals
 *   5. No team blocks -> empty result
 *   6. TeamCreate with no team_name -> skipped
 *   7. TeamCreate with missing parent message timestamp -> skipped
 *   8. TeamDelete with no matching create -> ignored
 *   9. Ordering: intervals sorted by createdAt
 *  10. Description propagation from tool_input
 */

import { describe, expect, test } from "bun:test";
import { extractTeamIntervals } from "../team-detection.js";
import type { ParsedContentBlock, TranscriptMessage } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let blockOrderCounter = 0;

/** Create a minimal ParsedContentBlock for a TeamCreate tool call. */
function makeTeamCreateBlock(
  messageId: string,
  teamName: string,
  opts?: { description?: string; blockOrder?: number },
): ParsedContentBlock {
  blockOrderCounter++;
  return {
    id: `block-create-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-1",
    teammate_id: null,
    block_order: opts?.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: "TeamCreate",
    tool_use_id: `tu-create-${blockOrderCounter}`,
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
    id: `block-delete-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-1",
    teammate_id: null,
    block_order: opts?.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: "TeamDelete",
    tool_use_id: `tu-delete-${blockOrderCounter}`,
    tool_input: { team_name: teamName },
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

/** Create a non-team content block (e.g., a Bash tool call). */
function makeOtherBlock(messageId: string, toolName: string, opts?: { blockOrder?: number }): ParsedContentBlock {
  blockOrderCounter++;
  return {
    id: `block-other-${blockOrderCounter}`,
    message_id: messageId,
    session_id: "sess-1",
    teammate_id: null,
    block_order: opts?.blockOrder ?? blockOrderCounter,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: toolName,
    tool_use_id: `tu-other-${blockOrderCounter}`,
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
    session_id: "sess-1",
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

// Reset counter between tests
function resetCounter() {
  blockOrderCounter = 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractTeamIntervals", () => {
  test("returns empty array when no content blocks", () => {
    resetCounter();
    const result = extractTeamIntervals([], []);
    expect(result).toEqual([]);
  });

  test("returns empty array when no team-related blocks", () => {
    resetCounter();
    const blocks = [
      makeOtherBlock("msg-1", "Bash"),
      makeOtherBlock("msg-1", "Read"),
    ];
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals(blocks, messages);
    expect(result).toEqual([]);
  });

  test("single TeamCreate with no delete produces open-ended interval", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "backend-team", { description: "Backend work", blockOrder: 1 }),
    ];
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      teamName: "backend-team",
      description: "Backend work",
      createdAt: "2026-03-03T10:00:00Z",
      endedAt: null,
    });
  });

  test("TeamCreate + TeamDelete produces bounded interval", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "frontend-team", { blockOrder: 1 }),
      makeTeamDeleteBlock("msg-2", "frontend-team", { blockOrder: 5 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:30:00Z"),
    ];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      teamName: "frontend-team",
      description: null,
      createdAt: "2026-03-03T10:00:00Z",
      endedAt: "2026-03-03T10:30:00Z",
    });
  });

  test("multiple different teams produce separate intervals", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "alpha", { description: "Alpha team", blockOrder: 1 }),
      makeTeamCreateBlock("msg-2", "beta", { description: "Beta team", blockOrder: 2 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:05:00Z"),
    ];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(2);
    expect(result[0].teamName).toBe("alpha");
    expect(result[0].endedAt).toBeNull();
    expect(result[1].teamName).toBe("beta");
    expect(result[1].endedAt).toBeNull();
  });

  test("same team created, deleted, then re-created produces two intervals", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "ops", { description: "First run", blockOrder: 1 }),
      makeTeamDeleteBlock("msg-2", "ops", { blockOrder: 3 }),
      makeTeamCreateBlock("msg-3", "ops", { description: "Second run", blockOrder: 5 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:15:00Z"),
      makeMessage("msg-3", "2026-03-03T10:30:00Z"),
    ];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(2);

    // First interval: created then deleted
    expect(result[0]).toEqual({
      teamName: "ops",
      description: "First run",
      createdAt: "2026-03-03T10:00:00Z",
      endedAt: "2026-03-03T10:15:00Z",
    });

    // Second interval: re-created, still open
    expect(result[1]).toEqual({
      teamName: "ops",
      description: "Second run",
      createdAt: "2026-03-03T10:30:00Z",
      endedAt: null,
    });
  });

  test("TeamCreate with missing team_name in input is skipped", () => {
    resetCounter();
    const block: ParsedContentBlock = {
      id: "block-bad",
      message_id: "msg-1",
      session_id: "sess-1",
      teammate_id: null,
      block_order: 1,
      block_type: "tool_use",
      content_text: null,
      thinking_text: null,
      tool_name: "TeamCreate",
      tool_use_id: "tu-bad",
      tool_input: { description: "no name" }, // missing team_name
      tool_result_id: null,
      is_error: false,
      result_text: null,
      result_s3_key: null,
      metadata: {},
    };
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals([block], messages);
    expect(result).toEqual([]);
  });

  test("TeamCreate with null tool_input is skipped", () => {
    resetCounter();
    const block: ParsedContentBlock = {
      id: "block-null-input",
      message_id: "msg-1",
      session_id: "sess-1",
      teammate_id: null,
      block_order: 1,
      block_type: "tool_use",
      content_text: null,
      thinking_text: null,
      tool_name: "TeamCreate",
      tool_use_id: "tu-null",
      tool_input: null,
      tool_result_id: null,
      is_error: false,
      result_text: null,
      result_s3_key: null,
      metadata: {},
    };
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals([block], messages);
    expect(result).toEqual([]);
  });

  test("TeamCreate with no matching message timestamp is skipped", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-unknown", "ghost-team", { blockOrder: 1 }),
    ];
    // No message with id "msg-unknown"
    const messages: TranscriptMessage[] = [];

    const result = extractTeamIntervals(blocks, messages);
    expect(result).toEqual([]);
  });

  test("message with null timestamp causes block to be skipped", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "null-ts-team", { blockOrder: 1 }),
    ];
    const messages = [makeMessage("msg-1", null)]; // null timestamp

    const result = extractTeamIntervals(blocks, messages);
    expect(result).toEqual([]);
  });

  test("TeamDelete with no matching TeamCreate is ignored", () => {
    resetCounter();
    // Only a delete, no create
    const blocks = [
      makeTeamDeleteBlock("msg-1", "orphan-team", { blockOrder: 1 }),
    ];
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals(blocks, messages);
    expect(result).toEqual([]);
  });

  test("intervals are sorted by createdAt", () => {
    resetCounter();
    // Create team-B first chronologically, then team-A, but team-A has an earlier
    // message timestamp
    const blocks = [
      makeTeamCreateBlock("msg-2", "team-B", { blockOrder: 1 }),
      makeTeamCreateBlock("msg-1", "team-A", { blockOrder: 2 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T09:00:00Z"), // earlier timestamp
      makeMessage("msg-2", "2026-03-03T10:00:00Z"), // later timestamp
    ];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(2);
    // team-A has earlier timestamp so should come first
    expect(result[0].teamName).toBe("team-A");
    expect(result[1].teamName).toBe("team-B");
  });

  test("description is null when not provided in tool_input", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "no-desc-team", { blockOrder: 1 }),
    ];
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBeNull();
  });

  test("description is preserved from tool_input", () => {
    resetCounter();
    const blocks = [
      makeTeamCreateBlock("msg-1", "described-team", {
        description: "A team for testing",
        blockOrder: 1,
      }),
    ];
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("A team for testing");
  });

  test("non-tool_use blocks are ignored", () => {
    resetCounter();
    const textBlock: ParsedContentBlock = {
      id: "block-text",
      message_id: "msg-1",
      session_id: "sess-1",
      teammate_id: null,
      block_order: 1,
      block_type: "text",
      content_text: "TeamCreate mentioned in text",
      thinking_text: null,
      tool_name: null,
      tool_use_id: null,
      tool_input: null,
      tool_result_id: null,
      is_error: false,
      result_text: null,
      result_s3_key: null,
      metadata: {},
    };
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals([textBlock], messages);
    expect(result).toEqual([]);
  });

  test("delete only pairs with create that comes before it (by block_order)", () => {
    resetCounter();
    // Delete has block_order=1, create has block_order=5 -> delete should NOT pair
    const blocks = [
      makeTeamDeleteBlock("msg-1", "order-team", { blockOrder: 1 }),
      makeTeamCreateBlock("msg-2", "order-team", { blockOrder: 5 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:30:00Z"),
    ];

    const result = extractTeamIntervals(blocks, messages);

    // The create produces an open interval (the delete came before it, so no pairing)
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      teamName: "order-team",
      description: null,
      createdAt: "2026-03-03T10:30:00Z",
      endedAt: null,
    });
  });

  test("mixed team and non-team blocks are handled correctly", () => {
    resetCounter();
    const blocks = [
      makeOtherBlock("msg-1", "Bash", { blockOrder: 1 }),
      makeTeamCreateBlock("msg-2", "mixed-team", { description: "Test", blockOrder: 2 }),
      makeOtherBlock("msg-3", "Read", { blockOrder: 3 }),
      makeTeamDeleteBlock("msg-4", "mixed-team", { blockOrder: 4 }),
      makeOtherBlock("msg-5", "Edit", { blockOrder: 5 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:01:00Z"),
      makeMessage("msg-3", "2026-03-03T10:02:00Z"),
      makeMessage("msg-4", "2026-03-03T10:03:00Z"),
      makeMessage("msg-5", "2026-03-03T10:04:00Z"),
    ];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      teamName: "mixed-team",
      description: "Test",
      createdAt: "2026-03-03T10:01:00Z",
      endedAt: "2026-03-03T10:03:00Z",
    });
  });

  test("multiple creates with single delete pairs only the first", () => {
    resetCounter();
    // Two creates of the same team, one delete -> first create gets paired
    const blocks = [
      makeTeamCreateBlock("msg-1", "dup-team", { description: "First", blockOrder: 1 }),
      makeTeamCreateBlock("msg-2", "dup-team", { description: "Second", blockOrder: 3 }),
      makeTeamDeleteBlock("msg-3", "dup-team", { blockOrder: 5 }),
    ];
    const messages = [
      makeMessage("msg-1", "2026-03-03T10:00:00Z"),
      makeMessage("msg-2", "2026-03-03T10:10:00Z"),
      makeMessage("msg-3", "2026-03-03T10:20:00Z"),
    ];

    const result = extractTeamIntervals(blocks, messages);

    expect(result).toHaveLength(2);

    // First create gets the delete
    expect(result[0]).toEqual({
      teamName: "dup-team",
      description: "First",
      createdAt: "2026-03-03T10:00:00Z",
      endedAt: "2026-03-03T10:20:00Z",
    });

    // Second create is open-ended (delete was consumed by the first)
    expect(result[1]).toEqual({
      teamName: "dup-team",
      description: "Second",
      createdAt: "2026-03-03T10:10:00Z",
      endedAt: null,
    });
  });

  test("team name via 'name' field in tool_input (fallback)", () => {
    resetCounter();
    const block: ParsedContentBlock = {
      id: "block-name-field",
      message_id: "msg-1",
      session_id: "sess-1",
      teammate_id: null,
      block_order: 1,
      block_type: "tool_use",
      content_text: null,
      thinking_text: null,
      tool_name: "TeamCreate",
      tool_use_id: "tu-name-field",
      tool_input: { name: "name-field-team", description: "Via name field" },
      tool_result_id: null,
      is_error: false,
      result_text: null,
      result_s3_key: null,
      metadata: {},
    };
    const messages = [makeMessage("msg-1", "2026-03-03T10:00:00Z")];

    const result = extractTeamIntervals([block], messages);

    expect(result).toHaveLength(1);
    expect(result[0].teamName).toBe("name-field-team");
    expect(result[0].description).toBe("Via name field");
  });
});
