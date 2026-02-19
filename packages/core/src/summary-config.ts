/**
 * Summary configuration loader.
 *
 * Reads summary-related settings from environment variables with sensible
 * defaults. The config controls whether session summaries are generated,
 * which Claude model to use, and the generation parameters.
 */

import type { SummaryConfig } from "./summary-generator.js";

/**
 * Load summary configuration from environment variables.
 *
 * Environment variables:
 *   SUMMARY_ENABLED          - "false" to disable (default: enabled)
 *   SUMMARY_MODEL            - Claude model ID (default: claude-sonnet-4-5-20250929)
 *   SUMMARY_TEMPERATURE      - Generation temperature 0-1 (default: 0.3)
 *   SUMMARY_MAX_OUTPUT_TOKENS - Max tokens in response (default: 150)
 *   ANTHROPIC_API_KEY         - Anthropic API key (required for generation)
 */
export function loadSummaryConfig(): SummaryConfig {
  return {
    enabled: process.env.SUMMARY_ENABLED !== "false",
    model: process.env.SUMMARY_MODEL || "claude-sonnet-4-5-20250929",
    temperature: parseFloat(process.env.SUMMARY_TEMPERATURE || "0.3"),
    maxOutputTokens: parseInt(process.env.SUMMARY_MAX_OUTPUT_TOKENS || "150", 10),
    apiKey: process.env.ANTHROPIC_API_KEY || "",
  };
}
