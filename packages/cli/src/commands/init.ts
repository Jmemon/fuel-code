/**
 * `fuel-code init` command.
 *
 * Initializes the ~/.fuel-code/ directory with a config.yaml file.
 * Handles both interactive and non-interactive (CI/scripting) modes.
 *
 * Flow:
 *   1. Check if already initialized (skip unless --force)
 *   2. Create directory structure
 *   3. Resolve device identity (preserve on --force if valid, else generate)
 *   4. Resolve device name, backend URL, and API key from flags/env/defaults
 *   5. Write config atomically
 *   6. Test backend connectivity (warn-only on failure)
 *   7. Print summary
 */

import { Command } from "commander";
import * as os from "node:os";
import { generateId, ConfigError } from "@fuel-code/shared";
import { scanForSessions } from "@fuel-code/core";
import {
  configExists,
  loadConfig,
  saveConfig,
  ensureDirectories,
  getQueueDir,
  type FuelCodeConfig,
} from "../lib/config.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Pattern for valid device names: 1-64 chars, alphanumeric/hyphens/underscores */
const DEVICE_NAME_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Validate a device name string.
 * Must be 1-64 characters and only contain alphanumeric, hyphens, underscores.
 */
function isValidDeviceName(name: string): boolean {
  return DEVICE_NAME_REGEX.test(name);
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * Create the `init` subcommand for the fuel-code CLI.
 * Returns a Commander Command instance ready to be registered on the program.
 */
export function createInitCommand(): Command {
  const cmd = new Command("init")
    .description("Initialize fuel-code on this device")
    .option("--name <name>", "Device name (default: hostname)")
    .option("--url <url>", "Backend URL (or set FUEL_CODE_BACKEND_URL)")
    .option("--api-key <key>", "API key (or set FUEL_CODE_API_KEY)")
    .option("--force", "Re-initialize even if already configured", false)
    .option(
      "--non-interactive",
      "Fail instead of prompting for missing values",
      false,
    )
    .action(async (opts) => {
      await runInit(opts);
    });

  return cmd;
}

// ---------------------------------------------------------------------------
// Init logic — extracted for testability
// ---------------------------------------------------------------------------

/** Options parsed by Commander for the init command */
interface InitOptions {
  name?: string;
  url?: string;
  apiKey?: string;
  force: boolean;
  nonInteractive: boolean;
}

/**
 * Core init logic. Separated from the Commander action so it can be
 * unit-tested without invoking Commander's argument parsing.
 */
export async function runInit(opts: InitOptions): Promise<void> {
  // 1. Check if already initialized
  if (configExists() && !opts.force) {
    console.log("Already initialized. Use --force to re-initialize.");
    return;
  }

  // 2. Create directory structure
  ensureDirectories();

  // 3. Determine device ID: preserve existing ID on --force if config is valid
  let deviceId: string;
  if (opts.force && configExists()) {
    try {
      const existing = loadConfig();
      deviceId = existing.device.id;
    } catch {
      // Config is corrupted/invalid — generate a fresh ID
      deviceId = generateId();
    }
  } else {
    deviceId = generateId();
  }

  // 4. Determine device name: --name flag > os.hostname()
  const deviceName = opts.name ?? os.hostname();
  if (!isValidDeviceName(deviceName)) {
    console.error(
      `Invalid device name "${deviceName}". ` +
        "Must be 1-64 characters: letters, numbers, hyphens, underscores.",
    );
    process.exitCode = 1;
    return;
  }

  // 5. Backend URL: --url > env FUEL_CODE_BACKEND_URL
  const backendUrl =
    opts.url ?? process.env.FUEL_CODE_BACKEND_URL;
  if (!backendUrl) {
    if (opts.nonInteractive) {
      console.error(
        "Backend URL is required. Provide --url or set FUEL_CODE_BACKEND_URL.",
      );
      process.exitCode = 1;
      return;
    }
    // In interactive mode we'd prompt, but prompting is a future enhancement.
    // For now, require the URL.
    console.error(
      "Backend URL is required. Provide --url or set FUEL_CODE_BACKEND_URL.",
    );
    process.exitCode = 1;
    return;
  }

  // 6. API key: --api-key > env FUEL_CODE_API_KEY
  const apiKey =
    opts.apiKey ?? process.env.FUEL_CODE_API_KEY;
  if (!apiKey) {
    if (opts.nonInteractive) {
      console.error(
        "API key is required. Provide --api-key or set FUEL_CODE_API_KEY.",
      );
      process.exitCode = 1;
      return;
    }
    console.error(
      "API key is required. Provide --api-key or set FUEL_CODE_API_KEY.",
    );
    process.exitCode = 1;
    return;
  }

  // 7. Build and save config
  const config: FuelCodeConfig = {
    backend: {
      url: backendUrl,
      api_key: apiKey,
    },
    device: {
      id: deviceId,
      name: deviceName,
      type: "local", // Remote envs set this differently during provisioning
    },
    pipeline: {
      queue_path: getQueueDir(),
      drain_interval_seconds: 10,
      batch_size: 50,
      post_timeout_ms: 5000,
    },
  };

  saveConfig(config);

  // 8. Test connectivity: GET {url}/api/health with 5s timeout
  let connectivityOk = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const healthUrl = `${backendUrl.replace(/\/+$/, "")}/api/health`;
    const response = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    connectivityOk = response.ok;
  } catch {
    // Connectivity test is best-effort — don't fail init
    connectivityOk = false;
  }

  // 9. Print summary
  console.log("");
  console.log("fuel-code initialized successfully!");
  console.log("");
  console.log(`  Device ID:    ${deviceId}`);
  console.log(`  Device name:  ${deviceName}`);
  console.log(`  Backend URL:  ${backendUrl}`);
  console.log(`  Queue path:   ${config.pipeline.queue_path}`);
  console.log("");

  if (connectivityOk) {
    console.log("  Backend connectivity: OK");
  } else {
    console.log(
      "  Backend connectivity: FAILED (init succeeded, but backend is unreachable)",
    );
  }
  console.log("");

  // Auto-trigger: scan for historical Claude Code sessions and start background backfill
  try {
    console.error("Scanning for historical Claude Code sessions...");
    const scanResult = await scanForSessions();
    if (scanResult.discovered.length > 0) {
      console.error(
        `Found ${scanResult.discovered.length} historical sessions. Starting background backfill...`,
      );
      // Spawn detached background process so init doesn't block
      Bun.spawn(["fuel-code", "backfill"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      console.error("No historical sessions found.");
    }
  } catch {
    // Backfill scan failure should never block init
  }
}
