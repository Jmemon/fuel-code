/**
 * Status bar for the bottom of the Dashboard.
 *
 * Displays aggregate statistics across all workspaces, WebSocket connection status,
 * and keyboard shortcut hints.
 */

import React from "react";
import { Text, Box } from "ink";
import { formatDuration, formatCost } from "../../lib/formatters.js";
import type { TodayStats } from "../hooks/useTodayStats.js";
import type { WsConnectionState } from "../../lib/ws-client.js";

export interface StatusBarProps {
  stats: TodayStats;
  wsState: WsConnectionState;
  queuePending?: number;
}

export function StatusBar({
  stats,
  wsState,
  queuePending = 0,
}: StatusBarProps): React.ReactElement {
  // WS indicator: filled bullet for connected, open circle for disconnected/polling
  const WS_CONNECTED_LABEL = "\u25CF Connected (ws)";
  const WS_RECONNECTING_LABEL = "\u25CB Reconnecting...";
  const WS_POLLING_LABEL = "\u25CB Polling (10s)";
  const wsLabel =
    wsState === "connected"
      ? WS_CONNECTED_LABEL
      : wsState === "reconnecting"
        ? WS_RECONNECTING_LABEL
        : WS_POLLING_LABEL;

  const wsColor =
    wsState === "connected" ? "green" : "yellow";

  return (
    <Box flexDirection="column" borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
      <Box>
        <Text>
          All: {stats.sessions} sessions {"\u00B7"}{" "}
          {formatDuration(stats.durationMs)} {"\u00B7"}{" "}
          {formatCost(stats.costUsd)}
          {stats.commits > 0 ? ` \u00B7 ${stats.commits} commits` : ""}
        </Text>
      </Box>
      <Box>
        <Text>
          Queue: {queuePending} pending {"\u00B7"} Backend:{" "}
        </Text>
        <Text color={wsColor}>{wsLabel}</Text>
      </Box>
      <Box>
        <Text dimColor>
          j/k:navigate  enter:detail  tab:switch  r:refresh  q:quit
        </Text>
      </Box>
    </Box>
  );
}
