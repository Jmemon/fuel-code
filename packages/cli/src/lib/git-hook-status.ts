/**
 * Git hook status checker for fuel-code.
 *
 * Inspects the current state of git hook installation:
 *   - Whether core.hooksPath is set and points to fuel-code's directory
 *   - Which individual hook scripts exist and are executable
 *   - Which hooks have chained .user files
 *
 * Used by `fuel-code hooks status` to display git hook state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  GIT_HOOK_NAMES,
  getGlobalHooksPath,
} from "./git-hook-installer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-hook status info */
export interface HookFileStatus {
  /** Whether the hook script file exists */
  exists: boolean;
  /** Whether a .user chained file exists alongside it */
  chained: boolean;
  /** Whether the hook file has the executable bit set */
  executable: boolean;
}

/** Overall git hook installation status */
export interface GitHookStatus {
  /** Whether fuel-code git hooks appear to be installed */
  installed: boolean;
  /** Current core.hooksPath value, or null if not set */
  hooksPath: string | null;
  /** Whether core.hooksPath points to fuel-code's git-hooks directory */
  isFuelCode: boolean;
  /** Per-hook status for each of the 4 tracked hooks */
  hooks: Record<string, HookFileStatus>;
}

// ---------------------------------------------------------------------------
// Default hooks directory (mirrors git-hook-installer.ts)
// ---------------------------------------------------------------------------

const DEFAULT_HOOKS_DIR = path.join(os.homedir(), ".fuel-code", "git-hooks");

/** Override for testing — allows pointing to a temp directory */
let hooksDirOverride: string | undefined;

export function overrideStatusHooksDir(p: string | undefined): void {
  hooksDirOverride = p;
}

function getHooksDir(): string {
  return hooksDirOverride ?? DEFAULT_HOOKS_DIR;
}

// ---------------------------------------------------------------------------
// Status function
// ---------------------------------------------------------------------------

/**
 * Get the current git hook installation status.
 *
 * Checks core.hooksPath, then inspects the hooks directory for
 * the presence and executability of each hook script, and whether
 * .user chain files exist.
 */
export async function getGitHookStatus(): Promise<GitHookStatus> {
  const hooksDir = getHooksDir();
  const hooksPath = getGlobalHooksPath();

  // Check if core.hooksPath points to our directory
  const isFuelCode =
    hooksPath !== null &&
    path.resolve(hooksPath) === path.resolve(hooksDir);

  // Determine which directory to inspect:
  // If hooksPath is set and points to fuel-code dir, use that.
  // Otherwise, check our default directory.
  const inspectDir = isFuelCode && hooksPath ? hooksPath : hooksDir;

  // Build per-hook status
  const hooks: Record<string, HookFileStatus> = {};

  for (const name of GIT_HOOK_NAMES) {
    const hookPath = path.join(inspectDir, name);
    const userPath = path.join(inspectDir, `${name}.user`);

    let exists = false;
    let executable = false;
    let chained = false;

    if (fs.existsSync(hookPath)) {
      exists = true;
      try {
        fs.accessSync(hookPath, fs.constants.X_OK);
        executable = true;
      } catch {
        executable = false;
      }
    }

    if (fs.existsSync(userPath)) {
      chained = true;
    }

    hooks[name] = { exists, chained, executable };
  }

  // Consider hooks "installed" if at least one hook file exists
  // and core.hooksPath points to our directory (or for per-repo checks,
  // just check existence)
  const anyHookExists = Object.values(hooks).some((h) => h.exists);
  const installed = isFuelCode && anyHookExists;

  return {
    installed,
    hooksPath,
    isFuelCode,
    hooks,
  };
}
