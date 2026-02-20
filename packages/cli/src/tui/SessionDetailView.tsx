/**
 * SessionDetailView — main TUI screen for viewing a session's details.
 *
 * Reached by pressing Enter on a session in the dashboard. Implements:
 *   - Header with session metadata (workspace, device, duration, cost, tokens, summary)
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
import type { FuelApiClient } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import { useSessionDetail } from "./hooks/useSessionDetail.js";
import { SessionHeader } from "./components/SessionHeader.js";
import { TranscriptViewer } from "./components/TranscriptViewer.js";
import { Sidebar } from "./components/Sidebar.js";
import { FooterBar } from "./components/FooterBar.js";
import { Spinner } from "./components/Spinner.js";
import { GitActivityPanel } from "./components/GitActivityPanel.js";
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
    getExportData,
  } = useSessionDetail(apiClient, wsClient, sessionId);

  const isLive = session?.lifecycle === "capturing";

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
          const fs = require("node:fs");
          fs.writeFileSync(filename, JSON.stringify(data, null, 2));
        } catch {
          // Export failed silently in TUI context
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

  return (
    <Box flexDirection="column">
      {/* Header */}
      <SessionHeader session={session} />

      {/* Tab indicator */}
      <Box marginTop={1}>
        <Text bold color={activeTab === "transcript" ? "cyan" : undefined}>
          [t]ranscript
        </Text>
        <Text>  </Text>
        <Text bold color={activeTab === "events" ? "cyan" : undefined}>
          [e]vents
        </Text>
        <Text>  </Text>
        <Text bold color={activeTab === "git" ? "cyan" : undefined}>
          [g]it
        </Text>
      </Box>

      {/* Tab content */}
      <Box marginTop={1} flexGrow={1}>
        {activeTab === "transcript" && (
          <Box>
            {/* Left panel: transcript (~65%) */}
            <Box flexGrow={1} flexBasis="65%">
              <TranscriptViewer
                messages={transcript as TranscriptMessageWithBlocks[] | null}
                scrollOffset={scrollOffset}
                onScrollChange={handleScrollChange}
                isLive={isLive}
                lifecycle={session?.lifecycle}
              />
            </Box>
            {/* Right panel: sidebar (~35%) */}
            <Box flexBasis="35%">
              <Sidebar
                gitActivity={gitActivity}
                messages={(transcript as TranscriptMessageWithBlocks[]) ?? []}
              />
            </Box>
          </Box>
        )}

        {activeTab === "events" && (
          <Box>
            {/* Left panel: events table (~65%) */}
            <Box flexGrow={1} flexBasis="65%" flexDirection="column">
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
                  {/* Event rows */}
                  {events.map((evt, idx) => (
                    <Box key={evt.id || idx}>
                      <Box width={12}><Text>{formatEventTime(evt.timestamp)}</Text></Box>
                      <Box width={22}><Text>{evt.type}</Text></Box>
                      <Box><Text>{formatEventData(evt)}</Text></Box>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
            {/* Right panel: sidebar (~35%) */}
            <Box flexBasis="35%">
              <Sidebar
                gitActivity={gitActivity}
                messages={(transcript as TranscriptMessageWithBlocks[]) ?? []}
              />
            </Box>
          </Box>
        )}

        {activeTab === "git" && (
          <Box flexDirection="column" width="100%">
            <GitActivityPanel commits={gitActivity} detailed />
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <FooterBar activeTab={activeTab} isLive={isLive} />
      </Box>
    </Box>
  );
}
