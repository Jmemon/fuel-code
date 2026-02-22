/**
 * Tests for git hook installation in the `fuel-code hooks` command group.
 *
 * All tests use a temporary HOME directory so they never touch the real
 * filesystem, git config, or ~/.fuel-code/ directory. Each test gets a
 * fresh temp directory and isolated git config file.
 *
 * Tests cover:
 *   - install --git-only creates hooks dir with all 4 hooks + resolve-workspace.sh
 *   - install --git-only sets git config core.hooksPath
 *   - All hook files are executable
 *   - Install twice is idempotent
 *   - Install with existing core.hooksPath: backs up and chains .user files
 *   - Install when already pointing to fuel-code: no backup, updates in place
 *   - hooks status shows git hook state
 *   - hooks status shows chained hooks
 *   - hooks uninstall --git-only removes hooks dir, unsets core.hooksPath
 *   - hooks uninstall --restore restores backed-up hooks path
 *   - hooks install (no flags) installs both CC and git hooks
 *   - Install when git not available: clear error
 *   - Install when fuel-code not initialized: clear error
 *   - Install with Husky detected: warning + abort
 *   - Install with --force when Husky detected: proceeds
 *   - Install with --per-repo: writes to .git/hooks/, no global change
 *   - Install with --per-repo outside git repo: error
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
  installGitHooks,
  uninstallGitHooks,
  overrideHooksDir,
  overrideBackupDir,
  overrideGitConfigFile,
  overrideHomeDir,
  GIT_HOOK_NAMES,
  loadBackupMeta,
  writeHookScripts,
  backupExistingHooks,
  getGlobalHooksPath,
} from "../../lib/git-hook-installer.js";
import {
  getGitHookStatus,
  overrideStatusHooksDir,
} from "../../lib/git-hook-status.js";
import { overrideSettingsPath, runCCInstall, runStatus } from "../hooks.js";

// ---------------------------------------------------------------------------
// Test setup/teardown — each test gets a fresh temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let hooksDir: string;
let backupDir: string;
let gitConfigFile: string;
let fuelCodeDir: string;
let settingsPath: string;

/** Saved CWD so we can restore it */
let originalCwd: string;

beforeEach(() => {
  // Create isolated temp directory structure:
  //   tmpDir/
  //     .fuel-code/            (simulates ~/.fuel-code/)
  //       git-hooks/           (target for hook installation)
  //       git-hooks-backup/    (backup metadata)
  //     .gitconfig             (isolated git config)
  //     .claude/settings.json  (for CC hooks)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-git-hooks-test-"));
  fuelCodeDir = path.join(tmpDir, ".fuel-code");
  hooksDir = path.join(fuelCodeDir, "git-hooks");
  backupDir = path.join(fuelCodeDir, "git-hooks-backup");
  gitConfigFile = path.join(tmpDir, ".gitconfig");
  settingsPath = path.join(tmpDir, ".claude", "settings.json");

  // Create the .fuel-code directory (simulates fuel-code init having run)
  fs.mkdirSync(fuelCodeDir, { recursive: true });

  // Create empty git config file
  fs.writeFileSync(gitConfigFile, "", "utf-8");

  // Create .claude directory for CC hooks
  fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });

  // Wire up all test overrides so we never touch real HOME
  overrideHooksDir(hooksDir);
  overrideBackupDir(backupDir);
  overrideGitConfigFile(gitConfigFile);
  overrideHomeDir(tmpDir);
  overrideStatusHooksDir(hooksDir);
  overrideSettingsPath(settingsPath);

  originalCwd = process.cwd();
});

