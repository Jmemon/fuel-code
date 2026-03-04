/**
 * Unit tests for teammate mapping — extractTeammateName(), extractTeamName(),
 * extractTeammateMapping().
 *
 * Tests the pure extraction functions that identify which teammate a subagent
 * belongs to by scanning its parsed transcript. No database required for the
 * extraction tests; resolveTeammateId() tests are omitted since they require
 * a real Postgres connection.
 *
 * Covers:
 *   extractTeammateName:
 *     1. routing.sender in SendMessage tool_result blocks
 *     2. teammate-message XML tags in user messages (string content)
 *     3. teammate-message XML tags in user messages (array content)
 *     4. routing.sender takes priority over XML tags
 *     5. Non-team subagent returns null
 *     6. Empty parse result returns null
 *     7. Malformed JSON in tool_result is skipped
 *     8. tool_result without routing.sender is skipped
 *     9. Only tool_result blocks are checked (not tool_use)
 *    10. Empty sender string is skipped
 *    11. Non-user messages are not checked for XML tags
 *    12. teammate_id with escaped quotes in JSON strings
 *
 *   extractTeamName:
 *     1. teamName from message metadata
 *     2. teamName from raw_message
 *     3. Fallback to ParseResult.teams array
 *     4. No team name returns null
 *     5. First message with teamName wins
 *
 *   extractTeammateMapping:
 *     1. Returns both teammate name and team name
 *     2. Returns null for both when not in team context
 */

import { describe, expect, test } from "bun:test";
import {
  extractTeammateName,
  extractTeamName,
  extractTeammateMapping,
} from "../teammate-mapping.js";
import type { ParseResult, ParsedContentBlock, TranscriptMessage } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Create a minimal ParseResult with overridable fields. */
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

/** Create a tool_result content block with SendMessage routing.sender. */
function makeRoutingBlock(
  sender: string,
  opts?: { extraFields?: Record<string, unknown> },
): ParsedContentBlock {
  idCounter++;
  const routing: Record<string, unknown> = { sender, ...(opts?.extraFields ?? {}) };
  return {
    id: `block-routing-${idCounter}`,
    message_id: `msg-${idCounter}`,
    session_id: "sess-1",
    teammate_id: null,
    block_order: idCounter,
    block_type: "tool_result",
    content_text: null,
    thinking_text: null,
    tool_name: null,
    tool_use_id: null,
    tool_input: null,
    tool_result_id: `tu-sm-${idCounter}`,
    is_error: false,
    result_text: JSON.stringify({ routing, type: "message_sent" }),
    result_s3_key: null,
    metadata: {},
  };
}

/** Create a tool_result content block with arbitrary result_text. */
function makeToolResultBlock(
  resultText: string | null,
  opts?: { blockType?: "tool_result" | "tool_use" },
): ParsedContentBlock {
  idCounter++;
  return {
    id: `block-result-${idCounter}`,
    message_id: `msg-${idCounter}`,
    session_id: "sess-1",
    teammate_id: null,
    block_order: idCounter,
    block_type: opts?.blockType ?? "tool_result",
    content_text: null,
    thinking_text: null,
    tool_name: null,
    tool_use_id: opts?.blockType === "tool_use" ? `tu-${idCounter}` : null,
    tool_input: null,
    tool_result_id: opts?.blockType === "tool_use" ? null : `tu-${idCounter}`,
    is_error: false,
    result_text: resultText,
    result_s3_key: null,
    metadata: {},
  };
}

/** Create a user TranscriptMessage with teammate-message XML in string content. */
function makeTeammateXmlMessage(
  teammateId: string,
  opts?: { content?: string; color?: string; messageType?: string },
): TranscriptMessage {
  idCounter++;
  const color = opts?.color ?? "green";
  const innerContent = opts?.content ?? "Hello from teammate";
  const xmlContent = `<teammate-message teammate_id="${teammateId}" color="${color}" summary="Test message">\n${innerContent}\n</teammate-message>`;

  return {
    id: `msg-xml-${idCounter}`,
    session_id: "sess-1",
    teammate_id: null,
    line_number: idCounter,
    ordinal: idCounter,
    message_type: opts?.messageType ?? "user",
    role: opts?.messageType === "assistant" ? "assistant" : "user",
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
      content: xmlContent,
    },
    metadata: {},
    has_text: false,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
  };
}

