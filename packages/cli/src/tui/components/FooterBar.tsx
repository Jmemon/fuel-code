/**
 * FooterBar — key hints displayed at the bottom of the session detail view.
 *
 * Shows contextual keybinding hints based on the active tab.
 * Renders as a single line of dimmed text with key shortcuts.
 */

import React from "react";
import { Box, Text } from "ink";

export interface FooterBarProps {
  /** Currently active tab: transcript, events, or git */
  activeTab: "transcript" | "events" | "git";
  /** Whether the session is live (changes some hints) */
  isLive?: boolean;
}

export function FooterBar({ activeTab, isLive }: FooterBarProps): React.ReactElement {
  const hints: string[] = [];

  // Navigation hints
  hints.push("b:back");
  hints.push("t:transcript");
  hints.push("e:events");
  hints.push("g:git");

  // Scroll hints (for scrollable tabs)
  if (activeTab === "transcript" || activeTab === "events" || activeTab === "git") {
    hints.push("j/k:scroll");
    hints.push("Space:page");
  }

  hints.push("x:export");
  hints.push("q:quit");

  if (isLive) {
    hints.push("LIVE");
  }

  return (
    <Box>
      <Text dimColor>{hints.join("  ")}</Text>
    </Box>
  );
}
