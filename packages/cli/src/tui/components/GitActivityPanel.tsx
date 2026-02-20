/**
 * GitActivityPanel — displays git commits in the sidebar.
 *
 * Shows up to 10 commits as: bullet hash message
 * Overflow displays "... N more" indicator.
 * Empty state: "No git activity"
 */

import React from "react";
import { Box, Text } from "ink";
import type { GitActivity } from "@fuel-code/shared";

export interface GitActivityPanelProps {
  commits: GitActivity[];
}

const MAX_VISIBLE = 10;

export function GitActivityPanel({ commits }: GitActivityPanelProps): React.ReactElement {
  if (commits.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Git Activity</Text>
        <Text dimColor>No git activity</Text>
      </Box>
    );
  }

  const visible = commits.slice(0, MAX_VISIBLE);
  const overflow = commits.length - MAX_VISIBLE;

  return (
    <Box flexDirection="column">
      <Text bold>Git Activity</Text>
      {visible.map((commit, idx) => {
        const sha = commit.commit_sha ? commit.commit_sha.slice(0, 7) : "-------";
        const msg = commit.message ?? commit.type;
        return (
          <Box key={idx}>
            <Text color="yellow">{"\u25CF"} </Text>
            <Text dimColor>{sha}</Text>
            <Text> {msg}</Text>
          </Box>
        );
      })}
      {overflow > 0 && (
        <Text dimColor>... {overflow} more</Text>
      )}
    </Box>
  );
}
