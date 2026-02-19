/**
 * Tests for resolve-workspace.sh — the bash script that resolves workspace
 * canonical ID from git repo state.
 *
 * Uses Bun.spawn to execute the script in temporary git repos with various
 * configurations (SSH remotes, HTTPS remotes, no remotes, empty repos, etc.).
 *
 * Each test creates a fresh temp directory and cleans up after itself.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute path to the resolve-workspace.sh script under test */
const SCRIPT_PATH = path.resolve(
  import.meta.dir,
  "..",
  "resolve-workspace.sh",
);

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

/** Create a tracked temp directory */
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Helper: run resolve-workspace.sh in a given directory
// ---------------------------------------------------------------------------

/**
 * Execute resolve-workspace.sh in the specified cwd and return stdout + exit code.
 * Uses Bun.spawn for subprocess execution.
 */
async function runScript(cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", SCRIPT_PATH], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Ensure PATH_PART variable doesn't collide with system PATH
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), exitCode };
}

/**
 * Create a git repo with an initial commit in a temp directory.
 * Returns the directory path.
 */
function initGitRepo(prefix: string): string {
  const dir = makeTempDir(prefix);
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "file.txt"), "hello");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: dir, stdio: "pipe" });
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolve-workspace.sh", () => {
  // --- SSH remote normalization ---

  it("normalizes SSH remote (git@github.com:user/repo.git)", async () => {
    const dir = initGitRepo("rw-ssh-");
    execSync("git remote add origin git@github.com:user/repo.git", {
      cwd: dir,
      stdio: "pipe",
    });

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("github.com/user/repo");
  });

  it("normalizes GitLab SSH remote", async () => {
    const dir = initGitRepo("rw-gitlab-ssh-");
    execSync("git remote add origin git@gitlab.com:org/subgroup/project.git", {
      cwd: dir,
      stdio: "pipe",
    });

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("gitlab.com/org/subgroup/project");
  });

  // --- HTTPS remote normalization ---

  it("normalizes HTTPS remote (https://github.com/user/repo.git)", async () => {
    const dir = initGitRepo("rw-https-");
    execSync("git remote add origin https://github.com/user/repo.git", {
      cwd: dir,
      stdio: "pipe",
    });

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("github.com/user/repo");
  });

  it("normalizes HTTPS remote without .git suffix", async () => {
    const dir = initGitRepo("rw-https-no-git-");
    execSync("git remote add origin https://github.com/user/repo", {
      cwd: dir,
      stdio: "pipe",
    });

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    // Same result with or without .git suffix
    expect(stdout).toBe("github.com/user/repo");
  });

  // --- No remote, has commits -> local:<hash> ---

  it("returns local:<sha256> for repo with no remote but commits", async () => {
    const dir = initGitRepo("rw-no-remote-");

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    // Should match "local:" followed by a 64-char hex string (sha256)
    expect(stdout).toMatch(/^local:[a-f0-9]{64}$/);
  });

  it("produces deterministic local: hash for same repo", async () => {
    const dir = initGitRepo("rw-determ-");

    const result1 = await runScript(dir);
    const result2 = await runScript(dir);

    expect(result1.stdout).toBe(result2.stdout);
  });

  // --- Empty repo (no commits) -> exit 1 ---

  it("exits 1 for empty git repo (no commits)", async () => {
    const dir = makeTempDir("rw-empty-repo-");
    execSync("git init", { cwd: dir, stdio: "pipe" });

    const { exitCode } = await runScript(dir);

    expect(exitCode).toBe(1);
  });

  // --- Not a git repo -> exit 1 ---

  it("exits 1 for non-git directory", async () => {
    const dir = makeTempDir("rw-not-git-");

    const { exitCode } = await runScript(dir);

    expect(exitCode).toBe(1);
  });

  // --- First remote fallback ---

  it("falls back to first remote alphabetically when origin missing", async () => {
    const dir = initGitRepo("rw-fallback-");
    // Add "zebra" and "alpha" remotes — "alpha" should be chosen
    execSync("git remote add zebra https://github.com/test/zebra-repo.git", {
      cwd: dir,
      stdio: "pipe",
    });
    execSync("git remote add alpha https://github.com/test/alpha-repo.git", {
      cwd: dir,
      stdio: "pipe",
    });

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("github.com/test/alpha-repo");
  });

  it("prefers origin over other remotes", async () => {
    const dir = initGitRepo("rw-origin-pref-");
    execSync("git remote add alpha https://github.com/test/alpha-repo.git", {
      cwd: dir,
      stdio: "pipe",
    });
    execSync("git remote add origin https://github.com/test/origin-repo.git", {
      cwd: dir,
      stdio: "pipe",
    });

    const { stdout, exitCode } = await runScript(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("github.com/test/origin-repo");
  });
});
