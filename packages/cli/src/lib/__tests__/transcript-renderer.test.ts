/**
 * Tests for the transcript renderer module.
 *
 * Covers rendering of human/assistant messages, tool use trees with
 * box-drawing characters, specific tool summaries (Read, Edit, Write,
 * Bash, Grep, Glob), thinking blocks (collapsed and expanded), empty
 * blocks, truncation, and text wrapping.
 */

import { describe, it, expect } from "bun:test";
import {
  renderTranscript,
  renderMessage,
  renderToolUseTree,
  formatToolSummary,
  type TranscriptMessageWithBlocks,
} from "../transcript-renderer.js";
import type { ParsedContentBlock } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Helpers — factory functions for test data
// ---------------------------------------------------------------------------

/** Create a minimal transcript message for testing */
function makeMessage(overrides: Partial<TranscriptMessageWithBlocks> = {}): TranscriptMessageWithBlocks {
  return {
    id: "msg-1",
    session_id: "sess-1",
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
    timestamp: "2025-06-15T14:30:00Z",
    raw_message: null,
    metadata: {},
    has_text: true,
    has_thinking: false,
    has_tool_use: false,
    has_tool_result: false,
    content_blocks: [],
    ...overrides,
  };
}

/** Create a content block for testing */
function makeBlock(overrides: Partial<ParsedContentBlock> = {}): ParsedContentBlock {
  return {
    id: "blk-1",
    message_id: "msg-1",
    session_id: "sess-1",
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

// ---------------------------------------------------------------------------
// Tests: Message rendering
// ---------------------------------------------------------------------------

describe("renderMessage — human message", () => {
  it("renders human message with ordinal and time", () => {
    const msg = makeMessage({ role: "user", ordinal: 1, timestamp: "2025-06-15T14:30:00Z" });
    const result = renderMessage(msg, 1, { colorize: false });
    expect(result).toContain("[1] User");
    // Time in HH:MM
    expect(result).toMatch(/\(\d{2}:\d{2}\)/);
  });
});

describe("renderMessage — assistant with text", () => {
  it("renders assistant message with model and cost", () => {
    const msg = makeMessage({
      role: "assistant",
      ordinal: 2,
      model: "claude-3-opus",
      cost_usd: 0.0123,
      content_blocks: [
        makeBlock({ block_type: "text", content_text: "Hello world" }),
      ],
    });
    const result = renderMessage(msg, 2, { colorize: false });
    expect(result).toContain("[2] Assistant");
    expect(result).toContain("claude-3-opus");
    expect(result).toContain("$0.0123");
    expect(result).toContain("Hello world");
  });
});

describe("renderMessage — assistant with tools", () => {
  it("renders tool use tree with box-drawing chars", () => {
    const msg = makeMessage({
      role: "assistant",
      ordinal: 3,
      content_blocks: [
        makeBlock({ block_type: "tool_use", tool_name: "Read", tool_input: { file_path: "/src/main.ts" } }),
        makeBlock({ block_type: "tool_use", tool_name: "Edit", tool_input: { file_path: "/src/main.ts", old_string: "foo", new_string: "bar\nbaz" } }),
      ],
    });
    const result = renderMessage(msg, 3, { colorize: false });
    // First tool gets the intermediate connector
    expect(result).toContain("\u251C Read /src/main.ts");
    // Last tool gets the terminating connector
    expect(result).toContain("\u2514 Edit /src/main.ts");
  });
});

// ---------------------------------------------------------------------------
// Tests: Tool summaries
// ---------------------------------------------------------------------------

describe("formatToolSummary — Read tool", () => {
  it("shows filepath", () => {
    const block = makeBlock({ block_type: "tool_use", tool_name: "Read", tool_input: { file_path: "/src/app.ts" } });
    expect(formatToolSummary(block)).toBe("Read /src/app.ts");
  });
});

describe("formatToolSummary — Edit tool", () => {
  it("shows filepath with +/- counts", () => {
    const block = makeBlock({
      block_type: "tool_use",
      tool_name: "Edit",
      tool_input: { file_path: "/src/app.ts", old_string: "line1\nline2", new_string: "new1\nnew2\nnew3" },
    });
    const result = formatToolSummary(block);
    expect(result).toContain("Edit /src/app.ts");
    expect(result).toContain("+3");
    expect(result).toContain("-2");
  });
});

describe("formatToolSummary — Write tool", () => {
  it("shows filepath", () => {
    const block = makeBlock({ block_type: "tool_use", tool_name: "Write", tool_input: { file_path: "/src/new.ts" } });
    expect(formatToolSummary(block)).toBe("Write /src/new.ts");
  });
});

describe("formatToolSummary — Bash tool", () => {
  it("shows truncated command", () => {
    const longCmd = "npm run build && npm run test && npm run lint && npm run deploy --production";
    const block = makeBlock({ block_type: "tool_use", tool_name: "Bash", tool_input: { command: longCmd } });
    const result = formatToolSummary(block);
    expect(result).toContain("Bash");
    // Should be truncated to ~60 chars
    expect(result.length).toBeLessThanOrEqual(65);
  });

  it("shows short command in full", () => {
    const block = makeBlock({ block_type: "tool_use", tool_name: "Bash", tool_input: { command: "ls -la" } });
    expect(formatToolSummary(block)).toBe("Bash ls -la");
  });
});

describe("formatToolSummary — Grep tool", () => {
  it("shows pattern", () => {
    const block = makeBlock({ block_type: "tool_use", tool_name: "Grep", tool_input: { pattern: "TODO|FIXME" } });
    expect(formatToolSummary(block)).toBe("Grep TODO|FIXME");
  });
});

describe("formatToolSummary — Glob tool", () => {
  it("shows pattern", () => {
    const block = makeBlock({ block_type: "tool_use", tool_name: "Glob", tool_input: { pattern: "**/*.ts" } });
    expect(formatToolSummary(block)).toBe("Glob **/*.ts");
  });
});

describe("formatToolSummary — unknown tool", () => {
  it("shows tool name only", () => {
    const block = makeBlock({ block_type: "tool_use", tool_name: "CustomTool", tool_input: {} });
    expect(formatToolSummary(block)).toBe("CustomTool");
  });
});

// ---------------------------------------------------------------------------
// Tests: Thinking blocks
// ---------------------------------------------------------------------------

describe("renderMessage — thinking block collapsed", () => {
  it("shows char count in collapsed mode", () => {
    const msg = makeMessage({
      role: "assistant",
      ordinal: 1,
      content_blocks: [
        makeBlock({ block_type: "thinking", thinking_text: "a".repeat(500) }),
      ],
    });
    const result = renderMessage(msg, 1, { colorize: false, showThinking: false });
    expect(result).toContain("[thinking... 500 chars]");
  });
});

describe("renderMessage — thinking block expanded", () => {
  it("shows full thinking text when showThinking is true", () => {
    const thinkText = "Let me analyze this problem carefully.";
    const msg = makeMessage({
      role: "assistant",
      ordinal: 1,
      content_blocks: [
        makeBlock({ block_type: "thinking", thinking_text: thinkText }),
      ],
    });
    const result = renderMessage(msg, 1, { colorize: false, showThinking: true });
    expect(result).toContain(thinkText);
    expect(result).not.toContain("[thinking...");
  });
});

// ---------------------------------------------------------------------------
// Tests: Edge cases
// ---------------------------------------------------------------------------

describe("renderMessage — empty content blocks", () => {
  it("renders header only when no content blocks", () => {
    const msg = makeMessage({ role: "user", ordinal: 1, content_blocks: [] });
    const result = renderMessage(msg, 1, { colorize: false });
    expect(result).toContain("[1] User");
    // Should be just the header line(s), no content
    expect(result.split("\n").length).toBeLessThanOrEqual(2);
  });
});

describe("renderTranscript — truncation", () => {
  it("truncates and shows remaining count when exceeding maxMessages", () => {
    const messages: TranscriptMessageWithBlocks[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeMessage({ ordinal: i + 1, id: `msg-${i}` }));
    }
    const result = renderTranscript(messages, { maxMessages: 3, colorize: false });
    expect(result).toContain("... 7 more messages");
  });
});

describe("renderTranscript — text wrapping", () => {
  it("wraps long text lines to maxWidth", () => {
    const longText = "word ".repeat(50).trim(); // ~250 chars of words
    const msg = makeMessage({
      ordinal: 1,
      content_blocks: [makeBlock({ block_type: "text", content_text: longText })],
    });
    const result = renderTranscript([msg], { maxWidth: 40, colorize: false });
    const lines = result.split("\n");
    // With 2-char indent + maxWidth=40, content lines should be <= 40 chars
    for (const line of lines) {
      if (line.startsWith("  word")) {
        expect(line.length).toBeLessThanOrEqual(42); // 2 indent + up to maxWidth
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: renderToolUseTree
// ---------------------------------------------------------------------------

describe("renderToolUseTree", () => {
  it("uses intermediate connector for non-last items and terminator for last", () => {
    const blocks = [
      makeBlock({ block_type: "tool_use", tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
      makeBlock({ block_type: "tool_use", tool_name: "Write", tool_input: { file_path: "/b.ts" } }),
      makeBlock({ block_type: "tool_use", tool_name: "Bash", tool_input: { command: "echo test" } }),
    ];
    const result = renderToolUseTree(blocks, { colorize: false });
    const lines = result.split("\n");
    // First two lines use intermediate connector
    expect(lines[0]).toContain("\u251C");
    expect(lines[1]).toContain("\u251C");
    // Last line uses terminating connector
    expect(lines[2]).toContain("\u2514");
  });

  it("returns empty string when no tool_use blocks", () => {
    const blocks = [makeBlock({ block_type: "text", content_text: "hello" })];
    expect(renderToolUseTree(blocks, { colorize: false })).toBe("");
  });
});
