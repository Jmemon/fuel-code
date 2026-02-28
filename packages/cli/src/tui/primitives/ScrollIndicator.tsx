/**
 * ScrollIndicator -- thin vertical scrollbar track showing position
 * within a scrollable list.
 *
 * Renders `height` rows as a column. The "thumb" portion uses a full-block
 * character in the accent color, while the rest of the track is a thin
 * vertical line in the muted color.
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export interface ScrollIndicatorProps {
  /** Total number of items in the list. */
  totalItems: number;
  /** Number of items visible in the viewport. */
  visibleItems: number;
  /** Current scroll offset (index of the first visible item). */
  scrollOffset: number;
  /** Track height in terminal rows. */
  height: number;
}

export function ScrollIndicator({
  totalItems,
  visibleItems,
  scrollOffset,
  height,
}: ScrollIndicatorProps): React.ReactElement | null {
  // Nothing to scroll or no content
  if (totalItems === 0 || totalItems <= visibleItems) return null;

  // Thumb size -- at least 1 row, proportional to the visible fraction
  const thumbSize = Math.max(1, Math.round((visibleItems / totalItems) * height));

  // Thumb position -- proportional to how far we've scrolled
  const maxOffset = Math.max(1, totalItems - visibleItems);
  const thumbPos = Math.round((scrollOffset / maxOffset) * (height - thumbSize));

  const rows: React.ReactElement[] = [];
  for (let i = 0; i < height; i++) {
    const isThumb = i >= thumbPos && i < thumbPos + thumbSize;
    rows.push(
      <Text key={i} color={isThumb ? theme.accent : theme.muted}>
        {isThumb ? "\u2588" : "\u2502"}
      </Text>,
    );
  }

  return <Box flexDirection="column">{rows}</Box>;
}
