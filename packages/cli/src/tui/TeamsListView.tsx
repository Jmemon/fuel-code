/**
 * TeamsListView — TUI screen listing all agent teams.
 *
 * Reached by pressing 't' from the dashboard. Displays teams in a navigable
 * list with name, member count, lead prompt excerpt, and creation date.
 *
 * Keybindings:
 *   j/k        — navigate up/down
 *   Enter      — open TeamDetailView for the selected team
 *   b/Escape   — return to dashboard
 *   r          — refresh data
 *   q          — quit
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FuelApiClient } from "../lib/api-client.js";
import { useTeams, type TeamSummary } from "./hooks/useTeams.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { formatRelativeTime } from "../lib/formatters.js";

export interface TeamsListViewProps {
  apiClient: FuelApiClient;
  onSelectTeam: (teamName: string) => void;
  onBack: () => void;
}

/** Truncate a string to maxLen, appending "..." if exceeded */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export function TeamsListView({
  apiClient,
  onSelectTeam,
  onBack,
}: TeamsListViewProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { teams, loading, error, refresh } = useTeams(apiClient);

  useInput((input, key) => {
    // Navigation
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, teams.length - 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    // Select team
    if (key.return && teams[selectedIndex]) {
      onSelectTeam(teams[selectedIndex].team_name);
      return;
    }

    // Back to dashboard
    if (input === "b" || key.escape) {
      onBack();
      return;
    }

    // Refresh
    if (input === "r") {
      refresh();
      return;
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      {/* Title */}
      <Box borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false}>
        <Text bold> Teams </Text>
      </Box>

      {/* Error */}
      {error && <ErrorBanner message={error.message} />}

      {/* Content */}
      <Box flexDirection="column" flexGrow={1}>
        {loading && teams.length === 0 ? (
          <Spinner label="Loading teams..." />
        ) : teams.length === 0 ? (
          <Box padding={1}>
            <Text dimColor>
              No teams found. Teams are created when Claude Code uses agent teams.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {/* Table header */}
            <Box>
              <Box width={4}><Text> </Text></Box>
              <Box width={22}><Text bold>NAME</Text></Box>
              <Box width={10}><Text bold>MEMBERS</Text></Box>
              <Box width={38}><Text bold>LEAD PROMPT</Text></Box>
              <Box width={12}><Text bold>CREATED</Text></Box>
            </Box>

            {/* Team rows */}
            {teams.map((team, i) => (
              <TeamRow
                key={team.id}
                team={team}
                selected={i === selectedIndex}
              />
            ))}
          </Box>
        )}
      </Box>

      {/* Footer with keybinding hints */}
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>
          j/k:navigate  enter:detail  r:refresh  b:back  q:quit
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// TeamRow — single row in the teams list
// ---------------------------------------------------------------------------

interface TeamRowProps {
  team: TeamSummary;
  selected: boolean;
}

function TeamRow({ team, selected }: TeamRowProps): React.ReactElement {
  const prompt = team.lead_session?.initial_prompt ?? "(no prompt)";

  return (
    <Box>
      <Box width={4}>
        <Text bold={selected} color={selected ? "cyan" : undefined}>
          {selected ? " > " : "   "}
        </Text>
      </Box>
      <Box width={22}>
        <Text bold={selected} color={selected ? "cyan" : undefined}>
          {truncateText(team.team_name, 20)}
        </Text>
      </Box>
      <Box width={10}>
        <Text>{team.member_count}</Text>
      </Box>
      <Box width={38}>
        <Text dimColor>{truncateText(prompt, 36)}</Text>
      </Box>
      <Box width={12}>
        <Text dimColor>{formatRelativeTime(team.created_at)}</Text>
      </Box>
    </Box>
  );
}
