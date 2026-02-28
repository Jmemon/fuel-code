/**
 * TeamDetailView — TUI screen showing a single team's details and members.
 *
 * Reached by pressing Enter on a team in TeamsListView. Displays team
 * metadata (description, lead session, creation date) and a navigable
 * list of sub-agent members.
 *
 * Keybindings:
 *   j/k        — navigate members
 *   Enter      — open session detail for the selected member (if it has a session_id)
 *   b/Escape   — return to TeamsListView
 *   r          — refresh data
 *   q          — quit
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { FuelApiClient } from "../lib/api-client.js";
import { useTeamDetail, type TeamMember } from "./hooks/useTeams.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { formatRelativeTime } from "../lib/formatters.js";

export interface TeamDetailViewProps {
  apiClient: FuelApiClient;
  teamName: string;
  onSelectSession: (sessionId: string) => void;
  onBack: () => void;
}

/** Truncate a string to maxLen, appending "..." if exceeded */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

// Status display: icon + color for sub-agent status
const STATUS_DISPLAY: Record<string, { icon: string; color: string }> = {
  running: { icon: "\u25CF", color: "green" },
  done: { icon: "\u2713", color: "green" },
  completed: { icon: "\u2713", color: "green" },
  error: { icon: "\u2717", color: "red" },
  failed: { icon: "\u2717", color: "red" },
  pending: { icon: "\u25CB", color: "yellow" },
};

export function TeamDetailView({
  apiClient,
  teamName,
  onSelectSession,
  onBack,
}: TeamDetailViewProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { team, loading, error, refresh } = useTeamDetail(apiClient, teamName);

  const members = team?.members ?? [];

  useInput((input, key) => {
    // Navigation through members
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(i + 1, members.length - 1));
      return;
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }

    // Enter: navigate to member's session detail (if it has a session_id)
    if (key.return && members[selectedIndex]?.session_id) {
      onSelectSession(members[selectedIndex].session_id!);
      return;
    }

    // Navigate to lead session
    if (input === "l" && team?.lead_session_id) {
      onSelectSession(team.lead_session_id);
      return;
    }

    // Back to teams list
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

  // Loading state
  if (loading && !team) {
    return (
      <Box flexDirection="column">
        <Spinner label={`Loading team ${teamName}...`} />
      </Box>
    );
  }

  // Error state
  if (error) {
    return (
      <Box flexDirection="column">
        <ErrorBanner message={error.message} />
        <Text dimColor>Press b to go back</Text>
      </Box>
    );
  }

  // Team not found
  if (!team) {
    return (
      <Box flexDirection="column">
        <Text color="red">Team not found: {teamName}</Text>
        <Text dimColor>Press b to go back</Text>
      </Box>
    );
  }

  const leadPrompt = team.lead_session?.initial_prompt
    ? truncateText(team.lead_session.initial_prompt, 60)
    : "(no prompt)";

  const leadModel = team.metadata?.model
    ? ` (${team.metadata.model as string})`
    : "";

  return (
    <Box flexDirection="column" width="100%">
      {/* Title */}
      <Box borderStyle="single" borderBottom borderTop={false} borderLeft={false} borderRight={false}>
        <Text bold> Team: {team.team_name} </Text>
      </Box>

      {/* Team metadata */}
      <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
        {team.description && (
          <Box>
            <Text bold>Description: </Text>
            <Text>{team.description}</Text>
          </Box>
        )}
        <Box>
          <Text bold>Created: </Text>
          <Text>{formatRelativeTime(team.created_at)}</Text>
        </Box>
        <Box>
          <Text bold>Lead: </Text>
          <Text>{leadPrompt}{leadModel}</Text>
        </Box>
        <Box>
          <Text bold>Members: </Text>
          <Text>{team.member_count}</Text>
        </Box>
      </Box>

      {/* Members list */}
      <Box flexDirection="column" flexGrow={1}>
        {members.length === 0 ? (
          <Box padding={1}>
            <Text dimColor>
              No sub-agent members recorded.
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {/* Table header */}
            <Box>
              <Box width={4}><Text> </Text></Box>
              <Box width={22}><Text bold>NAME</Text></Box>
              <Box width={18}><Text bold>TYPE</Text></Box>
              <Box width={16}><Text bold>MODEL</Text></Box>
              <Box width={12}><Text bold>STATUS</Text></Box>
            </Box>

            {/* Member rows */}
            {members.map((member, i) => (
              <MemberRow
                key={member.id}
                member={member}
                selected={i === selectedIndex}
              />
            ))}
          </Box>
        )}
      </Box>

      {/* Footer with keybinding hints */}
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>
          j/k:navigate  enter:member session  l:lead session  r:refresh  b:back  q:quit
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// MemberRow — single row in the members table
// ---------------------------------------------------------------------------

interface MemberRowProps {
  member: TeamMember;
  selected: boolean;
}

function MemberRow({ member, selected }: MemberRowProps): React.ReactElement {
  const name = member.agent_name ?? member.agent_id;
  const statusInfo = STATUS_DISPLAY[member.status] ?? {
    icon: "?",
    color: "gray",
  };

  return (
    <Box>
      <Box width={4}>
        <Text bold={selected} color={selected ? "cyan" : undefined}>
          {selected ? " > " : "   "}
        </Text>
      </Box>
      <Box width={22}>
        <Text bold={selected} color={selected ? "cyan" : undefined}>
          {truncateText(name, 20)}
        </Text>
      </Box>
      <Box width={18}>
        <Text>{truncateText(member.agent_type, 16)}</Text>
      </Box>
      <Box width={16}>
        <Text dimColor>{member.model ?? "-"}</Text>
      </Box>
      <Box width={12}>
        <Text color={statusInfo.color as any}>
          {statusInfo.icon} {member.status}
        </Text>
      </Box>
    </Box>
  );
}
