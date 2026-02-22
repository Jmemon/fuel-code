#!/usr/bin/env bun

/**
 * fuel-code CLI entry point.
 *
 * This is the main executable for the fuel-code developer activity tracking CLI.
 * Uses Commander for argument parsing and subcommand routing.
 *
 * Available commands:
 *   init      — Initialize fuel-code on this device (Task 5)
 *   status    — Show device info, queue depth, connectivity (Task 5)
 *   emit      — Emit an event to the backend with local queue fallback (Task 10)
 *   queue     — Manage the local event queue (Task 12)
 *   hooks     — Install/manage git and Claude Code hooks (Task 13)
 *   transcript — Upload transcript for session post-processing (Task 8)
 *   backfill  — Historical session discovery and ingestion (Task 11)
 *
 * On interactive commands (sessions, status, hooks, backfill, etc.), the CLI
 * checks for pending prompts (e.g., git hook installation) before running
 * the user's command. Non-interactive commands (emit, transcript, queue)
 * skip prompt checking for speed.
 */

import { Command } from "commander";
import pino from "pino";
import { createInitCommand } from "./commands/init.js";
import { createStatusCommand } from "./commands/status.js";
import { createSessionsCommand } from "./commands/sessions.js";
import { createTimelineCommand } from "./commands/timeline.js";
import { createEmitCommand } from "./commands/emit.js";
import { createQueueCommand } from "./commands/queue.js";
import { createHooksCommand } from "./commands/hooks.js";
import { createCCHookCommand } from "./commands/cc-hook.js";
import { createTranscriptCommand } from "./commands/transcript.js";
import { createBackfillCommand } from "./commands/backfill.js";
import { createSessionDetailCommand } from "./commands/session-detail.js";
import { registerWorkspacesCommands } from "./commands/workspaces.js";
import { configExists, loadConfig } from "./lib/config.js";
import { checkPendingPrompts } from "./lib/prompt-checker.js";
import { showGitHooksPrompt } from "./lib/git-hooks-prompt.js";

// ---------------------------------------------------------------------------
// Logger — structured JSON logging for debugging and error tracking
// ---------------------------------------------------------------------------

/** CLI-wide logger instance. Logs to stderr so stdout stays clean for output. */
const logger = pino({
  name: "fuel-code",
  // Only log warnings and above by default; set LOG_LEVEL=debug for verbose output
  level: process.env.LOG_LEVEL ?? "warn",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino/file", options: { destination: 2 } } // stderr
      : undefined,
});

// ---------------------------------------------------------------------------
// Interactive command list — these commands show pending prompts
// ---------------------------------------------------------------------------

/**
 * Commands that are considered "interactive" — the user is actively using
 * the CLI and should be shown pending prompts (e.g., git hook installation).
 * Non-interactive commands (emit, transcript, queue) skip prompts for speed.
 */
const INTERACTIVE_COMMANDS = new Set([
  "sessions",
  "session",
  "timeline",
  "workspaces",
  "workspace",
  "status",
  "hooks",
  "backfill",
]);

// ---------------------------------------------------------------------------
// Program setup
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("fuel-code")
  .description("Developer activity tracking")
  .version("0.1.0");

// Register subcommands
program.addCommand(createInitCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionsCommand());
program.addCommand(createTimelineCommand());

// Register emit command (Task 10: emit events with local queue fallback)
program.addCommand(createEmitCommand());

// Register queue management command (Task 12: queue drainer)
program.addCommand(createQueueCommand());

// Register hooks command (Task 13: Claude Code hook installation and management)
program.addCommand(createHooksCommand());

// Register cc-hook command (internal: called by CC hooks in settings.json)
program.addCommand(createCCHookCommand());

// Register transcript command (Task 8: transcript upload for session post-processing)
program.addCommand(createTranscriptCommand());

// Register backfill command (Task 11: historical session discovery and ingestion)
program.addCommand(createBackfillCommand());

// Register session detail command (Task 5: session <id> with all flags)
program.addCommand(createSessionDetailCommand());

// Register workspace commands (Task 6: workspaces list + workspace detail)
registerWorkspacesCommands(program);

// Default action: launch TUI dashboard when no subcommand is given
program.action(async () => {
  const { launchTui } = await import("./tui/App.js");
  await launchTui();
});

// ---------------------------------------------------------------------------
// Prompt checking hook — runs before interactive commands
// ---------------------------------------------------------------------------

/**
 * Before parsing, install a hook that checks for pending prompts
 * on interactive commands. Uses Commander's hook() API to run
 * pre-action logic for every command.
 *
 * The prompt check:
 *   1. Only runs for interactive commands (status, hooks, backfill, etc.)
 *   2. Only runs if config exists (fuel-code has been initialized)
 *   3. Fails silently on any error (never blocks CLI usage)
 *   4. Has a 2-second timeout built into checkPendingPrompts
 */
program.hook("preAction", async (thisCommand) => {
  try {
    // Determine the actual command being run (could be a subcommand)
    const commandName = thisCommand.args?.[0] ?? thisCommand.name();

    if (!INTERACTIVE_COMMANDS.has(commandName)) return;
    if (!configExists()) return;

    const config = loadConfig();
    const prompts = await checkPendingPrompts(config);

    for (const prompt of prompts) {
      if (prompt.type === "git_hooks_install") {
        await showGitHooksPrompt(prompt, config);
      }
    }
  } catch {
    // Prompt checking should never block the CLI — silently swallow errors
  }
});

// ---------------------------------------------------------------------------
// Global error handling
// ---------------------------------------------------------------------------

/**
 * Catch unhandled rejections and uncaught exceptions.
 * Log the error with pino and exit with code 1.
 */
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled rejection");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Parse and execute
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err) => {
  logger.fatal({ err }, "CLI execution failed");
  process.exit(1);
});
