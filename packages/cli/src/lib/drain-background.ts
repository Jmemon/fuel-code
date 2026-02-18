/**
 * Background queue drainer for fuel-code.
 *
 * Spawns a detached background process to drain the local event queue.
 * Called by `fuel-code emit` after queuing an event, so delivery happens
 * asynchronously without blocking the hook.
 *
 * Key behaviors:
 *   - 1-second debounce: waits before draining to accumulate events from
 *     rapid-fire hooks (e.g., multiple git hooks in quick succession)
 *   - Lockfile-based concurrency control: prevents multiple drain processes
 *     from running simultaneously. Stale lockfiles (dead PIDs) are cleaned up.
 *   - Completely silent: stdout and stderr are redirected to /dev/null so the
 *     background process cannot produce output that confuses CC hooks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FuelCodeConfig } from "./config.js";
import { CONFIG_DIR } from "./config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lockfile path — prevents concurrent drain processes */
const LOCKFILE_PATH = path.join(CONFIG_DIR, ".drain.lock");

/** Debounce delay (ms) before starting the drain */
const DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a background process to drain the event queue.
 *
 * Uses Bun.spawn to fork a detached child that:
 *   1. Waits 1 second (debounce for rapid hook firing)
 *   2. Acquires the drain lockfile
 *   3. Runs drainQueue()
 *   4. Releases the lockfile and exits
 *
 * The child process is fully detached (unref'd) so the parent can exit
 * immediately. All I/O is redirected to /dev/null.
 *
 * @param config - CLI configuration (used to locate the queue and backend)
 */
export function spawnBackgroundDrain(config: FuelCodeConfig): void {
  try {
    // Spawn a new bun process that runs the drain entry point script
    // We use inline JS via -e to keep it self-contained
    const drainScript = buildDrainScript(config);

    const child = Bun.spawn(["bun", "-e", drainScript], {
      // Detach from parent — parent can exit without waiting
      stdio: ["ignore", "ignore", "ignore"],
      // Don't keep the parent alive waiting for this child
    });

    // Unref the child so the parent process can exit immediately
    child.unref();
  } catch {
    // Silently ignore spawn failures — the queue will be drained next time
  }
}

// ---------------------------------------------------------------------------
// Lockfile management (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Try to acquire the drain lockfile.
 *
 * Checks if a lockfile already exists:
 *   - If it contains a PID of a still-running process: returns false (locked)
 *   - If it contains a PID of a dead process (stale): removes it and proceeds
 *   - If no lockfile exists: creates one with the current PID
 *
 * @param lockfilePath - Path to the lockfile (overridable for tests)
 * @returns true if the lock was acquired, false if another drain is running
 */
export function acquireLock(lockfilePath: string = LOCKFILE_PATH): boolean {
  try {
    // Check for existing lockfile
    if (fs.existsSync(lockfilePath)) {
      const pidStr = fs.readFileSync(lockfilePath, "utf-8").trim();
      const pid = parseInt(pidStr, 10);

      if (!isNaN(pid) && isProcessRunning(pid)) {
        // Another drain process is actively running — skip this drain
        return false;
      }

      // Stale lockfile (process is dead) — remove it and continue
      fs.unlinkSync(lockfilePath);
    }

    // Create lockfile with current PID
    const dir = path.dirname(lockfilePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockfilePath, String(process.pid), "utf-8");
    return true;
  } catch {
    // If we can't manage the lockfile, skip draining to be safe
    return false;
  }
}

/**
 * Release the drain lockfile.
 *
 * @param lockfilePath - Path to the lockfile (overridable for tests)
 */
export function releaseLock(lockfilePath: string = LOCKFILE_PATH): void {
  try {
    fs.unlinkSync(lockfilePath);
  } catch {
    // Ignore — lockfile may already be gone
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check if a process with the given PID is still running.
 * Uses kill(pid, 0) which checks process existence without sending a signal.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the inline JavaScript that the background child process will execute.
 *
 * This script is passed to `bun -e` and runs completely independently of the
 * parent process. It:
 *   1. Sleeps 1 second (debounce)
 *   2. Acquires the lockfile
 *   3. Loads the drain module and runs drainQueue
 *   4. Releases the lockfile
 *
 * We embed the config as a JSON string to avoid needing to re-load from disk
 * (the child process may run after the user has changed directories).
 */
function buildDrainScript(config: FuelCodeConfig): string {
  const configJson = JSON.stringify(config);
  // Using template literal for the child script. The child process
  // dynamically imports the drain and drain-background modules.
  return `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(${DEBOUNCE_MS});

    const { acquireLock, releaseLock } = await import("${path.resolve(import.meta.dir, "drain-background.ts")}");
    const { drainQueue } = await import("${path.resolve(import.meta.dir, "drain.ts")}");

    const config = ${configJson};
    const lockPath = "${LOCKFILE_PATH.replace(/\\/g, "\\\\")}";

    if (!acquireLock(lockPath)) {
      process.exit(0);
    }

    try {
      await drainQueue(config);
    } finally {
      releaseLock(lockPath);
    }
  `;
}
