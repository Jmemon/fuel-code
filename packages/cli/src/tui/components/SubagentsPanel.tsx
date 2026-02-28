/**
 * SubagentsPanel — displays sub-agents spawned during a session in the sidebar.
 *
 * Each row shows: agent type, agent name (or truncated agent_id), status indicator, and duration.
 * Status indicators:
 *   - running (dim green bullet)
 *   - completed (green checkmark)
 *   - failed (red X)
 *
 * Returns null when there are no sub-agents.
 */

import React from "react";
import { Box, Text } from "ink";
import type { Subagent } from "@fuel-code/shared";

export interface SubagentsPanelProps {
  subagents: Subagent[];
}

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

export function SubagentsPanel({ subagents }: SubagentsPanelProps): React.ReactElement | null {
  if (subagents.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Text bold>Sub-agents ({subagents.length})</Text>
      {subagents.map((sub) => {
        const { icon, color } = statusIndicator(sub.status);
        const name = sub.agent_name ?? sub.agent_id;
        const duration = formatSubagentDuration(sub);

        return (
          <Box key={sub.id}>
            <Text dimColor> {sub.agent_type}</Text>
            <Text>{"  "}</Text>
            <Text>{name}</Text>
            <Text>{"  "}</Text>
            <Text color={color as any} dimColor={sub.status === "running"}>
              {icon}
            </Text>
            {duration && (
              <>
                <Text>{"  "}</Text>
                <Text dimColor>{duration}</Text>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
