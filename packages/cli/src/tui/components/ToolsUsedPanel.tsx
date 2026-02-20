/**
 * ToolsUsedPanel — displays tool usage frequency table in the sidebar.
 *
 * Shows tool names sorted by frequency descending, with counts.
 * Empty state: "No tool usage recorded"
 */

import React from "react";
import { Box, Text } from "ink";

export interface ToolsUsedPanelProps {
  /** Map of tool name -> usage count, or raw array of tool names to count */
  toolCounts: Map<string, number> | Record<string, number>;
}

export function ToolsUsedPanel({ toolCounts }: ToolsUsedPanelProps): React.ReactElement {
  // Normalize to sorted entries
  const entries: Array<[string, number]> =
    toolCounts instanceof Map
      ? Array.from(toolCounts.entries())
      : Object.entries(toolCounts);

  // Sort descending by count
  entries.sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Tools Used</Text>
        <Text dimColor>No tool usage recorded</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Tools Used</Text>
      {entries.map(([name, count]) => (
        <Box key={name}>
          <Text>{name}</Text>
          <Text dimColor> ({count})</Text>
        </Box>
      ))}
    </Box>
  );
}