/** Create a user TranscriptMessage with teammate-message XML in array content. */
function makeTeammateXmlArrayMessage(
  teammateId: string,
  opts?: { fieldName?: "content" | "text" },
): TranscriptMessage {
  idCounter++;
  const fieldName = opts?.fieldName ?? "content";
  const xmlContent = `<teammate-message teammate_id="${teammateId}" color="blue">\nArray content\n</teammate-message>`;

  const contentBlock: Record<string, unknown> = {
    type: "text",
    [fieldName]: xmlContent,
  };

  return {
    id: `msg-xml-arr-${idCounter}`,
    session_id: "sess-1",
    teammate_id: null,
    line_number: idCounter,
    ordinal: idCounter,
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
      content: [contentBlock],
    },
    metadata: {},
    has_text: false,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
  };
}

/** Create a TranscriptMessage with metadata containing teamName. */
function makeMessageWithTeamName(
  teamName: string,
  source: "metadata" | "raw_message",
): TranscriptMessage {
  idCounter++;
  return {
    id: `msg-team-${idCounter}`,
    session_id: "sess-1",
    teammate_id: null,
    line_number: idCounter,
    ordinal: idCounter,
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
    raw_message: source === "raw_message"
      ? { role: "user", content: "hello", teamName }
      : { role: "user", content: "hello" },
    metadata: source === "metadata" ? { teamName } : {},
    has_text: true,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
  };
}

/** Create a plain TranscriptMessage with no team or teammate info. */
function makePlainMessage(opts?: { messageType?: string }): TranscriptMessage {
  idCounter++;
  return {
    id: `msg-plain-${idCounter}`,
    session_id: "sess-1",
    teammate_id: null,
    line_number: idCounter,
    ordinal: idCounter,
    message_type: opts?.messageType ?? "assistant",
    role: opts?.messageType === "user" ? "user" : "assistant",
    model: "claude-sonnet-4-20250514",
    tokens_in: 100,
    tokens_out: 50,
    cache_read: null,
    cache_write: null,
    cost_usd: null,
    compact_sequence: 0,
    is_compacted: false,
    timestamp: "2026-03-03T10:00:00Z",
    raw_message: {
      role: opts?.messageType === "user" ? "user" : "assistant",
      content: "Just a normal message",
    },
    metadata: {},
    has_text: true,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
  };
}

function resetCounter() {
  idCounter = 0;
}

// ---------------------------------------------------------------------------
// extractTeammateName tests
// ---------------------------------------------------------------------------

