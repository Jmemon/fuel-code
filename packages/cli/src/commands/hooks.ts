/**
 * `fuel-code hooks` command group.
 *
 * Manages Claude Code hook installation for fuel-code session tracking.
 * The hooks are bash scripts that delegate to TypeScript helpers, which
 * parse CC context and call `fuel-code emit` to record session events.
 *
 * Subcommands:
 *   install  — Register fuel-code hooks in ~/.claude/settings.json
 *   status   — Check if fuel-code hooks are installed
 *   test     — Emit a synthetic session.start event to verify the pipeline
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { scanForSessions } from "@fuel-code/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the Claude Code settings file */
const CLAUDE_SETTINGS_PATH = path.join(
  os.homedir(),
  ".claude",
  "settings.json",
);

/**
 * Marker substring in hook command paths that identifies a fuel-code hook.
 * Used during upsert to find and replace existing fuel-code entries
 * without disturbing hooks from other tools.
 */
const FUEL_CODE_HOOK_MARKER = "fuel-code";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single hook entry in Claude Code's settings.json */
interface ClaudeHookEntry {
  type: "command";
  command: string;
}

/** A hook configuration block in Claude Code's settings.json */
interface ClaudeHookConfig {
  matcher: string;
  hooks: ClaudeHookEntry[];
}

/** The shape of ~/.claude/settings.json (partial — only the fields we care about) */
interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookConfig[]>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Exported: settings path override for testing
// ---------------------------------------------------------------------------

/** Override the settings path (for tests only). Set to undefined to reset. */
let settingsPathOverride: string | undefined;

export function overrideSettingsPath(p: string | undefined): void {
  settingsPathOverride = p;
}

/** Get the active settings.json path (respects test override) */
function getSettingsPath(): string {
  return settingsPathOverride ?? CLAUDE_SETTINGS_PATH;
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Create the `hooks` command group for the fuel-code CLI.
 * Returns a Commander Command instance with install/status/test subcommands.
 */
export function createHooksCommand(): Command {
  const cmd = new Command("hooks").description(
    "Manage Claude Code hooks for session tracking",
  );

  cmd.addCommand(createInstallSubcommand());
  cmd.addCommand(createStatusSubcommand());
  cmd.addCommand(createTestSubcommand());

  return cmd;
}

// ---------------------------------------------------------------------------
// Subcommand: install
// ---------------------------------------------------------------------------

function createInstallSubcommand(): Command {
  return new Command("install")
    .description("Register fuel-code hooks in ~/.claude/settings.json")
    .action(async () => {
      await runInstall();
    });
}

/**
 * Core install logic. Reads (or creates) ~/.claude/settings.json and upserts
 * fuel-code hooks for SessionStart and Stop events.
 */
export async function runInstall(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settingsDir = path.dirname(settingsPath);

  // Resolve absolute paths to the hook shell scripts.
  // The hooks package is at packages/hooks relative to the monorepo root.
  // We resolve from this file's location back to the hooks package.
  const hooksDir = resolveHooksDir();
  const sessionStartScript = path.join(hooksDir, "claude", "SessionStart.sh");
  const sessionEndScript = path.join(hooksDir, "claude", "SessionEnd.sh");

  // Verify hook scripts exist
  if (!fs.existsSync(sessionStartScript)) {
    console.error(
      `Error: SessionStart.sh not found at ${sessionStartScript}`,
    );
    console.error(
      "The hooks package may not be installed correctly. Try reinstalling.",
    );
    process.exit(1);
  }
  if (!fs.existsSync(sessionEndScript)) {
    console.error(
      `Error: SessionEnd.sh not found at ${sessionEndScript}`,
    );
    process.exit(1);
  }

  // Ensure ~/.claude/ directory exists
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // Read existing settings or create a new object
  let settings: ClaudeSettings;
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    try {
      settings = JSON.parse(raw) as ClaudeSettings;
    } catch {
      console.error(
        `Error: ${settingsPath} is corrupted. Fix it manually or backup and delete it.`,
      );
      process.exit(1);
    }
  } else {
    settings = {};
  }

  // Ensure hooks object exists
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  // Upsert SessionStart hook
  upsertHook(settings.hooks, "SessionStart", sessionStartScript);

  // Upsert Stop hook (CC uses "Stop" for session end, not "SessionEnd")
  upsertHook(settings.hooks, "Stop", sessionEndScript);

  // Write settings atomically: write to a tmp file then rename
  const tmpPath = settingsPath + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, settingsPath);

  // Ensure hook scripts are executable
  fs.chmodSync(sessionStartScript, 0o755);
  fs.chmodSync(sessionEndScript, 0o755);

  console.log("fuel-code hooks installed successfully.");
  console.log(`  SessionStart → ${sessionStartScript}`);
  console.log(`  Stop         → ${sessionEndScript}`);
  console.log(`  Settings     → ${settingsPath}`);

  // Auto-trigger: scan for historical Claude Code sessions and start background backfill
  try {
    console.error("Scanning for historical Claude Code sessions...");
    const scanResult = await scanForSessions();
    if (scanResult.discovered.length > 0) {
      console.error(
        `Found ${scanResult.discovered.length} historical sessions. Starting background backfill...`,
      );
      // Spawn detached background process so hooks install doesn't block
      Bun.spawn(["fuel-code", "backfill"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      console.error("No historical sessions found.");
    }
  } catch {
    // Backfill scan failure should never block hooks install
  }
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

function createStatusSubcommand(): Command {
  return new Command("status")
    .description("Check if fuel-code hooks are installed in Claude Code")
    .action(async () => {
      await runStatus();
    });
}

/**
 * Core status logic. Reads ~/.claude/settings.json and reports which
 * fuel-code hooks are installed.
 */
export async function runStatus(): Promise<void> {
  const settingsPath = getSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    console.log("Claude Code settings not found. Hooks are not installed.");
    console.log(`  Expected: ${settingsPath}`);
    return;
  }

  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(
      fs.readFileSync(settingsPath, "utf-8"),
    ) as ClaudeSettings;
  } catch {
    console.error(`Error: ${settingsPath} is not valid JSON.`);
    return;
  }

  const hooks = settings.hooks ?? {};

  const sessionStartInstalled = hasHook(hooks, "SessionStart");
  const stopInstalled = hasHook(hooks, "Stop");

  console.log("fuel-code hook status:");
  console.log(
    `  SessionStart: ${sessionStartInstalled ? "installed" : "not installed"}`,
  );
  console.log(
    `  Stop:         ${stopInstalled ? "installed" : "not installed"}`,
  );
}

