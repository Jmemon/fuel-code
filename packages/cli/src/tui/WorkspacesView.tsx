/**
 * WorkspacesView — full-width workspace list with drill-down navigation.
 *
 * Replaces the left pane of the old Dashboard. Shows all workspaces with
 * session count, active indicator, and last activity. Press Enter to
 * drill into a workspace's sessions.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FuelApiClient } from "../lib/api-client.js";
import type { WsClient } from "../lib/ws-client.js";
import type { WorkspaceSummary } from "../lib/api-client.js";
import { useWorkspaces } from "./hooks/useWorkspaces.js";
import { useWsConnection } from "./hooks/useWsConnection.js";
import { useTodayStats } from "./hooks/useTodayStats.js";
import { StatusBar } from "./components/StatusBar.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { formatDuration, formatRelativeTime } from "../lib/formatters.js";

export interface WorkspacesViewProps {
  api: FuelApiClient;
  ws: WsClient;
  onSelectWorkspace: (workspace: WorkspaceSummary) => void;
  onTeams: () => void;
  onQuit: () => void;
}

export function WorkspacesView({
  api,
  ws,
  onSelectWorkspace,
  onTeams,
  onQuit,
}: WorkspacesViewProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { workspaces, loading, error, refresh } = useWorkspaces(api);
  const { state: wsState } = useWsConnection(ws);
  const stats = useTodayStats(workspaces);

  useInput((input, key) => {
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, workspaces.length - 1));
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (key.return && workspaces[selectedIndex]) {
      onSelectWorkspace(workspaces[selectedIndex]);
    }
    if (input === "r") {
      refresh();
    }
    if (input === "t") {
      onTeams();
    }
    if (input === "q") {
      onQuit();
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box>
        <Text bold> fuel-code </Text>
      </Box>

      {error && <ErrorBanner message={error.message} />}

      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="cyan"> WORKSPACES</Text>
        {loading && workspaces.length === 0 ? (
          <Spinner label="Loading workspaces..." />
        ) : workspaces.length === 0 ? (
          <Text dimColor> No workspaces found. Run `fuel-code init` to get started.</Text>
        ) : (
          workspaces.map((w, i) => {
            const selected = i === selectedIndex;
            const activeCount = w.active_session_count;
            return (
              <Box key={w.id}>
                <Text bold={selected} color={selected ? "cyan" : undefined}>
                  {selected ? "> " : "  "}
                  {w.display_name}
                </Text>
                <Text dimColor>  {w.session_count} sessions</Text>
                <Text dimColor>  {formatDuration(w.total_duration_ms)}</Text>
                {w.last_session_at && (
                  <Text dimColor>  {formatRelativeTime(w.last_session_at)}</Text>
                )}
                {activeCount > 0 && (
                  <Text color="green">  [{activeCount} live]</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* TODO: pass keyHints once StatusBar is updated (Task 8) */}
      <StatusBar stats={stats} wsState={wsState} />
    </Box>
  );
}
