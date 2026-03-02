/**
 * SessionsView — full-width session list for a single workspace.
 *
 * Groups sessions by team, shows session chain indicators (resumed_from),
 * supports expanding/collapsing team groups, and applies live WebSocket
 * updates via a buffered flush pattern. This replaces the right pane
 * of the old Dashboard with a standalone navigable view.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import type { FuelApiClient, WorkspaceSummary } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import type { Event, Session } from "@fuel-code/shared";
import { useSessions } from "./hooks/useSessions.js";
import { useWsConnection } from "./hooks/useWsConnection.js";
import { SessionRow, type SessionDisplayData } from "./components/SessionRow.js";
import { TeamGroupRow, type TeamGroup } from "./components/TeamGroupRow.js";
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

type DisplayItem =
  | { type: "session"; session: SessionDisplayData; isChainChild: boolean }
  | { type: "team-header"; group: TeamGroup }
  | { type: "team-member"; group: TeamGroup; memberIndex: number; session: SessionDisplayData };

// ---------------------------------------------------------------------------
// WS buffer entry types for batched updates
// ---------------------------------------------------------------------------

type WsBufferEntry =
  | { type: "update"; sessionId: string; patch: Record<string, unknown> }
  | { type: "prepend"; session: SessionDisplayData };

// ---------------------------------------------------------------------------
// Helper: build team groups + interleaved display order
// ---------------------------------------------------------------------------

/** A sortable item that can be either a standalone session or a team group */
type SortableItem =
  | { kind: "session"; session: SessionDisplayData }
  | { kind: "team"; group: TeamGroup };

/**
 * Group sessions by team_name and interleave with standalone sessions
 * chronologically by most recent started_at.
 */
function buildGroupedItems(sessions: SessionDisplayData[]): SortableItem[] {
  const teamMap = new Map<string, SessionDisplayData[]>();
  const standalone: SessionDisplayData[] = [];

  for (const s of sessions) {
    if (s.team_name) {
      const existing = teamMap.get(s.team_name);
      if (existing) {
        existing.push(s);
      } else {
        teamMap.set(s.team_name, [s]);
      }
    } else {
      standalone.push(s);
    }
  }

  const items: SortableItem[] = [];

  // Build TeamGroup objects
  for (const [teamName, members] of teamMap) {
    const leadSession = members.find((m) => m.team_role === "lead") ?? null;
    const memberSessions = members.filter((m) => m.team_role !== "lead");
    const group: TeamGroup = {
      teamName,
      leadSession,
      memberSessions,
      allSessions: members,
    };
    items.push({ kind: "team", group });
  }

  // Add standalone sessions
  for (const s of standalone) {
    items.push({ kind: "session", session: s });
  }

  // Sort chronologically by most recent started_at (newest first)
  items.sort((a, b) => {
    const aTime = getMostRecentTime(a);
    const bTime = getMostRecentTime(b);
    return bTime - aTime; // descending
  });

  return items;
}

/** Get the most recent started_at timestamp for a sortable item */
function getMostRecentTime(item: SortableItem): number {
  if (item.kind === "session") {
    return new Date(item.session.started_at).getTime();
  }
  // For teams, use the most recent member's started_at
  let max = 0;
  for (const s of item.group.allSessions) {
    const t = new Date(s.started_at).getTime();
    if (t > max) max = t;
  }
  return max;
}

/**
 * Build a flat display list from grouped items, respecting expanded teams
 * and marking chain children (sessions resumed from another visible session).
 */
