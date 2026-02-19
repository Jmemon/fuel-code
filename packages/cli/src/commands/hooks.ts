/**
 * `fuel-code hooks` command group.
 *
 * Manages both Claude Code (CC) hook installation and git hook installation
 * for fuel-code activity tracking.
 *
 * CC hooks: bash scripts registered in ~/.claude/settings.json that fire
 * on SessionStart/Stop events.
 *
 * Git hooks: bash scripts installed via core.hooksPath (global) or
 * .git/hooks/ (per-repo) that fire on post-commit, post-checkout,
 * post-merge, and pre-push events.
 *
 * Subcommands:
 *   install   — Install CC hooks, git hooks, or both
 *   uninstall — Remove CC hooks, git hooks, or both (with optional restore)
 *   status    — Check installation state of all hooks
 *   test      — Emit a synthetic session.start event to verify the pipeline
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { scanForSessions } from "@fuel-code/core";
import {
  installGitHooks,
  uninstallGitHooks,
  GIT_HOOK_NAMES,
} from "../lib/git-hook-installer.js";
import { getGitHookStatus } from "../lib/git-hook-status.js";

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
 * Returns a Commander Command instance with install/uninstall/status/test subcommands.
 */
export function createHooksCommand(): Command {
  const cmd = new Command("hooks").description(
    "Manage Claude Code and git hooks for activity tracking",
  );

  cmd.addCommand(createInstallSubcommand());
  cmd.addCommand(createUninstallSubcommand());
  cmd.addCommand(createStatusSubcommand());
  cmd.addCommand(createTestSubcommand());

  return cmd;
}

// ---------------------------------------------------------------------------
// Subcommand: install
// ---------------------------------------------------------------------------

