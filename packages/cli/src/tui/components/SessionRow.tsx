/**
 * Session row component for the right pane of the Dashboard.
 *
 * Displays lifecycle Badge, device name, duration, token counts, and summary.
 * Live sessions show per-tool usage counts inline.
 * Commit count is shown inline after the summary text to save vertical space.
 */

import React from "react";
import { Text, Box } from "ink";
import type { Session } from "@fuel-code/shared";
import { formatDuration, formatTokensCompact } from "../../lib/formatters.js";
import { theme, Badge } from "../primitives/index.js";

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
  const isLive = session.lifecycle === "detected" || session.lifecycle === "capturing";
  const deviceName = session.device_name ?? session.device_id;
  const duration = formatDuration(session.duration_ms);
  const tokens = formatTokensCompact((session as any).tokens_in ?? null, (session as any).tokens_out ?? null);
  const summary = session.summary ?? "(no summary)";
  const commitCount = (session.commit_messages ?? []).length;

  // Build inline suffix: " . N commits" for summarized sessions with commits
  const commitSuffix = commitCount > 0 ? ` \u00B7 ${commitCount} commit${commitCount === 1 ? "" : "s"}` : "";

  // Live sessions: tool usage line text
  const toolLine = isLive && session.total_messages != null
    ? (session.tool_counts
        ? formatToolCounts(session.tool_counts)
        : `${session.total_messages} messages${session.tool_uses != null ? ` / ${session.tool_uses} tool uses` : ""}`)
    : null;

  return (
    <Box flexDirection="column">
      {/* Row 1: selection indicator, badge, device, duration, tokens, (tool counts for live) */}
      <Box>
        <Text bold={selected} color={selected ? theme.accent : undefined}>
          {selected ? "> " : "  "}
        </Text>
        <Badge lifecycle={session.lifecycle} />
        <Text>{"  "}</Text>
        <Text dimColor>{deviceName}</Text>
        <Text>{"  "}</Text>
        <Text>{duration}</Text>
        <Text>{"  "}</Text>
        <Text>{tokens}</Text>
        {/* Live sessions: show per-tool breakdown inline on the header row */}
        {toolLine && (
          <>
            <Text>{"  "}</Text>
            <Text color={theme.live}>{toolLine}</Text>
          </>
        )}
      </Box>
      {/* Row 2: summary text + inline commit count */}
      <Box paddingLeft={4}>
        <Text dimColor wrap="truncate">
          {summary}{commitSuffix}
        </Text>
      </Box>
    </Box>
  );
}
