/**
 * CLI runner and assertion utilities for Phase 4 E2E tests.
 *
 * Instead of spawning the CLI binary (which requires a config file),
 * we construct a FuelApiClient directly with the test server's URL and
 * API key, then call the exported data-fetching + formatting functions
 * from each command module. This tests the real data layer + presentation
 * layer against a real backend.
 */

import { FuelApiClient } from "../../lib/api-client.js";
import { stripAnsi } from "../../lib/formatters.js";

/**
 * Create a FuelApiClient pointed at the test server.
 * Uses a short timeout since we're on localhost.
 */
export function createTestClient(baseUrl: string, apiKey: string): FuelApiClient {
  return new FuelApiClient({ baseUrl, apiKey, timeout: 10_000 });
}

/**
 * Strip ANSI escape codes from formatted output for clean text assertions.
 * Re-exports stripAnsi from formatters for convenience.
 */
export { stripAnsi };

/**
 * Wait for a specified number of milliseconds.
 * Useful for giving the pipeline time to process events.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a predicate until it returns true or timeout expires.
 * Replaces hardcoded `await wait(N)` patterns for timing-sensitive assertions.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  pollIntervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await wait(pollIntervalMs);
  }
  throw new Error(`waitFor: condition not met after ${timeoutMs}ms`);
}
