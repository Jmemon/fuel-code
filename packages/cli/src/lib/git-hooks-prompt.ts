/**
 * Git hooks installation prompt for fuel-code CLI.
 *
 * When the backend detects that a workspace could benefit from git hooks
 * (via session.start processing), this module handles the interactive
 * prompt to the user. The flow:
 *
 *   1. Check if hooks are already installed locally (auto-dismiss if so)
 *   2. Print a prompt to stderr asking the user
 *   3. Read Y/n response from stdin
 *   4. If accepted: install hooks, then dismiss prompt on backend
 *   5. If declined: dismiss prompt on backend without installing
 *
 * All output goes to stderr so it doesn't interfere with piped CLI output.
 */

import * as readline from "node:readline";
import type { FuelCodeConfig } from "./config.js";
import type { PendingPrompt } from "./prompt-checker.js";
import { dismissPrompt } from "./prompt-checker.js";
import { getGitHookStatus } from "./git-hook-status.js";
import { installGitHooks } from "./git-hook-installer.js";

/**
 * Show an interactive prompt asking the user to install git hooks for a workspace.
 *
 * If hooks are already installed locally (detected via getGitHookStatus),
 * auto-dismisses the prompt without asking the user. This handles the case
 * where hooks were installed via a different path (e.g., manual `fuel-code hooks install`).
 */
export async function showGitHooksPrompt(
  prompt: PendingPrompt,
  config: FuelCodeConfig,
): Promise<void> {
  // Check if git hooks are already installed locally — if so, auto-dismiss
  // without bothering the user. This handles race conditions where hooks
  // were installed between the session.start event and the CLI running.
  try {
    const status = await getGitHookStatus();
    if (status.installed) {
      await dismissPrompt(config, prompt.workspaceId, "accepted");
      return;
    }
  } catch {
    // If status check fails, proceed with the prompt anyway
  }

  // Print the prompt to stderr (so stdout stays clean for piped output)
  const displayName = prompt.workspaceName || prompt.workspaceCanonicalId;
  process.stderr.write(
    `\nInstall git tracking for "${displayName}"? This enables commit, push, merge, and checkout tracking. [Y/n] `,
  );

  // Read user response from stdin
  const answer = await readLineFromStdin();
  const accepted = answer.trim() === "" || answer.trim().toLowerCase().startsWith("y");

  if (accepted) {
    try {
      await installGitHooks();
      process.stderr.write("Git hooks installed successfully.\n\n");
      await dismissPrompt(config, prompt.workspaceId, "accepted");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to install git hooks: ${message}\n\n`);
      await dismissPrompt(config, prompt.workspaceId, "declined");
    }
  } else {
    process.stderr.write("Skipped git hook installation.\n\n");
    await dismissPrompt(config, prompt.workspaceId, "declined");
  }
}

/**
 * Read a single line from stdin using readline's question() method.
 *
 * Uses Node's readline interface for cross-platform compatibility.
 * Returns the line without the trailing newline.
 */
function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    // If stdin is not a TTY (piped input, CI, etc.), default to "no"
    // to avoid hanging forever waiting for input.
    if (!process.stdin.isTTY) {
      resolve("n");
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    // Use question() with empty prompt since we already printed the prompt.
    // This correctly reads a line and handles EOF (ctrl+D).
    rl.question("", (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}
