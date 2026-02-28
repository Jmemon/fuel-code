/**
 * Simple animated loading spinner for the TUI.
 * Cycles through Unicode braille characters at a fixed interval.
 */

import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { theme } from "../primitives/index.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label = "Loading..." }: SpinnerProps): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text>
      <Text color={theme.accent}>{FRAMES[frame]}</Text> {label}
    </Text>
  );
}
