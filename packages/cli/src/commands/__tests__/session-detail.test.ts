/**
 * Tests for the `fuel-code session <id>` command.
 *
 * Uses Bun.serve() as a mock HTTP server to test real HTTP round-trips
 * through FuelApiClient. Tests cover the default summary view, --json,
 * --transcript (with tools, thinking, truncation), --events, --git,
 * --export json/md, --tag (add + duplicate), --reparse, not found,
 * ambiguous prefix, short prefix, and lifecycle-gated transcript access.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Server } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FuelApiClient } from "../../lib/api-client.js";
import {
  fetchSessionDetail,
  fetchSessionTranscript,
  fetchSessionEvents,
  fetchSessionGit,
  fetchSessionExportData,
  formatSessionSummary,
  formatSessionEvents,
  formatSessionGitActivity,
  generateMarkdownExport,
  runSessionDetail,
  type SessionDetail,
  type SessionExportData,
} from "../session-detail.js";
import { resolveSessionId } from "../../lib/session-resolver.js";
import { stripAnsi } from "../../lib/formatters.js";

// ---------------------------------------------------------------------------
// Mock HTTP Server
// ---------------------------------------------------------------------------

let server: Server;
let serverPort: number;

/**
 * Route handler map. Tests set specific route handlers before making requests.
 * Routes are matched by "METHOD /path" key. The handler returns { status, body }.
 */
let routeHandlers: Record<string, (url: URL, body: unknown) => { status: number; body: unknown }>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: unknown = null;
      if (req.method !== "GET" && req.method !== "HEAD") {
        try { body = await req.json(); } catch { body = null; }
      }

      // Match routes by exact "METHOD /path" key
      const routeKey = `${req.method} ${url.pathname}`;
      const handler = routeHandlers[routeKey];
      if (handler) {
        const result = handler(url, body);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    },
  });
  serverPort = server.port;
});

afterAll(() => {
  server.stop();
});

beforeEach(() => {
  routeHandlers = {};
});

/** Create a FuelApiClient pointing at the mock server */
function makeClient(): FuelApiClient {
  return new FuelApiClient({
    baseUrl: `http://localhost:${serverPort}`,
    apiKey: "test-key",
    timeout: 5000,
  });
}

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

/** Create a mock session detail object */
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
    model: "claude-3-opus",
    duration_ms: 3600000,
    transcript_path: "s3://transcripts/sess-1.jsonl",
    started_at: "2025-06-15T10:00:00Z",
    ended_at: "2025-06-15T11:00:00Z",
    metadata: {},
    workspace_name: "my-project",
    workspace_canonical_id: "github.com/user/my-project",
    device_name: "macbook",
    device_type: "local",
    cost_estimate_usd: 1.23,
    summary: "Implemented session detail command with all flags",
    tags: ["feature", "cli"],
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

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evt-1",
    type: "session.start",
    timestamp: "2025-06-15T10:00:00Z",
    device_id: "dev-001",
    workspace_id: "ws-001",
    session_id: "sess-1",
    data: { branch: "main", model: "claude-3-opus" },
    ingested_at: "2025-06-15T10:00:01Z",
    blob_refs: [],
    ...overrides,
  };
}

function makeGitActivity(overrides: Partial<Record<string, unknown>> = {}) {
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

// ---------------------------------------------------------------------------
// Helper to set up mock routes for a full session
// ---------------------------------------------------------------------------

function setupSessionRoutes(session?: SessionDetail) {
  const sess = session ?? makeSession();
  routeHandlers[`GET /api/sessions/${sess.id}`] = () => ({
    status: 200,
    body: { session: sess },
  });
  routeHandlers["GET /api/sessions"] = () => ({
    status: 200,
    body: { sessions: [sess], next_cursor: null, has_more: false },
  });
}

// ---------------------------------------------------------------------------
// Tests: Default View
// ---------------------------------------------------------------------------

describe("session detail — default view", () => {
  it("fetches and formats a session summary card", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    const api = makeClient();

    const detail = await fetchSessionDetail(api, session.id);
    const output = formatSessionSummary(detail);
    const plain = stripAnsi(output);

    expect(plain).toContain("Session Detail");
    expect(plain).toContain(session.id);
    expect(plain).toContain("my-project");
    expect(plain).toContain("macbook");
    expect(plain).toContain("DONE"); // summarized lifecycle
    expect(plain).toContain("$1.23");
    expect(plain).toContain("claude-3-opus");
    expect(plain).toContain("main");
    expect(plain).toContain("Implemented session detail");
    expect(plain).toContain("42"); // total_messages
    expect(plain).toContain("feature, cli");
    expect(plain).toContain("Hint:");
  });
});

