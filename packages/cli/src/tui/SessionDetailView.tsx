/**
 * SessionDetailView — main TUI screen for viewing a session's details.
 *
 * Reached by pressing Enter on a session in the dashboard. Implements:
 *   - Compact Panel header with session metadata in the title
 *   - Scrollable transcript viewer (left ~65%)
 *   - Sidebar with git/tools/files (right ~35%)
 *   - Tab switching: t=transcript, e=events (lazy fetch), g=git (full-width)
 *   - Live session support: WS subscription, elapsed time counter, auto-scroll
 *
 * Keybindings:
 *   b/Escape — back to dashboard
 *   t — transcript tab (default)
 *   e — events tab (lazy fetch on first switch)
 *   g — git tab (full-width)
 *   j/k — scroll up/down by message
 *   Space — page down
 *   x — export session JSON
 *   q — quit
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import * as fs from "node:fs";
import type { FuelApiClient } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import { useSessionDetail } from "./hooks/useSessionDetail.js";
import { SessionHeader } from "./components/SessionHeader.js";
import { TranscriptViewer } from "./components/TranscriptViewer.js";
import { Sidebar } from "./components/Sidebar.js";
import { Spinner } from "./components/Spinner.js";
import { GitActivityPanel } from "./components/GitActivityPanel.js";
import { Panel, KeyHint, theme } from "./primitives/index.js";
import { formatDuration, formatTokensCompact, formatCost } from "../lib/formatters.js";
import type { TranscriptMessageWithBlocks } from "./components/MessageBlock.js";
import type { Event } from "@fuel-code/shared";

export interface SessionDetailViewProps {
  apiClient: FuelApiClient;
  wsClient: WsClient | null;
  sessionId: string;
  onBack: () => void;
}

type TabType = "transcript" | "events" | "git";

/**
 * Format events into a simple table for the events tab.
 */
function formatEventTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return "??:??:??";
  }
}

function formatEventData(evt: Event): string {
  const data = evt.data ?? {};
  switch (evt.type) {
    case "session.start": {
      const parts: string[] = [];
      if (data.branch) parts.push(`branch=${data.branch}`);
      if (data.model) parts.push(`model=${data.model}`);
      return parts.join(" ") || "-";
    }
    case "session.end": {
      const parts: string[] = [];
      if (data.duration_ms) parts.push(`duration=${Math.round((data.duration_ms as number) / 60000)}m`);
      if (data.reason) parts.push(`reason=${data.reason as string}`);
      return parts.join(" ") || "-";
    }
    case "git.commit": {
      const sha = data.commit_sha ? (data.commit_sha as string).slice(0, 7) : "";
      const msg = data.message ? `"${data.message as string}"` : "";
      return `${sha} ${msg}`.trim() || "-";
    }
    default:
      return JSON.stringify(data).slice(0, 50);
  }
}

/** Map lifecycle to icon + label for the Panel title */
function lifecycleTag(lifecycle: string): string {
  switch (lifecycle) {
    case "detected":
    case "capturing":
      return "● LIVE";
    case "ended":
      return "◑ ENDED";
    case "parsed":
      return "◌ PARSING";
    case "summarized":
      return "✓ DONE";
    case "archived":
      return "▪ ARCHIVED";
    case "failed":
      return "✗ FAIL";
    default:
      return lifecycle.toUpperCase();
  }
}

