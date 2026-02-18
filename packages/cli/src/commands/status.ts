/**
 * `fuel-code status` command.
 *
 * Displays current device info, queue depth, and backend connectivity.
 * Useful for quick health-checks and debugging.
 */

import { Command } from "commander";
import * as fs from "node:fs";
import { ConfigError } from "@fuel-code/shared";
import { configExists, loadConfig, getQueueDir } from "../lib/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count .json files in the queue directory.
 * These represent pending events waiting to be drained to the backend.
 */
function countQueuedEvents(): number {
  const queueDir = getQueueDir();
  if (!fs.existsSync(queueDir)) {
    return 0;
  }
  const files = fs.readdirSync(queueDir);
  return files.filter((f) => f.endsWith(".json")).length;
}

/**
 * Check backend health by hitting GET /api/health with a 5s timeout.
 * Returns true if the backend responds with a 2xx status.
 */
async function checkBackendHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const healthUrl = `${url.replace(/\/+$/, "")}/api/health`;
    const response = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * Create the `status` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createStatusCommand(): Command {
  const cmd = new Command("status")
    .description("Show device info, queue depth, and connectivity status")
    .action(async () => {
      await runStatus();
    });

  return cmd;
}

/**
 * Core status logic. Separated from Commander for testability.
 */
export async function runStatus(): Promise<void> {
  // Check if initialized
  if (!configExists()) {
    console.log("fuel-code is not initialized. Run 'fuel-code init' first.");
    process.exitCode = 1;
    return;
  }

  // Load config — exit on error
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Config error (${err.code}): ${err.message}`);
    } else {
      console.error("Failed to load config:", err);
    }
    process.exitCode = 1;
    return;
  }

  // Gather info
  const queueDepth = countQueuedEvents();
  const backendOk = await checkBackendHealth(config.backend.url);

  // Print status
  console.log("");
  console.log("fuel-code status");
  console.log("================");
  console.log("");
  console.log(`  Device ID:      ${config.device.id}`);
  console.log(`  Device name:    ${config.device.name}`);
  console.log(`  Device type:    ${config.device.type}`);
  console.log(`  Backend URL:    ${config.backend.url}`);
  console.log(`  Queue depth:    ${queueDepth} event(s)`);
  console.log(`  Connectivity:   ${backendOk ? "OK" : "UNREACHABLE"}`);
  console.log("");
}
