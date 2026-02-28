/**
 * Divider — horizontal rule with optional centered title.
 *
 * Renders a line of ─ characters spanning the given width.
 * When a title is provided, it is centered within the rule.
 */

import React from "react";
import { Text, useStdout } from "ink";
import { theme } from "./theme.js";

export interface DividerProps {
  title?: string;
  color?: string;    // default: theme.muted
  width?: number;    // default: use stdout.columns
}

export function Divider({
  title,
  color = theme.muted,
  width: explicitWidth,
}: DividerProps): React.ReactElement {
  const { stdout } = useStdout();
  const totalWidth = explicitWidth ?? stdout.columns ?? 80;

  if (!title) {
    return <Text color={color}>{"─".repeat(totalWidth)}</Text>;
  }

  // Center the title within the rule: ──── TITLE ────
  const titleDisplay = ` ${title} `;
  const remaining = totalWidth - titleDisplay.length;

  if (remaining < 2) {
    // Not enough room for dashes — just show the title
    return <Text color={color}>{titleDisplay.trim()}</Text>;
  }

  const leftDashes = Math.floor(remaining / 2);
  const rightDashes = remaining - leftDashes;

  return (
    <Text color={color}>
      {"─".repeat(leftDashes)}{titleDisplay}{"─".repeat(rightDashes)}
    </Text>
  );
}
