/**
 * Git hook installer for fuel-code.
 *
 * Handles installing fuel-code's git hook scripts either globally
 * (via core.hooksPath) or per-repo (into .git/hooks/). Supports:
 *   - Backup and restore of previous hooks and hooksPath config
 *   - Hook chaining: existing user hooks are renamed to <hook>.user
 *     and invoked by the fuel-code hook scripts
 *   - Detection of competing hook managers (Husky, Lefthook, pre-commit)
 *   - Idempotent installation (safe to run repeatedly)
 *
 * The actual hook scripts live in packages/hooks/git/ and are copied
 * to the target directory during installation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The 4 git hook names fuel-code installs */
export const GIT_HOOK_NAMES = [
  "post-commit",
  "post-checkout",
  "post-merge",
  "pre-push",
] as const;

/** Default global hooks directory: ~/.fuel-code/git-hooks/ */
const DEFAULT_HOOKS_DIR = path.join(os.homedir(), ".fuel-code", "git-hooks");

/** Directory for backup metadata: ~/.fuel-code/git-hooks-backup/ */
const DEFAULT_BACKUP_DIR = path.join(
  os.homedir(),
  ".fuel-code",
  "git-hooks-backup",
);

/** Known hook managers that may conflict with core.hooksPath */
const COMPETING_MANAGERS = [
  { name: "Husky", marker: ".husky" },
  { name: "Lefthook", marker: "lefthook.yml" },
  { name: "pre-commit", marker: ".pre-commit-config.yaml" },
] as const;

// ---------------------------------------------------------------------------
// Override support for testing
// ---------------------------------------------------------------------------

/**
 * Overrides for test isolation. When set, these paths replace the
 * real HOME-based defaults so tests never touch the real filesystem.
 */
let hooksDirOverride: string | undefined;
let backupDirOverride: string | undefined;
let gitConfigFileOverride: string | undefined;
let homeDirOverride: string | undefined;

/** Override the hooks install directory (for tests only) */
export function overrideHooksDir(p: string | undefined): void {
  hooksDirOverride = p;
}

/** Override the backup directory (for tests only) */
export function overrideBackupDir(p: string | undefined): void {
  backupDirOverride = p;
}

/** Override the git config file path (for tests only, used with --file) */
export function overrideGitConfigFile(p: string | undefined): void {
  gitConfigFileOverride = p;
}

/** Override the home directory (for tests only) */
export function overrideHomeDir(p: string | undefined): void {
  homeDirOverride = p;
}

/** Get the effective home directory (respects test override) */
function getHomeDir(): string {
  return homeDirOverride ?? os.homedir();
}

/** Get the active hooks directory (respects test override) */
function getHooksDir(): string {
  return hooksDirOverride ?? DEFAULT_HOOKS_DIR;
}

