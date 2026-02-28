/**
 * BarChart -- horizontal bar chart for displaying ranked items.
 *
 * Each row shows a right-padded label, a filled bar scaled to the maximum
 * value, and the numeric count. Bars are rendered with full-block characters
 * in the accent color.
 *
 * Example output:
 *   Edit ████████ 12
 *   Read ██████    8
 *   Bash ████      5
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export interface BarChartProps {
  /** Items to chart, in display order (caller is responsible for sorting). */
  items: Array<{ label: string; value: number }>;
  /** Maximum bar length in characters. Defaults to 8. */
  maxBarWidth?: number;
  /** Bar fill color. Defaults to theme.accent. */
  color?: string;
  /** Maximum number of items to display. Defaults to all. */
  maxItems?: number;
}

export function BarChart({
  items,
  maxBarWidth = 8,
  color = theme.accent,
  maxItems,
}: BarChartProps): React.ReactElement | null {
  if (items.length === 0) return null;

  const visible = maxItems ? items.slice(0, maxItems) : items;

  // Right-pad labels to the longest label length so bars align
  const longestLabel = Math.max(...visible.map((item) => item.label.length));
  const maxValue = Math.max(...visible.map((item) => item.value));

  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const paddedLabel = item.label.padEnd(longestLabel);
        // Items with value 0 get no bar at all
        const barWidth =
          item.value === 0 || maxValue === 0
            ? 0
            : Math.max(1, Math.round((item.value / maxValue) * maxBarWidth));
        const bar = "\u2588".repeat(barWidth);

        return (
          <Box key={i}>
            <Text>{paddedLabel} </Text>
            {barWidth > 0 && <Text color={color}>{bar}</Text>}
            {barWidth > 0 && <Text> </Text>}
            <Text dimColor>{item.value}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
