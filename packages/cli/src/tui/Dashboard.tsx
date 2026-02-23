/**
 * Dashboard view — the main TUI screen shown when `fuel-code` runs with no args.
 *
 * Two-column layout:
 *   Left (~30%):  Workspace list with selection indicator
 *   Right (~70%): Session list for the selected workspace
 *   Bottom:       StatusBar with stats, WS status, and key hints
 *
 * Keyboard navigation:
 *   j/k    — navigate within the focused pane
 *   Tab    — switch focus between workspace and session panes
 *   Enter  — open session detail view
 *   r      — refresh data from API
 *
 * WebSocket live updates:
 *   - session.update: updates matching session in-place
 *   - event (session.start): prepends new session if in selected workspace
 *   - event (session.end): updates matching session lifecycle to 'ended'
 *   - Updates are debounced to max 2/sec (500ms flush interval)
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { FuelApiClient } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import type { Event, Session } from "@fuel-code/shared";
import { useWorkspaces } from "./hooks/useWorkspaces.js";
import { useSessions } from "./hooks/useSessions.js";
import { useWsConnection } from "./hooks/useWsConnection.js";
import { useTodayStats } from "./hooks/useTodayStats.js";
import { WorkspaceItem } from "./components/WorkspaceItem.js";
import { SessionRow, type SessionDisplayData } from "./components/SessionRow.js";
import { StatusBar } from "./components/StatusBar.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";

export interface DashboardProps {
  api: FuelApiClient;
  ws: WsClient;
  onSelectSession: (sessionId: string) => void;
}

/**
 * Buffered WS update that will be flushed to state at max 2/sec.
 * Each update is either a session field patch or a new session to prepend.
 */
type WsBufferEntry =
  | { type: "update"; sessionId: string; patch: Record<string, unknown> }
  | { type: "prepend"; session: SessionDisplayData };

