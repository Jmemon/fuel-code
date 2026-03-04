/**
 * TeammateDetailView — TUI screen showing the stitched message feed for
 * a single teammate in a multi-agent team session.
 *
 * Reached by navigating to a teammate from the session detail or team
 * detail view. Displays teammate metadata (name, team, summary) at the
 * top, followed by a scrollable message feed. Each message shows its
 * source agent_id (the subagent that produced it), role, timestamp, and
 * content blocks (text, thinking, tool uses).
 *
 * Keybindings:
 *   j/k        — scroll through messages
 *   Space      — page down
 *   b/Escape   — return to previous view
 *   r          — refresh data
 *   q          — quit
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { FuelApiClient } from "../lib/api-client.js";
import type { TeammateMessageResponse } from "../lib/api-client.js";
import { useTeammateDetail } from "./hooks/useTeammateDetail.js";
import { Spinner } from "./components/Spinner.js";
import { ErrorBanner } from "./components/ErrorBanner.js";

export interface TeammateDetailViewProps {
  apiClient: FuelApiClient;
  sessionId: string;
  teammateId: string;
  onBack: () => void;
}

/** Truncate a string to maxLen, appending "..." if exceeded */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/** Format a timestamp to HH:MM:SS for message headers */
function formatTime(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  } catch {
    return "";
  }
}

/**
 * Extract a short display string for the primary argument of a tool use.
 * Mirrors the logic in MessageBlock.tsx for consistent display.
 */
function extractToolPrimaryInput(block: { tool_name?: string | null; tool_input?: unknown }): string {
  const name = (block.tool_name ?? "").toLowerCase();
  const input = (block.tool_input ?? {}) as Record<string, unknown>;

  switch (name) {
    case "read":
      return (input.file_path ?? input.path ?? "") as string;
    case "edit":
    case "write":
      return (input.file_path ?? input.path ?? "") as string;
    case "bash": {
      const cmd = (input.command ?? "") as string;
      return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
    }
    case "grep":
    case "glob":
      return (input.pattern ?? "") as string;
    default:
      return "";
  }
}