/** Get the active backup directory (respects test override) */
function getBackupDir(): string {
  return backupDirOverride ?? DEFAULT_BACKUP_DIR;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a git hook installation */
export interface GitHookInstallResult {
  /** Directory where hooks were installed */
  hooksDir: string;
  /** Previous core.hooksPath value, if any */
  previousHooksPath: string | null;
  /** Hook names that were backed up (had existing user hooks) */
  backedUp: string[];
  /** Hook names that were installed */
  installed: string[];
  /** Hook names that chain to a .user file */
  chained: string[];
}

/** Options for installGitHooks() */
export interface InstallGitHookOptions {
  /** Override competing hook manager warnings */
  force?: boolean;
  /** Override target hooks directory (for testing) */
  hooksDir?: string;
  /** Install into current repo's .git/hooks/ instead of global */
  perRepo?: boolean;
}

/** Backup metadata stored in meta.json */
export interface BackupMeta {
  previous_hooks_path: string | null;
  backup_timestamp: string;
  backed_up_hooks: string[];
}

// ---------------------------------------------------------------------------
// Core install function
// ---------------------------------------------------------------------------

/**
 * Install fuel-code git hooks.
 *
 * For global mode (default):
 *   1. Check prerequisites (git installed, ~/.fuel-code/ exists)
 *   2. Create hooks directory
 *   3. Detect existing core.hooksPath
 *   4. Detect competing hook managers — abort unless --force
 *   5. Backup existing hooks if core.hooksPath pointed elsewhere
 *   6. Copy hook scripts from packages/hooks/git/
 *   7. chmod +x all scripts
 *   8. Set git config --global core.hooksPath
 *
 * For per-repo mode (--per-repo):
 *   - Must be in a git repo
 *   - Installs into .git/hooks/
 *   - Does NOT set global core.hooksPath
 *   - Still backs up existing hooks as .user files
 */
export async function installGitHooks(
  options?: InstallGitHookOptions,
): Promise<GitHookInstallResult> {
  const force = options?.force ?? false;
  const perRepo = options?.perRepo ?? false;

  // -- Step 1: Check prerequisites --
  assertGitAvailable();
  assertFuelCodeInitialized();

  // -- Step 2: Determine target hooks directory --
  let targetDir: string;
  if (perRepo) {
    targetDir = resolvePerRepoHooksDir();
  } else {
    targetDir = options?.hooksDir ?? getHooksDir();
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // -- Step 3: Detect existing core.hooksPath (global mode only) --
  let previousHooksPath: string | null = null;
  if (!perRepo) {
    previousHooksPath = getGlobalHooksPath();
  }

  // -- Step 4: Detect competing hook managers (global mode only) --
  if (!perRepo && !force) {
    detectCompetingManagers();
  }

  // -- Step 5: Backup existing hooks --
  const backedUp: string[] = [];

  // If there was a previous hooksPath pointing elsewhere, back up those hooks
  if (
    !perRepo &&
    previousHooksPath &&
    path.resolve(previousHooksPath) !== path.resolve(targetDir)
  ) {
    const backed = backupExistingHooks(previousHooksPath, targetDir);
    backedUp.push(...backed);
  }

  // For per-repo mode, backup any existing hooks in .git/hooks/
  if (perRepo) {
    const backed = backupInPlaceHooks(targetDir);
    backedUp.push(...backed);
  }

  // -- Step 6: Write hook scripts --
  const installed = writeHookScripts(targetDir);

  // -- Step 7: chmod +x all scripts --
  for (const name of [...GIT_HOOK_NAMES, "resolve-workspace.sh"]) {
    const hookPath = path.join(targetDir, name);
    if (fs.existsSync(hookPath)) {
      fs.chmodSync(hookPath, 0o755);
    }
  }

  // -- Step 8: Set core.hooksPath (global mode only) --
  if (!perRepo) {
    setGlobalHooksPath(targetDir);
  }

  // Determine which hooks have .user chained files
  const chained: string[] = [];
  for (const name of GIT_HOOK_NAMES) {
    const userHook = path.join(targetDir, `${name}.user`);
    if (fs.existsSync(userHook)) {
      chained.push(name);
    }
  }

  // Save backup metadata if we backed up anything
  if (backedUp.length > 0 || (previousHooksPath && !perRepo)) {
    saveBackupMeta({
      previous_hooks_path: previousHooksPath,
      backup_timestamp: new Date().toISOString(),
      backed_up_hooks: backedUp,
    });
  }

  return {
    hooksDir: targetDir,
    previousHooksPath,
    backedUp,
    installed,
    chained,
  };
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

/**
 * Uninstall fuel-code git hooks.
 *
 * - Checks that core.hooksPath points to fuel-code's directory
 * - If --restore: restores the previous hooksPath from backup meta
 * - Removes the hooks directory
 * - Unsets core.hooksPath
 */
export async function uninstallGitHooks(options?: {
  restore?: boolean;
}): Promise<void> {
  const restore = options?.restore ?? false;
  const hooksDir = getHooksDir();
  const currentHooksPath = getGlobalHooksPath();

  // Only unset core.hooksPath if it points to our directory
  if (
    currentHooksPath &&
    path.resolve(currentHooksPath) === path.resolve(hooksDir)
  ) {
    if (restore) {
      // Try to restore from backup
      const meta = loadBackupMeta();
      if (meta && meta.previous_hooks_path) {
        setGlobalHooksPath(meta.previous_hooks_path);
      } else {
        unsetGlobalHooksPath();
      }
    } else {
      unsetGlobalHooksPath();
    }
  }

  // Remove the hooks directory
  if (fs.existsSync(hooksDir)) {
    fs.rmSync(hooksDir, { recursive: true, force: true });
  }

  // Clean up backup directory if restoring
  if (restore) {
    const backupDir = getBackupDir();
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Prerequisite checks
// ---------------------------------------------------------------------------

/**
 * Verify git is installed and available in PATH.
 * Throws with a clear message if not found.
 */
function assertGitAvailable(): void {
  try {
    execSync("git --version", { stdio: "pipe" });
  } catch {
    throw new Error(
      "git is not installed or not in PATH. Install git first.",
    );
  }
}

/**
 * Verify ~/.fuel-code/ directory exists (fuel-code has been initialized).
 * Throws with a clear message if not found.
 */
function assertFuelCodeInitialized(): void {
  const fuelCodeDir = path.join(getHomeDir(), ".fuel-code");
  if (!fs.existsSync(fuelCodeDir)) {
    throw new Error(
      `~/.fuel-code/ directory not found. Run 'fuel-code init' first.`,
    );
  }
}

/**
 * Detect competing hook managers (Husky, Lefthook, pre-commit) in the
 * current directory tree. Throws if any are found (unless --force).
 */
function detectCompetingManagers(): void {
  const cwd = process.cwd();

  for (const manager of COMPETING_MANAGERS) {
    const markerPath = path.join(cwd, manager.marker);
    if (fs.existsSync(markerPath)) {
      throw new Error(
        `Competing hook manager detected: ${manager.name} (found ${manager.marker}). ` +
          `Setting global core.hooksPath may conflict. Use --force to override.`,
      );
    }
  }
}

/**
 * Resolve the .git/hooks/ directory for the current repository.
 * Throws if not in a git repository.
 */
function resolvePerRepoHooksDir(): string {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    return path.resolve(gitDir, "hooks");
  } catch {
    throw new Error(
      "Not in a git repository. --per-repo requires being inside a git repo.",
    );
  }
}

// ---------------------------------------------------------------------------
// Git config helpers
// ---------------------------------------------------------------------------

/**
 * Get the current global core.hooksPath value, or null if not set.
 * Uses --file override if set (for testing).
 */
export function getGlobalHooksPath(): string | null {
  try {
    const args = gitConfigFileOverride
      ? `git config --file "${gitConfigFileOverride}" core.hooksPath`
      : "git config --global core.hooksPath";
    const result = execSync(args, {
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    return result || null;
  } catch {
    // Exit code 1 means the key is not set
    return null;
  }
}

/**
 * Set the global core.hooksPath to the given directory.
 * Uses --file override if set (for testing).
 */
function setGlobalHooksPath(dir: string): void {
  const args = gitConfigFileOverride
    ? `git config --file "${gitConfigFileOverride}" core.hooksPath "${dir}"`
    : `git config --global core.hooksPath "${dir}"`;
  execSync(args, { stdio: "pipe" });
}

/**
 * Unset the global core.hooksPath.
 * Uses --file override if set (for testing).
 */
function unsetGlobalHooksPath(): void {
  try {
    const args = gitConfigFileOverride
      ? `git config --file "${gitConfigFileOverride}" --unset core.hooksPath`
      : "git config --global --unset core.hooksPath";
    execSync(args, { stdio: "pipe" });
  } catch {
    // Key may not exist — that's fine
  }
}

// ---------------------------------------------------------------------------
// Hook script operations
// ---------------------------------------------------------------------------

/**
 * Resolve the source directory containing the git hook scripts
 * from packages/hooks/git/. Uses the same strategy as the existing
 * resolveHooksDir() in hooks.ts — navigates from this file's location.
 */
export function resolveSourceHooksDir(): string {
  // This file is at packages/cli/src/lib/git-hook-installer.ts
  // Navigate to packages/hooks/git/
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(thisDir, "..", "..", "..", "hooks", "git");
}

/**
 * Copy all hook scripts from packages/hooks/git/ to the target directory.
 * Returns the list of hook names that were installed.
 */
export function writeHookScripts(targetDir: string): string[] {
  const sourceDir = resolveSourceHooksDir();
  const installed: string[] = [];

  // Copy the 4 hook scripts
  for (const name of GIT_HOOK_NAMES) {
    const src = path.join(sourceDir, name);
    const dst = path.join(targetDir, name);

    if (!fs.existsSync(src)) {
      console.error(`Warning: source hook script not found: ${src}`);
      continue;
    }

    fs.copyFileSync(src, dst);
    installed.push(name);
  }

  // Copy resolve-workspace.sh (needed by all hooks)
  const resolverSrc = path.join(sourceDir, "resolve-workspace.sh");
  const resolverDst = path.join(targetDir, "resolve-workspace.sh");
  if (fs.existsSync(resolverSrc)) {
    fs.copyFileSync(resolverSrc, resolverDst);
  }

  return installed;
}

// ---------------------------------------------------------------------------
// Backup operations
// ---------------------------------------------------------------------------

/**
 * Backup existing hooks from a previous hooksPath directory.
 * Copies them to the target directory as <hook>.user files for chaining.
 * Returns the list of hook names that were backed up.
 */
export function backupExistingHooks(
  previousDir: string,
  targetDir: string,
): string[] {
  const backedUp: string[] = [];

  if (!fs.existsSync(previousDir)) {
    return backedUp;
  }

  for (const name of GIT_HOOK_NAMES) {
    const existing = path.join(previousDir, name);
    if (fs.existsSync(existing)) {
      // Copy to <hook>.user in the target directory for chaining
      const userHook = path.join(targetDir, `${name}.user`);
      fs.copyFileSync(existing, userHook);
      fs.chmodSync(userHook, 0o755);
      backedUp.push(name);
    }
  }

  return backedUp;
}

/**
 * Backup existing hooks in-place (for per-repo mode).
 * Renames existing hooks to <hook>.user if they exist and are not
 * already fuel-code hooks.
 * Returns the list of hook names that were backed up.
 */
function backupInPlaceHooks(targetDir: string): string[] {
  const backedUp: string[] = [];

  for (const name of GIT_HOOK_NAMES) {
    const hookPath = path.join(targetDir, name);
    if (!fs.existsSync(hookPath)) {
      continue;
    }

    // Check if this is already a fuel-code hook (idempotent install)
    const content = fs.readFileSync(hookPath, "utf-8");
    if (content.includes("fuel-code:")) {
      // Already our hook — skip backup
      continue;
    }

    // Rename to .user for chaining
    const userPath = path.join(targetDir, `${name}.user`);
    fs.renameSync(hookPath, userPath);
    fs.chmodSync(userPath, 0o755);
    backedUp.push(name);
  }

  return backedUp;
}

/**
 * Save backup metadata to meta.json.
 */
function saveBackupMeta(meta: BackupMeta): void {
  const backupDir = getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });
  const metaPath = path.join(backupDir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

/**
 * Load backup metadata from meta.json, or null if not found.
 */
export function loadBackupMeta(): BackupMeta | null {
  const backupDir = getBackupDir();
  const metaPath = path.join(backupDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as BackupMeta;
  } catch {
    return null;
  }
}
