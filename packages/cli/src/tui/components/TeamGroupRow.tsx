/**
 * Team group row component for the session list.
 *
 * Renders a collapsed or expanded team group. Collapsed shows team name,
 * member count, total duration, and aggregate status. Expanded shows
 * individual member sessions with lifecycle, role, duration, and summary.
 */

import React from "react";
import { Box, Text } from "ink";
import type { SessionDisplayData } from "./SessionRow.js";
import { formatDuration } from "../../lib/formatters.js";

// Lifecycle icon/color mapping (local copy to avoid coupling with SessionRow)
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

export interface TeamGroup {
  teamName: string;
  leadSession: SessionDisplayData | null;
  memberSessions: SessionDisplayData[];
  allSessions: SessionDisplayData[];
}

export interface TeamGroupRowProps {
  group: TeamGroup;
  expanded: boolean;
  selected: boolean;
  /** Index of selected member within the expanded group (-1 = header selected) */
  selectedMemberIndex: number;
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

/** Compute aggregate status: ACTIVE if any session is live, else DONE */
function getAggregateStatus(sessions: SessionDisplayData[]): {
  label: string;
  color: string;
} {
  const hasActive = sessions.some(
    (s) => s.lifecycle === "detected" || s.lifecycle === "capturing"
  );
  if (hasActive) return { label: "ACTIVE", color: "green" };
  return { label: "DONE", color: "gray" };
}

/** Sum duration_ms across all sessions, returning total ms */
function getTotalDuration(sessions: SessionDisplayData[]): number {
  return sessions.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
}

/** Get lead session summary text */
function getLeadSummary(group: TeamGroup): string {
  if (group.leadSession?.summary) return group.leadSession.summary;
  const initialPrompt = group.leadSession?.metadata?.initial_prompt;
  if (typeof initialPrompt === "string") return initialPrompt;
  return "(no summary)";
}

export function TeamGroupRow({
  group,
  expanded,
  selected,
  selectedMemberIndex,
}: TeamGroupRowProps): React.ReactElement {
  const headerSelected = selected && selectedMemberIndex === -1;
  const toggleIcon = expanded ? "\u25BC" : "\u25B6";
  const memberCount = group.allSessions.length;
  const totalDuration = formatDuration(getTotalDuration(group.allSessions));
  const status = getAggregateStatus(group.allSessions);
  const leadSummary = getLeadSummary(group);

  return (
    <Box flexDirection="column">
      {/* Header row: toggle icon, team name, member count, duration, status */}
      <Box>
        <Text bold={headerSelected} color={headerSelected ? "cyan" : undefined}>
          {headerSelected ? "> " : "  "}
        </Text>
        <Text bold={headerSelected} color={headerSelected ? "cyan" : undefined}>
          {toggleIcon} Team: {group.teamName}
        </Text>
        <Text>{"  "}</Text>
        <Text dimColor>
          {memberCount} member{memberCount !== 1 ? "s" : ""}
        </Text>
        <Text>{"  "}</Text>
        <Text>{totalDuration}</Text>
        <Text>{"  "}</Text>
        <Text color={status.color as any}>{status.label}</Text>
      </Box>

      {/* Lead summary line (always shown below header) */}
      <Box paddingLeft={4}>
        <Text dimColor wrap="truncate">
          {leadSummary}
        </Text>
      </Box>

      {/* Expanded: show individual member sessions */}
      {expanded &&
        group.allSessions.map((member, idx) => {
          const memberSelected = selected && selectedMemberIndex === idx;
          const display = LIFECYCLE_DISPLAY[member.lifecycle] ?? {
            icon: "?",
            label: member.lifecycle.toUpperCase(),
            color: "gray",
          };
          const role = getMemberRole(member);
          const duration = formatDuration(member.duration_ms);
          const summary =
            member.summary ??
            (typeof member.metadata?.initial_prompt === "string"
              ? member.metadata.initial_prompt
              : "(no summary)");

          return (
            <Box key={member.id} paddingLeft={4}>
              <Text
                bold={memberSelected}
                color={memberSelected ? "cyan" : undefined}
              >
                {memberSelected ? "> " : "  "}
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
        })}
    </Box>
  );
}
