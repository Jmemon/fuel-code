/**
 * SubagentsPanel — displays sub-agents spawned during a session in the sidebar.
 *
 * When teammates data is available, subagents are grouped into two sections:
 *   1. Teammates — grouped by teammate, showing name, subagent count, and aggregate status
 *   2. Other Subagents — subagents not affiliated with any teammate
 *
 * For non-team sessions (no teammates), the original flat list is shown unchanged.
 *
 * Status indicators:
 *   - running (dim green bullet)
 *   - completed (green checkmark)
 *   - failed (red X)
 *
 * Returns null when there are no sub-agents.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Subagent, Teammate } from "@fuel-code/shared";

export interface SubagentsPanelProps {
  subagents: Subagent[];
  /** Teammates for this session — when present, subagents are grouped by teammate */
  teammates?: Teammate[];
}

/** Default colors assigned to teammates that don't have an explicit color set */
const TEAMMATE_COLORS = ["cyan", "magenta", "yellow", "blue", "green", "red"];

/** Compute a human-readable duration string from started_at / ended_at timestamps. */
function formatSubagentDuration(sub: Subagent): string {
  if (!sub.started_at) return "";
  const start = new Date(sub.started_at).getTime();

  if (sub.status === "running") return "running";

  if (!sub.ended_at) return "";
  const end = new Date(sub.ended_at).getTime();
  const ms = end - start;
  if (ms < 1000) return "0s";

  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return remSecs > 0 ? `${mins}m${remSecs}s` : `${mins}m`;
}

/** Status indicator: icon + color */
function statusIndicator(status: Subagent["status"]): { icon: string; color: string } {
  switch (status) {
    case "running":
      return { icon: "\u25CF", color: "green" };
    case "completed":
      return { icon: "\u2713", color: "green" };
    case "failed":
      return { icon: "\u2717", color: "red" };
    default:
      return { icon: "?", color: "gray" };
  }
}

/**
 * Compute an aggregate status for a group of subagents.
 * Priority: failed > running > completed (worst status wins).
 */
function aggregateStatus(subs: Subagent[]): Subagent["status"] {
  if (subs.some((s) => s.status === "failed")) return "failed";
  if (subs.some((s) => s.status === "running")) return "running";
  return "completed";
}

/** Max number of "Other Subagents" to show before collapsing */
const MAX_OTHER_VISIBLE = 5;

/** Render a single subagent row (used in both flat and grouped views) */
function SubagentRow({ sub }: { sub: Subagent }): React.ReactElement {
  const { icon, color } = statusIndicator(sub.status);
  const name = sub.agent_name ?? sub.agent_id;
  const duration = formatSubagentDuration(sub);

  return (
    <Box key={sub.id}>
      <Text wrap="truncate" dimColor> {sub.agent_type}  {name}  <Text color={color as any} dimColor={sub.status === "running"}>{icon}</Text>{duration ? `  ${duration}` : ""}</Text>
    </Box>
  );
}

/**
 * Teammates view: groups subagents by teammate_id and renders two sections.
 * Each teammate row shows: color indicator, name, subagent count, aggregate status.
 */
function TeammatesView({
  teammates,
  subagents,
}: {
  teammates: Teammate[];
  subagents: Subagent[];
}): React.ReactElement {
  // Build a map of teammate_id -> subagents belonging to that teammate
  const teammateSubagentMap = new Map<string, Subagent[]>();
  const otherSubagents: Subagent[] = [];

  for (const sub of subagents) {
    if (sub.teammate_id) {
      const existing = teammateSubagentMap.get(sub.teammate_id) ?? [];
      existing.push(sub);
      teammateSubagentMap.set(sub.teammate_id, existing);
    } else {
      otherSubagents.push(sub);
    }
  }

  return (
    <Box flexDirection="column">
      {/* Teammates section header */}
      <Text bold>Teammates ({teammates.length})</Text>

      {/* Teammate rows — each shows name, subagent count, aggregate status */}
      {teammates.map((tm, idx) => {
        const tmSubs = teammateSubagentMap.get(tm.id) ?? [];
        const count = tmSubs.length;
        const aggStatus = count > 0 ? aggregateStatus(tmSubs) : "completed";
        const { icon, color: statusColor } = statusIndicator(aggStatus);
        // Use the teammate's own color if set, otherwise assign from palette
        const dotColor = tm.color ?? TEAMMATE_COLORS[idx % TEAMMATE_COLORS.length];

        return (
          <Box key={tm.id}>
            <Text color={dotColor as any}>{"\u25CF"}</Text>
            <Text> {tm.name}</Text>
            {count > 0 && <Text dimColor> ({count} agents)</Text>}
            <Text>{"  "}</Text>
            <Text color={statusColor as any} dimColor={aggStatus === "running"}>
              {icon}
            </Text>
          </Box>
        );
      })}

      {/* Other Subagents section — those not affiliated with any teammate */}
      {otherSubagents.length > 0 && (
        <>
          <Box marginTop={1}>
            <Text bold>Other Subagents ({otherSubagents.length})</Text>
          </Box>
          {otherSubagents.slice(0, MAX_OTHER_VISIBLE).map((sub) => (
            <SubagentRow key={sub.id} sub={sub} />
          ))}
          {otherSubagents.length > MAX_OTHER_VISIBLE && (
            <Text dimColor>  ...{otherSubagents.length - MAX_OTHER_VISIBLE} more</Text>
          )}
        </>
      )}
    </Box>
  );
}

export function SubagentsPanel({ subagents, teammates }: SubagentsPanelProps): React.ReactElement | null {
  if (subagents.length === 0) return null;

  // If we have teammates, render the grouped view
  if (teammates && teammates.length > 0) {
    return <TeammatesView teammates={teammates} subagents={subagents} />;
  }

  // Non-team sessions: render the original flat list unchanged
  return (
    <Box flexDirection="column">
      <Text bold>Sub-agents ({subagents.length})</Text>
      {subagents.map((sub) => (
        <SubagentRow key={sub.id} sub={sub} />
      ))}
    </Box>
  );
}
