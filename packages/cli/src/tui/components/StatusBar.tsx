/**
 * Status bar for the bottom of the Dashboard.
 *
 * Displays today's aggregate statistics, WebSocket connection status,
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
  const wsLabel =
    wsState === "connected"
      ? "connected (ws)"
      : wsState === "reconnecting"
        ? "reconnecting..."
        : "polling";

  const wsColor =
    wsState === "connected" ? "green" : wsState === "reconnecting" ? "yellow" : "red";

  return (
    <Box flexDirection="column" borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
      <Box>
        <Text>
          {stats.sessions} sessions {"\u00B7"}{" "}
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
