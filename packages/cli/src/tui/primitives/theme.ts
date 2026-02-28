/**
 * Centralized color palette for all TUI components.
 *
 * Every component should reference these semantic color tokens instead of
 * hardcoding color strings. This gives us a single place to adjust the
 * palette and keeps the visual language consistent across views.
 */

export const theme = {
  accent: 'yellowBright',       // selection highlight, focused borders, key hints
  success: 'green',             // done status, WS connected
  warning: 'yellow',            // ended/parsing states, reconnecting
  error: 'red',                 // failed status, error banners
  info: 'cyan',                 // human messages, informational text
  muted: 'gray',               // unfocused borders, secondary text
  live: 'green',                // live session indicators
} as const;

export type ThemeColor = typeof theme[keyof typeof theme];
