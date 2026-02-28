/**
 * Tests for the Sidebar TUI component and its sub-panels.
 *
 * 9 tests covering: git activity (normal + overflow), tools used (counts +
 * sorted), files modified (dedup + sorted), and empty states.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { GitActivityPanel } from "../components/GitActivityPanel.js";
import { ToolsUsedPanel } from "../components/ToolsUsedPanel.js";
import { FilesModifiedPanel } from "../components/FilesModifiedPanel.js";
import { Sidebar, extractToolCounts, extractModifiedFiles } from "../components/Sidebar.js";
import type { GitActivity } from "@fuel-code/shared";
import type { TranscriptMessageWithBlocks } from "../components/MessageBlock.js";
import type { ParsedContentBlock } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitCommit(sha: string, message: string): GitActivity {
  return {
    id: `git-${sha}`,
    workspace_id: "ws-001",
    device_id: "dev-001",
    session_id: "sess-1",
    type: "commit",
    branch: "main",
    commit_sha: sha + "0".repeat(40 - sha.length),
    message,
    files_changed: 3,
    insertions: 10,
    deletions: 5,
    timestamp: "2025-06-15T10:30:00Z",
    data: {},
    created_at: "2025-06-15T10:30:01Z",
  };
}

function makeToolBlock(name: string, input: Record<string, unknown>): ParsedContentBlock {
  return {
    id: `blk-${name}-${Math.random()}`,
    message_id: "msg-1",
    session_id: "sess-1",
    block_order: 0,
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

function makeMessageWithBlocks(blocks: ParsedContentBlock[]): TranscriptMessageWithBlocks {
  return {
    id: `msg-${Math.random()}`,
    session_id: "sess-1",
    line_number: 1,
    ordinal: 1,
    message_type: "assistant",
    role: "assistant",
    model: null,
    tokens_in: null,
    tokens_out: null,
    cache_read: null,
    cache_write: null,
    cost_usd: null,
    compact_sequence: 0,
    is_compacted: false,
    timestamp: null,
    raw_message: null,
    metadata: {},
    has_text: false,
    has_thinking: false,
    has_tool_use: true,
    has_tool_result: false,
    content_blocks: blocks,
  };
}

// ---------------------------------------------------------------------------
// GitActivityPanel
// ---------------------------------------------------------------------------

describe("GitActivityPanel", () => {
  it("1. shows git commits normally", () => {
    const commits = [
      makeGitCommit("abc1234", "fix: resolve parsing error"),
      makeGitCommit("def5678", "feat: add new feature"),
    ];
    const { lastFrame } = render(<GitActivityPanel commits={commits} />);
    const frame = lastFrame();
    // Title is now handled by parent Sidebar's Divider, not by GitActivityPanel
    expect(frame).toContain("abc1234");
    expect(frame).toContain("resolve parsing error");
    expect(frame).toContain("def5678");
    expect(frame).toContain("add new feature");
  });

  it("2. shows overflow indicator when > 10 commits", () => {
    const commits = Array.from({ length: 15 }, (_, i) =>
      makeGitCommit(`sha${String(i).padStart(4, "0")}`, `commit ${i}`)
    );
    const { lastFrame } = render(<GitActivityPanel commits={commits} />);
    const frame = lastFrame();
    expect(frame).toContain("... 5 more");
  });
});

// ---------------------------------------------------------------------------
// ToolsUsedPanel
// ---------------------------------------------------------------------------

describe("ToolsUsedPanel", () => {
  it("3. shows tool counts", () => {
    const { lastFrame } = render(
      <ToolsUsedPanel toolCounts={{ Read: 5, Edit: 3, Bash: 1 }} />
    );
    const frame = lastFrame();
    // Title is now handled by parent Sidebar's Divider, not by ToolsUsedPanel
    // ToolsUsedPanel now renders a BarChart: "Read ████████ 5" format
    expect(frame).toContain("Read");
    expect(frame).toContain("5");
    expect(frame).toContain("Edit");
    expect(frame).toContain("3");
    expect(frame).toContain("Bash");
    expect(frame).toContain("1");
  });

  it("4. tools sorted descending by count", () => {
    const { lastFrame } = render(
      <ToolsUsedPanel toolCounts={{ Bash: 1, Read: 10, Edit: 5 }} />
    );
    const frame = lastFrame();
    const readIdx = frame.indexOf("Read");
    const editIdx = frame.indexOf("Edit");
    const bashIdx = frame.indexOf("Bash");
    // Read (10) should come before Edit (5) which should come before Bash (1)
    expect(readIdx).toBeLessThan(editIdx);
    expect(editIdx).toBeLessThan(bashIdx);
  });
});

// ---------------------------------------------------------------------------
// FilesModifiedPanel
// ---------------------------------------------------------------------------

describe("FilesModifiedPanel", () => {
  it("5. deduplicates files", () => {
    const { lastFrame } = render(
      <FilesModifiedPanel files={["/src/a.ts", "/src/b.ts", "/src/a.ts", "/src/b.ts"]} />
    );
    const frame = lastFrame();
    // Count occurrences of "/src/a.ts"
    const count = (frame.match(/\/src\/a\.ts/g) || []).length;
    expect(count).toBe(1);
  });

  it("6. files sorted alphabetically", () => {
    const { lastFrame } = render(
      <FilesModifiedPanel files={["/src/z.ts", "/src/a.ts", "/src/m.ts"]} />
    );
    const frame = lastFrame();
    const aIdx = frame.indexOf("/src/a.ts");
    const mIdx = frame.indexOf("/src/m.ts");
    const zIdx = frame.indexOf("/src/z.ts");
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });
});

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

describe("Empty states", () => {
  it("7. GitActivityPanel shows 'No git activity' when empty", () => {
    const { lastFrame } = render(<GitActivityPanel commits={[]} />);
    expect(lastFrame()).toContain("No git activity");
  });

  it("8. ToolsUsedPanel shows 'No tool usage recorded' when empty", () => {
    const { lastFrame } = render(<ToolsUsedPanel toolCounts={{}} />);
    expect(lastFrame()).toContain("No tool usage recorded");
  });

  it("9. FilesModifiedPanel shows 'No files modified' when empty", () => {
    const { lastFrame } = render(<FilesModifiedPanel files={[]} />);
    expect(lastFrame()).toContain("No files modified");
  });
});