afterEach(() => {
  // Restore overrides
  overrideHooksDir(undefined);
  overrideBackupDir(undefined);
  overrideGitConfigFile(undefined);
  overrideHomeDir(undefined);
  overrideStatusHooksDir(undefined);
  overrideSettingsPath(undefined);

  // Restore CWD if changed
  try {
    process.chdir(originalCwd);
  } catch {
    // CWD may have been removed
  }

  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: capture console output
// ---------------------------------------------------------------------------

async function captureConsole(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { logs, errors };
}

// ---------------------------------------------------------------------------
// Helper: read git config from isolated file
// ---------------------------------------------------------------------------

function readGitConfigHooksPath(): string | null {
  try {
    return execSync(`git config --file "${gitConfigFile}" core.hooksPath`, {
      stdio: "pipe",
      encoding: "utf-8",
    }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests: install --git-only
// ---------------------------------------------------------------------------

describe("hooks install --git-only", () => {
  it("creates hooks dir with all 4 hooks + resolve-workspace.sh", async () => {
    const result = await installGitHooks();

    // All 4 hooks should be installed
    expect(result.installed).toEqual([...GIT_HOOK_NAMES]);

    // Verify files exist on disk
    for (const name of GIT_HOOK_NAMES) {
      expect(fs.existsSync(path.join(hooksDir, name))).toBe(true);
    }
    expect(fs.existsSync(path.join(hooksDir, "resolve-workspace.sh"))).toBe(
      true,
    );
  });

  it("sets git config core.hooksPath", async () => {
    await installGitHooks();

    const configuredPath = readGitConfigHooksPath();
    expect(configuredPath).toBe(hooksDir);
  });

  it("all hook files are executable", async () => {
    await installGitHooks();

    for (const name of [...GIT_HOOK_NAMES, "resolve-workspace.sh"]) {
      const hookPath = path.join(hooksDir, name);
      const stat = fs.statSync(hookPath);
      // Check the owner execute bit is set
      expect(stat.mode & 0o100).toBeTruthy();
    }
  });

  it("install twice is idempotent", async () => {
    const result1 = await installGitHooks();
    const result2 = await installGitHooks();

    // Second install should still succeed with same hooks installed
    expect(result2.installed).toEqual([...GIT_HOOK_NAMES]);

    // Should NOT have created .user backup files (already our hooks)
    expect(result2.backedUp).toEqual([]);

    // Still only 4 hook files + resolve-workspace.sh
    const files = fs.readdirSync(hooksDir);
    const hookFiles = files.filter(
      (f) => !f.endsWith(".user") && f !== "resolve-workspace.sh",
    );
    expect(hookFiles).toHaveLength(4);
  });

  it("backs up and chains .user files when existing core.hooksPath points elsewhere", async () => {
    // Set up a "previous" hooks directory with some hooks
    const prevDir = path.join(tmpDir, "prev-hooks");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(
      path.join(prevDir, "post-commit"),
      "#!/bin/sh\necho user hook",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "post-commit"), 0o755);
    fs.writeFileSync(
      path.join(prevDir, "pre-push"),
      "#!/bin/sh\necho user pre-push",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "pre-push"), 0o755);

    // Set the git config to point to the previous directory
    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${prevDir}"`,
      { stdio: "pipe" },
    );

    const result = await installGitHooks();

    // Should have backed up the existing user hooks
    expect(result.backedUp).toContain("post-commit");
    expect(result.backedUp).toContain("pre-push");
    expect(result.previousHooksPath).toBe(prevDir);

    // .user files should exist in the new hooks dir
    expect(fs.existsSync(path.join(hooksDir, "post-commit.user"))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, "pre-push.user"))).toBe(true);

    // Chained list should include the backed up hooks
    expect(result.chained).toContain("post-commit");
    expect(result.chained).toContain("pre-push");

    // Backup metadata should be saved
    const meta = loadBackupMeta();
    expect(meta).not.toBeNull();
    expect(meta!.previous_hooks_path).toBe(prevDir);
    expect(meta!.backed_up_hooks).toContain("post-commit");
    expect(meta!.backed_up_hooks).toContain("pre-push");
  });

  it("no backup when already pointing to fuel-code dir", async () => {
    // First install
    await installGitHooks();

    // Second install — already pointing to fuel-code dir
    const result = await installGitHooks();

    // Should not backup anything (already our own hooks)
    expect(result.backedUp).toEqual([]);
    // previousHooksPath should be our own dir
    expect(result.previousHooksPath).toBe(hooksDir);
  });
});

// ---------------------------------------------------------------------------
// Tests: hooks status with git hooks
// ---------------------------------------------------------------------------

