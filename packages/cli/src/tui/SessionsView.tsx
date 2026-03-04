/**
 * SessionsView — full-width session list for a single workspace.
 *
 * Shows sessions with inline teammate annotations (when has_team is true),
 * session chain indicators (resumed_from), and applies live WebSocket
 * updates via a buffered flush pattern. This replaces the right pane
 * of the old Dashboard with a standalone navigable view.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { FuelApiClient, WorkspaceSummary } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import type { Event, Session } from "@fuel-code/shared";
import { useSessions } from "./hooks/useSessions.js";
import { useWsConnection } from "./hooks/useWsConnection.js";
import { SessionRow, type SessionDisplayData } from "./components/SessionRow.js";
import { StatusBar } from "./components/StatusBar.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionsViewProps {
  api: FuelApiClient;
  ws: WsClient;
  workspace: WorkspaceSummary;
  onSelectSession: (sessionId: string) => void;
  onBack: () => void;
  onTeams: () => void;
  onQuit: () => void;
}

// ---------------------------------------------------------------------------
// Display list item types — flat list for cursor navigation
// ---------------------------------------------------------------------------

type DisplayItem = {
  type: "session";
  session: SessionDisplayData;
  isChainChild: boolean;
};

// ---------------------------------------------------------------------------
// WS buffer entry types for batched updates
// ---------------------------------------------------------------------------

type WsBufferEntry =
  | { type: "update"; sessionId: string; patch: Record<string, unknown> }
  | { type: "prepend"; session: SessionDisplayData };

// ---------------------------------------------------------------------------
// Helper: build sorted session list and flat display list
// ---------------------------------------------------------------------------

/**
 * Sort sessions chronologically by started_at (newest first).
 * Teammate info is now rendered inline on each SessionRow via
 * has_team / num_teammates / teammate_names fields, so no grouping is needed.
 */
function buildSortedSessions(sessions: SessionDisplayData[]): SessionDisplayData[] {
  return [...sessions].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
}

/**
 * Build a flat display list from sorted sessions, marking chain children
 * (sessions resumed from another visible session).
 */
