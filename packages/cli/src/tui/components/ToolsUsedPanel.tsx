/**
 * ToolsUsedPanel -- displays tool usage frequency as a horizontal bar chart.
 *
 * Shows tool names sorted by frequency descending via the BarChart primitive.
 * Title is handled by the parent Sidebar's Divider.
 * Empty state: "No tool usage recorded"
 */

import React from "react";
import { Box, Text } from "ink";
import { BarChart } from "../primitives/index.js";

export interface ToolsUsedPanelProps {
  /** Map of tool name -> usage count, or raw array of tool names to count */
  toolCounts: Map<string, number> | Record<string, number>;
}

export function ToolsUsedPanel({ toolCounts }: ToolsUsedPanelProps): React.ReactElement {
  // Normalize to sorted entries (descending by count)
  const entries: Array<[string, number]> =
    toolCounts instanceof Map
      ? Array.from(toolCounts.entries())
      : Object.entries(toolCounts);

  entries.sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No tool usage recorded</Text>
      </Box>
    );
  }

  // Convert sorted entries to BarChart items format
  const items = entries.map(([label, value]) => ({ label, value }));

  return (
    <Box flexDirection="column">
      <BarChart items={items} maxBarWidth={8} />
    </Box>
  );
}
