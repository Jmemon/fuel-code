/**
 * Integration tests for the TUI Dashboard view.
 *
 * Uses ink-testing-library to render the Dashboard component with mock
 * ApiClient and WsClient instances. Tests cover workspace/session rendering,
 * keyboard navigation, WebSocket live updates, polling fallback, and
 * error/loading states.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import { EventEmitter } from "events";
import { Dashboard, type DashboardProps } from "../Dashboard.js";
import type { FuelApiClient, WorkspaceSummary, PaginatedResponse } from "../../lib/api-client.js";
import type { Session } from "@fuel-code/shared";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeWorkspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-001",
    canonical_id: "github.com/test/repo",
    display_name: "test-repo",
    default_branch: "main",
    metadata: {},
    first_seen_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-15T12:00:00Z",
    session_count: 5,
    active_session_count: 1,
    last_session_at: "2025-01-15T12:00:00Z",
    device_count: 1,
    total_cost_usd: 1.5,
    total_tokens_in: 100000,
    total_tokens_out: 40000,
    total_duration_ms: 3600000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session & Record<string, unknown>> = {}): Session {
  return {
    id: "sess-001",
    workspace_id: "ws-001",
    device_id: "dev-001",
    cc_session_id: "cc-123",
    lifecycle: "capturing",
    parse_status: "pending",
    cwd: "/home/user/project",
    git_branch: "main",
    git_remote: "https://github.com/test/repo",
    model: "claude-3.5-sonnet",
    duration_ms: 1800000,
    transcript_path: null,
    started_at: "2025-01-15T10:00:00Z",
    ended_at: null,
    metadata: {},
    ...overrides,
  } as Session;
}

// ---------------------------------------------------------------------------
// Mock API client
// ---------------------------------------------------------------------------

function createMockApi(opts?: {
  workspaces?: WorkspaceSummary[];
  sessions?: Session[];
  workspacesError?: Error;
  sessionsError?: Error;
}): FuelApiClient {
  const workspaces = opts?.workspaces ?? [makeWorkspace()];
  const sessions = opts?.sessions ?? [makeSession()];

  return {
    listWorkspaces: async (): Promise<PaginatedResponse<WorkspaceSummary>> => {
      if (opts?.workspacesError) throw opts.workspacesError;
      return {
        data: workspaces,
        nextCursor: null,
        hasMore: false,
      };
    },
    listSessions: async (): Promise<PaginatedResponse<Session>> => {
      if (opts?.sessionsError) throw opts.sessionsError;
      return {
        data: sessions,
        nextCursor: null,
        hasMore: false,
      };
    },
  } as unknown as FuelApiClient;
}

// ---------------------------------------------------------------------------
// Mock WsClient — EventEmitter with WsClient interface
// ---------------------------------------------------------------------------

class MockWsClient extends EventEmitter {
  connected = false;
  _state: string = "disconnected";

  get state() {
    return this._state;
  }

  async connect() {
    this.connected = true;
    this._state = "connected";
  }

  disconnect() {
    this.connected = false;
    this._state = "disconnected";
  }

  subscribe() {}
  unsubscribe() {}
  destroy() {}
}

// ---------------------------------------------------------------------------
// Helper to render Dashboard with defaults
// ---------------------------------------------------------------------------

function renderDashboard(overrides?: Partial<DashboardProps> & {
  workspaces?: WorkspaceSummary[];
  sessions?: Session[];
  workspacesError?: Error;
  sessionsError?: Error;
}) {
  const api = overrides?.api ?? createMockApi({
    workspaces: overrides?.workspaces,
    sessions: overrides?.sessions,
    workspacesError: overrides?.workspacesError,
    sessionsError: overrides?.sessionsError,
  });
  const ws = overrides?.ws ?? new MockWsClient();
  const onSelectSession = overrides?.onSelectSession ?? (() => {});

  return render(
    <Dashboard api={api as any} ws={ws as any} onSelectSession={onSelectSession} />,
  );
}

// ---------------------------------------------------------------------------
// Helper: wait for next render tick (async data fetching)
// ---------------------------------------------------------------------------

function wait(ms: number = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Strip ANSI codes for text assertions
// ---------------------------------------------------------------------------

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
function strip(s: string | undefined): string {
  return (s ?? "").replace(ANSI_REGEX, "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dashboard", () => {
  afterEach(() => {
    cleanup();
  });

  // 1. Dashboard renders workspace list with names and counts
  it("renders workspace list with names and counts", async () => {
    const ws1 = makeWorkspace({ id: "ws-001", display_name: "alpha-repo", session_count: 3 });
    const ws2 = makeWorkspace({ id: "ws-002", display_name: "beta-repo", session_count: 7 });
    const instance = renderDashboard({ workspaces: [ws1, ws2] });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("alpha-repo");
    expect(output).toContain("beta-repo");
    expect(output).toContain("(3)");
    expect(output).toContain("(7)");
  });

  // 2. First workspace selected by default, sessions appear
  it("first workspace is selected by default and sessions are shown", async () => {
    const ws = makeWorkspace({ id: "ws-001", display_name: "my-project" });
    const sess = makeSession({
      id: "sess-001",
      workspace_id: "ws-001",
      lifecycle: "capturing",
    });
    const instance = renderDashboard({ workspaces: [ws], sessions: [sess] });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("my-project");
    expect(output).toContain("LIVE");
  });

  // 3. j moves workspace down, k moves up
  it("j/k navigates workspace list", async () => {
    const ws1 = makeWorkspace({ id: "ws-001", display_name: "first" });
    const ws2 = makeWorkspace({ id: "ws-002", display_name: "second" });
    const instance = renderDashboard({ workspaces: [ws1, ws2] });
    await wait(100);

    // Press j to move down
    instance.stdin.write("j");
    await wait(50);
    const afterJ = strip(instance.lastFrame());
    // second should now be selected - it will show ">" prefix
    expect(afterJ).toContain("second");

    // Press k to move back up
    instance.stdin.write("k");
    await wait(50);
    const afterK = strip(instance.lastFrame());
    expect(afterK).toContain("first");
  });

  // 4. Changing workspace fetches that workspace's sessions
  it("changing workspace triggers session re-fetch", async () => {
    let lastWorkspaceId: string | null = null;
    const mockApi = {
      listWorkspaces: async () => ({
        data: [
          makeWorkspace({ id: "ws-A", display_name: "repo-a" }),
          makeWorkspace({ id: "ws-B", display_name: "repo-b" }),
        ],
        nextCursor: null,
        hasMore: false,
      }),
      listSessions: async (params: any) => {
        // fetchSessions passes SessionListParams (camelCase) to listSessions
        lastWorkspaceId = params?.workspaceId ?? null;
        return { data: [], nextCursor: null, hasMore: false };
      },
    } as unknown as FuelApiClient;

    const instance = render(
      <Dashboard api={mockApi} ws={new MockWsClient() as any} onSelectSession={() => {}} />,
    );
    await wait(100);

    // Navigate down to second workspace
    instance.stdin.write("j");
    await wait(150);
    expect(lastWorkspaceId).toBe("ws-B");
    cleanup();
  });

  // 5. Tab switches focus from workspace to session pane
  it("Tab switches focus between panes", async () => {
    const instance = renderDashboard({
      workspaces: [makeWorkspace()],
      sessions: [makeSession()],
    });
    await wait(100);

    const before = strip(instance.lastFrame());
    expect(before).toContain("WORKSPACES");

    // Press Tab to switch to sessions pane
    instance.stdin.write("\t");
    await wait(50);
    const after = strip(instance.lastFrame());
    // Both pane headers still present, focus indicator shifts
    expect(after).toContain("SESSIONS");
  });

  // 6. j/k navigates sessions when focused on session pane
  it("j/k navigates sessions in session pane", async () => {
    const sessions = [
      makeSession({ id: "s1", lifecycle: "capturing" }),
      makeSession({ id: "s2", lifecycle: "summarized" }),
    ];
    const instance = renderDashboard({
      workspaces: [makeWorkspace()],
      sessions,
    });
    await wait(100);

    // Switch to sessions pane
    instance.stdin.write("\t");
    await wait(50);

    // Navigate down
    instance.stdin.write("j");
    await wait(50);

    const output = strip(instance.lastFrame());
    expect(output).toContain("DONE");
  });

  // 7. Enter calls onSelectSession with session ID
  it("Enter calls onSelectSession with the selected session ID", async () => {
    let selectedId = "";
    const instance = render(
      <Dashboard
        api={createMockApi({
          workspaces: [makeWorkspace()],
          sessions: [makeSession({ id: "sess-xyz" })],
        })}
        ws={new MockWsClient() as any}
        onSelectSession={(id) => { selectedId = id; }}
      />,
    );
    await wait(100);

    // Switch to sessions pane and press Enter
    instance.stdin.write("\t");
    await wait(50);
    instance.stdin.write("\r");
    await wait(50);

    expect(selectedId).toBe("sess-xyz");
    cleanup();
  });

  // 8. r re-fetches workspaces and sessions
  it("r refreshes data", async () => {
    let fetchCount = 0;
    const mockApi = {
      listWorkspaces: async () => {
        fetchCount++;
        return { data: [makeWorkspace()], nextCursor: null, hasMore: false };
      },
      listSessions: async () => {
        fetchCount++;
        return { data: [], nextCursor: null, hasMore: false };
      },
    } as unknown as FuelApiClient;

    const instance = render(
      <Dashboard api={mockApi} ws={new MockWsClient() as any} onSelectSession={() => {}} />,
    );
    await wait(100);
    const countBefore = fetchCount;

    instance.stdin.write("r");
    await wait(150);

    expect(fetchCount).toBeGreaterThan(countBefore);
    cleanup();
  });

  // 9. SessionRow shows correct lifecycle icons
  it("shows correct lifecycle icons for different session states", async () => {
    const sessions = [
      makeSession({ id: "s1", lifecycle: "capturing" }),
      makeSession({ id: "s2", lifecycle: "summarized" }),
      makeSession({ id: "s3", lifecycle: "failed" }),
    ];
    const instance = renderDashboard({
      workspaces: [makeWorkspace()],
      sessions,
    });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("LIVE");
    expect(output).toContain("DONE");
    expect(output).toContain("FAIL");
  });

  // 10. Live sessions show message/tool counts
  it("live sessions display message counts when available", async () => {
    const sess = makeSession({
      id: "s1",
      lifecycle: "capturing",
    });
    (sess as any).total_messages = 15;
    (sess as any).tool_uses = 8;

    const instance = renderDashboard({
      workspaces: [makeWorkspace()],
      sessions: [sess],
    });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("LIVE");
    expect(output).toContain("15 messages");
  });

  // 11. Summarized sessions with commits show commit messages
  it("summarized sessions show commit messages when available", async () => {
    const sess = makeSession({ id: "s1", lifecycle: "summarized" });
    (sess as any).commit_messages = ["fix: login bug", "feat: add dashboard"];

    const instance = renderDashboard({
      workspaces: [makeWorkspace()],
      sessions: [sess],
    });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("fix: login bug");
  });

  // 12. StatusBar shows today's stats
  it("StatusBar displays aggregate statistics", async () => {
    const ws = makeWorkspace({
      session_count: 12,
      total_tokens_in: 500000,
      total_tokens_out: 200000,
      total_duration_ms: 7200000,
    });
    const instance = renderDashboard({ workspaces: [ws] });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("12 sessions");
    expect(output).toContain("500K/200K");
  });

  // 13. StatusBar shows WS connected/polling status
  it("StatusBar shows WebSocket connection state", async () => {
    const mockWs = new MockWsClient();
    mockWs._state = "connected";
    const instance = renderDashboard({ ws: mockWs as any });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("\u25CF Connected");
  });

  // 14. WS session.update updates session in-place
  it("WS session.update updates session fields in-place", async () => {
    const mockWs = new MockWsClient();
    const sess = makeSession({ id: "sess-upd", lifecycle: "capturing" });
    (sess as any).summary = null;
    const instance = renderDashboard({
      workspaces: [makeWorkspace()],
      sessions: [sess],
      ws: mockWs as any,
    });
    await wait(100);

    // Emit session.update via WS
    mockWs.emit("session.update", {
      session_id: "sess-upd",
      lifecycle: "summarized",
      summary: "Fixed login bug",
    });

    // Wait for debounce flush (500ms interval)
    await wait(600);
    const output = strip(instance.lastFrame());
    expect(output).toContain("DONE");
  });

  // 15. WS session.start event prepends new session
  it("WS event with session.start prepends new session", async () => {
    const mockWs = new MockWsClient();
    const ws = makeWorkspace({ id: "ws-001" });
    const instance = renderDashboard({
      workspaces: [ws],
      sessions: [],
      ws: mockWs as any,
    });
    await wait(100);

    // Emit session.start event
    mockWs.emit("event", {
      id: "evt-001",
      type: "session.start",
      timestamp: new Date().toISOString(),
      device_id: "dev-001",
      workspace_id: "ws-001",
      session_id: "new-sess",
      data: { cc_session_id: "cc-new", cwd: "/tmp" },
      ingested_at: null,
      blob_refs: [],
    });

    await wait(600);
    const output = strip(instance.lastFrame());
    expect(output).toContain("LIVE");
  });

  // 16. Empty workspace list shows appropriate message
  it("shows empty state when no workspaces exist", async () => {
    const instance = renderDashboard({ workspaces: [], sessions: [] });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("No workspaces");
  });

  // 17. API error shows ErrorBanner
  it("shows ErrorBanner when API returns error", async () => {
    const instance = renderDashboard({
      workspacesError: new Error("Connection refused"),
    });
    await wait(100);
    const output = strip(instance.lastFrame());
    expect(output).toContain("Error");
    expect(output).toContain("Connection refused");
  });

  // 18. Loading state shows Spinner
  it("shows loading spinner while data is being fetched", async () => {
    // Create an API that never resolves to keep loading state
    const api = {
      listWorkspaces: () => new Promise(() => {}), // Never resolves
      listSessions: () => new Promise(() => {}),
    } as unknown as FuelApiClient;

    const instance = render(
      <Dashboard api={api} ws={new MockWsClient() as any} onSelectSession={() => {}} />,
    );
    await wait(50);
    const output = strip(instance.lastFrame());
    expect(output).toContain("Loading");
    cleanup();
  });
});