export function Dashboard({
  api,
  ws,
  onSelectSession,
}: DashboardProps): React.ReactElement {
  // ----- Focus and navigation state -----
  const [focusPane, setFocusPane] = useState<"workspaces" | "sessions">("workspaces");
  const [selectedWorkspaceIndex, setSelectedWorkspaceIndex] = useState(0);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);

  // ----- Data hooks -----
  const {
    workspaces,
    loading: wsLoading,
    error: wsError,
    refresh: refreshWorkspaces,
  } = useWorkspaces(api);

  const selectedWorkspace = workspaces[selectedWorkspaceIndex] ?? null;

  const {
    sessions,
    loading: sessLoading,
    error: sessError,
    refresh: refreshSessions,
    updateSession,
    prependSession,
  } = useSessions(api, selectedWorkspace?.id ?? null);

  const { connected: wsConnected, state: wsState } = useWsConnection(ws);
  const stats = useTodayStats(workspaces);

  // ----- Reset session index when workspace changes -----
  useEffect(() => {
    setSelectedSessionIndex(0);
  }, [selectedWorkspaceIndex]);

  // ----- WebSocket live update handling with debounce buffer -----
  const wsBufferRef = useRef<WsBufferEntry[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Flush buffered WS updates to state
  const flushBuffer = useCallback(() => {
    const entries = wsBufferRef.current;
    if (entries.length === 0) return;
    wsBufferRef.current = [];

    for (const entry of entries) {
      if (entry.type === "update") {
        updateSession(entry.sessionId, entry.patch as Partial<Session>);
      } else if (entry.type === "prepend") {
        prependSession(entry.session);
      }
    }
  }, [updateSession, prependSession]);

  // Set up flush interval (max 2/sec = every 500ms)
  useEffect(() => {
    flushTimerRef.current = setInterval(flushBuffer, 500);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, [flushBuffer]);

  // WS event listeners
  useEffect(() => {
    const onSessionUpdate = (update: {
      session_id: string;
      lifecycle: string;
      summary?: string;
      stats?: { total_messages?: number; total_cost_usd?: number; duration_ms?: number };
    }) => {
      const patch: Record<string, unknown> = { lifecycle: update.lifecycle };
      if (update.summary) patch.summary = update.summary;
      if (update.stats?.total_messages != null) patch.total_messages = update.stats.total_messages;
      if (update.stats?.duration_ms != null) patch.duration_ms = update.stats.duration_ms;
      wsBufferRef.current.push({ type: "update", sessionId: update.session_id, patch });
    };

    const onEvent = (event: Event) => {
      if (event.type === "session.start" && selectedWorkspace && event.workspace_id === selectedWorkspace.id) {
        // Create a minimal session object from the event to prepend
        const data = (event.data ?? {}) as Record<string, unknown>;
        const newSession: SessionDisplayData = {
          id: event.session_id ?? event.id,
          workspace_id: event.workspace_id,
          device_id: event.device_id,
          lifecycle: "detected",
          started_at: event.timestamp,
          ended_at: null,
          duration_ms: null,
          cc_session_id: (data.cc_session_id as string) ?? "",
          parse_status: "pending",
          cwd: (data.cwd as string) ?? "",
          git_branch: null,
          git_remote: null,
          model: null,
          transcript_path: null,
          metadata: {},
        };
        wsBufferRef.current.push({ type: "prepend", session: newSession });
      } else if (event.type === "session.end" && event.session_id) {
        wsBufferRef.current.push({
          type: "update",
          sessionId: event.session_id,
          patch: { lifecycle: "ended", ended_at: event.timestamp },
        });
      }
    };

    ws.on("session.update", onSessionUpdate);
    ws.on("event", onEvent);

    return () => {
      ws.removeListener("session.update", onSessionUpdate);
      ws.removeListener("event", onEvent);
    };
  }, [ws, selectedWorkspace]);

  // ----- Polling fallback: poll every 10s when WS is disconnected -----
  useEffect(() => {
    if (wsConnected) return;

    const pollTimer = setInterval(() => {
      refreshWorkspaces();
      refreshSessions();
    }, 10_000);

    return () => clearInterval(pollTimer);
  }, [wsConnected, refreshWorkspaces, refreshSessions]);

  // ----- Keyboard input -----
  useInput((input, key) => {
    // Navigation: j/down=down, k/up=up
    if (input === "j" || key.downArrow) {
      if (focusPane === "workspaces") {
        setSelectedWorkspaceIndex((i) => Math.min(i + 1, workspaces.length - 1));
      } else {
        setSelectedSessionIndex((i) => Math.min(i + 1, sessions.length - 1));
      }
    }
    if (input === "k" || key.upArrow) {
      if (focusPane === "workspaces") {
        setSelectedWorkspaceIndex((i) => Math.max(i - 1, 0));
      } else {
        setSelectedSessionIndex((i) => Math.max(i - 1, 0));
      }
    }

    // Tab: switch pane
    if (key.tab) {
      setFocusPane((p) => (p === "workspaces" ? "sessions" : "workspaces"));
    }

    // Enter: select session for detail view
    if (key.return && focusPane === "sessions" && sessions[selectedSessionIndex]) {
      onSelectSession(sessions[selectedSessionIndex].id);
    }

    // r: refresh
    if (input === "r") {
      refreshWorkspaces();
      refreshSessions();
    }
  });

  // ----- Render -----
  const loading = wsLoading || sessLoading;
  const error = wsError || sessError;

  return (
    <Box flexDirection="column" width="100%">
      {/* Title bar */}
      <Box>
        <Text bold> fuel-code </Text>
      </Box>

      {/* Error banner */}
      {error && <ErrorBanner message={error.message} />}

      {/* Main content: two panes */}
      <Box flexGrow={1}>
        {/* Left pane: Workspaces */}
        <Box
          flexDirection="column"
          width="30%"
          borderStyle="single"
          borderRight
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
        >
          <Text bold color={focusPane === "workspaces" ? "cyan" : undefined}>
            {" "}WORKSPACES
          </Text>
          {loading && workspaces.length === 0 ? (
            <Spinner label="Loading workspaces..." />
          ) : workspaces.length === 0 ? (
            <Text dimColor> No workspaces found. Run {"`"}fuel-code init{"`"} to get started.</Text>
          ) : (
            workspaces.map((w, i) => (
              <WorkspaceItem
                key={w.id}
                workspace={w}
                selected={i === selectedWorkspaceIndex && focusPane === "workspaces"}
              />
            ))
          )}
        </Box>

        {/* Right pane: Sessions */}
        <Box flexDirection="column" width="70%">
          <Text bold color={focusPane === "sessions" ? "cyan" : undefined}>
            {" "}SESSIONS
          </Text>
          {sessLoading && sessions.length === 0 ? (
            <Spinner label="Loading sessions..." />
          ) : sessions.length === 0 ? (
            <Text dimColor> No sessions for this workspace</Text>
          ) : (
            sessions.map((s, i) => (
              <SessionRow
                key={s.id}
                session={s as SessionDisplayData}
                selected={i === selectedSessionIndex && focusPane === "sessions"}
              />
            ))
          )}
        </Box>
      </Box>

      {/* Bottom: Status bar */}
      <StatusBar stats={stats} wsState={wsState} />
    </Box>
  );
}
