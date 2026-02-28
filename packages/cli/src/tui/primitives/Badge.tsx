/**
 * Badge — compact lifecycle status indicator.
 *
 * Maps session lifecycle strings to colored icon + label pairs.
 * Use `compact` mode for icon-only display in tight layouts.
 */

import React from "react";
import { Text } from "ink";
import { theme, type ThemeColor } from "./theme.js";

interface BadgeConfig {
  icon: string;
  label: string;
  color: ThemeColor;
}

// Lifecycle-to-display mapping
const BADGE_MAP: Record<string, BadgeConfig> = {
  detected:   { icon: "●", label: "LIVE",    color: theme.live },
  capturing:  { icon: "●", label: "LIVE",    color: theme.live },
  ended:      { icon: "◑", label: "ENDED",   color: theme.warning },
  parsed:     { icon: "◌", label: "PARSING", color: theme.warning },
  summarized: { icon: "✓", label: "DONE",    color: theme.success },
  archived:   { icon: "▪", label: "ARCH",    color: theme.muted },
  failed:     { icon: "✗", label: "FAIL",    color: theme.error },
};

export interface BadgeProps {
  lifecycle: string;
  compact?: boolean;   // icon only, no label
}

export function Badge({ lifecycle, compact = false }: BadgeProps): React.ReactElement {
  const config = BADGE_MAP[lifecycle];

  // Unknown lifecycle: dim fallback
  if (!config) {
    return compact
      ? <Text dimColor>?</Text>
      : <Text dimColor>? {lifecycle.toUpperCase()}</Text>;
  }

  return compact
    ? <Text color={config.color}>{config.icon}</Text>
    : <Text color={config.color}>{config.icon} {config.label}</Text>;
}
