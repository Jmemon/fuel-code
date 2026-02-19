/**
 * Unit tests for git-hook-installer.ts library functions.
 *
 * Tests the core backup, write, and status functions in isolation
 * using temporary directories. Each test gets a fresh temp directory
 * that is cleaned up after the test completes.
 *
 * Covers:
 *   - backupExistingHooks() creates backup + meta.json in timestamped dir
 *   - writeHookScripts() writes all scripts correctly
 *   - getGitHookStatus() detects installed state
 *   - getGitHookStatus() detects chained hooks
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
  backupExistingHooks,
  writeHookScripts,
  installGitHooks,
  loadBackupMeta,
  overrideHooksDir,
  overrideBackupDir,
  overrideGitConfigFile,
  overrideHomeDir,
  GIT_HOOK_NAMES,
} from "../git-hook-installer.js";
import {
  getGitHookStatus,
  overrideStatusHooksDir,
} from "../git-hook-status.js";

// ---------------------------------------------------------------------------
// Test setup/teardown — each test gets a fresh temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let hooksDir: string;
let backupDir: string;
let gitConfigFile: string;
let fuelCodeDir: string;

beforeEach(() => {
  // Create isolated temp directory structure:
  //   tmpDir/
  //     .fuel-code/            (simulates ~/.fuel-code/)
  //       git-hooks/           (target for hook installation)
  //       git-hooks-backup/    (backup metadata)
  //     .gitconfig             (isolated git config)
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fuel-code-installer-unit-test-"),
  );
  fuelCodeDir = path.join(tmpDir, ".fuel-code");
  hooksDir = path.join(fuelCodeDir, "git-hooks");
  backupDir = path.join(fuelCodeDir, "git-hooks-backup");
  gitConfigFile = path.join(tmpDir, ".gitconfig");

  // Create the .fuel-code directory (simulates fuel-code init having run)
  fs.mkdirSync(fuelCodeDir, { recursive: true });

  // Create empty git config file
  fs.writeFileSync(gitConfigFile, "", "utf-8");

  // Wire up all test overrides so we never touch real HOME
  overrideHooksDir(hooksDir);
  overrideBackupDir(backupDir);
  overrideGitConfigFile(gitConfigFile);
  overrideHomeDir(tmpDir);
  overrideStatusHooksDir(hooksDir);
});

afterEach(() => {
  // Restore overrides
  overrideHooksDir(undefined);
  overrideBackupDir(undefined);
  overrideGitConfigFile(undefined);
  overrideHomeDir(undefined);
  overrideStatusHooksDir(undefined);

  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: backupExistingHooks — timestamped backup directory
// ---------------------------------------------------------------------------

describe("backupExistingHooks", () => {
  it("creates backup + meta.json in timestamped dir", async () => {
    // Create a source directory with some existing hook scripts
    const sourceDir = path.join(tmpDir, "prev-hooks");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "post-commit"),
      "#!/bin/sh\necho old post-commit",
      "utf-8",
    );
    fs.chmodSync(path.join(sourceDir, "post-commit"), 0o755);
    fs.writeFileSync(
      path.join(sourceDir, "pre-push"),
      "#!/bin/sh\necho old pre-push",
      "utf-8",
    );
    fs.chmodSync(path.join(sourceDir, "pre-push"), 0o755);

    // Create target directory for chained .user files
    const targetDir = path.join(tmpDir, "target-hooks");
    fs.mkdirSync(targetDir, { recursive: true });

    // Set up git config to point to the previous hooks dir
    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${sourceDir}"`,
      { stdio: "pipe" },
    );

    // Run the full install which triggers backupExistingHooks + saveBackupMeta
    const result = await installGitHooks();

    // Verify the backup dir contains a timestamped subdirectory
    expect(fs.existsSync(backupDir)).toBe(true);
    const entries = fs.readdirSync(backupDir);
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // The timestamped subdirectory should contain meta.json
    const snapshotDir = path.join(backupDir, entries[0]);
    const stat = fs.statSync(snapshotDir);
    expect(stat.isDirectory()).toBe(true);

    const metaPath = path.join(snapshotDir, "meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);

    // meta.json should contain the correct backup info
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.previous_hooks_path).toBe(sourceDir);
    expect(meta.backed_up_hooks).toContain("post-commit");
    expect(meta.backed_up_hooks).toContain("pre-push");
    expect(meta.backup_timestamp).toBeDefined();

    // The actual hook files should also be copied into the snapshot dir
    expect(fs.existsSync(path.join(snapshotDir, "post-commit"))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, "pre-push"))).toBe(true);

    // Verify the original content is preserved in the backup
    const backedUpContent = fs.readFileSync(
      path.join(snapshotDir, "post-commit"),
      "utf-8",
    );
    expect(backedUpContent).toContain("echo old post-commit");
  });

  it("copies hooks as .user files into target dir for chaining", () => {
    // Create source with one hook
    const sourceDir = path.join(tmpDir, "src-hooks");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "post-merge"),
      "#!/bin/sh\necho merge hook",
      "utf-8",
    );

    // Create target
    const targetDir = path.join(tmpDir, "tgt-hooks");
    fs.mkdirSync(targetDir, { recursive: true });

    const backed = backupExistingHooks(sourceDir, targetDir);

    // Should have backed up post-merge
    expect(backed).toContain("post-merge");
    expect(backed).not.toContain("post-commit");

    // .user file should exist in target with original content
    const userPath = path.join(targetDir, "post-merge.user");
    expect(fs.existsSync(userPath)).toBe(true);
    const content = fs.readFileSync(userPath, "utf-8");
    expect(content).toContain("echo merge hook");
  });

  it("returns empty array when previous dir does not exist", () => {
    const targetDir = path.join(tmpDir, "tgt-hooks-2");
    fs.mkdirSync(targetDir, { recursive: true });

    const backed = backupExistingHooks("/nonexistent/dir", targetDir);
    expect(backed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: writeHookScripts — writes all scripts correctly
// ---------------------------------------------------------------------------

describe("writeHookScripts", () => {
  it("writes all 4 hook scripts correctly", () => {
    const targetDir = path.join(tmpDir, "write-hooks-test");
    fs.mkdirSync(targetDir, { recursive: true });

    const installed = writeHookScripts(targetDir);

    // All 4 hook names should be returned
    expect(installed).toEqual([...GIT_HOOK_NAMES]);

    // Each hook file should exist on disk
    for (const name of GIT_HOOK_NAMES) {
      const hookPath = path.join(targetDir, name);
      expect(fs.existsSync(hookPath)).toBe(true);
    }
  });

  it("each hook file contains fuel-code marker", () => {
    const targetDir = path.join(tmpDir, "write-hooks-marker");
    fs.mkdirSync(targetDir, { recursive: true });

    writeHookScripts(targetDir);

    // Each file should contain the fuel-code: marker for idempotency checks
    for (const name of GIT_HOOK_NAMES) {
      const content = fs.readFileSync(path.join(targetDir, name), "utf-8");
      expect(content).toContain("fuel-code:");
    }
  });

  it("copies resolve-workspace.sh alongside hook scripts", () => {
    const targetDir = path.join(tmpDir, "write-hooks-resolver");
    fs.mkdirSync(targetDir, { recursive: true });

    writeHookScripts(targetDir);

    expect(fs.existsSync(path.join(targetDir, "resolve-workspace.sh"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: getGitHookStatus — detects installed state
// ---------------------------------------------------------------------------

describe("getGitHookStatus", () => {
  it("detects installed state after installGitHooks", async () => {
    // Perform a full install
    await installGitHooks();

    const status = await getGitHookStatus();

    expect(status.installed).toBe(true);
    expect(status.isFuelCode).toBe(true);
    expect(status.hooksPath).toBe(hooksDir);

    // All 4 hooks should show as existing and executable
    for (const name of GIT_HOOK_NAMES) {
      expect(status.hooks[name].exists).toBe(true);
      expect(status.hooks[name].executable).toBe(true);
    }
  });

  it("reports not installed when no hooks exist", async () => {
    // Do not install anything — status should report not installed
    const status = await getGitHookStatus();

    expect(status.installed).toBe(false);
    expect(status.isFuelCode).toBe(false);
    expect(status.hooksPath).toBeNull();

    for (const name of GIT_HOOK_NAMES) {
      expect(status.hooks[name].exists).toBe(false);
    }
  });

  it("detects chained hooks when .user files are present", async () => {
    // Set up a previous hooks directory with one hook
    const prevDir = path.join(tmpDir, "prev-for-chaining");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(
      path.join(prevDir, "post-commit"),
      "#!/bin/sh\necho chained",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "post-commit"), 0o755);

    // Point git config to the previous dir so install will back it up
    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${prevDir}"`,
      { stdio: "pipe" },
    );

    await installGitHooks();
    const status = await getGitHookStatus();

    // post-commit should be chained (had a .user file)
    expect(status.hooks["post-commit"].chained).toBe(true);

    // Others should not be chained (no .user files for them)
    expect(status.hooks["post-checkout"].chained).toBe(false);
    expect(status.hooks["post-merge"].chained).toBe(false);
    expect(status.hooks["pre-push"].chained).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: loadBackupMeta — reads from timestamped subdirectory
// ---------------------------------------------------------------------------

describe("loadBackupMeta", () => {
  it("returns null when no backups exist", () => {
    const meta = loadBackupMeta();
    expect(meta).toBeNull();
  });

  it("loads meta from the most recent timestamped backup", async () => {
    // Set up previous hooks and install to create a backup
    const prevDir = path.join(tmpDir, "prev-for-meta");
    fs.mkdirSync(prevDir, { recursive: true });
    fs.writeFileSync(
      path.join(prevDir, "post-commit"),
      "#!/bin/sh\necho meta test",
      "utf-8",
    );
    fs.chmodSync(path.join(prevDir, "post-commit"), 0o755);

    execSync(
      `git config --file "${gitConfigFile}" core.hooksPath "${prevDir}"`,
      { stdio: "pipe" },
    );

    await installGitHooks();

    // loadBackupMeta should find the meta.json in the timestamped subdir
    const meta = loadBackupMeta();
    expect(meta).not.toBeNull();
    expect(meta!.previous_hooks_path).toBe(prevDir);
    expect(meta!.backed_up_hooks).toContain("post-commit");
    expect(meta!.backup_timestamp).toBeDefined();
  });
});