export function TeammateDetailView({
  apiClient,
  sessionId,
  teammateId,
  onBack,
}: TeammateDetailViewProps): React.ReactElement {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;

  const [scrollOffset, setScrollOffset] = useState(0);
  const { teammate, messages, loading, error, refresh } = useTeammateDetail(
    apiClient,
    sessionId,
    teammateId,
  );

  const pageSize = 10;
  const maxScroll = useCallback(() => {
    return Math.max(0, messages.length - 1);
  }, [messages]);

  useInput((input, key) => {
    // Scroll down
    if (input === "j" || key.downArrow) {
      setScrollOffset((prev) => Math.min(prev + 1, maxScroll()));
      return;
    }
    // Scroll up
    if (input === "k" || key.upArrow) {
      setScrollOffset((prev) => Math.max(prev - 1, 0));
      return;
    }
    // Page down
    if (input === " " || key.pageDown) {
      setScrollOffset((prev) => Math.min(prev + pageSize, maxScroll()));
      return;
    }
    // Page up
    if (key.pageUp) {
      setScrollOffset((prev) => Math.max(prev - pageSize, 0));
      return;
    }
    // Back to previous view
    if (input === "b" || key.escape) {
      onBack();
      return;
    }
    // Refresh
    if (input === "r") {
      refresh();
      return;
    }
  });

  // Loading state
  if (loading && !teammate) {
    return (
      <Box flexDirection="column">
        <Spinner label="Loading teammate detail..." />
      </Box>
    );
  }

  // Error state
  if (error) {
    return (
      <Box flexDirection="column">
        <ErrorBanner message={error.message} />
        <Text dimColor>Press b to go back</Text>
      </Box>
    );
  }

  // Teammate not found
  if (!teammate) {
    return (
      <Box flexDirection="column">
        <Text color="red">Teammate not found</Text>
        <Text dimColor>Press b to go back</Text>
      </Box>
    );
  }

  // Calculate how many messages fit in the visible area.
  // Reserve rows for: title (1) + metadata (3-4) + separator (1) + footer (2) = ~7
  const reservedRows = 7;
  const visibleCount = Math.max(1, termRows - reservedRows);

  // Slice the messages to the visible window
  const visibleMessages = messages.slice(scrollOffset, scrollOffset + visibleCount);

  return (
    <Box flexDirection="column" height={termRows}>
      {/* Title bar */}
      <Box
        borderStyle="single"
        borderBottom
        borderTop={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text bold>
          {" "}Teammate: {teammate.name} (Team: {teammate.team_name}){" "}
        </Text>
      </Box>

      {/* Teammate metadata */}
      <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
        {teammate.summary ? (
          <Box>
            <Text bold>Summary: </Text>
            <Text wrap="wrap">{truncateText(teammate.summary, 80)}</Text>
          </Box>
        ) : (
          <Box>
            <Text bold>Summary: </Text>
            <Text dimColor>(no summary)</Text>
          </Box>
        )}
        {teammate.color && (
          <Box>
            <Text bold>Color: </Text>
            <Text>{teammate.color}</Text>
          </Box>
        )}
      </Box>

      {/* Message feed — scrollable */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {messages.length === 0 ? (
          <Box padding={1}>
            <Text dimColor>No messages found for this teammate.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {visibleMessages.map((msg, idx) => (
              <TeammateMessageRow
                key={msg.id}
                message={msg}
                ordinal={scrollOffset + idx + 1}
              />
            ))}
          </Box>
        )}
      </Box>

      {/* Footer with scroll position and keybinding hints */}
      <Box
        borderStyle="single"
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
      >
        <Text dimColor>
          {messages.length > 0
            ? `Message ${scrollOffset + 1} of ${messages.length}  |  `
            : ""}
          [b]ack  [j/k] scroll  [r]efresh  [q]uit
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// TeammateMessageRow — renders a single message in the stitched feed
// ---------------------------------------------------------------------------

interface TeammateMessageRowProps {
  message: TeammateMessageResponse;
  ordinal: number;
}

/**
 * Renders a single message in the teammate stitched feed.
 * Shows the role, source agent, timestamp, and content blocks
 * (text, thinking, tool uses) following the same visual style
 * as the main TranscriptViewer's MessageBlock component.
 */
function TeammateMessageRow({
  message,
  ordinal,
}: TeammateMessageRowProps): React.ReactElement {
  const role = message.role ?? message.message_type ?? "unknown";
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const time = formatTime(message.timestamp);
  const isHuman = role === "human" || role === "user";
  const isAssistant = role === "assistant";

  // Build the source agent label: prefer agent_name, fall back to agent_id
  const agentLabel = message.agent_name ?? message.agent_id ?? null;

  // Build header: [ordinal] Role (agent) HH:MM:SS
  let header = `[${ordinal}] ${roleLabel}`;
  if (agentLabel) header += ` (${truncateText(agentLabel, 20)})`;
  if (time) header += ` ${time}`;

  // Determine header color consistent with MessageBlock
  const headerColor = isHuman ? "cyan" : isAssistant ? "green" : undefined;

  // Separate content blocks by type
  const blocks = message.content_blocks ?? [];
  const textBlocks = blocks.filter((b) => b.block_type === "text");
  const thinkingBlocks = blocks.filter((b) => b.block_type === "thinking");
  const toolUseBlocks = blocks.filter((b) => b.block_type === "tool_use");

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Message header */}
      <Box>
        <Text bold color={headerColor}>
          {header}
        </Text>
      </Box>

      {/* Text content blocks */}
      {textBlocks.map((block, idx) => {
        const text = block.content_text ?? "";
        // Truncate long assistant text to keep the feed scannable
        const displayText =
          isAssistant && text.length > 120
            ? `"${truncateText(text, 120)}"`
            : text;
        return (
          <Box key={`text-${idx}`} marginLeft={2}>
            <Text wrap="wrap">{displayText}</Text>
          </Box>
        );
      })}

      {/* Thinking blocks — collapsed */}
      {thinkingBlocks.map((block, idx) => {
        const text = block.thinking_text ?? block.content_text ?? "";
        return (
          <Box key={`think-${idx}`} marginLeft={2}>
            <Text dimColor>[thinking... {text.length} chars]</Text>
          </Box>
        );
      })}

      {/* Tool use blocks — tree rendering with box-drawing chars */}
      {toolUseBlocks.length > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>
            {"\u2514"}{" "}Tool uses:{" "}
            {toolUseBlocks.map((block, idx) => {
              const toolName = block.tool_name ?? "unknown";
              const primaryInput = extractToolPrimaryInput(block);
              const label = primaryInput
                ? `${toolName}: ${truncateText(primaryInput, 40)}`
                : toolName;
              const separator = idx < toolUseBlocks.length - 1 ? ", " : "";
              return label + separator;
            }).join("")}
          </Text>
        </Box>
      )}
    </Box>
  );
}