function createInstallSubcommand(): Command {
  return new Command("install")
    .description("Install fuel-code hooks (CC hooks + git hooks)")
    .option("--cc-only", "Install only Claude Code hooks (Phase 1 behavior)")
    .option("--git-only", "Install only git hooks")
    .option("--per-repo", "Install git hooks only in current repo's .git/hooks/")
    .option("--force", "Override competing hook manager warnings")
    .action(async (opts) => {
      const ccOnly = opts.ccOnly ?? false;
      const gitOnly = opts.gitOnly ?? false;
      const perRepo = opts.perRepo ?? false;
      const force = opts.force ?? false;

      // Determine what to install. Default (no flags) = both.
      const installCC = !gitOnly;
      const installGit = !ccOnly;

      // Install CC hooks
      if (installCC) {
        await runCCInstall();
      }

      // Install git hooks
      if (installGit) {
        try {
          const result = await installGitHooks({ force, perRepo });

          console.log("\nGit hooks installed successfully.");
          console.log(`  Hooks dir:  ${result.hooksDir}`);
          console.log(`  Installed:  ${result.installed.join(", ")}`);
          if (result.chained.length > 0) {
            console.log(`  Chained:    ${result.chained.join(", ")}`);
          }
          if (result.backedUp.length > 0) {
            console.log(`  Backed up:  ${result.backedUp.join(", ")}`);
          }
          if (result.previousHooksPath) {
            console.log(`  Previous hooksPath: ${result.previousHooksPath}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\nError installing git hooks: ${msg}`);
          process.exit(1);
        }
      }
    });
}

/**
 * Install Claude Code hooks into ~/.claude/settings.json.
 * This is the original install logic from Phase 1, extracted into its own function
 * so the install subcommand can orchestrate CC + git installs together.
 */
export async function runCCInstall(): Promise<void> {
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

  console.log("Claude Code hooks installed successfully.");
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

/**
 * Legacy wrapper: installs both CC and git hooks (default behavior).
 * Kept for backward compatibility with existing tests that call runInstall().
 */
export async function runInstall(): Promise<void> {
  await runCCInstall();
}

// ---------------------------------------------------------------------------
// Subcommand: uninstall
// ---------------------------------------------------------------------------

function createUninstallSubcommand(): Command {
  return new Command("uninstall")
    .description("Remove fuel-code hooks")
    .option("--cc-only", "Remove only Claude Code hooks")
    .option("--git-only", "Remove only git hooks")
    .option("--restore", "Restore previous git hooksPath from backup")
    .action(async (opts) => {
      const ccOnly = opts.ccOnly ?? false;
      const gitOnly = opts.gitOnly ?? false;
      const restore = opts.restore ?? false;

      // Default (no flags) = uninstall both
      const uninstallCC = !gitOnly;
      const uninstallGit = !ccOnly;

      if (uninstallCC) {
        await runCCUninstall();
      }

      if (uninstallGit) {
        try {
          await uninstallGitHooks({ restore });
          console.log("Git hooks uninstalled successfully.");
          if (restore) {
            console.log("  Previous hooksPath restored from backup.");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Error uninstalling git hooks: ${msg}`);
          process.exit(1);
        }
      }
    });
}

/**
 * Remove fuel-code CC hooks from ~/.claude/settings.json.
 * Removes the SessionStart and Stop hook entries that contain fuel-code markers.
 */
async function runCCUninstall(): Promise<void> {
  const settingsPath = getSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    console.log("Claude Code settings not found. Nothing to uninstall.");
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

  if (!settings.hooks) {
    console.log("No hooks found in Claude Code settings.");
    return;
  }

  // Remove fuel-code entries from SessionStart and Stop
  removeHook(settings.hooks, "SessionStart");
  removeHook(settings.hooks, "Stop");

  // Write back
  const tmpPath = settingsPath + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, settingsPath);

  console.log("Claude Code hooks uninstalled successfully.");
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

function createStatusSubcommand(): Command {
  return new Command("status")
    .description("Check if fuel-code hooks are installed")
    .action(async () => {
      await runStatus();
    });
}

/**
 * Core status logic. Reports both CC hooks and git hooks state.
 */
export async function runStatus(): Promise<void> {
  // -- CC hooks status --
  const settingsPath = getSettingsPath();

  console.log("Claude Code hooks:");

  if (!fs.existsSync(settingsPath)) {
    console.log("  SessionStart: not installed");
    console.log("  Stop:         not installed");
  } else {
    let settings: ClaudeSettings;
    try {
      settings = JSON.parse(
        fs.readFileSync(settingsPath, "utf-8"),
      ) as ClaudeSettings;
    } catch {
      console.error(`  Error: ${settingsPath} is not valid JSON.`);
      settings = {};
    }

    const hooks = settings.hooks ?? {};
    const sessionStartInstalled = hasHook(hooks, "SessionStart");
    const stopInstalled = hasHook(hooks, "Stop");

    console.log(
      `  SessionStart: ${sessionStartInstalled ? "installed" : "not installed"}`,
    );
    console.log(
      `  Stop:         ${stopInstalled ? "installed" : "not installed"}`,
    );
  }

  // -- Git hooks status --
  console.log("");
  console.log("Git hooks:");

  try {
    const gitStatus = await getGitHookStatus();

    console.log(
      `  core.hooksPath: ${gitStatus.hooksPath ?? "(not set)"}`,
    );

    for (const name of GIT_HOOK_NAMES) {
      const hookInfo = gitStatus.hooks[name];
      if (!hookInfo) continue;

      let statusStr: string;
      if (!hookInfo.exists) {
        statusStr = "not installed";
      } else if (!hookInfo.executable) {
        statusStr = "installed (not executable)";
      } else {
        statusStr = "installed";
      }

      // Append chained info if applicable
      if (hookInfo.chained) {
        statusStr += ` (chained: ${name}.user)`;
      }

      // Pad hook name for alignment
      const paddedName = (name + ":").padEnd(16);
      console.log(`  ${paddedName}${statusStr}`);
    }
  } catch {
    console.log("  (unable to check git hook status)");
  }
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
 * Remove fuel-code hook entries from a CC hook event slot.
 * Preserves non-fuel-code hooks. Removes empty config blocks.
 *
 * @param hooks - The hooks object from settings.json
 * @param eventName - CC hook event name (e.g., "SessionStart", "Stop")
 */
function removeHook(
  hooks: Record<string, ClaudeHookConfig[]>,
  eventName: string,
): void {
  const configs = hooks[eventName];
  if (!Array.isArray(configs)) return;

  for (const config of configs) {
    if (!config.hooks || !Array.isArray(config.hooks)) continue;

    config.hooks = config.hooks.filter(
      (h) =>
        !h.command ||
        (!h.command.includes(FUEL_CODE_HOOK_MARKER) &&
          !h.command.includes("SessionStart.sh") &&
          !h.command.includes("SessionEnd.sh")),
    );
  }

  // Remove empty config blocks
  hooks[eventName] = configs.filter(
    (c) => c.hooks && c.hooks.length > 0,
  );

  // Remove the event key entirely if no configs remain
  if (hooks[eventName].length === 0) {
    delete hooks[eventName];
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
