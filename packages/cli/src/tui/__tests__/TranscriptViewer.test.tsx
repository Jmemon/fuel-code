/**
 * Tests for the TranscriptViewer TUI component.
 *
 * 13 tests covering: empty states, single messages, assistant with tools,
 * tree chars, tool argument display, thinking blocks, word wrap, scroll
 * position, and auto-scroll behavior.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { TranscriptViewer } from "../components/TranscriptViewer.js";
import type { TranscriptMessageWithBlocks } from "../components/MessageBlock.js";
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

function makeTextBlock(text: string, overrides: Partial<ParsedContentBlock> = {}): ParsedContentBlock {
  return {
    id: "blk-1",
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
    ...overrides,
  };
}

function makeToolBlock(name: string, input: Record<string, unknown>, overrides: Partial<ParsedContentBlock> = {}): ParsedContentBlock {
  return {
    id: `blk-tool-${name}`,
    message_id: "msg-2",
    session_id: "sess-1",
    block_order: 1,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TranscriptViewer — Empty states", () => {
  it("1. null messages shows 'not yet available'", () => {
    const { lastFrame } = render(
      <TranscriptViewer messages={null} scrollOffset={0} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("not yet available");
  });

  it("2. empty array shows 'not yet available'", () => {
    const { lastFrame } = render(
      <TranscriptViewer messages={[]} scrollOffset={0} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("not yet available");
  });
});

describe("TranscriptViewer — Single messages", () => {
  it("3. Single Human message", () => {
    const msg = makeMessage({
      content_blocks: [makeTextBlock("Fix the tests")],
    });
    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );

    const frame = lastFrame();
    expect(frame).toContain("[1]");
    expect(frame).toContain("Human");
    expect(frame).toContain("Fix the tests");
    expect(frame).toContain("Message 1 of 1");
  });
});

describe("TranscriptViewer — Assistant with tools", () => {
  it("4. Assistant message with tools", () => {
    const msg = makeMessage({
      id: "msg-2",
      ordinal: 2,
      role: "assistant",
      message_type: "assistant",
      model: "claude-sonnet-4-5",
      cost_usd: 0.05,
      has_tool_use: true,
      content_blocks: [
        makeTextBlock("I'll fix the tests.", { id: "blk-2", message_id: "msg-2" }),
        makeToolBlock("Read", { file_path: "/src/test.ts" }),
        makeToolBlock("Edit", { file_path: "/src/test.ts", old_string: "old", new_string: "new" }, { id: "blk-tool-Edit", block_order: 2 }),
      ],
    });

    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );

    const frame = lastFrame();
    expect(frame).toContain("[2]");
    expect(frame).toContain("Assistant");
    expect(frame).toContain("I'll fix the tests.");
    expect(frame).toContain("Read");
    expect(frame).toContain("Edit");
  });

  it("5. Tree chars: middle uses \\u251C, last uses \\u2514", () => {
    const msg = makeMessage({
      id: "msg-2",
      ordinal: 2,
      role: "assistant",
      has_tool_use: true,
      content_blocks: [
        makeToolBlock("Read", { file_path: "/a.ts" }, { id: "blk-t1", block_order: 0 }),
        makeToolBlock("Edit", { file_path: "/b.ts" }, { id: "blk-t2", block_order: 1 }),
        makeToolBlock("Write", { file_path: "/c.ts" }, { id: "blk-t3", block_order: 2 }),
      ],
    });

    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );

    const frame = lastFrame();
    // First two should have \u251C (middle), last should have \u2514
    expect(frame).toContain("\u251C");
    expect(frame).toContain("\u2514");
  });
});

describe("TranscriptViewer — Tool argument display", () => {
  it("6. Read shows file_path", () => {
    const msg = makeMessage({
      ordinal: 1, role: "assistant", has_tool_use: true,
      content_blocks: [makeToolBlock("Read", { file_path: "/src/main.ts" })],
    });
    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("/src/main.ts");
  });

  it("7. Bash shows command", () => {
    const msg = makeMessage({
      ordinal: 1, role: "assistant", has_tool_use: true,
      content_blocks: [makeToolBlock("Bash", { command: "npm test" })],
    });
    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("npm test");
  });

  it("8. Grep shows pattern", () => {
    const msg = makeMessage({
      ordinal: 1, role: "assistant", has_tool_use: true,
      content_blocks: [makeToolBlock("Grep", { pattern: "TODO" })],
    });
    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("TODO");
  });
});

describe("TranscriptViewer — Thinking blocks", () => {
  it("9. Thinking block shows collapsed summary", () => {
    const msg = makeMessage({
      ordinal: 1, role: "assistant", has_thinking: true,
      content_blocks: [{
        id: "blk-think", message_id: "msg-1", session_id: "sess-1",
        block_order: 0, block_type: "thinking",
        content_text: null, thinking_text: "a".repeat(150),
        tool_name: null, tool_use_id: null, tool_input: null,
        tool_result_id: null, is_error: false, result_text: null,
        result_s3_key: null, metadata: {},
      }],
    });
    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("[thinking... 150 chars]");
  });
});

describe("TranscriptViewer — Word wrap", () => {
  it("10. Long text content is wrapped", () => {
    const longText = "This is a very long message that should be wrapped across multiple lines in the terminal display to ensure readability.";
    const msg = makeMessage({
      ordinal: 1, role: "human",
      content_blocks: [makeTextBlock(longText)],
    });
    const { lastFrame } = render(
      <TranscriptViewer messages={[msg]} scrollOffset={0} onScrollChange={() => {}} />
    );
    // The text should be present (ink handles wrapping)
    expect(lastFrame()).toContain("very long message");
  });
});

describe("TranscriptViewer — Scroll position", () => {
  it("11. Shows correct scroll position", () => {
    const messages = [
      makeMessage({ id: "m1", ordinal: 1 }),
      makeMessage({ id: "m2", ordinal: 2 }),
      makeMessage({ id: "m3", ordinal: 3 }),
    ];
    const { lastFrame } = render(
      <TranscriptViewer messages={messages} scrollOffset={1} onScrollChange={() => {}} />
    );
    expect(lastFrame()).toContain("Message 2 of 3");
  });
});

describe("TranscriptViewer — Auto-scroll", () => {
  it("12. Auto-scroll is enabled when isLive and at bottom", () => {
    const messages = [
      makeMessage({ id: "m1", ordinal: 1 }),
      makeMessage({ id: "m2", ordinal: 2 }),
    ];
    let scrollPos = 1; // At bottom (last message)
    const onScroll = (pos: number) => { scrollPos = pos; };
    const { rerender } = render(
      <TranscriptViewer messages={messages} scrollOffset={scrollPos} onScrollChange={onScroll} isLive={true} />
    );

    // Add a new message and re-render
    const newMessages = [
      ...messages,
      makeMessage({ id: "m3", ordinal: 3 }),
    ];
    rerender(
      <TranscriptViewer messages={newMessages} scrollOffset={scrollPos} onScrollChange={onScroll} isLive={true} />
    );
    // onScrollChange should have been called to scroll to new bottom
    expect(scrollPos).toBe(2);
  });

  it("13. Auto-scroll preserves position when scrolled up", () => {
    const messages = [
      makeMessage({ id: "m1", ordinal: 1 }),
      makeMessage({ id: "m2", ordinal: 2 }),
      makeMessage({ id: "m3", ordinal: 3 }),
    ];
    let scrollPos = 0; // Scrolled to top
    const onScroll = (pos: number) => { scrollPos = pos; };
    const { rerender } = render(
      <TranscriptViewer messages={messages} scrollOffset={scrollPos} onScrollChange={onScroll} isLive={true} />
    );

    // Add a new message
    const newMessages = [
      ...messages,
      makeMessage({ id: "m4", ordinal: 4 }),
    ];
    rerender(
      <TranscriptViewer messages={newMessages} scrollOffset={scrollPos} onScrollChange={onScroll} isLive={true} />
    );
    // Should stay at 0 since user was not at bottom
    expect(scrollPos).toBe(0);
  });
});
