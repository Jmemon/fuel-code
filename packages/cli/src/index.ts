#!/usr/bin/env bun

/**
 * fuel-code CLI entry point.
 *
 * This is the main executable for the fuel-code developer activity tracking CLI.
 * Uses Commander for argument parsing and subcommand routing.
 *
 * Available commands:
 *   init    — Initialize fuel-code on this device (Task 5)
 *   status  — Show device info, queue depth, connectivity (Task 5)
 *   emit    — Emit an event to the backend with local queue fallback (Task 10)
 *
 * Future commands (registered by other tasks):
 *   queue   — Manage the local event queue (Task 12)
 *   hooks   — Install/manage git and Claude Code hooks (Task 13)
 */

import { Command } from "commander";
import pino from "pino";
import { createInitCommand } from "./commands/init.js";
import { createStatusCommand } from "./commands/status.js";
import { createEmitCommand } from "./commands/emit.js";
import { createQueueCommand } from "./commands/queue.js";
import { createHooksCommand } from "./commands/hooks.js";

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

// Register emit command (Task 10: emit events with local queue fallback)
program.addCommand(createEmitCommand());

// Register queue management command (Task 12: queue drainer)
program.addCommand(createQueueCommand());

// Register hooks command (Task 13: Claude Code hook installation and management)
program.addCommand(createHooksCommand());

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