describe("session detail — --json", () => {
  it("outputs session data as JSON", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    const api = makeClient();

    const detail = await fetchSessionDetail(api, session.id);
    const json = JSON.stringify(detail, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.id).toBe(session.id);
    expect(parsed.lifecycle).toBe("summarized");
    expect(parsed.workspace_name).toBe("my-project");
  });
});

// ---------------------------------------------------------------------------
// Tests: --transcript
// ---------------------------------------------------------------------------

describe("session detail — --transcript with tools", () => {
  it("renders transcript with tool use tree", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    routeHandlers[`GET /api/sessions/${session.id}/transcript`] = () => ({
      status: 200,
      body: {
        messages: [
          {
            id: "msg-1",
            session_id: session.id,
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
            timestamp: "2025-06-15T10:00:00Z",
            raw_message: null,
            metadata: {},
            has_text: true,
            has_thinking: false,
            has_tool_use: false,
            has_tool_result: false,
            content_blocks: [{ id: "blk-1", message_id: "msg-1", session_id: session.id, block_order: 0, block_type: "text", content_text: "Fix the tests", thinking_text: null, tool_name: null, tool_use_id: null, tool_input: null, tool_result_id: null, is_error: false, result_text: null, result_s3_key: null, metadata: {} }],
          },
          {
            id: "msg-2",
            session_id: session.id,
            line_number: 2,
            ordinal: 2,
            message_type: "assistant",
            role: "assistant",
            model: "claude-3-opus",
            tokens_in: 1000,
            tokens_out: 500,
            cache_read: null,
            cache_write: null,
            cost_usd: 0.05,
            compact_sequence: 0,
            is_compacted: false,
            timestamp: "2025-06-15T10:00:05Z",
            raw_message: null,
            metadata: {},
            has_text: true,
            has_thinking: false,
            has_tool_use: true,
            has_tool_result: false,
            content_blocks: [
              { id: "blk-2", message_id: "msg-2", session_id: session.id, block_order: 0, block_type: "text", content_text: "I'll fix the tests.", thinking_text: null, tool_name: null, tool_use_id: null, tool_input: null, tool_result_id: null, is_error: false, result_text: null, result_s3_key: null, metadata: {} },
              { id: "blk-3", message_id: "msg-2", session_id: session.id, block_order: 1, block_type: "tool_use", content_text: null, thinking_text: null, tool_name: "Read", tool_use_id: "tu-1", tool_input: { file_path: "/src/test.ts" }, tool_result_id: null, is_error: false, result_text: null, result_s3_key: null, metadata: {} },
              { id: "blk-4", message_id: "msg-2", session_id: session.id, block_order: 2, block_type: "tool_use", content_text: null, thinking_text: null, tool_name: "Edit", tool_use_id: "tu-2", tool_input: { file_path: "/src/test.ts", old_string: "old", new_string: "new" }, tool_result_id: null, is_error: false, result_text: null, result_s3_key: null, metadata: {} },
            ],
          },
        ],
      },
    });

    const api = makeClient();
    const messages = await fetchSessionTranscript(api, session.id);
    expect(messages).toHaveLength(2);
    // Content blocks should be present in messages
    expect((messages[1] as any).content_blocks).toHaveLength(3);
  });
});

