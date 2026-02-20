/**
 * TranscriptViewer — left panel (~65%) scrollable transcript view.
 *
 * Renders conversation turns in chronological order with:
 *   - Ordinal numbers, role labels, timestamps
 *   - Tool usage with tree chars
 *   - Thinking blocks collapsed
 *   - Scroll position indicator "Message N of M"
 *   - Auto-scroll for live sessions at bottom; preserves position if scrolled up
 */

import React, { useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { MessageBlock, type TranscriptMessageWithBlocks } from "./MessageBlock.js";

export interface TranscriptViewerProps {
  messages: TranscriptMessageWithBlocks[] | null;
  scrollOffset: number;
  onScrollChange: (offset: number) => void;
  /** Number of messages visible per page (for Space/page scrolling) */
  pageSize?: number;
  /** Whether this is a live session (auto-scroll behavior) */
  isLive?: boolean;
}

export function TranscriptViewer({
  messages,
  scrollOffset,
  onScrollChange,
  isLive,
}: TranscriptViewerProps): React.ReactElement {
  const prevLengthRef = useRef(messages?.length ?? 0);

  // Auto-scroll for live sessions: when new messages arrive and user is at the bottom
  useEffect(() => {
    if (!messages || !isLive) return;
    const prevLen = prevLengthRef.current;
    const wasAtBottom = scrollOffset >= prevLen - 1;
    prevLengthRef.current = messages.length;

    if (wasAtBottom && messages.length > prevLen) {
      onScrollChange(messages.length - 1);
    }
  }, [messages?.length, isLive, scrollOffset, onScrollChange]);

  // Handle null or empty transcript
  if (messages === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Transcript not yet available</Text>
      </Box>
    );
  }

  if (messages.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Transcript not yet available</Text>
      </Box>
    );
  }

  // Sort messages by ordinal for chronological display
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <Box flexDirection="column">
      {/* Scroll position indicator */}
      <Box>
        <Text dimColor>
          Message {scrollOffset + 1} of {sorted.length}
        </Text>
      </Box>

      {/* Render messages around the scroll offset for visibility */}
      {sorted.map((msg, idx) => (
        <Box key={msg.id || idx} flexDirection="column">
          <MessageBlock message={msg} ordinal={msg.ordinal} />
          {idx < sorted.length - 1 && <Text>{" "}</Text>}
        </Box>
      ))}
    </Box>
  );
}
