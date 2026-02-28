/**
 * GitActivityPanel — displays git commits in the sidebar or full-width git tab.
 *
 * Sidebar mode (detailed=false): Shows up to 10 commits as: bullet hash message
 * Full-width mode (detailed=true): Shows additional per-commit detail including
 *   insertions/deletions, files_changed count, and branch.
 * Overflow displays "... N more" indicator.
 * Empty state: "No git activity"
 */

import React from "react";
import { Box, Text } from "ink";
import type { GitActivity } from "@fuel-code/shared";

export interface GitActivityPanelProps {
  commits: GitActivity[];
  /** When true, shows additional detail per commit (insertions, deletions, files, branch) */
  detailed?: boolean;
}

const MAX_VISIBLE = 10;

export function GitActivityPanel({ commits, detailed = false }: GitActivityPanelProps): React.ReactElement {
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

        if (detailed) {
          // Full-width mode: show extra detail per commit
          const stats: string[] = [];
          if (commit.insertions != null) stats.push(`+${commit.insertions}`);
          if (commit.deletions != null) stats.push(`-${commit.deletions}`);
          if (commit.files_changed != null) stats.push(`${commit.files_changed} files`);
          const statsStr = stats.length > 0 ? ` (${stats.join(", ")})` : "";
          const branchStr = commit.branch ? ` [${commit.branch}]` : "";

          return (
            <Box key={idx} flexDirection="column">
              <Box>
                <Text color="yellow">{"\u25CF"} </Text>
                <Text dimColor>{sha}</Text>
                <Text> {msg}</Text>
                <Text dimColor>{branchStr}</Text>
              </Box>
              {statsStr && (
                <Box marginLeft={4}>
                  <Text dimColor>{statsStr}</Text>
                </Box>
              )}
            </Box>
          );
        }

        return (
          <Box key={idx}>
            <Text color="yellow">{"\u25CF"} </Text>
            <Text dimColor>{sha}</Text>
            <Text> {msg}</Text>
          </Box>
        );
      })}
      {overflow > 0 && (
        <Text dimColor>... {overflow} more commits</Text>
      )}
    </Box>
  );
}
