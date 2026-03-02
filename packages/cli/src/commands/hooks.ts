/**
 * `fuel-code hooks` command group.
 *
 * Manages both Claude Code (CC) hook installation and git hook installation
 * for fuel-code activity tracking.
 *
 * CC hooks: commands registered in ~/.claude/settings.json that fire on
 * various CC lifecycle events. Currently registers 10 hook entries across
 * 7 event types:
 *   - SessionStart, SessionEnd (backgrounded via bash -c)
 *   - SubagentStart, SubagentStop
 *   - PostToolUse with matchers: TeamCreate, Skill, EnterWorktree, SendMessage
 *   - WorktreeCreate, WorktreeRemove
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
 * All CC hook entries fuel-code registers.
 * Each entry describes one hook: the CC event name, the cc-hook subcommand,
 * and an optional matcher (used by PostToolUse to filter by tool name).
 *
 * SessionStart/SessionEnd use a bash wrapper that captures stdin then
 * backgrounds the actual processing so they never block Claude Code.
 * All other hooks run synchronously (they are fast enough).
 */
interface HookDefinition {
  event: string;
  subcommand: string;
  matcher?: string;
  /** Whether to wrap the command in bash -c '...' & for background execution */
  background?: boolean;
}

const HOOK_DEFINITIONS: HookDefinition[] = [
  { event: "SessionStart", subcommand: "session-start", background: true },
  { event: "SessionEnd", subcommand: "session-end", background: true },
  { event: "SubagentStart", subcommand: "subagent-start" },
  { event: "SubagentStop", subcommand: "subagent-stop" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "TeamCreate" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "Skill" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "EnterWorktree" },
  { event: "PostToolUse", subcommand: "post-tool-use", matcher: "SendMessage" },
  { event: "WorktreeCreate", subcommand: "worktree-create" },
  { event: "WorktreeRemove", subcommand: "worktree-remove" },
];

/**
 * Check if a hook command string belongs to fuel-code.
 * Matches both old format (shell script paths containing "fuel-code" or
 * "SessionStart.sh"/"SessionEnd.sh") and new format ("cc-hook" commands).
 */
function isFuelCodeHookCommand(command: string): boolean {
  return (
    command.includes("cc-hook") ||
    command.includes("fuel-code") ||
    command.includes("SessionStart.sh") ||
    command.includes("SessionEnd.sh")
  );
}

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
 *
 * Registers all fuel-code hook entries defined in HOOK_DEFINITIONS.
 * SessionStart/SessionEnd commands are wrapped in `bash -c '... &'` to fork
 * to background so they never block Claude Code startup/shutdown.
 * Other hooks run synchronously (fast enough to not block).
 *
 * No external shell scripts are referenced — the CLI itself handles all
 * hook logic via the `cc-hook` subcommand.
 */
export async function runCCInstall(): Promise<void> {
  const settingsPath = getSettingsPath();
  const settingsDir = path.dirname(settingsPath);

  // Resolve how to invoke the fuel-code CLI from settings.json hooks.
  // Prefers the global `fuel-code` binary; falls back to `bun run <abs-path>`.
  const cliCommand = resolveCliCommand();

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

  // Upsert all hook entries from HOOK_DEFINITIONS
  for (const def of HOOK_DEFINITIONS) {
    const cmd = buildHookCommand(cliCommand, def);
    upsertHook(settings.hooks, def.event, cmd, def.matcher);
  }

  // Clean up stale Stop hook from pre-migration installs (was previously
  // used for session-end before we migrated to SessionEnd)
  removeHook(settings.hooks, "Stop");

  // Write settings atomically: write to a tmp file then rename
  const tmpPath = settingsPath + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, settingsPath);

  console.log("Claude Code hooks installed successfully.");
  for (const def of HOOK_DEFINITIONS) {
    const label = def.matcher
      ? `${def.event}[${def.matcher}]`
      : def.event;
    const cmd = buildHookCommand(cliCommand, def);
    console.log(`  ${label.padEnd(28)} → ${cmd}`);
  }
  console.log(`  Settings${" ".repeat(18)} → ${settingsPath}`);

}

/**
 * Build the full command string for a hook definition.
 * Background hooks (SessionStart/SessionEnd) capture stdin then fork to
 * background so they return immediately. Other hooks run synchronously.
 */
