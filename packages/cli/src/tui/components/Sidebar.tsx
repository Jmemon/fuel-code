/**
 * Sidebar — right panel (~35%) in the session detail transcript tab.
 *
 * Aggregates three sub-panels:
 *   1. GitActivityPanel — recent commits
 *   2. ToolsUsedPanel — tool frequency table
 *   3. FilesModifiedPanel — deduplicated file list
 *
 * Data is derived from transcript content_blocks and git activity.
 */

import React from "react";
import { Box } from "ink";
import type { GitActivity, ParsedContentBlock } from "@fuel-code/shared";
import { GitActivityPanel } from "./GitActivityPanel.js";
import { ToolsUsedPanel } from "./ToolsUsedPanel.js";
import { FilesModifiedPanel } from "./FilesModifiedPanel.js";
import type { TranscriptMessageWithBlocks } from "./MessageBlock.js";

export interface SidebarProps {
  gitActivity: GitActivity[];
  /** Transcript messages to derive tool usage and file modifications from */
  messages: TranscriptMessageWithBlocks[];
}

/**
 * Extract tool usage frequency counts from transcript messages.
 * Scans all content_blocks for tool_use blocks and counts by tool_name.
 */
export function extractToolCounts(messages: TranscriptMessageWithBlocks[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    for (const block of msg.content_blocks ?? []) {
      if (block.block_type === "tool_use" && block.tool_name) {
        counts[block.tool_name] = (counts[block.tool_name] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/**
 * Extract modified file paths from transcript messages.
 * Looks at tool_use blocks for Edit, Write, and Read tools.
 */
export function extractModifiedFiles(messages: TranscriptMessageWithBlocks[]): string[] {
  const files: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content_blocks ?? []) {
      if (block.block_type === "tool_use") {
        const name = (block.tool_name ?? "").toLowerCase();
        const input = (block.tool_input ?? {}) as Record<string, unknown>;
        if (name === "edit" || name === "write") {
          const filePath = (input.file_path ?? input.path ?? "") as string;
          if (filePath) files.push(filePath);
        }
      }
    }
  }
  return files;
}

export function Sidebar({ gitActivity, messages }: SidebarProps): React.ReactElement {
  const toolCounts = extractToolCounts(messages);
  const modifiedFiles = extractModifiedFiles(messages);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <GitActivityPanel commits={gitActivity} />
      <Box marginTop={1}>
        <ToolsUsedPanel toolCounts={toolCounts} />
      </Box>
      <Box marginTop={1}>
        <FilesModifiedPanel files={modifiedFiles} />
      </Box>
    </Box>
  );
}
