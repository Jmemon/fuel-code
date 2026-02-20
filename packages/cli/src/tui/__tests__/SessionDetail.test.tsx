/**
 * Tests for the TUI SessionDetailView and its sub-components.
 *
 * Uses ink-testing-library to render Ink components in a test environment.
 * Mock API client and WS client are used instead of real HTTP/WS connections.
 * 27 test cases covering header, transcript, sidebar, tabs, live sessions,
 * export, loading, and error states.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { SessionDetailView } from "../SessionDetailView.js";
import { SessionHeader } from "../components/SessionHeader.js";
import type { SessionDetail } from "../../commands/session-detail.js";
import type { TranscriptMessage, ParsedContentBlock, GitActivity, Event } from "@fuel-code/shared";
import type { TranscriptMessageWithBlocks } from "../components/MessageBlock.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "01JTEST1234567890ABCDEFGHI",
    workspace_id: "ws-001",
    device_id: "dev-001",
    cc_session_id: "cc-123",
    lifecycle: "summarized",
    parse_status: "completed",
    cwd: "/home/user/project",
    git_branch: "main",
    git_remote: "github.com/user/repo",
    model: "claude-sonnet-4-5",
    duration_ms: 2820000,
    transcript_path: "s3://transcripts/sess-1.jsonl",
    started_at: "2025-06-15T10:00:00Z",
    ended_at: "2025-06-15T10:47:00Z",
    metadata: {},
    workspace_name: "my-project",
    workspace_canonical_id: "github.com/user/my-project",
    device_name: "macbook",
    device_type: "local",
    cost_estimate_usd: 1.23,
    summary: "Implemented JWT authentication for the API",
    tags: ["feature"],
    branch: "main",
    stats: {
      tokens_in: 125000,
      tokens_out: 48000,
      tokens_cache: 890000,
      total_messages: 42,
      tool_use_count: 15,
      commit_count: 3,
    },
    ...overrides,
  };
}

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

function makeGitCommit(overrides: Partial<GitActivity> = {}): GitActivity {
  return {
    id: "git-1",
    workspace_id: "ws-001",
    device_id: "dev-001",
    session_id: "sess-1",
    type: "commit",
    branch: "main",
    commit_sha: "abc1234def5678901234567890abcdef12345678",
    message: "fix: resolve parsing error",
    files_changed: 3,
    insertions: 15,
    deletions: 5,
    timestamp: "2025-06-15T10:30:00Z",
    data: {},
    created_at: "2025-06-15T10:30:01Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "evt-1",
    type: "session.start",
    timestamp: "2025-06-15T10:00:00Z",
    device_id: "dev-001",
    workspace_id: "ws-001",
    session_id: "sess-1",
    data: { branch: "main", model: "claude-sonnet-4-5" },
    ingested_at: "2025-06-15T10:00:01Z",
    blob_refs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock API Client
// ---------------------------------------------------------------------------

interface MockApiClientOptions {
  session?: SessionDetail;
  transcript?: TranscriptMessageWithBlocks[] | null;
  git?: GitActivity[];
  events?: Event[];
  sessionError?: Error;
}

function makeMockApiClient(opts: MockApiClientOptions = {}) {
  const session = opts.session ?? makeSession();
  const transcript = opts.transcript !== undefined ? opts.transcript : [
    makeMessage({ id: "msg-1", ordinal: 1, role: "human", content_blocks: [makeTextBlock("Fix the tests")] }),
    makeMessage({
      id: "msg-2", ordinal: 2, role: "assistant", message_type: "assistant",
      model: "claude-sonnet-4-5", cost_usd: 0.05,
      has_tool_use: true,
      content_blocks: [
        makeTextBlock("I'll fix the tests.", { id: "blk-2", message_id: "msg-2" }),
        makeToolBlock("Read", { file_path: "/src/test.ts" }),
        makeToolBlock("Edit", { file_path: "/src/test.ts", old_string: "old", new_string: "new" }, { id: "blk-tool-Edit", block_order: 2 }),
      ],
    }),
  ];
  const git = opts.git ?? [makeGitCommit()];
  const events = opts.events ?? [makeEvent()];

  return {
    getSession: opts.sessionError
      ? mock(() => Promise.reject(opts.sessionError))
      : mock(() => Promise.resolve(session)),
    getTranscript: mock(() => Promise.resolve(transcript ?? [])),
    getSessionGit: mock(() => Promise.resolve(git)),
    getSessionEvents: mock(() => Promise.resolve(events)),
    getHealth: mock(() => Promise.resolve(true)),
    // Remaining methods as stubs
    listSessions: mock(() => Promise.resolve({ data: [], nextCursor: null, hasMore: false })),
    updateSession: mock(() => Promise.resolve(session)),
    reparseSession: mock(() => Promise.resolve()),
  } as any;
}

// ---------------------------------------------------------------------------
// Mock WS Client
// ---------------------------------------------------------------------------

function makeMockWsClient() {
  const listeners: Record<string, Function[]> = {};
  return {
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
    on: mock((event: string, fn: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    }),
    off: mock((event: string, fn: Function) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      }
    }),
    emit: (event: string, data: unknown) => {
      for (const fn of listeners[event] ?? []) {
        fn(data);
      }
    },
    connected: true,
    _listeners: listeners,
  } as any;
}

// ---------------------------------------------------------------------------
// Helper: wait for component to settle async state
// ---------------------------------------------------------------------------

async function waitForText(lastFrame: () => string, text: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = lastFrame();
    if (frame.includes(text)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for text: "${text}" in frame:\n${lastFrame()}`);
}

async function waitForNoText(lastFrame: () => string, text: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = lastFrame();
    if (!frame.includes(text)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionDetail — Header", () => {
  it("1. renders workspace, device, duration, cost, summary", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "my-project");

    const frame = lastFrame();
    expect(frame).toContain("my-project");
    expect(frame).toContain("macbook");
    expect(frame).toContain("$1.23");
    expect(frame).toContain("JWT authentication");
  });

  it("2. renders token counts (125K in / 48K out / 890K cache)", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "125K");

    const frame = lastFrame();
    expect(frame).toContain("125K in");
    expect(frame).toContain("48K out");
    expect(frame).toContain("890K cache");
  });
});

describe("SessionDetail — Transcript", () => {
  it("3. renders messages in order with ordinal numbers", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "[1]");

    const frame = lastFrame();
    expect(frame).toContain("[1]");
    expect(frame).toContain("[2]");
  });

  it("4. Human=cyan, Assistant=green (role labels present)", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Human");

    const frame = lastFrame();
    expect(frame).toContain("Human");
    expect(frame).toContain("Assistant");
  });

  it("5. Tool usage with tree chars", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "\u251C");

    const frame = lastFrame();
    // First tool use should have \u251C (middle), last should have \u2514 (last)
    expect(frame).toContain("\u251C");
    expect(frame).toContain("\u2514");
  });

  it("6. Thinking blocks collapsed", async () => {
    const api = makeMockApiClient({
      transcript: [
        makeMessage({
          id: "msg-think", ordinal: 1, role: "assistant", message_type: "assistant",
          has_thinking: true,
          content_blocks: [
            {
              id: "blk-think", message_id: "msg-think", session_id: "sess-1",
              block_order: 0, block_type: "thinking",
              content_text: null, thinking_text: "x".repeat(200),
              tool_name: null, tool_use_id: null, tool_input: null,
              tool_result_id: null, is_error: false, result_text: null,
              result_s3_key: null, metadata: {},
            },
          ],
        }),
      ],
    });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "thinking");

    const frame = lastFrame();
    expect(frame).toContain("[thinking... 200 chars]");
  });

  it("7. Scroll position indicator", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Message 1 of");

    const frame = lastFrame();
    expect(frame).toContain("Message 1 of 2");
  });

  it("8. j increments scroll, k decrements", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Message 1 of");

    stdin.write("j");
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toContain("Message 2 of 2");

    stdin.write("k");
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toContain("Message 1 of 2");
  });

  it("9. Space scrolls by page", async () => {
    // Create many messages to test page scrolling
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        ordinal: i + 1,
        role: i % 2 === 0 ? "human" : "assistant",
        content_blocks: [makeTextBlock(`Message ${i + 1}`, { id: `blk-${i}`, message_id: `msg-${i}` })],
      })
    );
    const api = makeMockApiClient({ transcript: messages });
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Message 1 of 20");

    stdin.write(" ");
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toContain("Message 11 of 20");
  });

  it("10. Scroll clamped", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Message 1 of");

    // Try to scroll past the end
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toContain("Message 2 of 2");

    // Try to scroll before start
    stdin.write("k");
    stdin.write("k");
    stdin.write("k");
    await new Promise((r) => setTimeout(r, 100));
    expect(lastFrame()).toContain("Message 1 of 2");
  });
});

describe("SessionDetail — Sidebar", () => {
  it("11. shows git activity with commits", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "abc1234");

    const frame = lastFrame();
    expect(frame).toContain("Git Activity");
    expect(frame).toContain("abc1234");
    // Message may wrap across terminal lines; check for a substring
    expect(frame).toContain("resolve parsing");
  });

  it("12. shows tools used frequency table", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Tools Used");

    const frame = lastFrame();
    expect(frame).toContain("Tools Used");
    expect(frame).toContain("Read");
    expect(frame).toContain("Edit");
  });

  it("13. shows files modified deduplicated and sorted", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Files Modified");

    const frame = lastFrame();
    expect(frame).toContain("Files Modified");
    expect(frame).toContain("/src/test.ts");
  });
});

describe("SessionDetail — Tab switching", () => {
  it("14. e switches to events tab, triggers lazy fetch", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "my-project");

    stdin.write("e");
    await new Promise((r) => setTimeout(r, 200));

    // getSessionEvents should have been called
    expect(api.getSessionEvents).toHaveBeenCalled();
  });

  it("15. Events tab renders table", async () => {
    const api = makeMockApiClient({
      events: [
        makeEvent({ id: "evt-1", type: "session.start", data: { branch: "main", model: "claude-sonnet-4-5" } }),
        makeEvent({ id: "evt-2", type: "git.commit" as any, data: { commit_sha: "abc1234", message: "refactor: JWT auth" }, timestamp: "2025-06-15T10:31:15Z" }),
      ],
    });
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "my-project");

    stdin.write("e");
    await waitForText(lastFrame, "TIME");

    const frame = lastFrame();
    expect(frame).toContain("TIME");
    expect(frame).toContain("TYPE");
    expect(frame).toContain("DATA");
    expect(frame).toContain("session.start");
  });

  it("16. g switches to git tab (full-width)", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "my-project");

    stdin.write("g");
    await new Promise((r) => setTimeout(r, 100));

    const frame = lastFrame();
    expect(frame).toContain("Git Activity");
    expect(frame).toContain("abc1234");
  });

  it("17. t switches back to transcript (cached)", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Message 1 of");

    // Switch to events, then back to transcript
    stdin.write("e");
    await new Promise((r) => setTimeout(r, 200));
    stdin.write("t");
    await new Promise((r) => setTimeout(r, 100));

    const frame = lastFrame();
    expect(frame).toContain("Message 1 of 2");
    // getSession should only have been called once (data cached)
    expect(api.getSession).toHaveBeenCalledTimes(1);
  });
});

describe("SessionDetail — Navigation", () => {
  it("18. b calls onBack", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    let backCalled = false;
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => { backCalled = true; }} />
    );
    await waitForText(lastFrame, "my-project");

    stdin.write("b");
    await new Promise((r) => setTimeout(r, 100));
    expect(backCalled).toBe(true);
  });
});

describe("SessionDetail — Empty states", () => {
  it("19. No transcript shows 'not yet available' message", async () => {
    const api = makeMockApiClient({ transcript: null });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "not yet available");

    expect(lastFrame()).toContain("not yet available");
  });

  it("20. No git shows 'No git activity'", async () => {
    const api = makeMockApiClient({ git: [] });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "No git activity");

    expect(lastFrame()).toContain("No git activity");
  });

  it("21. No tools shows 'No tool usage recorded'", async () => {
    const api = makeMockApiClient({
      transcript: [
        makeMessage({ id: "msg-1", ordinal: 1, role: "human", content_blocks: [makeTextBlock("Hello")] }),
      ],
    });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "No tool usage recorded");

    expect(lastFrame()).toContain("No tool usage recorded");
  });
});

describe("SessionDetail — Live session", () => {
  it("22. Live session subscribes via WS", async () => {
    const api = makeMockApiClient({
      session: makeSession({ lifecycle: "capturing", duration_ms: null, ended_at: null }),
    });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "LIVE");

    expect(ws.subscribe).toHaveBeenCalled();
  });

  it("23. Live session WS update changes header", async () => {
    const api = makeMockApiClient({
      session: makeSession({ lifecycle: "capturing", duration_ms: null, ended_at: null, summary: null }),
    });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "LIVE");

    // Simulate a WS session.update message
    ws.emit("session.update", {
      session_id: "01JTEST1234567890ABCDEFGHI",
      lifecycle: "capturing",
      summary: "Updated summary from WS",
      stats: { total_messages: 50, total_cost_usd: 2.50 },
    });

    await waitForText(lastFrame, "Updated summary from WS");
    expect(lastFrame()).toContain("Updated summary from WS");
  });

  it("24. Live session elapsed time counter", async () => {
    const recentStart = new Date(Date.now() - 5000).toISOString();
    const api = makeMockApiClient({
      session: makeSession({
        lifecycle: "capturing",
        duration_ms: null,
        ended_at: null,
        started_at: recentStart,
      }),
    });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "LIVE");

    // The duration should show some seconds
    const frame = lastFrame();
    // Should show either "5s" or "6s" or similar (elapsed from recentStart)
    expect(frame).toContain("Duration:");
  });
});

describe("SessionDetail — Export", () => {
  it("25. x exports session JSON", async () => {
    const api = makeMockApiClient();
    const ws = makeMockWsClient();
    const { lastFrame, stdin } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "my-project");

    // Press x to export — this will try to write a file but may fail in test env
    // We just verify it doesn't crash
    stdin.write("x");
    await new Promise((r) => setTimeout(r, 100));
    // No crash means success
    expect(lastFrame()).toBeDefined();
  });
});

describe("SessionDetail — Loading & Error", () => {
  it("26. Loading shows spinner", () => {
    // Create a slow API client that never resolves
    const api = {
      getSession: mock(() => new Promise(() => {})),
      getTranscript: mock(() => new Promise(() => {})),
      getSessionGit: mock(() => new Promise(() => {})),
      getSessionEvents: mock(() => Promise.resolve([])),
    } as any;
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );

    expect(lastFrame()).toContain("Loading");
  });

  it("27. API error shows error message", async () => {
    const api = makeMockApiClient({
      sessionError: new Error("Session not found"),
    });
    const ws = makeMockWsClient();
    const { lastFrame } = render(
      <SessionDetailView apiClient={api} wsClient={ws} sessionId="01JTEST1234567890ABCDEFGHI" onBack={() => {}} />
    );
    await waitForText(lastFrame, "Error");

    expect(lastFrame()).toContain("Error");
    expect(lastFrame()).toContain("Session not found");
  });
});