function buildHookCommand(cliCommand: string, def: HookDefinition): string {
  const base = `${cliCommand} cc-hook ${def.subcommand}`;
  if (def.background) {
    // IMPORTANT: `bash -c 'cmd &'` redirects stdin from /dev/null for the
    // backgrounded process (POSIX non-interactive shell behavior). We MUST
    // read stdin BEFORE backgrounding, then pipe the captured data in.
    return `bash -c 'data=$(cat); printf "%s" "$data" | ${base} &'`;
  }
  return base;
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
 * Removes all fuel-code hook entries from every event type we register.
 * Non-fuel-code hooks from other tools are preserved.
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

  // Collect unique event names from HOOK_DEFINITIONS and remove fuel-code
  // entries from each. Also remove the stale Stop hook if present.
  const eventNames = new Set(HOOK_DEFINITIONS.map((d) => d.event));
  eventNames.add("Stop"); // Legacy cleanup
  for (const eventName of eventNames) {
    removeHook(settings.hooks, eventName);
  }

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

  let hooks: Record<string, ClaudeHookConfig[]> = {};

  if (!fs.existsSync(settingsPath)) {
    // No settings file — all hooks are not installed
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
    hooks = settings.hooks ?? {};
  }

  // Report status for every hook definition
  for (const def of HOOK_DEFINITIONS) {
    const label = def.matcher
      ? `${def.event}[${def.matcher}]:`
      : `${def.event}:`;
    const installed = hasHook(hooks, def.event, def.matcher);
    console.log(
      `  ${label.padEnd(29)} ${installed ? "installed" : "not installed"}`,
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
// CLI command resolution
// ---------------------------------------------------------------------------

/** Override the CLI command (for tests only). Set to undefined to reset. */
let cliCommandOverride: string | undefined;

export function overrideCliCommand(cmd: string | undefined): void {
  cliCommandOverride = cmd;
}

/**
 * Resolve the fuel-code CLI invocation command for use in settings.json hooks.
 *
 * Prefers a globally available `fuel-code` binary. Falls back to
 * `bun run <absolute-path-to-cli>` using the current script's path.
 * The path is double-quoted to handle directories with spaces.
 */
function resolveCliCommand(): string {
  if (cliCommandOverride) return cliCommandOverride;

  const which = Bun.which("fuel-code");
  if (which) return "fuel-code";

  // Fall back to bun run with absolute path to the CLI entry point
  const scriptPath = path.resolve(process.argv[1]);
  // Double-quote the path to handle spaces in directory names
  const escaped = scriptPath.replace(/"/g, '\\"');
  return `bun run "${escaped}"`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a fuel-code hook into a Claude Code hook event slot.
 *
 * If the slot already has a fuel-code hook in a matching config block
 * (identified by isFuelCodeHookCommand), replace it. Otherwise, append.
 * Non-fuel-code hooks from other tools are always preserved.
 *
 * @param hooks - The hooks object from settings.json
 * @param eventName - CC hook event name (e.g., "SessionStart", "PostToolUse")
 * @param command - The full command string to register as a hook
 * @param matcher - Optional matcher string (used by PostToolUse to filter by tool name).
 *                  When provided, the hook is placed in a config block with that matcher.
 */
function upsertHook(
  hooks: Record<string, ClaudeHookConfig[]>,
  eventName: string,
  command: string,
  matcher?: string,
): void {
  const targetMatcher = matcher ?? "";
  const newEntry: ClaudeHookEntry = {
    type: "command",
    command,
  };

  // If no configs exist for this event, create a fresh one
  if (!hooks[eventName] || !Array.isArray(hooks[eventName])) {
    hooks[eventName] = [{ matcher: targetMatcher, hooks: [newEntry] }];
    return;
  }

  const configs = hooks[eventName];

  // Find the config block with the matching matcher value
  const matchingConfig = configs.find((c) => c.matcher === targetMatcher);

  if (matchingConfig) {
    if (!matchingConfig.hooks || !Array.isArray(matchingConfig.hooks)) {
      matchingConfig.hooks = [newEntry];
      return;
    }

    // Look for an existing fuel-code hook in this config block
    const fuelCodeIdx = matchingConfig.hooks.findIndex(
      (h) => h.command && isFuelCodeHookCommand(h.command),
    );

    if (fuelCodeIdx !== -1) {
      // Replace existing fuel-code hook in-place
      matchingConfig.hooks[fuelCodeIdx] = newEntry;
    } else {
      // Append to existing config block
      matchingConfig.hooks.push(newEntry);
    }
    return;
  }

  // No config block with the target matcher — create a new one
  configs.push({ matcher: targetMatcher, hooks: [newEntry] });
}

/**
 * Remove fuel-code hook entries from a CC hook event slot.
 * Preserves non-fuel-code hooks. Removes empty config blocks.
 *
 * @param hooks - The hooks object from settings.json
 * @param eventName - CC hook event name (e.g., "SessionStart", "SessionEnd")
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
      (h) => !h.command || !isFuelCodeHookCommand(h.command),
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
 * Check if a fuel-code hook is installed for a given event name and optional matcher.
 *
 * @param hooks - The hooks object from settings.json
 * @param eventName - CC hook event name (e.g., "SessionStart", "PostToolUse")
 * @param matcher - Optional matcher to check for (e.g., "TeamCreate").
 *                  When provided, only config blocks with that exact matcher are checked.
 */
function hasHook(
  hooks: Record<string, ClaudeHookConfig[]>,
  eventName: string,
  matcher?: string,
): boolean {
  const configs = hooks[eventName];
  if (!Array.isArray(configs)) return false;

  const targetMatcher = matcher ?? "";

  return configs.some(
    (config) =>
      config.matcher === targetMatcher &&
      Array.isArray(config.hooks) &&
      config.hooks.some(
        (h) => h.command && isFuelCodeHookCommand(h.command),
      ),
  );
}