describe("extractTeammateName", () => {
  test("returns null for empty parse result", () => {
    resetCounter();
    const result = extractTeammateName(makeParseResult());
    expect(result).toBeNull();
  });

  test("extracts teammate name from routing.sender in tool_result block", () => {
    resetCounter();
    const block = makeRoutingBlock("alice");
    const pr = makeParseResult({ contentBlocks: [block] });

    const result = extractTeammateName(pr);
    expect(result).toBe("alice");
  });

  test("returns first routing.sender when multiple exist", () => {
    resetCounter();
    const block1 = makeRoutingBlock("alice");
    const block2 = makeRoutingBlock("bob");
    const pr = makeParseResult({ contentBlocks: [block1, block2] });

    const result = extractTeammateName(pr);
    expect(result).toBe("alice");
  });

  test("extracts teammate name from <teammate-message> XML in string content", () => {
    resetCounter();
    const msg = makeTeammateXmlMessage("bob");
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBe("bob");
  });

  test("extracts teammate name from <teammate-message> XML in array content (content field)", () => {
    resetCounter();
    const msg = makeTeammateXmlArrayMessage("carol", { fieldName: "content" });
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBe("carol");
  });

  test("extracts teammate name from <teammate-message> XML in array content (text field)", () => {
    resetCounter();
    const msg = makeTeammateXmlArrayMessage("dave", { fieldName: "text" });
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBe("dave");
  });

  test("routing.sender takes priority over XML tags", () => {
    resetCounter();
    const routingBlock = makeRoutingBlock("alice");
    const xmlMsg = makeTeammateXmlMessage("bob");
    const pr = makeParseResult({
      contentBlocks: [routingBlock],
      messages: [xmlMsg],
    });

    const result = extractTeammateName(pr);
    expect(result).toBe("alice");
  });

  test("falls back to XML when routing.sender is not present", () => {
    resetCounter();
    // Non-routing tool_result block
    const nonRoutingBlock = makeToolResultBlock(JSON.stringify({ success: true }));
    const xmlMsg = makeTeammateXmlMessage("charlie");
    const pr = makeParseResult({
      contentBlocks: [nonRoutingBlock],
      messages: [xmlMsg],
    });

    const result = extractTeammateName(pr);
    expect(result).toBe("charlie");
  });

  test("returns null for non-team subagent (no routing or XML)", () => {
    resetCounter();
    const plainBlock = makeToolResultBlock(JSON.stringify({ output: "done" }));
    const plainMsg = makePlainMessage({ messageType: "user" });
    const pr = makeParseResult({
      contentBlocks: [plainBlock],
      messages: [plainMsg],
    });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("skips malformed JSON in tool_result result_text", () => {
    resetCounter();
    const badJsonBlock = makeToolResultBlock("not valid json {{{");
    const xmlMsg = makeTeammateXmlMessage("fallback-teammate");
    const pr = makeParseResult({
      contentBlocks: [badJsonBlock],
      messages: [xmlMsg],
    });

    // Should skip the bad JSON and fall back to XML
    const result = extractTeammateName(pr);
    expect(result).toBe("fallback-teammate");
  });

  test("skips tool_result with routing but no sender field", () => {
    resetCounter();
    const noSenderBlock = makeToolResultBlock(
      JSON.stringify({ routing: { destination: "somewhere" } }),
    );
    const pr = makeParseResult({ contentBlocks: [noSenderBlock] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("skips tool_result with null result_text", () => {
    resetCounter();
    const nullBlock = makeToolResultBlock(null);
    const pr = makeParseResult({ contentBlocks: [nullBlock] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("skips empty string sender in routing", () => {
    resetCounter();
    const emptyBlock = makeToolResultBlock(
      JSON.stringify({ routing: { sender: "" } }),
    );
    const pr = makeParseResult({ contentBlocks: [emptyBlock] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("skips non-string sender in routing", () => {
    resetCounter();
    const numericBlock = makeToolResultBlock(
      JSON.stringify({ routing: { sender: 42 } }),
    );
    const pr = makeParseResult({ contentBlocks: [numericBlock] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("only checks tool_result blocks, not tool_use blocks", () => {
    resetCounter();
    // A tool_use block with routing.sender in result_text should be ignored
    const toolUseBlock = makeToolResultBlock(
      JSON.stringify({ routing: { sender: "sneaky" } }),
      { blockType: "tool_use" },
    );
    const pr = makeParseResult({ contentBlocks: [toolUseBlock] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("does not check assistant messages for XML tags", () => {
    resetCounter();
    // An assistant message with teammate-message XML should not match
    const assistantMsg = makeTeammateXmlMessage("ghost", { messageType: "assistant" });
    const pr = makeParseResult({ messages: [assistantMsg] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("handles teammate-message with escaped quotes (JSON-encoded JSONL)", () => {
    resetCounter();
    // In real JSONL, the content string may have escaped quotes
    const msg: TranscriptMessage = {
      id: "msg-escaped",
      session_id: "sess-1",
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
        content: '<teammate-message teammate_id="escaped-teammate" color="red">\nHello\n</teammate-message>',
      },
      metadata: {},
      has_text: false,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBe("escaped-teammate");
  });

  test("handles message with null raw_message gracefully", () => {
    resetCounter();
    const msg: TranscriptMessage = {
      id: "msg-null-raw",
      session_id: "sess-1",
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
      raw_message: null,
      metadata: {},
      has_text: false,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("handles real-world teammate-message format from CC", () => {
    resetCounter();
    // This is the actual format observed in Claude Code transcripts
    const msg: TranscriptMessage = {
      id: "msg-real",
      session_id: "sess-1",
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
      timestamp: "2026-03-03T18:50:05.397Z",
      raw_message: {
        role: "user",
        content: '<teammate-message teammate_id="bob" color="green" summary="Bob fires back with 45893 in round 3, refusing to back down">\nDOMINATES?! Oh alice, I LOVE the confidence! But let me tell you something - bob doesn\'t sweat, bob PERSPIRES EXCELLENCE!\n\n**Round 3/30 - Bob\'s move: 45893**\n\nYou think you control the heat? The heat and I are on a first-name basis, baby! This game is only getting started. Buckle up, because round 3 is just the appetizer!\n</teammate-message>',
      },
      metadata: {},
      has_text: false,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBe("bob");
  });

  test("handles system teammate-message (teammate_id='system')", () => {
    resetCounter();
    const msg: TranscriptMessage = {
      id: "msg-system",
      session_id: "sess-1",
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
        content: '<teammate-message teammate_id="system">\n{"type":"teammate_terminated","message":"client has shut down."}\n</teammate-message>',
      },
      metadata: {},
      has_text: false,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeammateName(pr);
    expect(result).toBe("system");
  });

  test("handles routing.sender with complex nested result structure", () => {
    resetCounter();
    const block = makeToolResultBlock(
      JSON.stringify({
        type: "message_sent",
        routing: {
          sender: "designer",
          recipient: "backend",
          team: "birthday-app",
        },
        messageId: "msg-123",
        timestamp: "2026-03-03T10:00:00Z",
      }),
    );
    const pr = makeParseResult({ contentBlocks: [block] });

    const result = extractTeammateName(pr);
    expect(result).toBe("designer");
  });

  test("skips text content blocks (only checks tool_result)", () => {
    resetCounter();
    const textBlock: ParsedContentBlock = {
      id: "block-text",
      message_id: "msg-1",
      session_id: "sess-1",
      teammate_id: null,
      block_order: 1,
      block_type: "text",
      content_text: JSON.stringify({ routing: { sender: "hidden" } }),
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
    const pr = makeParseResult({ contentBlocks: [textBlock] });

    const result = extractTeammateName(pr);
    expect(result).toBeNull();
  });

  test("multiple user messages — first with teammate_id wins", () => {
    resetCounter();
    const msg1 = makePlainMessage({ messageType: "user" });
    const msg2 = makeTeammateXmlMessage("first-teammate");
    const msg3 = makeTeammateXmlMessage("second-teammate");
    const pr = makeParseResult({ messages: [msg1, msg2, msg3] });

    const result = extractTeammateName(pr);
    expect(result).toBe("first-teammate");
  });
});

// ---------------------------------------------------------------------------
// extractTeamName tests
// ---------------------------------------------------------------------------

describe("extractTeamName", () => {
  test("returns null for empty parse result", () => {
    resetCounter();
    const result = extractTeamName(makeParseResult());
    expect(result).toBeNull();
  });

  test("extracts team name from message metadata", () => {
    resetCounter();
    const msg = makeMessageWithTeamName("backend-team", "metadata");
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeamName(pr);
    expect(result).toBe("backend-team");
  });

  test("extracts team name from raw_message.teamName", () => {
    resetCounter();
    const msg = makeMessageWithTeamName("frontend-team", "raw_message");
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeamName(pr);
    expect(result).toBe("frontend-team");
  });

  test("metadata teamName takes priority over raw_message teamName", () => {
    resetCounter();
    // Create a message with both metadata and raw_message teamName
    const msg: TranscriptMessage = {
      id: "msg-both",
      session_id: "sess-1",
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
      raw_message: { role: "user", content: "hi", teamName: "raw-team" },
      metadata: { teamName: "meta-team" },
      has_text: true,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeamName(pr);
    expect(result).toBe("meta-team");
  });

  test("falls back to ParseResult.teams array", () => {
    resetCounter();
    const plainMsg = makePlainMessage();
    const pr = makeParseResult({
      messages: [plainMsg],
      teams: [{ team_name: "ops-team", message_count: 5 }],
    });

    const result = extractTeamName(pr);
    expect(result).toBe("ops-team");
  });

  test("first message with teamName wins", () => {
    resetCounter();
    const msg1 = makeMessageWithTeamName("first-team", "metadata");
    const msg2 = makeMessageWithTeamName("second-team", "metadata");
    const pr = makeParseResult({ messages: [msg1, msg2] });

    const result = extractTeamName(pr);
    expect(result).toBe("first-team");
  });

  test("returns null when no team info present anywhere", () => {
    resetCounter();
    const plainMsg = makePlainMessage();
    const pr = makeParseResult({ messages: [plainMsg] });

    const result = extractTeamName(pr);
    expect(result).toBeNull();
  });

  test("skips messages with null raw_message", () => {
    resetCounter();
    const msg: TranscriptMessage = {
      id: "msg-null",
      session_id: "sess-1",
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
      raw_message: null,
      metadata: {},
      has_text: false,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeamName(pr);
    expect(result).toBeNull();
  });

  test("skips non-string teamName in metadata", () => {
    resetCounter();
    const msg: TranscriptMessage = {
      id: "msg-bad-meta",
      session_id: "sess-1",
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
      raw_message: { role: "user", content: "hi" },
      metadata: { teamName: 42 },
      has_text: true,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeamName(pr);
    expect(result).toBeNull();
  });

  test("skips empty string teamName in metadata", () => {
    resetCounter();
    const msg: TranscriptMessage = {
      id: "msg-empty-meta",
      session_id: "sess-1",
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
      raw_message: { role: "user", content: "hi" },
      metadata: { teamName: "" },
      has_text: true,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
    };
    const pr = makeParseResult({ messages: [msg] });

    const result = extractTeamName(pr);
    expect(result).toBeNull();
  });

  test("returns first team name from teams array when multiple exist", () => {
    resetCounter();
    const pr = makeParseResult({
      teams: [
        { team_name: "alpha-team", message_count: 3 },
        { team_name: "beta-team", message_count: 7 },
      ],
    });

    const result = extractTeamName(pr);
    expect(result).toBe("alpha-team");
  });
});

// ---------------------------------------------------------------------------
// extractTeammateMapping tests
// ---------------------------------------------------------------------------

describe("extractTeammateMapping", () => {
  test("returns both teammate name and team name when available", () => {
    resetCounter();
    const routingBlock = makeRoutingBlock("alice");
    const teamMsg = makeMessageWithTeamName("research-team", "metadata");
    const pr = makeParseResult({
      contentBlocks: [routingBlock],
      messages: [teamMsg],
    });

    const mapping = extractTeammateMapping(pr);
    expect(mapping).toEqual({
      teammateName: "alice",
      teamName: "research-team",
    });
  });

  test("returns null for both when parse result has no team info", () => {
    resetCounter();
    const plainMsg = makePlainMessage();
    const plainBlock = makeToolResultBlock(JSON.stringify({ ok: true }));
    const pr = makeParseResult({
      contentBlocks: [plainBlock],
      messages: [plainMsg],
    });

    const mapping = extractTeammateMapping(pr);
    expect(mapping).toEqual({
      teammateName: null,
      teamName: null,
    });
  });

  test("returns teammate name without team name if only routing present", () => {
    resetCounter();
    const routingBlock = makeRoutingBlock("bob");
    const pr = makeParseResult({ contentBlocks: [routingBlock] });

    const mapping = extractTeammateMapping(pr);
    expect(mapping.teammateName).toBe("bob");
    expect(mapping.teamName).toBeNull();
  });

  test("returns team name without teammate name if only team info present", () => {
    resetCounter();
    const teamMsg = makeMessageWithTeamName("solo-team", "metadata");
    const pr = makeParseResult({ messages: [teamMsg] });

    const mapping = extractTeammateMapping(pr);
    expect(mapping.teammateName).toBeNull();
    expect(mapping.teamName).toBe("solo-team");
  });

  test("combines XML teammate and teams array team name", () => {
    resetCounter();
    const xmlMsg = makeTeammateXmlMessage("carol");
    const pr = makeParseResult({
      messages: [xmlMsg],
      teams: [{ team_name: "dev-team", message_count: 2 }],
    });

    const mapping = extractTeammateMapping(pr);
    expect(mapping).toEqual({
      teammateName: "carol",
      teamName: "dev-team",
    });
  });
});
