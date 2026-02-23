/**
 * Session row component for the right pane of the Dashboard.
 *
 * Displays lifecycle status icon, device name, duration, cost, and summary.
 * Live sessions show tool usage counts; summarized sessions show commit info.
 */

import React from "react";
import { Text, Box } from "ink";
import type { Session } from "@fuel-code/shared";
import { formatDuration, formatTokensCompact } from "../../lib/formatters.js";

// Lifecycle display: icon + color mapping
const LIFECYCLE_DISPLAY: Record<
  string,
  { icon: string; label: string; color: string }
> = {
  detected: { icon: "\u25CB", label: "DETECTED", color: "gray" },
  capturing: { icon: "\u25CF", label: "LIVE", color: "green" },
  ended: { icon: "\u25D0", label: "ENDED", color: "yellow" },
  parsed: { icon: "\u25CC", label: "PARSING", color: "yellow" },
  summarized: { icon: "\u2713", label: "DONE", color: "green" },
  archived: { icon: "\u25AA", label: "ARCHIVED", color: "gray" },
  failed: { icon: "\u2717", label: "FAIL", color: "red" },
};

/** Format per-tool usage counts like "Edit(3) Bash(2) Read(5)" */
function formatToolCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([name, count]) => `${name}(${count})`)
    .join(" ");
}

/**
 * Extended Session type with display fields returned by the API's session list.
 * The base Session type (from shared) only has core DB columns; the API response
 * includes extra joined/computed fields for display purposes.
 */
export interface SessionDisplayData extends Session {
  device_name?: string;
  workspace_name?: string;
  summary?: string | null;
  cost_estimate_usd?: number | null;
  total_messages?: number | null;
  tool_uses?: number | null;
  commit_messages?: string[] | null;
  /** Per-tool usage counts for live sessions, e.g. { Edit: 3, Bash: 2, Read: 5 } */
  tool_counts?: Record<string, number> | null;
}

export interface SessionRowProps {
  session: SessionDisplayData;
  selected: boolean;
}

export function SessionRow({
  session,
  selected,
}: SessionRowProps): React.ReactElement {
  const display = LIFECYCLE_DISPLAY[session.lifecycle] ?? {
    icon: "?",
    label: session.lifecycle.toUpperCase(),
    color: "gray",
  };

  const deviceName = session.device_name ?? session.device_id;
  const duration = formatDuration(session.duration_ms);
  const tokens = formatTokensCompact((session as any).tokens_in ?? null, (session as any).tokens_out ?? null);
  const summary = session.summary ?? "(no summary)";
  const commitMessages: string[] = session.commit_messages ?? [];
  const overflowCount = Math.max(0, commitMessages.length - 2);
  const overflowText = overflowCount > 0 ? "... " + overflowCount + " more commits" : "";

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold={selected} color={selected ? "cyan" : undefined}>
          {selected ? "> " : "  "}
        </Text>
        <Text color={display.color as any}>
          {display.icon} {display.label}
        </Text>
        <Text>{"  "}</Text>
        <Text dimColor>{deviceName}</Text>
        <Text>{"  "}</Text>
        <Text>{duration}</Text>
        <Text>{"  "}</Text>
        <Text>{tokens}</Text>
      </Box>
      <Box paddingLeft={4}>
        <Text dimColor wrap="truncate">
          {summary}
        </Text>
      </Box>
      {/* Live sessions: show per-tool breakdown or aggregate counts */}
      {session.lifecycle === "capturing" && session.total_messages != null && (
        <Box paddingLeft={4}>
          <Text color="green">
            {session.tool_counts
              ? formatToolCounts(session.tool_counts)
              : `${session.total_messages} messages${session.tool_uses != null ? ` / ${session.tool_uses} tool uses` : ""}`}
          </Text>
        </Box>
      )}
      {/* Summarized sessions: show commit messages if available */}
      {commitMessages.length > 0 && (
        <Box paddingLeft={4} flexDirection="column">
          {commitMessages.slice(0, 2).map((msg, i) => (
            <Text key={i} dimColor>
              {"\u2022"} {msg}
            </Text>
          ))}
          {overflowCount > 0 && (
            <Text dimColor>
              {overflowText}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
