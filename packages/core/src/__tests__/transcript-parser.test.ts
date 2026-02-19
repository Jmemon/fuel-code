/**
 * Tests for the JSONL transcript parser.
 *
 * All test transcripts are inline JSONL strings for precise control over
 * edge cases. A sample fixture file is also tested for integration coverage.
 *
 * Each test verifies a specific aspect of the parser:
 *   - Message construction (ordinals, types, roles)
 *   - Content block extraction (text, thinking, tool_use, tool_result)
 *   - Assistant multi-line grouping by message.id
 *   - Token usage extraction from the last line of a group
 *   - Cost computation from known token counts
 *   - Stats aggregation (counts, sums, durations)
 *   - Edge cases (empty input, malformed JSON, oversized lines, etc.)
 */

import { describe, expect, test } from "bun:test";
import { parseTranscript } from "../transcript-parser.js";
import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helper: build a single JSONL line as a string
// ---------------------------------------------------------------------------

function jsonl(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

// ---------------------------------------------------------------------------
// 1. Simple conversation
// ---------------------------------------------------------------------------

describe("parseTranscript", () => {
  test("simple conversation: 1 user text + 1 assistant text", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Hello world" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_001",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "text", text: "Hi there!" }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // 2 messages: user + assistant
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].message_type).toBe("user");
    expect(result.messages[0].ordinal).toBe(0);
    expect(result.messages[1].message_type).toBe("assistant");
    expect(result.messages[1].ordinal).toBe(1);

    // 2 content blocks: user text + assistant text
    expect(result.contentBlocks).toHaveLength(2);
    expect(result.contentBlocks[0].block_type).toBe("text");
    expect(result.contentBlocks[0].content_text).toBe("Hello world");
    expect(result.contentBlocks[1].block_type).toBe("text");
    expect(result.contentBlocks[1].content_text).toBe("Hi there!");

    // No errors
    expect(result.errors).toHaveLength(0);

    // Session IDs on rows
    expect(result.messages[0].session_id).toBe("sess_1");
    expect(result.contentBlocks[0].session_id).toBe("sess_1");
  });

  // ---------------------------------------------------------------------------
  // 2. Multi-block assistant (grouped by message.id)
  // ---------------------------------------------------------------------------

  test("multi-block assistant: thinking + text + tool_use grouped into 1 message", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Fix the bug" },
      },
      // 3 JSONL lines for the same assistant message (streaming)
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_002",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "thinking", thinking: "Let me analyze the issue." }],
          usage: { input_tokens: 50, output_tokens: 10 },
        },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:02.000Z",
        message: {
          role: "assistant",
          id: "msg_002",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "text", text: "I found the bug." }],
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:03.000Z",
        message: {
          role: "assistant",
          id: "msg_002",
          model: "claude-sonnet-4-20250514",
          content: [{ type: "tool_use", id: "toolu_01", name: "Edit", input: { path: "foo.ts" } }],
          usage: { input_tokens: 50, output_tokens: 60 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // 2 messages total: 1 user + 1 assistant (3 lines grouped)
    expect(result.messages).toHaveLength(2);

    const assistantMsg = result.messages[1];
    expect(assistantMsg.message_type).toBe("assistant");
    expect(assistantMsg.has_thinking).toBe(true);
    expect(assistantMsg.has_text).toBe(true);
    expect(assistantMsg.has_tool_use).toBe(true);
    expect(assistantMsg.has_tool_result).toBe(false);

    // 4 content blocks: 1 user text + 3 assistant blocks
    expect(result.contentBlocks).toHaveLength(4);

    // Assistant blocks should all reference the same message_id
    const assistantBlocks = result.contentBlocks.filter(
      (b) => b.message_id === assistantMsg.id,
    );
    expect(assistantBlocks).toHaveLength(3);
    expect(assistantBlocks[0].block_type).toBe("thinking");
    expect(assistantBlocks[0].thinking_text).toBe("Let me analyze the issue.");
    expect(assistantBlocks[1].block_type).toBe("text");
    expect(assistantBlocks[2].block_type).toBe("tool_use");
    expect(assistantBlocks[2].tool_name).toBe("Edit");
  });

  // ---------------------------------------------------------------------------
  // 3. Tool round-trip
  // ---------------------------------------------------------------------------

  test("tool round-trip: assistant tool_use -> user tool_result", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_003",
          content: [{ type: "tool_use", id: "toolu_abc", name: "Read", input: { path: "x.ts" } }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "user",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_abc", content: "file contents here" },
          ],
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // Check tool_use block
    const toolUseBlock = result.contentBlocks.find((b) => b.block_type === "tool_use");
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock!.tool_use_id).toBe("toolu_abc");
    expect(toolUseBlock!.tool_name).toBe("Read");

    // Check tool_result block
    const toolResultBlock = result.contentBlocks.find((b) => b.block_type === "tool_result");
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.tool_result_id).toBe("toolu_abc");
    expect(toolResultBlock!.result_text).toBe("file contents here");

    // Flags on messages
    const assistantMsg = result.messages.find((m) => m.message_type === "assistant");
    expect(assistantMsg!.has_tool_use).toBe(true);

    const userMsg = result.messages.find((m) => m.message_type === "user");
    expect(userMsg!.has_tool_result).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 4. Token extraction
  // ---------------------------------------------------------------------------

  test("token extraction from assistant usage data", async () => {
    const input = jsonl({
      type: "assistant",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "assistant",
        id: "msg_004",
        content: [{ type: "text", text: "Done." }],
        usage: {
          input_tokens: 5000,
          output_tokens: 1200,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 500,
        },
      },
    });

    const result = await parseTranscript("sess_1", input);
    const msg = result.messages[0];

    expect(msg.tokens_in).toBe(5000);
    expect(msg.tokens_out).toBe(1200);
    expect(msg.cache_read).toBe(3000);
    expect(msg.cache_write).toBe(500);
  });

  // ---------------------------------------------------------------------------
  // 5. Cost computation
  // ---------------------------------------------------------------------------

  test("cost computation with known token counts", async () => {
    // Pricing: input $3/MTok, output $15/MTok, cache_read $0.30/MTok, cache_write $3.75/MTok
    // 10000 input tokens = 10000 * 3 / 1_000_000 = 0.030
    // 2000 output tokens  = 2000 * 15 / 1_000_000 = 0.030
    // 5000 cache_read     = 5000 * 0.30 / 1_000_000 = 0.0015
    // 1000 cache_write    = 1000 * 3.75 / 1_000_000 = 0.00375
    // Total = 0.06525
    const input = jsonl({
      type: "assistant",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "assistant",
        id: "msg_005",
        content: [{ type: "text", text: "Done." }],
        usage: {
          input_tokens: 10000,
          output_tokens: 2000,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 1000,
        },
      },
    });

    const result = await parseTranscript("sess_1", input);
    const msg = result.messages[0];

    expect(msg.cost_usd).toBeCloseTo(0.06525, 3);
    expect(result.stats.cost_estimate_usd).toBeCloseTo(0.06525, 3);
  });

  // ---------------------------------------------------------------------------
  // 6. Empty transcript
  // ---------------------------------------------------------------------------

  test("empty transcript returns empty results with zero stats", async () => {
    const result = await parseTranscript("sess_1", "");

    expect(result.messages).toHaveLength(0);
    expect(result.contentBlocks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.total_messages).toBe(0);
    expect(result.stats.user_messages).toBe(0);
    expect(result.stats.assistant_messages).toBe(0);
    expect(result.stats.tokens_in).toBe(0);
    expect(result.stats.tokens_out).toBe(0);
    expect(result.stats.cost_estimate_usd).toBe(0);
    expect(result.stats.duration_ms).toBe(0);
    expect(result.stats.initial_prompt).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 7. Malformed line
  // ---------------------------------------------------------------------------

  test("malformed JSON lines are recorded in errors, valid lines still parsed", async () => {
    const input = [
      JSON.stringify({
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Hello" },
      }),
      "this is not valid json {{{",
      JSON.stringify({
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_006",
          content: [{ type: "text", text: "Hi" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n");

    const result = await parseTranscript("sess_1", input);

    // 2 valid messages parsed
    expect(result.messages).toHaveLength(2);

    // 1 error for the malformed line
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(2);
    expect(result.errors[0].error).toBe("Invalid JSON");
  });

  // ---------------------------------------------------------------------------
  // 8. Metadata-only transcript (skip types)
  // ---------------------------------------------------------------------------

  test("progress and file-history-snapshot lines produce no messages", async () => {
    const input = jsonl(
      { type: "progress", data: { step: 1 } },
      { type: "file-history-snapshot", snapshot: { timestamp: "2025-05-10T10:00:00.000Z" } },
      { type: "queue-operation", data: { op: "enqueue" } },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.messages).toHaveLength(0);
    expect(result.contentBlocks).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 9. Large tool result truncation
  // ---------------------------------------------------------------------------

  test("tool result exceeding maxInlineContentBytes is truncated", async () => {
    // Create a tool result with content > 256 bytes (using a small limit for testing)
    const largeContent = "x".repeat(500);
    const input = jsonl({
      type: "user",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_big", content: largeContent }],
      },
    });

    const result = await parseTranscript("sess_1", input, {
      maxInlineContentBytes: 100,
    });

    const block = result.contentBlocks.find((b) => b.block_type === "tool_result");
    expect(block).toBeDefined();

    // Result text should be truncated
    expect(block!.result_text!.length).toBeLessThanOrEqual(100);
    // Metadata should indicate truncation
    expect(block!.metadata.truncated).toBe(true);
    expect(block!.metadata.original_byte_length).toBe(500);
  });

  // ---------------------------------------------------------------------------
  // 10. Initial prompt extraction
  // ---------------------------------------------------------------------------

  test("initial_prompt is text of first user message", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Build me a REST API" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_010",
          content: [{ type: "text", text: "Sure!" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.stats.initial_prompt).toBe("Build me a REST API");
  });

  test("initial_prompt is truncated to 1000 chars with ellipsis", async () => {
    const longPrompt = "A".repeat(1500);
    const input = jsonl({
      type: "user",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: { role: "user", content: longPrompt },
    });

    const result = await parseTranscript("sess_1", input);

    expect(result.stats.initial_prompt).toHaveLength(1003); // 1000 + "..."
    expect(result.stats.initial_prompt!.endsWith("...")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 11. Summary line
  // ---------------------------------------------------------------------------

  test("summary line creates a message_type='summary' message", async () => {
    const input = jsonl({
      type: "summary",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "assistant",
        content: "This conversation discussed adding a health check endpoint.",
      },
    });

    const result = await parseTranscript("sess_1", input);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].message_type).toBe("summary");
    expect(result.messages[0].role).toBe("assistant");

    // Content block should have the summary text
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks[0].content_text).toBe(
      "This conversation discussed adding a health check endpoint.",
    );
  });

  // ---------------------------------------------------------------------------
  // 12. Duration computation
  // ---------------------------------------------------------------------------

  test("duration_ms computed from first to last timestamp", async () => {
    const t0 = "2025-05-10T10:00:00.000Z"; // epoch ms: some value
    const t30m = "2025-05-10T10:30:00.000Z"; // 30 minutes later

    const input = jsonl(
      {
        type: "user",
        timestamp: t0,
        message: { role: "user", content: "Start" },
      },
      {
        type: "assistant",
        timestamp: t30m,
        message: {
          role: "assistant",
          id: "msg_012",
          content: [{ type: "text", text: "End" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // 30 minutes = 1800000 ms
    expect(result.stats.duration_ms).toBe(1_800_000);
  });

  // ---------------------------------------------------------------------------
  // 13. Subagent detection
  // ---------------------------------------------------------------------------

  test("tool_use with tool_name='Task' counted in subagent_count", async () => {
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_013a",
          content: [
            { type: "tool_use", id: "toolu_sub1", name: "Task", input: { prompt: "do thing" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:02.000Z",
        message: {
          role: "assistant",
          id: "msg_013b",
          content: [
            { type: "tool_use", id: "toolu_edit1", name: "Edit", input: { path: "x.ts" } },
            { type: "tool_use", id: "toolu_sub2", name: "Task", input: { prompt: "other" } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // 3 tool_use blocks total, 2 of which are "Task" subagents
    expect(result.stats.tool_use_count).toBe(3);
    expect(result.stats.subagent_count).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------------------

  test("assistant with string content (not array) treated as single text block", async () => {
    const input = jsonl({
      type: "assistant",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "assistant",
        id: "msg_str",
        content: "Plain string response",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const result = await parseTranscript("sess_1", input);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].has_text).toBe(true);
    expect(result.contentBlocks).toHaveLength(1);
    expect(result.contentBlocks[0].block_type).toBe("text");
    expect(result.contentBlocks[0].content_text).toBe("Plain string response");
  });

  test("null content: message has all has_* flags false", async () => {
    const input = jsonl({
      type: "assistant",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "assistant",
        id: "msg_null",
        content: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });

    const result = await parseTranscript("sess_1", input);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].has_text).toBe(false);
    expect(result.messages[0].has_thinking).toBe(false);
    expect(result.messages[0].has_tool_use).toBe(false);
    expect(result.messages[0].has_tool_result).toBe(false);
    expect(result.contentBlocks).toHaveLength(0);
  });

  test("unknown type field recorded as error", async () => {
    const input = jsonl({ type: "banana", message: { content: "wat" } });

    const result = await parseTranscript("sess_1", input);

    expect(result.messages).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("Unknown line type");
  });

  test("missing type field recorded as error", async () => {
    const input = jsonl({ message: { content: "no type" } });

    const result = await parseTranscript("sess_1", input);

    expect(result.messages).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("Missing type field");
  });

  test("metadata extracted from first line with sessionId/cwd/version/gitBranch", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        sessionId: "cc_sess_xyz",
        cwd: "/home/dev/project",
        version: "1.2.3",
        gitBranch: "feature/cool",
        message: { role: "user", content: "Hi" },
      },
      {
        type: "user",
        timestamp: "2025-05-10T10:00:05.000Z",
        sessionId: "cc_sess_xyz",
        cwd: "/home/dev/other",
        version: "1.2.4",
        gitBranch: "main",
        message: { role: "user", content: "Bye" },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // Metadata comes from the first line only
    expect(result.metadata.sessionId).toBe("cc_sess_xyz");
    expect(result.metadata.cwd).toBe("/home/dev/project");
    expect(result.metadata.version).toBe("1.2.3");
    expect(result.metadata.gitBranch).toBe("feature/cool");
    expect(result.metadata.firstTimestamp).toBe("2025-05-10T10:00:00.000Z");
    expect(result.metadata.lastTimestamp).toBe("2025-05-10T10:00:05.000Z");
  });

  test("token usage from last line of assistant group (streaming)", async () => {
    // Three streaming lines for one assistant message. Usage on last line is most complete.
    const input = jsonl(
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: {
          role: "assistant",
          id: "msg_stream",
          content: [{ type: "thinking", thinking: "hmm" }],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_stream",
          content: [{ type: "text", text: "result" }],
          usage: { input_tokens: 500, output_tokens: 200 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    // Should use usage from the LAST line
    expect(result.messages[0].tokens_in).toBe(500);
    expect(result.messages[0].tokens_out).toBe(200);
  });

  test("tool_result with is_error flag", async () => {
    const input = jsonl({
      type: "user",
      timestamp: "2025-05-10T10:00:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_err",
            content: "Command failed with exit code 1",
            is_error: true,
          },
        ],
      },
    });

    const result = await parseTranscript("sess_1", input);

    const block = result.contentBlocks.find((b) => b.block_type === "tool_result");
    expect(block).toBeDefined();
    expect(block!.is_error).toBe(true);
    expect(block!.tool_result_id).toBe("toolu_err");
  });

  test("onLineError callback is invoked for errors", async () => {
    const errorLog: Array<{ lineNumber: number; error: string }> = [];

    const input = [
      "not json",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "ok" },
      }),
    ].join("\n");

    await parseTranscript("sess_1", input, {
      onLineError: (lineNumber, error) => {
        errorLog.push({ lineNumber, error });
      },
    });

    expect(errorLog).toHaveLength(1);
    expect(errorLog[0].lineNumber).toBe(1);
    expect(errorLog[0].error).toBe("Invalid JSON");
  });

  test("line exceeding 5MB is skipped with error", async () => {
    // Create a line that's over 5MB when encoded
    const hugeLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(6 * 1024 * 1024) },
    });

    const input = [
      hugeLine,
      JSON.stringify({
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "small" },
      }),
    ].join("\n");

    const result = await parseTranscript("sess_1", input);

    // The huge line should be skipped, the small line parsed
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].has_text).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("Line exceeds max size");
  });

  // ---------------------------------------------------------------------------
  // Fixture file integration test
  // ---------------------------------------------------------------------------

  test("parses sample-transcript.jsonl fixture correctly", async () => {
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "sample-transcript.jsonl",
    );
    const input = readFileSync(fixturePath, "utf-8");

    const result = await parseTranscript("sess_fixture", input);

    // The fixture has: 1 system + 4 user + 4 assistant messages (msg_001 is 2 lines grouped)
    // system line, user line, assistant msg_001 (2 lines), user tool_result,
    // assistant msg_002, user tool_result, assistant msg_003, user tool_result, assistant msg_004
    // = 1 system + 4 user + 4 assistant = 9 messages
    expect(result.messages).toHaveLength(9);

    // Metadata from the first line (system)
    expect(result.metadata.sessionId).toBe("sess_abc123");
    expect(result.metadata.cwd).toBe("/home/user/project");
    expect(result.metadata.version).toBe("1.0.25");
    expect(result.metadata.gitBranch).toBe("main");

    // No errors
    expect(result.errors).toHaveLength(0);

    // Should have subagent usage (msg_003 uses "Task" tool)
    expect(result.stats.subagent_count).toBe(1);

    // Duration: first timestamp 14:00:00 to last 14:00:17 = 17 seconds = 17000ms
    expect(result.stats.duration_ms).toBe(17_000);

    // Initial prompt should be from the first user message
    expect(result.stats.initial_prompt).toBe(
      "Add a health check endpoint to the Express server",
    );

    // Stats should aggregate token counts from all assistant messages
    expect(result.stats.tokens_in).toBeGreaterThan(0);
    expect(result.stats.tokens_out).toBeGreaterThan(0);
    expect(result.stats.cost_estimate_usd).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // ReadableStream input
  // ---------------------------------------------------------------------------

  test("parses ReadableStream input correctly", async () => {
    const text = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Stream test" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_stream_test",
          content: [{ type: "text", text: "Streamed!" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    );

    // Create a ReadableStream from the text
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });

    const result = await parseTranscript("sess_1", stream);

    expect(result.messages).toHaveLength(2);
    expect(result.contentBlocks).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Stats aggregation across multiple assistant messages
  // ---------------------------------------------------------------------------

  test("stats aggregate tokens and costs across multiple messages", async () => {
    const input = jsonl(
      {
        type: "user",
        timestamp: "2025-05-10T10:00:00.000Z",
        message: { role: "user", content: "Q1" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:01.000Z",
        message: {
          role: "assistant",
          id: "msg_a1",
          content: [{ type: "text", text: "A1" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
      {
        type: "user",
        timestamp: "2025-05-10T10:00:02.000Z",
        message: { role: "user", content: "Q2" },
      },
      {
        type: "assistant",
        timestamp: "2025-05-10T10:00:03.000Z",
        message: {
          role: "assistant",
          id: "msg_a2",
          content: [{ type: "text", text: "A2" }],
          usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
        },
      },
    );

    const result = await parseTranscript("sess_1", input);

    expect(result.stats.total_messages).toBe(4);
    expect(result.stats.user_messages).toBe(2);
    expect(result.stats.assistant_messages).toBe(2);
    expect(result.stats.tokens_in).toBe(300);
    expect(result.stats.tokens_out).toBe(150);
    expect(result.stats.cache_read_tokens).toBe(50);
    expect(result.stats.cache_write_tokens).toBe(10);
  });
});
