/**
 * FilesModifiedPanel — displays modified files list in the sidebar.
 *
 * Shows deduplicated, alphabetically sorted file paths.
 * Empty state: "No files modified"
 */

import React from "react";
import { Box, Text } from "ink";

export interface FilesModifiedPanelProps {
  files: string[];
}

export function FilesModifiedPanel({ files }: FilesModifiedPanelProps): React.ReactElement {
  // Deduplicate and sort alphabetically
  const uniqueSorted = Array.from(new Set(files)).sort();

  if (uniqueSorted.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Files Modified</Text>
        <Text dimColor>No files modified</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>Files Modified</Text>
      {uniqueSorted.map((file) => (
        <Box key={file}>
          <Text>{file}</Text>
        </Box>
      ))}
    </Box>
  );
}
