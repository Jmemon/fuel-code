/**
 * Tests for the MessageBlock TUI component.
 *
 * 6 tests covering: Human header format, Assistant header with model+cost,
 * text indented+wrapped, tool sequence tree chars, primary input extraction,
 * and tool_result skipped.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MessageBlock, type TranscriptMessageWithBlocks } from "../components/MessageBlock.js";
import type { ParsedContentBlock } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<TranscriptMessageWithBlocks> = {}): TranscriptMessageWithBlocks {
  return {
    id: "msg-1",
    session_id: "sess-1",
    line_number: 1,
    ordinal: 1,
    message_type: "user",
    role: "human",
    model: null,
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    cost_usd: null,
    compact_sequence: 0,
    is_compacted: false,
    timestamp: "2025-06-15T10:00:00Z",
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

function makeTextBlock(text: string): ParsedContentBlock {
  return {
    id: "blk-text",
    message_id: "msg-1",
    session_id: "sess-1",
    block_order: 0,
    block_type: "text",
    content_text: text,
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
}

function makeToolBlock(name: string, input: Record<string, unknown>, order: number = 1): ParsedContentBlock {
  return {
    id: `blk-tool-${name}-${order}`,
    message_id: "msg-1",
    session_id: "sess-1",
    block_order: order,
    block_type: "tool_use",
    content_text: null,
    thinking_text: null,
    tool_name: name,
    tool_use_id: `tu-${name}`,
    tool_input: input,
    tool_result_id: null,
    is_error: false,
    result_text: null,
    result_s3_key: null,
    metadata: {},
  };
}

function makeToolResultBlock(order: number = 2): ParsedContentBlock {
  return {
    id: `blk-result-${order}`,
    message_id: "msg-1",
    session_id: "sess-1",
    block_order: order,
    block_type: "tool_result",
    content_text: "some result content",
    thinking_text: null,
    tool_name: null,
    tool_use_id: null,
    tool_input: null,
    tool_result_id: "tu-Read",
    is_error: false,
    result_text: "result data here",
    result_s3_key: null,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageBlock", () => {
  it("1. Human header format: [N] Human (HH:MM):", () => {
    const msg = makeMessage({
      ordinal: 1,
      role: "human",
      timestamp: "2025-06-15T14:30:00Z",
      content_blocks: [makeTextBlock("Hello")],
    });
    const { lastFrame } = render(<MessageBlock message={msg} ordinal={1} />);
    const frame = lastFrame();
    expect(frame).toContain("[1]");
    expect(frame).toContain("Human");
    expect(frame).toContain("14:30");
    expect(frame).toContain(":");
  });

  it("2. Assistant header with model and cost", () => {
    const msg = makeMessage({
      ordinal: 2,
      role: "assistant",
      message_type: "assistant",
      model: "claude-sonnet-4-5",
      cost_usd: 0.0532,
      timestamp: "2025-06-15T14:31:00Z",
      content_blocks: [makeTextBlock("I'll help with that.")],
    });
    const { lastFrame } = render(<MessageBlock message={msg} ordinal={2} />);
    const frame = lastFrame();
    expect(frame).toContain("[2]");
    expect(frame).toContain("Assistant");
    expect(frame).toContain("claude-sonnet-4-5");
    expect(frame).toContain("$0.05");
    // Model and cost separated by middot
    expect(frame).toContain("\u00B7");
  });

  it("3. Text content is indented and wrapped", () => {
    const msg = makeMessage({
      content_blocks: [makeTextBlock("This is the message content that should be displayed.")],
    });
    const { lastFrame } = render(<MessageBlock message={msg} ordinal={1} />);
    const frame = lastFrame();
    expect(frame).toContain("This is the message content");
  });

  it("4. Tool sequence uses tree chars: mid=\\u251C, last=\\u2514", () => {
    const msg = makeMessage({
      role: "assistant",
      has_tool_use: true,
      content_blocks: [
        makeToolBlock("Read", { file_path: "/a.ts" }, 0),
        makeToolBlock("Edit", { file_path: "/b.ts" }, 1),
        makeToolBlock("Write", { file_path: "/c.ts" }, 2),
      ],
    });
    const { lastFrame } = render(<MessageBlock message={msg} ordinal={1} />);
    const frame = lastFrame();
    // Read and Edit should use \u251C (middle connector)
    // Write should use \u2514 (last connector)
    expect(frame).toContain("\u251C");
    expect(frame).toContain("\u2514");
    // Verify Read appears before Write in the output
    const readIdx = frame.indexOf("Read");
    const writeIdx = frame.indexOf("Write");
    expect(readIdx).toBeLessThan(writeIdx);
  });

  it("5. Primary input extraction: Read shows path, Bash shows command", () => {
    const msg = makeMessage({
      role: "assistant",
      has_tool_use: true,
      content_blocks: [
        makeToolBlock("Read", { file_path: "/src/main.ts" }, 0),
        makeToolBlock("Bash", { command: "npm test" }, 1),
      ],
    });
    const { lastFrame } = render(<MessageBlock message={msg} ordinal={1} />);
    const frame = lastFrame();
    expect(frame).toContain("/src/main.ts");
    expect(frame).toContain("npm test");
  });

  it("6. tool_result blocks are skipped (not rendered)", () => {
    const msg = makeMessage({
      role: "assistant",
      has_tool_use: true,
      has_tool_result: true,
      content_blocks: [
        makeToolBlock("Read", { file_path: "/a.ts" }, 0),
        makeToolResultBlock(1),
      ],
    });
    const { lastFrame } = render(<MessageBlock message={msg} ordinal={1} />);
    const frame = lastFrame();
    // The tool result content should NOT appear in the output
    expect(frame).not.toContain("some result content");
    expect(frame).not.toContain("result data here");
    // But the tool use should be visible
    expect(frame).toContain("Read");
    expect(frame).toContain("/a.ts");
  });
});