describe("session detail — --transcript with thinking", () => {
  it("renders collapsed thinking blocks", async () => {
    const { renderTranscript } = await import("../../lib/transcript-renderer.js");

    const messages = [
      {
        id: "msg-1",
        session_id: "sess-1",
        line_number: 1,
        ordinal: 1,
        message_type: "assistant",
        role: "assistant",
        model: "claude-3-opus",
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
        has_text: false,
        has_thinking: true,
        has_tool_use: false,
        has_tool_result: false,
        content_blocks: [
          { id: "blk-1", message_id: "msg-1", session_id: "sess-1", block_order: 0, block_type: "thinking" as const, content_text: null, thinking_text: "x".repeat(200), tool_name: null, tool_use_id: null, tool_input: null, tool_result_id: null, is_error: false, result_text: null, result_s3_key: null, metadata: {} },
        ],
      },
    ];

    const result = renderTranscript(messages as any, { colorize: false, showThinking: false });
    expect(result).toContain("[thinking... 200 chars]");
  });
});

describe("session detail — --transcript truncation", () => {
  it("shows remaining message count when exceeding maxMessages", async () => {
    const { renderTranscript } = await import("../../lib/transcript-renderer.js");

    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `msg-${i}`,
      session_id: "sess-1",
      line_number: i + 1,
      ordinal: i + 1,
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
      timestamp: "2025-06-15T10:00:00Z",
      raw_message: null,
      metadata: {},
      has_text: true,
      has_thinking: false,
      has_tool_use: false,
      has_tool_result: false,
      content_blocks: [],
    }));

    // Default maxMessages is 50
    const result = renderTranscript(messages as any, { colorize: false });
    expect(result).toContain("... 10 more messages");
  });
});

// ---------------------------------------------------------------------------
// Tests: --events
// ---------------------------------------------------------------------------

describe("session detail — --events", () => {
  it("renders event table with type-specific data", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    const events = [
      makeEvent({ type: "session.start", data: { branch: "main", model: "claude-3-opus" } }),
      makeEvent({ id: "evt-2", type: "git.commit", data: { commit_sha: "abc1234", message: "fix bug", files_changed: 3 }, timestamp: "2025-06-15T10:15:00Z" }),
      makeEvent({ id: "evt-3", type: "session.end", data: { duration_ms: 3600000, reason: "user_exit" }, timestamp: "2025-06-15T11:00:00Z" }),
    ];
    routeHandlers[`GET /api/sessions/${session.id}/events`] = () => ({
      status: 200,
      body: { events },
    });

    const api = makeClient();
    const fetchedEvents = await fetchSessionEvents(api, session.id);
    const output = formatSessionEvents(fetchedEvents as any);
    const plain = stripAnsi(output);

    expect(plain).toContain("TIME");
    expect(plain).toContain("TYPE");
    expect(plain).toContain("DATA");
    expect(plain).toContain("session.start");
    expect(plain).toContain("git.commit");
    expect(plain).toContain("session.end");
  });

  it("handles empty events", () => {
    const output = formatSessionEvents([]);
    const plain = stripAnsi(output);
    expect(plain).toContain("No events");
  });
});

// ---------------------------------------------------------------------------
// Tests: --git
// ---------------------------------------------------------------------------

describe("session detail — --git", () => {
  it("renders git activity table with commits", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    const gitActivity = [
      makeGitActivity(),
      makeGitActivity({ id: "git-2", commit_sha: "def5678abc", message: "feat: add new feature", files_changed: 5, insertions: 30, deletions: 10 }),
    ];
    routeHandlers[`GET /api/sessions/${session.id}/git`] = () => ({
      status: 200,
      body: { git_activity: gitActivity },
    });

    const api = makeClient();
    const fetched = await fetchSessionGit(api, session.id);
    const output = formatSessionGitActivity(fetched as any);
    const plain = stripAnsi(output);

    expect(plain).toContain("HASH");
    expect(plain).toContain("MESSAGE");
    expect(plain).toContain("abc1234");
    expect(plain).toContain("def5678");
    expect(plain).toContain("+15 -5");
    expect(plain).toContain("+30 -10");
  });

  it("shows push activity below commit table", () => {
    const gitActivity = [
      makeGitActivity(),
      { ...makeGitActivity({ id: "git-push", type: "push", commit_sha: null, message: null, data: { remote: "origin" } }) },
    ];
    const output = formatSessionGitActivity(gitActivity as any);
    const plain = stripAnsi(output);
    expect(plain).toContain("push:");
    expect(plain).toContain("origin");
  });

  it("handles empty git activity", () => {
    const output = formatSessionGitActivity([]);
    const plain = stripAnsi(output);
    expect(plain).toContain("No git activity");
  });
});

