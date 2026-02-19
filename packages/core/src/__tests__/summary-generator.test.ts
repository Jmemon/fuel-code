/**
 * Tests for the summary generator: prompt rendering, initial prompt extraction,
 * and generateSummary guard clauses.
 *
 * All tests are unit tests — no real Anthropic API calls are made. The tests
 * verify prompt rendering logic, truncation behavior, and the early-return
 * guard clauses in generateSummary.
 */

import { describe, expect, test } from "bun:test";
import type { TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";
import {
  renderTranscriptForSummary,
  extractInitialPrompt,
  generateSummary,
  type SummaryConfig,
} from "../summary-generator.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Counter for generating unique IDs across test helpers */
let idCounter = 0;

/**
 * Build a minimal TranscriptMessage for testing.
 * Defaults to a user message with has_text: true.
 */
function makeMessage(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  idCounter++;
  return {
    id: `msg-${idCounter}`,
    session_id: "sess-001",
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
    timestamp: "2024-06-15T10:00:00.000Z",
    raw_message: null,
    metadata: {},
    has_text: true,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
    ...overrides,
  };
}

/**
 * Build a minimal ParsedContentBlock for testing.
 * Defaults to a text block.
 */
function makeBlock(overrides: Partial<ParsedContentBlock> = {}): ParsedContentBlock {
  idCounter++;
  return {
    id: `block-${idCounter}`,
    message_id: `msg-1`, // default; override to link to specific message
    session_id: "sess-001",
    block_order: 0,
    block_type: "text",
    content_text: null,
    thinking_text: null,
    tool_name: null,
    tool_use_id: null,
    tool_input: null,
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
    ...overrides,
  };
}

/** Default config with summary generation disabled (for guard clause tests) */
function makeConfig(overrides: Partial<SummaryConfig> = {}): SummaryConfig {
  return {
    enabled: true,
    model: "claude-sonnet-4-5-20250929",
    temperature: 0.3,
    maxOutputTokens: 150,
    apiKey: "test-api-key",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderTranscriptForSummary tests
// ---------------------------------------------------------------------------

describe("renderTranscriptForSummary", () => {
  test("produces readable markdown with user/assistant turns from 3 messages", () => {
    // Reset counter for predictable IDs
    idCounter = 0;

    const userMsg = makeMessage({
      id: "msg-user-1",
      role: "user",
      message_type: "user",
      ordinal: 1,
    });
    const assistantMsg = makeMessage({
      id: "msg-asst-1",
      role: "assistant",
      message_type: "assistant",
      model: "claude-sonnet-4-5-20250929",
      ordinal: 2,
      has_text: true,
      has_tool_use: true,
    });
    const userMsg2 = makeMessage({
      id: "msg-user-2",
      role: "user",
      message_type: "user",
      ordinal: 3,
    });

    const blocks: ParsedContentBlock[] = [
      makeBlock({
        message_id: "msg-user-1",
        block_type: "text",
        content_text: "Fix the login bug in auth.ts",
        block_order: 0,
      }),
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "text",
        content_text: "I'll fix the login bug by updating the token validation.",
        block_order: 0,
      }),
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "tool_use",
        tool_name: "Read",
        block_order: 1,
      }),
      makeBlock({
        message_id: "msg-user-2",
        block_type: "text",
        content_text: "Looks good, now add tests",
        block_order: 0,
      }),
    ];

    const result = renderTranscriptForSummary(
      [userMsg, assistantMsg, userMsg2],
      blocks
    );

    // Should contain the header
    expect(result).toContain("# Session Transcript");
    expect(result).toContain("Messages: 3");
    expect(result).toContain("Tool uses: 1");

    // Should contain user and assistant turns
    expect(result).toContain("[User]: Fix the login bug in auth.ts");
    expect(result).toContain("[Assistant]: I'll fix the login bug by updating the token validation.");
    expect(result).toContain("- Used Read");
    expect(result).toContain("[User]: Looks good, now add tests");
  });

  test("output truncated to < 8000 chars with 200+ messages", () => {
    idCounter = 0;

    // Generate 200 user/assistant pairs with substantial content
    const messages: TranscriptMessage[] = [];
    const blocks: ParsedContentBlock[] = [];

    for (let i = 0; i < 200; i++) {
      const userMsgId = `msg-user-${i}`;
      const asstMsgId = `msg-asst-${i}`;

      messages.push(
        makeMessage({
          id: userMsgId,
          role: "user",
          message_type: "user",
          ordinal: i * 2,
          timestamp: new Date(Date.now() + i * 60_000).toISOString(),
        })
      );
      messages.push(
        makeMessage({
          id: asstMsgId,
          role: "assistant",
          message_type: "assistant",
          model: "claude-sonnet-4-5-20250929",
          ordinal: i * 2 + 1,
          timestamp: new Date(Date.now() + i * 60_000 + 30_000).toISOString(),
        })
      );

      blocks.push(
        makeBlock({
          message_id: userMsgId,
          block_type: "text",
          content_text: `User message ${i}: ${"a".repeat(100)}`,
          block_order: 0,
        })
      );
      blocks.push(
        makeBlock({
          message_id: asstMsgId,
          block_type: "text",
          content_text: `Assistant response ${i}: ${"b".repeat(100)}`,
          block_order: 0,
        })
      );
    }

    const result = renderTranscriptForSummary(messages, blocks);

    // Should be truncated with the marker
    expect(result).toContain("... [truncated");
    expect(result).toContain("messages] ...");

    // Total length should be reasonable (head + tail + marker < ~8000 + marker overhead)
    // The output is TRUNCATE_HEAD + TRUNCATE_TAIL + marker text, roughly ~6200 chars
    expect(result.length).toBeLessThan(8000);
  });

  test("excludes thinking blocks and tool results", () => {
    idCounter = 0;

    const assistantMsg = makeMessage({
      id: "msg-asst-1",
      role: "assistant",
      message_type: "assistant",
      model: "claude-sonnet-4-5-20250929",
      ordinal: 1,
      has_text: true,
      has_thinking: true,
      has_tool_use: true,
      has_tool_result: true,
    });

    const blocks: ParsedContentBlock[] = [
      // Thinking block — should be excluded
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "thinking",
        thinking_text: "Let me think about this carefully...",
        block_order: 0,
      }),
      // Text block — should be included
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "text",
        content_text: "Here is my answer.",
        block_order: 1,
      }),
      // Tool use — should be included (name only)
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "tool_use",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        block_order: 2,
      }),
      // Tool result — should be excluded
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "tool_result",
        result_text: "file1.ts\nfile2.ts",
        tool_result_id: "tool-123",
        block_order: 3,
      }),
    ];

    const result = renderTranscriptForSummary([assistantMsg], blocks);

    // Text and tool use should be present
    expect(result).toContain("[Assistant]: Here is my answer.");
    expect(result).toContain("- Used Bash");

    // Thinking and tool results should NOT be present
    expect(result).not.toContain("Let me think about this carefully");
    expect(result).not.toContain("file1.ts");
    expect(result).not.toContain("file2.ts");
    // Ensure tool input is not rendered
    expect(result).not.toContain("ls -la");
  });

  test("includes tool use names as bullet list", () => {
    idCounter = 0;

    const assistantMsg = makeMessage({
      id: "msg-asst-1",
      role: "assistant",
      message_type: "assistant",
      ordinal: 1,
      has_tool_use: true,
    });

    const blocks: ParsedContentBlock[] = [
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "tool_use",
        tool_name: "Read",
        block_order: 0,
      }),
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "tool_use",
        tool_name: "Edit",
        block_order: 1,
      }),
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "tool_use",
        tool_name: "Bash",
        block_order: 2,
      }),
    ];

    const result = renderTranscriptForSummary([assistantMsg], blocks);

    // All three tool uses should appear as bullet points
    expect(result).toContain("- Used Read");
    expect(result).toContain("- Used Edit");
    expect(result).toContain("- Used Bash");

    // Header should report 3 tool uses
    expect(result).toContain("Tool uses: 3");
  });
});

