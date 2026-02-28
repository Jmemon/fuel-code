/**
 * Panel — bordered container with rounded Unicode corners and optional title.
 *
 * Renders its own border characters as Text elements rather than using Ink's
 * borderStyle, because Ink doesn't support rounded corners or title-in-border.
 * The title is embedded inline in the top border row.
 *
 * Border glyphs: ╭ ╮ ╰ ╯ ─ │
 *
 * Works with Ink's flex layout: pass width/flexGrow/flexBasis through to the
 * outer Box. Border string lengths are computed from an explicit `columns` prop
 * or fall back to stdout.columns.
 */

import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "./theme.js";

// Box-drawing characters for rounded corners
const TL = "╭";  // top-left
const TR = "╮";  // top-right
const BL = "╰";  // bottom-left
const BR = "╯";  // bottom-right
const H  = "─";  // horizontal
const V  = "│";  // vertical

export interface PanelProps {
  title?: string;
  focused?: boolean;           // accent border when true, muted when false
  width?: number | string;     // passthrough to outer Box
  height?: number | string;
  flexGrow?: number;
  flexBasis?: string;
  /** Explicit column count for border strings. Falls back to stdout.columns. */
  columns?: number;
  children: React.ReactNode;
}

export function Panel({
  title,
  focused = false,
  width,
  height,
  flexGrow,
  flexBasis,
  columns: explicitColumns,
  children,
}: PanelProps): React.ReactElement {
  const { stdout } = useStdout();
  const borderColor = focused ? theme.accent : theme.muted;

  // Determine the total character width available for border strings.
  // Prefer explicit columns prop, then numeric width, then terminal width.
  const cols = explicitColumns
    ?? (typeof width === "number" ? width : undefined)
    ?? stdout.columns
    ?? 80;

  // Inner width is total minus the two border chars (left │ + right │)
  const innerWidth = Math.max(cols - 2, 0);

  // Build top border string: ╭─ Title ──...──╮ or ╭──...──╮
  let topMiddle: string;
  if (title) {
    const titleDisplay = ` ${title} `;
    const availableForTitle = innerWidth - 2; // at least one ─ on each side of title
    if (availableForTitle < 1) {
      // Not enough room for any title — just fill with ─
      topMiddle = H.repeat(innerWidth);
    } else if (titleDisplay.length > availableForTitle) {
      // Truncate title with ellipsis
      const truncated = titleDisplay.slice(0, availableForTitle - 1) + "…";
      const remaining = innerWidth - truncated.length;
      topMiddle = H + truncated + H.repeat(Math.max(remaining - 1, 0));
    } else {
      const leftPad = 1; // single ─ before title
      const rightPad = innerWidth - leftPad - titleDisplay.length;
      topMiddle = H.repeat(leftPad) + titleDisplay + H.repeat(Math.max(rightPad, 0));
    }
  } else {
    topMiddle = H.repeat(innerWidth);
  }

  const topBorder = TL + topMiddle + TR;
  const bottomBorder = BL + H.repeat(innerWidth) + BR;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexGrow={flexGrow}
      flexBasis={flexBasis}
    >
      {/* Top border */}
      <Text color={borderColor} wrap="truncate">{topBorder}</Text>

      {/* Content area: │ content │ */}
      <Box flexDirection="row" flexGrow={1}>
        <Text color={borderColor}>{V} </Text>
        <Box flexGrow={1} flexDirection="column">
          {children}
        </Box>
        <Text color={borderColor}> {V}</Text>
      </Box>

      {/* Bottom border */}
      <Text color={borderColor} wrap="truncate">{bottomBorder}</Text>
    </Box>
  );
}
