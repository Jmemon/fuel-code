/**
 * KeyHint -- renders a row of keyboard shortcut hints with consistent styling.
 *
 * Keys are displayed in the accent color, actions in dim gray, and pairs
 * are separated by two spaces. An optional trailing string (e.g. "LIVE")
 * can be appended at the end.
 *
 * Example output:  j/k nav  Enter open  Tab pane  q quit
 */

import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export interface KeyHintProps {
  /** Ordered list of { key, action } pairs to display. */
  hints: Array<{ key: string; action: string }>;
  /** Optional trailing text appended after all hints (e.g. "LIVE" indicator). */
  extra?: string;
}

export function KeyHint({ hints, extra }: KeyHintProps): React.ReactElement {
  return (
    <Box>
      {hints.map((h, i) => (
        <React.Fragment key={i}>
          {/* Separate each pair with two spaces (skip leading separator) */}
          {i > 0 && <Text>  </Text>}
          <Text color={theme.accent}>{h.key}</Text>
          <Text dimColor> {h.action}</Text>
        </React.Fragment>
      ))}
      {extra && (
        <>
          <Text>  </Text>
          <Text color={theme.live} bold>{extra}</Text>
        </>
      )}
    </Box>
  );
}
