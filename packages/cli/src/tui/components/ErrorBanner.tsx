/**
 * Error display component for the TUI.
 * Shows a red error banner with the error message.
 */

import React from "react";
import { Text, Box } from "ink";
import { theme } from "../primitives/index.js";

export interface ErrorBannerProps {
  message: string;
}

export function ErrorBanner({ message }: ErrorBannerProps): React.ReactElement {
  return (
    <Box>
      <Text color={theme.error} bold>
        ✗ Error:
      </Text>
      <Text color={theme.error}> {message}</Text>
    </Box>
  );
}
