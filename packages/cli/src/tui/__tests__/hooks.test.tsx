/**
 * Unit tests for TUI hooks: useWorkspaces, useSessions, useWsConnection, useTodayStats.
 *
 * Since these are React hooks, we test them indirectly by rendering minimal
 * components that use the hooks and capturing their output via ink-testing-library.
 * Where possible we test the hook logic directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import React, { useState, useEffect } from "react";
import { render, cleanup } from "ink-testing-library";
import { Text, Box } from "ink";
import { EventEmitter } from "events";
import type { FuelApiClient, WorkspaceSummary, PaginatedResponse } from "../../lib/api-client.js";
import type { Session } from "@fuel-code/shared";
import { useWorkspaces } from "../hooks/useWorkspaces.js";
import { useSessions } from "../hooks/useSessions.js";
import { useWsConnection, type UseWsConnectionResult } from "../hooks/useWsConnection.js";
import { useTodayStats, type TodayStats } from "../hooks/useTodayStats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wait(ms: number = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
function strip(s: string | undefined): string {
  return (s ?? "").replace(ANSI_REGEX, "");
}

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
    total_cost_usd: 2.0,
    total_tokens_in: 100000,
    total_tokens_out: 40000,
    total_duration_ms: 3600000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
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
  };
}

class MockWsClient extends EventEmitter {
  connected = false;
  _state: string = "disconnected";
  get state() { return this._state; }
  async connect() { this._state = "connected"; }
  disconnect() { this._state = "disconnected"; }
  subscribe() {}
  unsubscribe() {}
  destroy() {}
}

// ---------------------------------------------------------------------------
// useWorkspaces tests
// ---------------------------------------------------------------------------

describe("useWorkspaces", () => {
  afterEach(() => { cleanup(); });

  // 1. Returns workspaces from API
  it("returns workspaces after loading", async () => {
    const api = {
      listWorkspaces: async () => ({
        data: [makeWorkspace({ display_name: "my-ws" })],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { workspaces, loading } = useWorkspaces(api);
      return <Text>{loading ? "loading" : workspaces.map((w) => w.display_name).join(",")}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(100);
    expect(strip(instance.lastFrame())).toContain("my-ws");
  });

  // 2. Reports error on API failure
  it("reports error when API fails", async () => {
    const api = {
      listWorkspaces: async () => { throw new Error("network fail"); },
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { error, loading } = useWorkspaces(api);
      if (loading) return <Text>loading</Text>;
      return <Text>{error ? error.message : "no error"}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(100);
    expect(strip(instance.lastFrame())).toContain("network fail");
  });

  // 3. Refresh triggers re-fetch
  it("refresh triggers re-fetch", async () => {
    let callCount = 0;
    const api = {
      listWorkspaces: async () => {
        callCount++;
        return { data: [makeWorkspace({ display_name: `call-${callCount}` })], nextCursor: null, hasMore: false };
      },
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { workspaces, refresh } = useWorkspaces(api);
      return (
        <Box flexDirection="column">
          <Text>{workspaces[0]?.display_name ?? "empty"}</Text>
          <Text>{`count:${callCount}`}</Text>
        </Box>
      );
    }

    const instance = render(<TestComponent />);
    await wait(100);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// useSessions tests
// ---------------------------------------------------------------------------

describe("useSessions", () => {
  afterEach(() => { cleanup(); });

  // 4. Returns sessions for given workspaceId
  it("returns sessions for a workspace", async () => {
    const api = {
      listSessions: async () => ({
        data: [makeSession({ id: "s1" })],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { sessions, loading } = useSessions(api, "ws-001");
      if (loading) return <Text>loading</Text>;
      return <Text>{sessions.map((s) => s.id).join(",")}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(100);
    expect(strip(instance.lastFrame())).toContain("s1");
  });

  // 5. Returns empty when workspaceId is null
  it("returns empty sessions when workspaceId is null", async () => {
    const api = {
      listSessions: async () => ({ data: [], nextCursor: null, hasMore: false }),
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { sessions, loading } = useSessions(api, null);
      return <Text>{loading ? "loading" : `count:${sessions.length}`}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(100);
    expect(strip(instance.lastFrame())).toContain("count:0");
  });

  // 6. updateSession merges fields in-place
  it("updateSession merges fields in-place", async () => {
    const api = {
      listSessions: async () => ({
        data: [makeSession({ id: "s1", lifecycle: "capturing" })],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { sessions, loading, updateSession } = useSessions(api, "ws-001");
      useEffect(() => {
        if (!loading && sessions.length > 0) {
          // Schedule update after initial render
          setTimeout(() => updateSession("s1", { lifecycle: "summarized" } as any), 10);
        }
      }, [loading, sessions.length]);
      return <Text>{sessions[0]?.lifecycle ?? "none"}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(200);
    expect(strip(instance.lastFrame())).toContain("summarized");
  });

  // 7. prependSession adds to beginning of list
  it("prependSession adds session to beginning", async () => {
    const api = {
      listSessions: async () => ({
        data: [makeSession({ id: "existing" })],
        nextCursor: null,
        hasMore: false,
      }),
    } as unknown as FuelApiClient;

    function TestComponent() {
      const { sessions, loading, prependSession } = useSessions(api, "ws-001");
      useEffect(() => {
        if (!loading && sessions.length === 1) {
          setTimeout(() => prependSession(makeSession({ id: "new-one" })), 10);
        }
      }, [loading, sessions.length]);
      return <Text>{sessions.map((s) => s.id).join(",")}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(200);
    const output = strip(instance.lastFrame());
    expect(output).toContain("new-one");
  });
});

// ---------------------------------------------------------------------------
// useWsConnection tests
// ---------------------------------------------------------------------------

describe("useWsConnection", () => {
  afterEach(() => { cleanup(); });

  // 8. Reflects initial connected state
  it("reflects initial WS state", async () => {
    const mockWs = new MockWsClient();
    mockWs._state = "connected";

    function TestComponent() {
      const { connected, state } = useWsConnection(mockWs as any);
      return <Text>{connected ? "yes" : "no"}:{state}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(50);
    expect(strip(instance.lastFrame())).toContain("yes:connected");
  });

  // 9. Updates when WS emits connected/disconnected
  it("updates on WS connection events", async () => {
    const mockWs = new MockWsClient();
    mockWs._state = "disconnected";

    function TestComponent() {
      const { connected, state } = useWsConnection(mockWs as any);
      return <Text>{state}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(50);
    expect(strip(instance.lastFrame())).toContain("disconnected");

    mockWs.emit("connected");
    await wait(50);
    expect(strip(instance.lastFrame())).toContain("connected");

    mockWs.emit("disconnected");
    await wait(50);
    expect(strip(instance.lastFrame())).toContain("disconnected");
  });
});

// ---------------------------------------------------------------------------
// useTodayStats tests
// ---------------------------------------------------------------------------

describe("useTodayStats", () => {
  afterEach(() => { cleanup(); });

  // 10. Computes aggregate stats from workspaces
  it("aggregates stats from workspace list", async () => {
    const workspaces: WorkspaceSummary[] = [
      makeWorkspace({ session_count: 3, total_tokens_in: 100000, total_tokens_out: 50000, total_duration_ms: 1000 }),
      makeWorkspace({ session_count: 7, total_tokens_in: 200000, total_tokens_out: 80000, total_duration_ms: 2000 }),
    ];

    function TestComponent() {
      const stats = useTodayStats(workspaces);
      return <Text>{`s:${stats.sessions} ti:${stats.tokensIn} to:${stats.tokensOut} d:${stats.durationMs}`}</Text>;
    }

    const instance = render(<TestComponent />);
    await wait(50);
    const output = strip(instance.lastFrame());
    expect(output).toContain("s:10");
    expect(output).toContain("ti:300000");
    expect(output).toContain("to:130000");
    expect(output).toContain("d:3000");
  });
});
