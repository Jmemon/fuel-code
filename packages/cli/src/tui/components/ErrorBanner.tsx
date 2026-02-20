/**
 * Error display component for the TUI.
 * Shows a red error banner with the error message.
 */

import React from "react";
import { Text, Box } from "ink";

export interface ErrorBannerProps {
  message: string;
}

export function ErrorBanner({ message }: ErrorBannerProps): React.ReactElement {
  return (
    <Box>
      <Text color="red" bold>
        ✗ Error:
      </Text>
      <Text color="red"> {message}</Text>
    </Box>
  );
}