// ---------------------------------------------------------------------------
// Subcommand: test
// ---------------------------------------------------------------------------

function createTestSubcommand(): Command {
  return new Command("test")
    .description("Emit a synthetic session.start event to verify the pipeline")
    .action(async () => {
      await runTest();
    });
}

/**
 * Core test logic. Emits a synthetic session.start event with test data
 * to verify the emit pipeline is working.
 */
export async function runTest(): Promise<void> {
  const testPayload = {
    cc_session_id: "test-session-" + Date.now(),
    cwd: process.cwd(),
    git_branch: null,
    git_remote: null,
    cc_version: "test",
    model: null,
    source: "startup",
    transcript_path: "",
  };

  const dataJson = JSON.stringify(testPayload);

  console.log("Emitting synthetic session.start event...");

  try {
    const proc = Bun.spawn(
      [
        "fuel-code",
        "emit",
        "session.start",
        "--data",
        dataJson,
        "--workspace-id",
        "_unassociated",
        "--session-id",
        testPayload.cc_session_id,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log("Test event emitted successfully (exit code 0).");
      console.log(
        "The event was either sent to the backend or queued locally.",
      );
    } else {
      console.error(`Test event failed with exit code ${exitCode}.`);
    }
  } catch (err) {
    console.error("Failed to run fuel-code emit:", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the hooks package directory.
 *
 * Uses the known monorepo structure: this file is in packages/cli/src/commands/,
 * and the hooks package is at packages/hooks/.
 */
function resolveHooksDir(): string {
  // Navigate from packages/cli/src/commands/ → packages/hooks/
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(thisDir, "..", "..", "..", "hooks");
}

/**
 * Upsert a fuel-code hook into a Claude Code hook event slot.
 *
 * If the slot already has a fuel-code hook (identified by FUEL_CODE_HOOK_MARKER
 * in the command path), replace it. Otherwise, append a new entry.
 * Non-fuel-code hooks from other tools are always preserved.
 *
 * @param hooks - The hooks object from settings.json
 * @param eventName - CC hook event name (e.g., "SessionStart", "Stop")
 * @param scriptPath - Absolute path to the hook shell script
 */
function upsertHook(
  hooks: Record<string, ClaudeHookConfig[]>,
  eventName: string,
  scriptPath: string,
): void {
  const newEntry: ClaudeHookEntry = {
    type: "command",
    command: scriptPath,
  };

  // If no configs exist for this event, create a fresh one
  if (!hooks[eventName] || !Array.isArray(hooks[eventName])) {
    hooks[eventName] = [{ matcher: "", hooks: [newEntry] }];
    return;
  }

  const configs = hooks[eventName];

  // Look for an existing config block that has a fuel-code hook
  for (const config of configs) {
    if (!config.hooks || !Array.isArray(config.hooks)) {
      continue;
    }

    const fuelCodeIdx = config.hooks.findIndex(
      (h) =>
        h.command &&
        (h.command.includes(FUEL_CODE_HOOK_MARKER) ||
          h.command.includes("SessionStart.sh") ||
          h.command.includes("SessionEnd.sh")),
    );

    if (fuelCodeIdx !== -1) {
      // Replace existing fuel-code hook in-place
      config.hooks[fuelCodeIdx] = newEntry;
      return;
    }
  }

  // No existing fuel-code hook found — append to the first config's hooks array,
  // or create a new config block if the first one has a non-empty matcher
  const firstConfig = configs[0];
  if (firstConfig && firstConfig.matcher === "") {
    firstConfig.hooks = firstConfig.hooks ?? [];
    firstConfig.hooks.push(newEntry);
  } else {
    // All existing configs have matchers — add a new catch-all config
    configs.push({ matcher: "", hooks: [newEntry] });
  }
}

/**
 * Check if a fuel-code hook is installed for a given event name.
 *
 * @param hooks - The hooks object from settings.json
 * @param eventName - CC hook event name (e.g., "SessionStart", "Stop")
 */
function hasHook(
  hooks: Record<string, ClaudeHookConfig[]>,
  eventName: string,
): boolean {
  const configs = hooks[eventName];
  if (!Array.isArray(configs)) return false;

  return configs.some(
    (config) =>
      Array.isArray(config.hooks) &&
      config.hooks.some(
        (h) =>
          h.command &&
          (h.command.includes(FUEL_CODE_HOOK_MARKER) ||
            h.command.includes("SessionStart.sh") ||
            h.command.includes("SessionEnd.sh")),
      ),
  );
}