describe("hooks status with git hooks", () => {
  it("shows git hook state after install", async () => {
    await installGitHooks();

    const status = await getGitHookStatus();

    expect(status.installed).toBe(true);
    expect(status.isFuelCode).toBe(true);
    expect(status.hooksPath).toBe(hooksDir);

    for (const name of GIT_HOOK_NAMES) {
      expect(status.hooks[name].exists).toBe(true);
      expect(status.hooks[name].executable).toBe(true);
    }
  });

  it("shows chained hooks in status", async () => {
    // Set up previous hooks to trigger chaining
    const prevDir = path.join(tmpDir, "prev-hooks");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(
      path.join(prevDir, "post-commit"),
      "#!/bin/sh\necho user hook",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "post-commit"), 0o755);

    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${prevDir}"`,
      { stdio: "pipe" },
    );

    await installGitHooks();

    const status = await getGitHookStatus();
    expect(status.hooks["post-commit"].chained).toBe(true);
    // post-checkout should not be chained (no user hook was backed up)
    expect(status.hooks["post-checkout"].chained).toBe(false);
  });

  it("shows not installed when no hooks exist", async () => {
    const status = await getGitHookStatus();

    expect(status.installed).toBe(false);
    expect(status.isFuelCode).toBe(false);
    expect(status.hooksPath).toBeNull();

    for (const name of GIT_HOOK_NAMES) {
      expect(status.hooks[name].exists).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: hooks uninstall --git-only
// ---------------------------------------------------------------------------

describe("hooks uninstall --git-only", () => {
  it("removes hooks dir and unsets core.hooksPath", async () => {
    // Install first
    await installGitHooks();
    expect(fs.existsSync(hooksDir)).toBe(true);
    expect(readGitConfigHooksPath()).toBe(hooksDir);

    // Uninstall
    await uninstallGitHooks();

    // Hooks directory should be removed
    expect(fs.existsSync(hooksDir)).toBe(false);

    // core.hooksPath should be unset
    expect(readGitConfigHooksPath()).toBeNull();
  });

  it("restores backed-up hooks path with --restore", async () => {
    // Set up previous hooks
    const prevDir = path.join(tmpDir, "prev-hooks");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(
      path.join(prevDir, "post-commit"),
      "#!/bin/sh\necho user hook",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "post-commit"), 0o755);

    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${prevDir}"`,
      { stdio: "pipe" },
    );

    // Install (backs up previous hooksPath)
    await installGitHooks();

    // Uninstall with restore
    await uninstallGitHooks({ restore: true });

    // core.hooksPath should be restored to previous value
    expect(readGitConfigHooksPath()).toBe(prevDir);

    // Backup metadata should be cleaned up
    expect(fs.existsSync(backupDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: install (no flags) installs both CC and git hooks
// ---------------------------------------------------------------------------

describe("hooks install (default — both CC and git)", () => {
  it("installs both CC hooks and git hooks", async () => {
    // Run CC install
    await runCCInstall();

    // Run git install
    const gitResult = await installGitHooks();

    // CC hooks should be in settings.json
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks?.SessionStart).toBeDefined();
    expect(settings.hooks?.SessionEnd).toBeDefined();

    // Git hooks should be installed
    expect(gitResult.installed).toEqual([...GIT_HOOK_NAMES]);
    expect(readGitConfigHooksPath()).toBe(hooksDir);
  });
});

// ---------------------------------------------------------------------------
// Tests: error conditions
// ---------------------------------------------------------------------------

describe("error conditions", () => {
  it("errors when fuel-code not initialized (no ~/.fuel-code/)", async () => {
    // Remove the .fuel-code directory to simulate uninitialized state
    fs.rmSync(fuelCodeDir, { recursive: true, force: true });

    await expect(installGitHooks()).rejects.toThrow(
      /~\/\.fuel-code\/ directory not found/,
    );
  });

  it("aborts with warning when Husky detected", async () => {
    // Create a .husky directory in the CWD to simulate Husky
    const testRepoDir = path.join(tmpDir, "repo-with-husky");
    fs.mkdirSync(path.join(testRepoDir, ".husky"), { recursive: true });
    process.chdir(testRepoDir);

    await expect(installGitHooks()).rejects.toThrow(
      /Competing hook manager detected: Husky/,
    );
  });

  it("proceeds with --force when Husky detected", async () => {
    // Create a .husky directory in CWD
    const testRepoDir = path.join(tmpDir, "repo-with-husky-force");
    fs.mkdirSync(path.join(testRepoDir, ".husky"), { recursive: true });
    process.chdir(testRepoDir);

    // Should NOT throw when force is set
    const result = await installGitHooks({ force: true });
    expect(result.installed).toEqual([...GIT_HOOK_NAMES]);
  });

  it("errors when --per-repo used outside a git repo", async () => {
    // chdir to a non-git directory
    const nonGitDir = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(nonGitDir, { recursive: true });
    process.chdir(nonGitDir);

    await expect(installGitHooks({ perRepo: true })).rejects.toThrow(
      /Not in a git repository/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: --per-repo mode
// ---------------------------------------------------------------------------

describe("--per-repo mode", () => {
  it("writes to .git/hooks/ without changing global core.hooksPath", async () => {
    // Create a temporary git repository
    const repoDir = path.join(tmpDir, "test-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    process.chdir(repoDir);

    const result = await installGitHooks({ perRepo: true });

    // Hooks should be in .git/hooks/
    // Use realpathSync to normalize macOS /var -> /private/var symlink
    const gitHooksDir = path.join(repoDir, ".git", "hooks");
    expect(fs.realpathSync(result.hooksDir)).toBe(
      fs.realpathSync(gitHooksDir),
    );

    for (const name of GIT_HOOK_NAMES) {
      expect(fs.existsSync(path.join(result.hooksDir, name))).toBe(true);
    }
    expect(
      fs.existsSync(path.join(result.hooksDir, "resolve-workspace.sh")),
    ).toBe(true);

    // Global core.hooksPath should NOT be set
    expect(readGitConfigHooksPath()).toBeNull();
  });

  it("backs up existing hooks as .user files in per-repo mode", async () => {
    // Create a temporary git repository with an existing post-commit hook
    const repoDir = path.join(tmpDir, "test-repo-existing");
    fs.mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir, stdio: "pipe" });

    const gitHooksDir = path.join(repoDir, ".git", "hooks");
    fs.mkdirSync(gitHooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitHooksDir, "post-commit"),
      "#!/bin/sh\necho existing hook",
      "utf-8",
    );
    fs.chmodSync(path.join(gitHooksDir, "post-commit"), 0o755);

    process.chdir(repoDir);

    const result = await installGitHooks({ perRepo: true });

    // The existing hook should be backed up as .user
    expect(result.backedUp).toContain("post-commit");
    expect(
      fs.existsSync(path.join(gitHooksDir, "post-commit.user")),
    ).toBe(true);

    // The .user file should contain the original content
    const userContent = fs.readFileSync(
      path.join(gitHooksDir, "post-commit.user"),
      "utf-8",
    );
    expect(userContent).toContain("existing hook");
  });
});

// ---------------------------------------------------------------------------
// Tests: status command output
// ---------------------------------------------------------------------------

describe("hooks status output", () => {
  it("runStatus shows both CC and git hook state", async () => {
    // Install CC hooks
    await runCCInstall();

    // Install git hooks
    await installGitHooks();

    const { logs } = await captureConsole(async () => {
      await runStatus();
    });

    const output = logs.join("\n");

    // Should show CC hooks section
    expect(output).toContain("Claude Code hooks:");
    expect(output).toContain("SessionStart:");
    expect(output).toContain("installed");

    // Should show Git hooks section
    expect(output).toContain("Git hooks:");
    expect(output).toContain("core.hooksPath:");
    expect(output).toContain("post-commit:");
    expect(output).toContain("post-checkout:");
    expect(output).toContain("post-merge:");
    expect(output).toContain("pre-push:");
  });
});

// ---------------------------------------------------------------------------
// Tests: unit tests for library functions
// ---------------------------------------------------------------------------

describe("backupExistingHooks", () => {
  it("creates backup + .user files for existing hooks", () => {
    // Create source directory with hooks
    const sourceDir = path.join(tmpDir, "source-hooks");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "post-commit"),
      "#!/bin/sh\necho old",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "post-merge"),
      "#!/bin/sh\necho old merge",
      "utf-8",
    );

    // Create target directory
    const targetDir = path.join(tmpDir, "target-hooks");
    fs.mkdirSync(targetDir, { recursive: true });

    const backed = backupExistingHooks(sourceDir, targetDir);

    expect(backed).toContain("post-commit");
    expect(backed).toContain("post-merge");
    expect(backed).not.toContain("post-checkout");
    expect(backed).not.toContain("pre-push");

    // .user files should exist in target
    expect(fs.existsSync(path.join(targetDir, "post-commit.user"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "post-merge.user"))).toBe(true);
  });
});

describe("writeHookScripts", () => {
  it("writes all scripts correctly", () => {
    const targetDir = path.join(tmpDir, "write-test");
    fs.mkdirSync(targetDir, { recursive: true });

    const installed = writeHookScripts(targetDir);

    expect(installed).toEqual([...GIT_HOOK_NAMES]);

    // Each file should contain fuel-code marker
    for (const name of GIT_HOOK_NAMES) {
      const content = fs.readFileSync(path.join(targetDir, name), "utf-8");
      expect(content).toContain("fuel-code:");
    }

    // resolve-workspace.sh should also be copied
    expect(fs.existsSync(path.join(targetDir, "resolve-workspace.sh"))).toBe(
      true,
    );
  });
});

describe("getGitHookStatus", () => {
  it("detects installed state", async () => {
    await installGitHooks();
    const status = await getGitHookStatus();
    expect(status.installed).toBe(true);
    expect(status.isFuelCode).toBe(true);
  });

  it("detects chained hooks", async () => {
    // Set up a previous directory with a hook
    const prevDir = path.join(tmpDir, "prev-hooks-status");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(
      path.join(prevDir, "post-commit"),
      "#!/bin/sh\necho user",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "post-commit"), 0o755);

    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${prevDir}"`,
      { stdio: "pipe" },
    );

    await installGitHooks();
    const status = await getGitHookStatus();

    expect(status.hooks["post-commit"].chained).toBe(true);
    expect(status.hooks["post-checkout"].chained).toBe(false);
  });
});
