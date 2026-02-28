/**
 * Tests for TUI presentational components.
 *
 * Uses ink-testing-library to render components in isolation and assert
 * on their text output. These are pure rendering tests — no API calls.
 *
 * Tests:
 *   1-3. WorkspaceItem: name+count, selected style, active count
 *   4-7. SessionRow: status icon, live tools, summarized commits, overflow commits
 *   8.   StatusBar key hints
 *   9-10. Spinner/ErrorBanner render
 */

import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { WorkspaceItem } from "../components/WorkspaceItem.js";
import { SessionRow } from "../components/SessionRow.js";
import { StatusBar } from "../components/StatusBar.js";
import { Spinner } from "../components/Spinner.js";
import { ErrorBanner } from "../components/ErrorBanner.js";
import type { WorkspaceSummary } from "../../lib/api-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for content assertions */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function makeWorkspace(overrides?: Partial<WorkspaceSummary>): WorkspaceSummary {
  return {
    id: "ws-001",
    canonical_id: "github.com/user/repo",
    display_name: "fuel-code",
    first_seen_at: "2025-01-01T00:00:00Z",
    default_branch: "main",
    metadata: {},
    session_count: 5,
    active_session_count: 0,
    last_session_at: "2025-06-15T10:00:00Z",
    device_count: 2,
    total_cost_usd: 12.50,
    total_duration_ms: 3600000,
    ...overrides,
  };
}

function makeSession(overrides?: Record<string, unknown>): any {
  return {
    id: "sess-001",
    workspace_id: "ws-001",
    device_id: "dev-001",
    device_name: "macbook-pro",
    cc_session_id: "cc-001",
    lifecycle: "summarized",
    parse_status: "completed",
    cwd: "/home/user/code",
    git_branch: "main",
    git_remote: null,
    model: "claude-4",
    duration_ms: 720000,
    transcript_path: null,
    started_at: "2025-06-15T10:00:00Z",
    ended_at: "2025-06-15T10:12:00Z",
    metadata: {},
    summary: "Refactored auth middleware",
    cost_estimate_usd: 0.42,
    total_messages: null,
    tool_uses: null,
    commit_messages: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WorkspaceItem tests
// ---------------------------------------------------------------------------

describe("WorkspaceItem", () => {
  test("1. renders workspace name and session count", () => {
    const { lastFrame } = render(
      <WorkspaceItem workspace={makeWorkspace()} selected={false} />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("fuel-code");
    expect(output).toContain("(5)");
  });

  test("2. selected item shows ► prefix", () => {
    const { lastFrame } = render(
      <WorkspaceItem workspace={makeWorkspace()} selected={true} />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("\u25BA fuel-code");
  });

  test("3. shows active session count when > 0", () => {
    const { lastFrame } = render(
      <WorkspaceItem
        workspace={makeWorkspace({ active_session_count: 2 })}
        selected={false}
      />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("[2 live]");
  });
});

// ---------------------------------------------------------------------------
// SessionRow tests
// ---------------------------------------------------------------------------

describe("SessionRow", () => {
  test("4. shows correct status icon for summarized (DONE)", () => {
    const { lastFrame } = render(
      <SessionRow session={makeSession()} selected={false} />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("DONE");
    // Check mark icon
    expect(output).toContain("\u2713");
  });

  test("5. live sessions show tool usage counts", () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({
          lifecycle: "capturing",
          total_messages: 15,
          tool_uses: 8,
          duration_ms: null,
          ended_at: null,
        })}
        selected={false}
      />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("LIVE");
    expect(output).toContain("15 messages");
    expect(output).toContain("8 tool uses");
  });

  test("6. summarized sessions show commit messages", () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({
          commit_messages: ["Fix login bug", "Add tests"],
        })}
        selected={false}
      />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("Fix login bug");
    expect(output).toContain("Add tests");
  });

  test("7. overflow commits show +N more", () => {
    const { lastFrame } = render(
      <SessionRow
        session={makeSession({
          commit_messages: [
            "Commit 1",
            "Commit 2",
            "Commit 3",
            "Commit 4",
            "Commit 5",
          ],
        })}
        selected={false}
      />,
    );
    const output = stripAnsi(lastFrame()!);
    // Should show 2 commits + overflow message
    expect(output).toContain("Commit 1");
    expect(output).toContain("Commit 2");
    expect(output).not.toContain("Commit 3");
    expect(output).toContain("... 3 more commits");
  });
});

// ---------------------------------------------------------------------------
// StatusBar tests
// ---------------------------------------------------------------------------

describe("StatusBar", () => {
  test("8. shows key hints", () => {
    const { lastFrame } = render(
      <StatusBar
        stats={{ sessions: 4, durationMs: 10200000, tokensIn: 300000, tokensOut: 120000, commits: 0 }}
        wsState="connected"
      />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("j/k:navigate");
    expect(output).toContain("enter:detail");
    expect(output).toContain("tab:switch");
    expect(output).toContain("r:refresh");
    expect(output).toContain("q:quit");
  });
});

// ---------------------------------------------------------------------------
// Spinner and ErrorBanner tests
// ---------------------------------------------------------------------------

describe("Spinner", () => {
  test("9. renders with label text", () => {
    const { lastFrame } = render(<Spinner label="Loading data..." />);
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("Loading data...");
  });
});

describe("ErrorBanner", () => {
  test("10. renders error message with ✗ prefix", () => {
    const { lastFrame } = render(
      <ErrorBanner message="Connection refused" />,
    );
    const output = stripAnsi(lastFrame()!);
    expect(output).toContain("\u2717 Error:");
    expect(output).toContain("Connection refused");
  });
});