function buildDisplayList(
  sortedSessions: SessionDisplayData[],
  visibleSessionIds: Set<string>,
): DisplayItem[] {
  return sortedSessions.map((session) => ({
    type: "session" as const,
    session,
    isChainChild:
      !!session.resumed_from_session_id &&
      visibleSessionIds.has(session.resumed_from_session_id),
  }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionsView({
  api,
  ws,
  workspace,
  onSelectSession,
  onBack,
  onTeams,
  onQuit,
}: SessionsViewProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  // Reserve ~6 lines for header/breadcrumb/status bar, ~3 lines per session row
  const visibleCount = Math.max(5, Math.floor((termRows - 6) / 3));

  const { sessions, loading, error, refresh, updateSession, prependSession } =
    useSessions(api, workspace.id);

  const { connected, state: wsState } = useWsConnection(ws);

  // Cast sessions to SessionDisplayData (API returns enriched objects)
  const displaySessions = sessions as SessionDisplayData[];

  // Build the set of all visible session IDs for chain detection
  const visibleSessionIds = useMemo(
    () => new Set(displaySessions.map((s) => s.id)),
    [displaySessions],
  );

  // Sort sessions chronologically (newest first)
  const sortedSessions = useMemo(
    () => buildSortedSessions(displaySessions),
    [displaySessions],
  );

  // Build flat display list for cursor navigation
  const displayList = useMemo(
    () => buildDisplayList(sortedSessions, visibleSessionIds),
    [sortedSessions, visibleSessionIds],
  );

  // Compute aggregate stats from sessions for the StatusBar
  const stats = useMemo(
    () => ({
      sessions: displaySessions.length,
      durationMs: displaySessions.reduce((s, sess) => s + (sess.duration_ms ?? 0), 0),
      tokensIn: displaySessions.reduce(
        (s, sess) => s + (Number((sess as any).tokens_in) || 0),
        0,
      ),
      tokensOut: displaySessions.reduce(
        (s, sess) => s + (Number((sess as any).tokens_out) || 0),
        0,
      ),
      commits: 0,
    }),
    [displaySessions],
  );

  // Clamp selected index when display list shrinks
  useEffect(() => {
    if (displayList.length > 0 && selectedIndex >= displayList.length) {
      setSelectedIndex(displayList.length - 1);
    }
  }, [displayList.length, selectedIndex]);

  // -----------------------------------------------------------------------
  // WebSocket live updates — buffered flush pattern
  // -----------------------------------------------------------------------

  const wsBufferRef = useRef<WsBufferEntry[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Start/stop the 500ms flush interval
  useEffect(() => {
    flushTimerRef.current = setInterval(flushBuffer, 500);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, [flushBuffer]);

  // Subscribe to WS events and buffer updates
  useEffect(() => {
    const onSessionUpdate = (update: {
      session_id: string;
      lifecycle: string;
      summary?: string;
      stats?: { total_messages?: number; total_cost_usd?: number; duration_ms?: number };
    }) => {
      const patch: Record<string, unknown> = { lifecycle: update.lifecycle };
      if (update.summary) patch.summary = update.summary;
      if (update.stats?.total_messages != null)
        patch.total_messages = update.stats.total_messages;
      if (update.stats?.duration_ms != null)
        patch.duration_ms = update.stats.duration_ms;
      wsBufferRef.current.push({
        type: "update",
        sessionId: update.session_id,
        patch,
      });
    };

    const onEvent = (event: Event) => {
      if (event.type === "session.start" && event.workspace_id === workspace.id) {
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
          cwd: (data.cwd as string) ?? "",
          git_branch: null,
          git_remote: null,
          model: null,
          transcript_path: null,
          last_error: null,
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
  }, [ws, workspace.id]);

  // Polling fallback: refresh every 10s when WS is disconnected
  useEffect(() => {
    if (connected) return;
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [connected, refresh]);

  // -----------------------------------------------------------------------
  // Keyboard navigation
  // -----------------------------------------------------------------------

  useInput((input, key) => {
    // j / down: move cursor down (guard against empty list)
    if ((input === "j" || key.downArrow) && displayList.length > 0) {
      setSelectedIndex((i) => Math.min(i + 1, displayList.length - 1));
    }
    // k / up: move cursor up
    if ((input === "k" || key.upArrow) && displayList.length > 0) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    // Enter: open session detail
    if (key.return && displayList.length > 0) {
      const item = displayList[selectedIndex];
      if (!item) return;
      onSelectSession(item.session.id);
    }
    if (input === "b") onBack();
    if (input === "r") refresh();
    if (input === "t") onTeams();
    if (input === "q") onQuit();
  });

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <Box flexDirection="column" width="100%">
      {/* Breadcrumb header */}
      <Box>
        <Text bold> fuel-code </Text>
        <Text dimColor> {">"} </Text>
        <Text bold> {workspace.display_name} </Text>
      </Box>

      {error && <ErrorBanner message={error.message} />}

      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="cyan">
          {" "}
          SESSIONS
        </Text>

        {loading && displaySessions.length === 0 ? (
          <Spinner label="Loading sessions..." />
        ) : displaySessions.length === 0 ? (
          <Text dimColor>
            {" "}
            No sessions yet. Start a Claude Code session in this workspace.
          </Text>
        ) : (() => {
          // Windowed rendering: compute visible slice around selected index
          const half = Math.floor(visibleCount / 2);
          let windowStart = Math.max(0, selectedIndex - half);
          let windowEnd = windowStart + visibleCount;
          if (windowEnd > displayList.length) {
            windowEnd = displayList.length;
            windowStart = Math.max(0, windowEnd - visibleCount);
          }
          const windowedList = displayList.slice(windowStart, windowEnd);

          return (
            <>
              {windowStart > 0 && (
                <Text dimColor>  ↑ {windowStart} more above</Text>
              )}
              {windowedList.map((item, idx) => {
                const realIdx = windowStart + idx;
                const isSelected = realIdx === selectedIndex;
                return (
                  <Box key={item.session.id} paddingLeft={item.isChainChild ? 2 : 0}>
                    {item.isChainChild && (
                      <Text dimColor>{"\u21B3 "}</Text>
                    )}
                    <Box flexGrow={1}>
                      <SessionRow session={item.session} selected={isSelected} />
                    </Box>
                  </Box>
                );
              })}
              {windowEnd < displayList.length && (
                <Text dimColor>  ↓ {displayList.length - windowEnd} more below</Text>
              )}
            </>
          );
        })()}
      </Box>

      <StatusBar
        stats={stats}
        wsState={wsState}
        keyHints="j/k:navigate  enter:open  b:back  r:refresh  t:teams  q:quit"
      />
    </Box>
  );
}