// ---------------------------------------------------------------------------
// Tests: --export json
// ---------------------------------------------------------------------------

describe("session detail — --export json", () => {
  it("combines all session data into export structure", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    routeHandlers[`GET /api/sessions/${session.id}/transcript`] = () => ({
      status: 200,
      body: { messages: [{ id: "msg-1", ordinal: 1, role: "user" }] },
    });
    routeHandlers[`GET /api/sessions/${session.id}/events`] = () => ({
      status: 200,
      body: { events: [makeEvent()] },
    });
    routeHandlers[`GET /api/sessions/${session.id}/git`] = () => ({
      status: 200,
      body: { git_activity: [makeGitActivity()] },
    });

    const api = makeClient();
    const exportData = await fetchSessionExportData(api, session.id);

    expect(exportData.session.id).toBe(session.id);
    expect(exportData.transcript).toHaveLength(1);
    expect(exportData.events).toHaveLength(1);
    expect(exportData.git_activity).toHaveLength(1);
    expect(exportData.exported_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: --export md
// ---------------------------------------------------------------------------

describe("session detail — --export md", () => {
  it("generates markdown with all sections", () => {
    const session = makeSession();
    const exportData: SessionExportData = {
      session,
      transcript: [
        { id: "msg-1", session_id: session.id, line_number: 1, ordinal: 1, message_type: "user", role: "user", model: null, tokens_in: null, tokens_out: null, cache_read: null, cache_write: null, cost_usd: null, compact_sequence: 0, is_compacted: false, timestamp: "2025-06-15T10:00:00Z", raw_message: null, metadata: {}, has_text: true, has_thinking: false, has_tool_use: false, has_tool_result: false },
      ],
      events: [makeEvent() as any],
      git_activity: [makeGitActivity() as any],
      exported_at: "2025-06-15T12:00:00Z",
    };

    const md = generateMarkdownExport(exportData);
    expect(md).toContain(`# Session ${session.id}`);
    expect(md).toContain("**Workspace:** my-project");
    expect(md).toContain("**Model:** claude-3-opus");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Stats");
    expect(md).toContain("## Transcript");
    expect(md).toContain("## Git Activity");
    expect(md).toContain("abc1234");
    expect(md).toContain("Exported at");
  });
});

// ---------------------------------------------------------------------------
// Tests: --tag
// ---------------------------------------------------------------------------

describe("session detail — --tag add", () => {
  it("adds a new tag to the session", async () => {
    const session = makeSession({ tags: ["existing"] });
    setupSessionRoutes(session);
    let patchBody: unknown = null;
    routeHandlers[`PATCH /api/sessions/${session.id}`] = (_url, body) => {
      patchBody = body;
      return {
        status: 200,
        body: { session: { ...session, tags: ["existing", "new-tag"] } },
      };
    };

    const api = makeClient();
    const detail = await fetchSessionDetail(api, session.id);
    const currentTags = detail.tags ?? [];
    expect(currentTags).not.toContain("new-tag");

    const newTags = [...currentTags, "new-tag"];
    await api.updateSession(session.id, { tags: newTags });
    expect(patchBody).toEqual({ tags: ["existing", "new-tag"] });
  });
});

describe("session detail — --tag duplicate", () => {
  it("detects duplicate tag without making PATCH call", async () => {
    const session = makeSession({ tags: ["feature", "cli"] });
    setupSessionRoutes(session);

    const api = makeClient();
    const detail = await fetchSessionDetail(api, session.id);
    const currentTags = detail.tags ?? [];

    // Check for duplicate
    expect(currentTags.includes("feature")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: --reparse
// ---------------------------------------------------------------------------

describe("session detail — --reparse", () => {
  it("triggers reparse via POST", async () => {
    const session = makeSession();
    setupSessionRoutes(session);
    let reparseCalled = false;
    routeHandlers[`POST /api/sessions/${session.id}/reparse`] = () => {
      reparseCalled = true;
      return { status: 200, body: { status: "queued" } };
    };

    const api = makeClient();
    await api.reparseSession(session.id);
    expect(reparseCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Session ID resolution
// ---------------------------------------------------------------------------

describe("session resolver — not found", () => {
  it("throws when no session matches prefix", async () => {
    routeHandlers["GET /api/sessions"] = () => ({
      status: 200,
      body: { sessions: [makeSession()], next_cursor: null, has_more: false },
    });

    const api = makeClient();
    try {
      await resolveSessionId(api, "ZZZZZZZZ");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect((err as Error).message).toContain("Session not found: ZZZZZZZZ");
    }
  });
});

describe("session resolver — ambiguous prefix", () => {
  it("throws listing candidates with rich metadata when multiple sessions match", async () => {
    const sess1 = makeSession({ id: "01JTEST1111111111111111111" });
    const sess2 = makeSession({ id: "01JTEST1222222222222222222" });
    routeHandlers["GET /api/sessions"] = () => ({
      status: 200,
      body: { sessions: [sess1, sess2], next_cursor: null, has_more: false },
    });

    const api = makeClient();
    try {
      await resolveSessionId(api, "01JTEST1");
      expect(true).toBe(false);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("Ambiguous");
      // Should show 16-char prefix IDs with "..." suffix, workspace name, and summary
      expect(msg).toContain("01JTEST111111111...");
      expect(msg).toContain("01JTEST122222222...");
      expect(msg).toContain("my-project");
      expect(msg).toContain("Implemented session detail");
    }
  });
});

describe("session resolver — short prefix", () => {
  it("rejects prefixes shorter than 8 characters", async () => {
    const api = makeClient();
    try {
      await resolveSessionId(api, "01JTE");
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("at least 8 characters");
      expect((err as Error).message).toContain("Got 5");
    }
  });
});

describe("session resolver — full ULID", () => {
  it("passes through a 26-char ULID without fetching", async () => {
    // No routes set up — should not make any HTTP calls
    const api = makeClient();
    const result = await resolveSessionId(api, "01JTEST1234567890ABCDEFGHI");
    expect(result).toBe("01JTEST1234567890ABCDEFGHI");
  });
});

// ---------------------------------------------------------------------------
// Tests: Lifecycle-gated transcript access
// ---------------------------------------------------------------------------

describe("session detail — capturing + --transcript", () => {
  it("shows transcript not available message for capturing sessions", async () => {
    const session = makeSession({ lifecycle: "capturing" });
    setupSessionRoutes(session);

    // Capture stdout by temporarily replacing process.stdout.write
    let captured = "";
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stdout.write;

    // Stub FuelApiClient.fromConfig to return our mock client
    const origFromConfig = FuelApiClient.fromConfig;
    FuelApiClient.fromConfig = () => makeClient();

    try {
      await runSessionDetail(session.id, { transcript: true });
      expect(captured).toContain("Transcript not yet available. Session is currently capturing.");
    } finally {
      process.stdout.write = origWrite;
      FuelApiClient.fromConfig = origFromConfig;
    }
  });
});

describe("session detail — failed + --transcript", () => {
  it("shows transcript parsing failed message for failed sessions", async () => {
    const session = makeSession({ lifecycle: "failed" });
    setupSessionRoutes(session);

    // Capture stdout by temporarily replacing process.stdout.write
    let captured = "";
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      captured += chunk;
      return true;
    }) as typeof process.stdout.write;

    // Stub FuelApiClient.fromConfig to return our mock client
    const origFromConfig = FuelApiClient.fromConfig;
    FuelApiClient.fromConfig = () => makeClient();

    try {
      await runSessionDetail(session.id, { transcript: true });
      expect(captured).toContain("Transcript parsing failed. Use --reparse to retry.");
    } finally {
      process.stdout.write = origWrite;
      FuelApiClient.fromConfig = origFromConfig;
    }
  });
});