export function SessionDetailView({
  apiClient,
  wsClient,
  sessionId,
  onBack,
}: SessionDetailViewProps): React.ReactElement {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabType>("transcript");
  const [scrollOffset, setScrollOffset] = useState(0);

  const {
    session,
    transcript,
    events,
    gitActivity,
    loading,
    error,
    fetchEvents,
    isLive,
    getExportData,
  } = useSessionDetail(apiClient, wsClient, sessionId);

  // Scroll helpers
  const maxScroll = useCallback(() => {
    if (activeTab === "transcript") {
      return Math.max(0, (transcript?.length ?? 0) - 1);
    }
    if (activeTab === "events") {
      return Math.max(0, (events?.length ?? 0) - 1);
    }
    if (activeTab === "git") {
      return Math.max(0, gitActivity.length - 1);
    }
    return 0;
  }, [activeTab, transcript, events, gitActivity]);

  const pageSize = 10;

  const handleScrollChange = useCallback((offset: number) => {
    setScrollOffset(offset);
  }, []);

  // Key handling
  useInput((input, key) => {
    // Back
    if (input === "b" || key.escape) {
      onBack();
      return;
    }

    // Quit
    if (input === "q") {
      exit();
      return;
    }

    // Tab switching
    if (input === "t") {
      setActiveTab("transcript");
      setScrollOffset(0);
      return;
    }
    if (input === "e") {
      setActiveTab("events");
      setScrollOffset(0);
      fetchEvents();
      return;
    }
    if (input === "g") {
      setActiveTab("git");
      setScrollOffset(0);
      return;
    }

    // Scrolling
    if (input === "j" || key.downArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxScroll()));
      return;
    }
    if (input === "k" || key.upArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (input === " " || key.pageDown) {
      setScrollOffset((prev) => Math.min(prev + pageSize, maxScroll()));
      return;
    }
    if (key.pageUp) {
      setScrollOffset((prev) => Math.max(prev - pageSize, 0));
      return;
    }

    // Export
    if (input === "x") {
      const data = getExportData();
      if (data) {
        const filename = `session-${sessionId.slice(0, 8)}.json`;
        try {
          fs.writeFileSync(filename, JSON.stringify(data, null, 2));
        } catch (err) {
          process.stderr.write(`Export failed: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      return;
    }
  });

  // Loading state
  if (loading) {
    return (
      <Box flexDirection="column">
        <Spinner label="Loading session detail..." />
      </Box>
    );
  }

  // Error state
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press b to go back</Text>
      </Box>
    );
  }

  // Session not loaded (shouldn't happen after loading=false and no error)
  if (!session) {
    return (
      <Box flexDirection="column">
        <Text color="red">Session not found</Text>
        <Text dimColor>Press b to go back</Text>
      </Box>
    );
  }

  // Build the compact Panel title from session metadata
  const workspaceName = session.workspace_name ?? session.workspace_id;
  const deviceName = session.device_name ?? session.device_id;
  const stats = session.stats;
  const tokenStr = formatTokensCompact(stats?.tokens_in ?? null, stats?.tokens_out ?? null);
  const lifecycleStr = lifecycleTag(session.lifecycle);
  const headerTitle = `Session ── ${workspaceName} / ${deviceName} ── ${tokenStr} tok ── ${lifecycleStr}`;

  // Compute total item count for scroll position indicator
  const totalItems = activeTab === "transcript"
    ? (transcript?.length ?? 0)
    : activeTab === "events"
      ? (events?.length ?? 0)
      : gitActivity.length;

  return (
    <Box flexDirection="column">
      {/* Header: compact Panel with inline metadata */}
      <Panel title={headerTitle}>
        <SessionHeader session={session} />
      </Panel>

      {/* Tab bar: active tab in accent color, inactive tabs dim, scroll position right-aligned */}
      <Box marginTop={1}>
        <Text bold color={activeTab === "transcript" ? theme.accent : undefined} dimColor={activeTab !== "transcript"}>
          [t]ranscript
        </Text>
        <Text>  </Text>
        <Text bold color={activeTab === "events" ? theme.accent : undefined} dimColor={activeTab !== "events"}>
          [e]vents
        </Text>
        <Text>  </Text>
        <Text bold color={activeTab === "git" ? theme.accent : undefined} dimColor={activeTab !== "git"}>
          [g]it
        </Text>
        <Box flexGrow={1} justifyContent="flex-end">
          {totalItems > 0 && (
            <Text dimColor>msg {scrollOffset + 1} of {totalItems}</Text>
          )}
        </Box>
      </Box>

      {/* Tab content */}
      <Box marginTop={1} flexGrow={1}>
        {activeTab === "transcript" && (
          <Box>
            <Panel title="Transcript" flexBasis="65%" flexGrow={1}>
              <TranscriptViewer
                messages={transcript as TranscriptMessageWithBlocks[] | null}
                scrollOffset={scrollOffset}
                onScrollChange={handleScrollChange}
                isLive={isLive}
                lifecycle={session?.lifecycle}
              />
            </Panel>
            <Panel title="Sidebar" flexBasis="35%">
              <Sidebar
                gitActivity={gitActivity}
                messages={(transcript as TranscriptMessageWithBlocks[]) ?? []}
              />
            </Panel>
          </Box>
        )}

        {activeTab === "events" && (
          <Box>
            <Panel title="Events" flexBasis="65%" flexGrow={1}>
              {events === null ? (
                <Text dimColor>Loading events...</Text>
              ) : events.length === 0 ? (
                <Text dimColor>No events for this session.</Text>
              ) : (
                <Box flexDirection="column">
                  {/* Events table header */}
                  <Box>
                    <Box width={12}><Text bold>TIME</Text></Box>
                    <Box width={22}><Text bold>TYPE</Text></Box>
                    <Box><Text bold>DATA</Text></Box>
                  </Box>
                  {/* Windowed event rows: only render visible slice */}
                  {events.slice(scrollOffset, scrollOffset + pageSize).map((evt, idx) => (
                    <Box key={evt.id || idx}>
                      <Box width={12}><Text>{formatEventTime(evt.timestamp)}</Text></Box>
                      <Box width={22}><Text>{evt.type}</Text></Box>
                      <Box><Text>{formatEventData(evt)}</Text></Box>
                    </Box>
                  ))}
                </Box>
              )}
            </Panel>
            <Panel title="Sidebar" flexBasis="35%">
              <Sidebar
                gitActivity={gitActivity}
                messages={(transcript as TranscriptMessageWithBlocks[]) ?? []}
              />
            </Panel>
          </Box>
        )}

        {activeTab === "git" && (
          <Panel title="Git Activity" flexGrow={1}>
            <GitActivityPanel commits={gitActivity} detailed />
          </Panel>
        )}
      </Box>

      {/* Footer: KeyHint replaces FooterBar */}
      <Box marginTop={1}>
        <KeyHint
          hints={[
            { key: 'b', action: 'back' },
            { key: 't', action: 'transcript' },
            { key: 'e', action: 'events' },
            { key: 'g', action: 'git' },
            { key: 'j/k', action: 'scroll' },
            { key: 'spc', action: 'page' },
            { key: 'x', action: 'export' },
            { key: 'q', action: 'quit' },
          ]}
          extra={isLive ? "LIVE" : undefined}
        />
      </Box>
    </Box>
  );
}
