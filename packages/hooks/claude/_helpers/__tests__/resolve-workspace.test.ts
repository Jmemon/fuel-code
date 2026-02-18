/**
 * Tests for the resolve-workspace utility.
 *
 * Tests workspace resolution logic across different git scenarios:
 *   - Normal git repos with remotes
 *   - Non-git directories (workspace = _unassociated)
 *   - Repos with no remote (workspace = local:<hash>)
 *
 * Uses the actual CWD (which is a git repo at /Users/johnmemon/Desktop/fuel-code)
 * and creates temp directories for non-git scenarios.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { resolveWorkspace } from "../resolve-workspace.js";

// ---------------------------------------------------------------------------
// Track temp directories for cleanup
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/**
 * Create a temp directory and track it for cleanup.
 */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveWorkspace", () => {
  it("resolves workspace from git remote in the actual repo CWD", async () => {
    // The fuel-code repo at /Users/johnmemon/Desktop/fuel-code has a git remote
    const result = await resolveWorkspace(
      "/Users/johnmemon/Desktop/fuel-code",
    );

    // Should have a workspace ID derived from the git remote
    expect(result.workspaceId).not.toBe("_unassociated");
    // Should not be a local: hash since the repo has a remote
    expect(result.workspaceId).not.toMatch(/^local:/);
    // Should have a git branch
    expect(result.gitBranch).toBeTruthy();
    // Should have a git remote
    expect(result.gitRemote).toBeTruthy();
  });

  it("returns _unassociated for non-git directories", async () => {
    const tmpDir = makeTempDir("fuel-code-no-git-");

    const result = await resolveWorkspace(tmpDir);

    expect(result.workspaceId).toBe("_unassociated");
    expect(result.gitBranch).toBeNull();
    expect(result.gitRemote).toBeNull();
  });

  it("returns local:<hash> for git repos with no remote", async () => {
    const tmpDir = makeTempDir("fuel-code-no-remote-");

    // Create a git repo with no remote
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync("git commit -m 'initial'", { cwd: tmpDir, stdio: "pipe" });

    const result = await resolveWorkspace(tmpDir);

    // Should be a local: hash
    expect(result.workspaceId).toMatch(/^local:[a-f0-9]{64}$/);
    // Should have a branch but no remote
    expect(result.gitBranch).toBeTruthy();
    expect(result.gitRemote).toBeNull();
  });

  it("prefers origin remote over other remotes", async () => {
    const tmpDir = makeTempDir("fuel-code-multi-remote-");

    // Create a git repo with multiple remotes
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync("git commit -m 'initial'", { cwd: tmpDir, stdio: "pipe" });

    // Add remotes — "alpha" comes first alphabetically, but "origin" should be preferred
    execSync(
      "git remote add alpha https://github.com/test/alpha-repo.git",
      { cwd: tmpDir, stdio: "pipe" },
    );
    execSync(
      "git remote add origin https://github.com/test/origin-repo.git",
      { cwd: tmpDir, stdio: "pipe" },
    );

    const result = await resolveWorkspace(tmpDir);

    // Should use origin, not alpha
    expect(result.workspaceId).toContain("origin-repo");
    expect(result.gitRemote).toContain("origin-repo");
  });

  it("falls back to first alphabetical remote when no origin exists", async () => {
    const tmpDir = makeTempDir("fuel-code-no-origin-");

    // Create a git repo with a remote that is NOT named "origin"
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", {
      cwd: tmpDir,
      stdio: "pipe",
    });
    execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "hello");
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync("git commit -m 'initial'", { cwd: tmpDir, stdio: "pipe" });

    execSync(
      "git remote add zebra https://github.com/test/zebra-repo.git",
      { cwd: tmpDir, stdio: "pipe" },
    );
    execSync(
      "git remote add beta https://github.com/test/beta-repo.git",
      { cwd: tmpDir, stdio: "pipe" },
    );

    const result = await resolveWorkspace(tmpDir);

    // Should use "beta" (first alphabetically)
    expect(result.workspaceId).toContain("beta-repo");
  });
});
