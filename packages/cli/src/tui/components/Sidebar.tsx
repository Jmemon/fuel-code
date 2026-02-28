/**
 * Sidebar -- right panel (~35%) in the session detail transcript tab.
 *
 * Aggregates three sub-panels separated by Divider section headers:
 *   1. GitActivityPanel -- recent commits
 *   2. ToolsUsedPanel -- tool frequency bar chart
 *   3. FilesModifiedPanel -- deduplicated file list
 *
 * Data is derived from transcript content_blocks and git activity.
 */

import React from "react";
import { Box } from "ink";
import type { GitActivity, ParsedContentBlock } from "@fuel-code/shared";
import { Divider } from "../primitives/index.js";
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
 * Extract modified file paths from transcript messages and git activity.
 * Sources:
 *   1. git_activity[].data.files -- file lists from commits (if available)
 *   2. content_blocks where tool_name in (Edit, Write) -- files touched by tools
 */
export function extractModifiedFiles(
  messages: TranscriptMessageWithBlocks[],
  gitActivity?: GitActivity[],
): string[] {
  const files: string[] = [];

  // Source 1: git activity file lists (from commit data if available)
  if (gitActivity) {
    for (const ga of gitActivity) {
      const data = (ga.data ?? {}) as Record<string, unknown>;
      const fileList = data.files ?? data.file_list;
      if (Array.isArray(fileList)) {
        for (const f of fileList) {
          if (typeof f === "string" && f) files.push(f);
          // Handle objects like { filename: "path", status: "M" }
          else if (f && typeof f === "object" && typeof (f as any).filename === "string") {
            files.push((f as any).filename);
          }
        }
      }
    }
  }

  // Source 2: transcript tool_use blocks for Edit/Write
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
  const modifiedFiles = extractModifiedFiles(messages, gitActivity);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Divider title="GIT" width={30} />
      <GitActivityPanel commits={gitActivity} />
      <Box marginTop={1}>
        <Box flexDirection="column">
          <Divider title="TOOLS" width={30} />
          <ToolsUsedPanel toolCounts={toolCounts} />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Box flexDirection="column">
          <Divider title="FILES" width={30} />
          <FilesModifiedPanel files={modifiedFiles} />
        </Box>
      </Box>
    </Box>
  );
}
