/**
 * MessageBlock — renders a single conversation turn in the transcript viewer.
 *
 * Shows the message header with ordinal, role, timestamp, and optionally
 * model/cost for assistant messages. Content blocks are rendered as:
 *   - Text: indented and word-wrapped
 *   - Thinking: collapsed as "[thinking... N chars]"
 *   - Tool uses: tree with box-drawing chars (mid=\u251C, last=\u2514)
 *   - Tool results: skipped (too noisy)
 *
 * Primary input extraction for tool lines:
 *   - Read -> file_path
 *   - Bash -> command
 *   - Grep -> pattern
 *   - Edit -> file_path
 *   - Write -> file_path
 *   - Glob -> pattern
 */

import React from "react";
import { Box, Text } from "ink";
import type { TranscriptMessage, ParsedContentBlock } from "@fuel-code/shared";

/** Extended transcript message with content_blocks attached */
export interface TranscriptMessageWithBlocks extends TranscriptMessage {
  content_blocks?: ParsedContentBlock[];
}

export interface MessageBlockProps {
  message: TranscriptMessageWithBlocks;
  ordinal: number;
}

/**
 * Extract the primary input argument for a tool use block.
 * Returns a short summary string showing the most important argument.
 */
function extractToolPrimaryInput(block: ParsedContentBlock): string {
  const name = (block.tool_name ?? "").toLowerCase();
  const input = (block.tool_input ?? {}) as Record<string, unknown>;

  switch (name) {
    case "read":
      return (input.file_path ?? input.path ?? "") as string;
    case "edit":
    case "write":
      return (input.file_path ?? input.path ?? "") as string;
    case "bash":
      return (input.command ?? "") as string;
    case "grep":
    case "glob":
      return (input.pattern ?? "") as string;
    default:
      return "";
  }
}

/**
 * Format a timestamp to HH:MM for message headers.
 */
function formatTime(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const h = d.getHours();
    const m = d.getMinutes();
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function MessageBlock({ message, ordinal }: MessageBlockProps): React.ReactElement {
  const role = message.role ?? message.message_type ?? "unknown";
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const time = formatTime(message.timestamp);
  const isHuman = role === "human" || role === "user";
  const isAssistant = role === "assistant";

  // Build header string
  let header = `[${ordinal}] ${roleLabel}`;
  if (time) header += ` (${time})`;
  header += ":";

  // Assistant extras: model + cost
  let extras = "";
  if (isAssistant) {
    const parts: string[] = [];
    if (message.model) parts.push(message.model);
    if (message.cost_usd != null && message.cost_usd > 0) {
      parts.push(`$${message.cost_usd.toFixed(4)}`);
    }
    if (parts.length > 0) extras = ` ${parts.join(" ")}`;
  }

  // Determine header color
  const headerColor = isHuman ? "cyan" : isAssistant ? "green" : undefined;

  // Separate content blocks by type
  const blocks = message.content_blocks ?? [];
  const textBlocks = blocks.filter((b) => b.block_type === "text");
  const thinkingBlocks = blocks.filter((b) => b.block_type === "thinking");
  const toolUseBlocks = blocks.filter((b) => b.block_type === "tool_use");

  return (
    <Box flexDirection="column">
      {/* Message header */}
      <Box>
        <Text bold color={headerColor}>
          {header}
        </Text>
        {extras && <Text dimColor>{extras}</Text>}
      </Box>

      {/* Text content blocks — indented */}
      {textBlocks.map((block, idx) => (
        <Box key={`text-${idx}`} marginLeft={2}>
          <Text wrap="wrap">{block.content_text ?? ""}</Text>
        </Box>
      ))}

      {/* Thinking blocks — collapsed */}
      {thinkingBlocks.map((block, idx) => {
        const text = block.thinking_text ?? block.content_text ?? "";
        return (
          <Box key={`think-${idx}`} marginLeft={2}>
            <Text dimColor>[thinking... {text.length} chars]</Text>
          </Box>
        );
      })}

      {/* Tool use blocks — tree with box-drawing chars */}
      {toolUseBlocks.map((block, idx) => {
        const isLast = idx === toolUseBlocks.length - 1;
        const prefix = isLast ? "\u2514" : "\u251C";
        const toolName = block.tool_name ?? "unknown";
        const primaryInput = extractToolPrimaryInput(block);
        const label = primaryInput ? `${toolName}: ${primaryInput}` : toolName;
        return (
          <Box key={`tool-${idx}`} marginLeft={2}>
            <Text color="cyan">
              {prefix} {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