function buildDisplayList(
  groupedItems: SortableItem[],
  expandedTeams: Set<string>,
  visibleSessionIds: Set<string>,
): DisplayItem[] {
  const result: DisplayItem[] = [];

  for (const item of groupedItems) {
    if (item.kind === "session") {
      const isChainChild =
        !!item.session.resumed_from_session_id &&
        visibleSessionIds.has(item.session.resumed_from_session_id);
      result.push({ type: "session", session: item.session, isChainChild });
    } else {
      // Team group — always show header
      result.push({ type: "team-header", group: item.group });

      // If expanded, show individual member rows
      if (expandedTeams.has(item.group.teamName)) {
        for (let i = 0; i < item.group.allSessions.length; i++) {
          result.push({
            type: "team-member",
            group: item.group,
            memberIndex: i,
            session: item.group.allSessions[i],
          });
        }
      }
    }
  }

  return result;
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
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());

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

  // Group sessions by team and interleave chronologically
  const groupedItems = useMemo(
    () => buildGroupedItems(displaySessions),
    [displaySessions],
  );

  // Build flat display list for cursor navigation
  const displayList = useMemo(
    () => buildDisplayList(groupedItems, expandedTeams, visibleSessionIds),
    [groupedItems, expandedTeams, visibleSessionIds],
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

  // Clamp selected index when display list shrinks (e.g., team collapsed)
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
    // j / down: move cursor down
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, displayList.length - 1));
    }
    // k / up: move cursor up
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    // Enter: open session or toggle team expansion
    if (key.return && displayList.length > 0) {
      const item = displayList[selectedIndex];
      if (!item) return;

      if (item.type === "session") {
        onSelectSession(item.session.id);
      } else if (item.type === "team-header") {
        // Toggle expansion
        setExpandedTeams((prev) => {
          const next = new Set(prev);
          if (next.has(item.group.teamName)) {
            next.delete(item.group.teamName);
          } else {
            next.add(item.group.teamName);
          }
          return next;
        });
      } else if (item.type === "team-member") {
        onSelectSession(item.session.id);
      }
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
        ) : (
          displayList.map((item, idx) => {
            const isSelected = idx === selectedIndex;

            if (item.type === "session") {
              // Standalone session — optionally prefixed with chain indicator
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
            }

            if (item.type === "team-header") {
              // Team group header — determine selected member index for TeamGroupRow
              // When the header itself is selected, selectedMemberIndex is -1
              // Render header only — expanded member rows are handled as
              // separate display list items below so each gets its own
              // navigation index. Pass expanded={false} to avoid double render.
              return (
                <TeamGroupRow
                  key={`team-${item.group.teamName}`}
                  group={item.group}
                  expanded={false}
                  selected={isSelected}
                  selectedMemberIndex={-1}
                />
              );
            }

            if (item.type === "team-member") {
              // Expanded team member — render as a sub-row within TeamGroupRow
              // We render individual member lines here since TeamGroupRow handles
              // its own member rendering only when it sees the full expanded state.
              // Instead, render each member as a standalone SessionRow with indent.
              const display = getLifecycleDisplay(item.session.lifecycle);
              const role = getMemberRole(item.session);
              const duration = formatDurationCompact(item.session.duration_ms);
              const summary =
                item.session.summary ??
                (typeof item.session.metadata?.initial_prompt === "string"
                  ? item.session.metadata.initial_prompt
                  : "(no summary)");

              return (
                <Box key={item.session.id} paddingLeft={4}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? "cyan" : undefined}
                  >
                    {isSelected ? "> " : "  "}
                  </Text>
                  <Text color={display.color as any}>
                    {display.icon} {display.label}
                  </Text>
                  <Text>{"  "}</Text>
                  <Text>{role.padEnd(12)}</Text>
                  <Text>{duration.padStart(4)}</Text>
                  <Text>{"  "}</Text>
                  <Text dimColor wrap="truncate">
                    {summary}
                  </Text>
                </Box>
              );
            }

            return null;
          })
        )}
      </Box>

      <StatusBar
        stats={stats}
        wsState={wsState}
        keyHints="j/k:navigate  enter:open/expand  b:back  r:refresh  t:teams  q:quit"
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Local helpers for rendering team member rows inline
// ---------------------------------------------------------------------------

const LIFECYCLE_DISPLAY: Record<
  string,
  { icon: string; label: string; color: string }
> = {
  detected: { icon: "\u25CF", label: "LIVE", color: "green" },
  capturing: { icon: "\u25CF", label: "LIVE", color: "green" },
  ended: { icon: "\u25D0", label: "ENDED", color: "yellow" },
  parsed: { icon: "\u25CC", label: "PARSING", color: "yellow" },
  summarized: { icon: "\u2713", label: "DONE", color: "green" },
  archived: { icon: "\u25AA", label: "ARCHIVED", color: "gray" },
  failed: { icon: "\u2717", label: "FAIL", color: "red" },
};

function getLifecycleDisplay(lifecycle: string) {
  return (
    LIFECYCLE_DISPLAY[lifecycle] ?? {
      icon: "?",
      label: lifecycle.toUpperCase(),
      color: "gray",
    }
  );
}

/** Determine the role label for a member session */
function getMemberRole(member: SessionDisplayData): string {
  if (member.team_role === "lead") return "lead";
  const agentName = (member as any).agent_name;
  if (agentName) return agentName;
  const agentType = (member as any).agent_type;
  if (agentType) return agentType;
  return "member";
}

/** Simple duration formatter for inline team member rows */
function formatDurationCompact(ms: number | null): string {
  if (ms == null || ms <= 0) return "--";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h${remaining}m` : `${hours}h`;
}