// ---------------------------------------------------------------------------
// extractInitialPrompt tests
// ---------------------------------------------------------------------------

describe("extractInitialPrompt", () => {
  test("returns first user message text (first 1000 chars)", () => {
    idCounter = 0;

    const userMsg1 = makeMessage({
      id: "msg-user-1",
      role: "user",
      ordinal: 1,
    });
    const userMsg2 = makeMessage({
      id: "msg-user-2",
      role: "user",
      ordinal: 3,
    });

    const blocks: ParsedContentBlock[] = [
      makeBlock({
        message_id: "msg-user-1",
        block_type: "text",
        content_text: "Fix the authentication bug in the login handler",
        block_order: 0,
      }),
      makeBlock({
        message_id: "msg-user-2",
        block_type: "text",
        content_text: "Now add tests for it",
        block_order: 0,
      }),
    ];

    const result = extractInitialPrompt([userMsg1, userMsg2], blocks);

    expect(result).toBe("Fix the authentication bug in the login handler");
  });

  test("truncates text longer than 1000 chars with ellipsis", () => {
    idCounter = 0;

    const longText = "x".repeat(1500);
    const userMsg = makeMessage({
      id: "msg-user-1",
      role: "user",
      ordinal: 1,
    });

    const blocks: ParsedContentBlock[] = [
      makeBlock({
        message_id: "msg-user-1",
        block_type: "text",
        content_text: longText,
        block_order: 0,
      }),
    ];

    const result = extractInitialPrompt([userMsg], blocks);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1003); // 1000 chars + "..."
    expect(result!.endsWith("...")).toBe(true);
  });

  test("returns null when no user messages exist", () => {
    idCounter = 0;

    const assistantMsg = makeMessage({
      id: "msg-asst-1",
      role: "assistant",
      ordinal: 1,
    });

    const blocks: ParsedContentBlock[] = [
      makeBlock({
        message_id: "msg-asst-1",
        block_type: "text",
        content_text: "Here is my response",
        block_order: 0,
      }),
    ];

    const result = extractInitialPrompt([assistantMsg], blocks);

    expect(result).toBeNull();
  });

  test("returns null when user message has no text blocks", () => {
    idCounter = 0;

    const userMsg = makeMessage({
      id: "msg-user-1",
      role: "user",
      ordinal: 1,
    });

    // No content blocks for this message
    const result = extractInitialPrompt([userMsg], []);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generateSummary guard clause tests
// ---------------------------------------------------------------------------

describe("generateSummary", () => {
  test("with enabled = false: returns { success: true, summary: undefined }", async () => {
    const config = makeConfig({ enabled: false });
    const result = await generateSummary([], [], config);

    expect(result.success).toBe(true);
    expect(result.summary).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  test("with empty messages: returns { success: true, summary: 'Empty session.' }", async () => {
    const config = makeConfig();
    const result = await generateSummary([], [], config);

    expect(result.success).toBe(true);
    expect(result.summary).toBe("Empty session.");
    expect(result.error).toBeUndefined();
  });

  test("with missing API key: returns { success: false, error }", async () => {
    idCounter = 0;

    const config = makeConfig({ apiKey: "" });
    const messages = [makeMessage()];

    const result = await generateSummary(messages, [], config);

    expect(result.success).toBe(false);
    expect(result.error).toBe("ANTHROPIC_API_KEY not configured");
    expect(result.summary).toBeUndefined();
  });
});
