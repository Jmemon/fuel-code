/**
 * Single workspace row in the left pane of the Dashboard.
 *
 * Shows a selection indicator, workspace name, and session count.
 * Selected items get a bold highlight and pointer prefix.
 */

import React from "react";
import { Text, Box } from "ink";
import type { WorkspaceSummary } from "../../lib/api-client.js";
import { theme } from "../primitives/index.js";

export interface WorkspaceItemProps {
  workspace: WorkspaceSummary;
  selected: boolean;
}

export function WorkspaceItem({
  workspace,
  selected,
}: WorkspaceItemProps): React.ReactElement {
  const prefix = selected ? "\u25BA" : " ";
  const activeCount = workspace.active_session_count;

  return (
    <Box>
      <Text bold={selected} color={selected ? theme.accent : undefined}>
        {prefix} {workspace.display_name}
      </Text>
      <Text dimColor> ({workspace.session_count})</Text>
      {activeCount > 0 && (
        <Text color={theme.live}> [{activeCount} live]</Text>
      )}
    </Box>
  );
}
