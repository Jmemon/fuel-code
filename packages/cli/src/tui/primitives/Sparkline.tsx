/**
 * Sparkline -- renders a series of numeric values as a compact inline
 * mini-chart using Unicode block characters.
 *
 * Eight vertical-resolution levels are mapped from the lowest block (index 0)
 * to a full block (index 7):  ▁▂▃▄▅▆▇█
 *
 * Values are optionally bucketed when the data length exceeds the requested
 * width, and explicit min/max bounds can be provided for consistent scaling
 * across multiple sparklines.
 */

import React from "react";
import { Text } from "ink";
import { theme } from "./theme.js";

/** Block characters ordered from lowest (0) to tallest (7). */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export interface SparklineProps {
  /** Numeric values to chart. */
  values: number[];
  /** Maximum character width; values are bucketed (averaged) to fit. Defaults to values.length. */
  width?: number;
  /** Bar color. Defaults to theme.accent. */
  color?: string;
  /** Explicit minimum bound (defaults to data min). */
  min?: number;
  /** Explicit maximum bound (defaults to data max). */
  max?: number;
}

export function Sparkline({
  values,
  width,
  color = theme.accent,
  min: explicitMin,
  max: explicitMax,
}: SparklineProps): React.ReactElement | null {
  // Empty input -- render nothing
  if (values.length === 0) return null;

  // Single value -- always render the full block
  if (values.length === 1) {
    return <Text color={color}>{BLOCKS[7]}</Text>;
  }

  const targetWidth = width ?? values.length;

  // Bucket values into `targetWidth` groups by averaging when data is wider
  let bucketed: number[];
  if (values.length > targetWidth) {
    const groupSize = values.length / targetWidth;
    bucketed = [];
    for (let i = 0; i < targetWidth; i++) {
      const start = Math.floor(i * groupSize);
      const end = Math.floor((i + 1) * groupSize);
      let sum = 0;
      for (let j = start; j < end; j++) sum += values[j];
      bucketed.push(sum / (end - start));
    }
  } else {
    bucketed = values;
  }

  const dataMin = explicitMin ?? Math.min(...bucketed);
  const dataMax = explicitMax ?? Math.max(...bucketed);

  // All values identical -- render the middle block for every position
  if (dataMin === dataMax) {
    // If all values are zero (and no explicit bounds override), use lowest block
    const idx = dataMin === 0 && explicitMin === undefined && explicitMax === undefined ? 0 : 3;
    return <Text color={color}>{BLOCKS[idx].repeat(bucketed.length)}</Text>;
  }

  const chars = bucketed.map((v) => {
    const normalized = Math.round(((v - dataMin) / (dataMax - dataMin)) * 7);
    const idx = Math.max(0, Math.min(7, normalized));
    return BLOCKS[idx];
  });

  return <Text color={color}>{chars.join("")}</Text>;
}
