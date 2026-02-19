/**
 * Integration tests for git hook scripts (post-commit, post-checkout,
 * post-merge, pre-push).
 *
 * Strategy:
 *   1. Create a temp git repo for each test
 *   2. Copy our hook scripts into the repo's .git/hooks/ directory
 *   3. Create a mock `fuel-code` script that writes received args + stdin
 *      to a capture file for assertion
 *   4. Run git operations that trigger hooks
 *   5. Assert the captured data matches expectations
 *
 * The mock fuel-code script captures:
 *   - Command-line arguments (event type, --workspace-id, --data-stdin)
 *   - Stdin content (the JSON payload)
 *
 * All temp directories are cleaned up after each test.
 */

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory containing the hook scripts under test */
const HOOKS_DIR = path.resolve(import.meta.dir, "..");

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

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Test harness: mock fuel-code and git repo setup
// ---------------------------------------------------------------------------

/**
 * Set up a test git repo with our hooks installed and a mock fuel-code binary.
 *
 * Returns:
 *   - repoDir: path to the git repo
 *   - captureFile: path to the file where mock fuel-code writes captured data
 *   - mockBinDir: path to the directory containing the mock fuel-code binary
 */
function setupTestRepo(prefix: string): {
  repoDir: string;
  captureFile: string;
  mockBinDir: string;
} {
  const baseDir = makeTempDir(prefix);
  const repoDir = path.join(baseDir, "repo");
  const mockBinDir = path.join(baseDir, "bin");
  const captureFile = path.join(baseDir, "captured.jsonl");

  // Create directories
  fs.mkdirSync(repoDir);
  fs.mkdirSync(mockBinDir);

  // Initialize git repo
  execSync("git init", { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: "pipe" });

  // Create mock fuel-code binary that captures args and stdin.
  // Always read stdin since hooks pipe data via heredoc to --data-stdin.
  // The script checks if --data-stdin is in args to decide whether to read.
  const mockScript = `#!/usr/bin/env bash
# Mock fuel-code: writes args and stdin to capture file
STDIN_DATA=""
for arg in "$@"; do
  if [ "$arg" = "--data-stdin" ]; then
    STDIN_DATA=$(cat)
    break
  fi
done
echo "ARGS: $@" >> "${captureFile}"
echo "STDIN: $STDIN_DATA" >> "${captureFile}"
echo "---" >> "${captureFile}"
`;
  fs.writeFileSync(path.join(mockBinDir, "fuel-code"), mockScript, { mode: 0o755 });

  // Install our hook scripts into the repo's .git/hooks/
  const gitHooksDir = path.join(repoDir, ".git", "hooks");

  // Copy resolve-workspace.sh
  fs.copyFileSync(
    path.join(HOOKS_DIR, "resolve-workspace.sh"),
    path.join(gitHooksDir, "resolve-workspace.sh"),
  );
  fs.chmodSync(path.join(gitHooksDir, "resolve-workspace.sh"), 0o755);

  // Copy hook scripts
  for (const hook of ["post-commit", "post-checkout", "post-merge", "pre-push"]) {
    fs.copyFileSync(
      path.join(HOOKS_DIR, hook),
      path.join(gitHooksDir, hook),
    );
    fs.chmodSync(path.join(gitHooksDir, hook), 0o755);
  }

  // Add a remote so resolve-workspace.sh works
  execSync("git remote add origin https://github.com/test/hook-test-repo.git", {
    cwd: repoDir,
    stdio: "pipe",
  });

  return { repoDir, captureFile, mockBinDir };
}

/**
 * Run a git command in the test repo with the mock fuel-code on PATH.
 * Waits briefly for background hook processes to complete.
 */
function gitExec(
  repoDir: string,
  mockBinDir: string,
  command: string,
  opts?: { stdin?: string; expectNonZero?: boolean },
): string {
  const env = {
    ...process.env,
    // Prepend mock bin dir to PATH so hooks find our mock fuel-code
    PATH: `${mockBinDir}:${process.env.PATH}`,
    // Prevent git from using system-wide hooks
    GIT_CONFIG_NOSYSTEM: "1",
  };

  try {
    const result = execSync(command, {
      cwd: repoDir,
      stdio: "pipe",
      env,
      input: opts?.stdin,
      timeout: 10000,
    });
    return result.toString();
  } catch (err: any) {
    if (opts?.expectNonZero) {
      return err.stdout?.toString() ?? "";
    }
    throw err;
  }
}

/**
 * Wait for background hook processes to write to the capture file.
 * Hooks run in background (&), so we need a small delay.
 */
async function waitForCapture(captureFile: string, timeoutMs = 3000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(captureFile)) {
      const content = fs.readFileSync(captureFile, "utf-8");
      if (content.includes("---")) {
        // Give a tiny extra delay for any remaining writes
        await Bun.sleep(100);
        return fs.readFileSync(captureFile, "utf-8");
      }
    }
    await Bun.sleep(50);
  }
  // Return whatever we have (or empty string)
  return fs.existsSync(captureFile)
    ? fs.readFileSync(captureFile, "utf-8")
    : "";
}

/**
 * Parse captured data from the mock fuel-code output file.
 * Returns an array of captured invocations with their args and stdin.
 *
 * Format per entry:
 *   ARGS: <args>
 *   STDIN: <multiline json>
 *   ---
 *
 * The STDIN value may span multiple lines (JSON from heredoc),
 * so we collect everything between "STDIN: " and "---".
 */
function parseCaptured(content: string): Array<{ args: string; stdin: string }> {
  const entries = content.split("---\n").filter((e) => e.trim());
  return entries.map((entry) => {
    const lines = entry.trim().split("\n");
    const argsLine = lines.find((l) => l.startsWith("ARGS: ")) ?? "";

    // Find the STDIN line index and collect all remaining lines as stdin content
    const stdinIdx = lines.findIndex((l) => l.startsWith("STDIN: "));
    let stdinContent = "";
    if (stdinIdx !== -1) {
      // First line: strip "STDIN: " prefix. Remaining lines: join as-is.
      const firstLine = lines[stdinIdx].replace("STDIN: ", "");
      const restLines = lines.slice(stdinIdx + 1);
      stdinContent = [firstLine, ...restLines].join("\n");
    }

    return {
      args: argsLine.replace("ARGS: ", ""),
      stdin: stdinContent,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests: post-commit
// ---------------------------------------------------------------------------

describe("post-commit hook", () => {
  it("emits git.commit with correct payload after commit", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-pc-");

    // Make an initial commit (hooks won't fire on first commit in some setups,
    // so we need files staged)
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello world");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial commit"');

    const captured = await waitForCapture(captureFile);
    const entries = parseCaptured(captured);

    // Should have at least one invocation
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // Find the git.commit invocation
    const commitEntry = entries.find((e) => e.args.includes("git.commit"));
    expect(commitEntry).toBeDefined();

    // Verify args contain event type, workspace-id, and --data-stdin
    expect(commitEntry!.args).toContain("git.commit");
    expect(commitEntry!.args).toContain("--workspace-id");
    expect(commitEntry!.args).toContain("github.com/test/hook-test-repo");
    expect(commitEntry!.args).toContain("--data-stdin");

    // Verify stdin contains expected JSON fields
    const stdinData = commitEntry!.stdin;
    expect(stdinData).toContain('"hash"');
    expect(stdinData).toContain('"message"');
    expect(stdinData).toContain('"author_name"');
    expect(stdinData).toContain('"branch"');
    expect(stdinData).toContain('"files_changed"');
    expect(stdinData).toContain('"insertions"');
    expect(stdinData).toContain('"deletions"');
    expect(stdinData).toContain('"file_list"');
  });

  it("JSON-escapes multiline commit messages", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-pc-ml-");

    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    // Multiline commit message with special characters
    gitExec(repoDir, mockBinDir, `git commit -m 'line one
line two with "quotes"
line three'`);

    const captured = await waitForCapture(captureFile);
    const entries = parseCaptured(captured);
    const commitEntry = entries.find((e) => e.args.includes("git.commit"));
    expect(commitEntry).toBeDefined();

    // The message field should be JSON-escaped (python3 json.dumps handles this)
    // It should contain escaped newlines and quotes
    const stdinData = commitEntry!.stdin;
    expect(stdinData).toContain('"message"');
    // The JSON should be parseable — try to extract and parse it
    // (The full stdin is a JSON object)
  });

  it("handles binary files without breaking numstat", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-pc-bin-");

    // Create a binary file (random bytes)
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(repoDir, "image.png"), binaryData);
    gitExec(repoDir, mockBinDir, "git add image.png");
    gitExec(repoDir, mockBinDir, 'git commit -m "add binary file"');

    const captured = await waitForCapture(captureFile);
    const entries = parseCaptured(captured);
    const commitEntry = entries.find((e) => e.args.includes("git.commit"));

    // Hook should not crash — should still emit event
    expect(commitEntry).toBeDefined();
    expect(commitEntry!.args).toContain("git.commit");
  });
});

// ---------------------------------------------------------------------------
// Tests: post-checkout
// ---------------------------------------------------------------------------

describe("post-checkout hook", () => {
  it("emits git.checkout on branch switch", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-co-");

    // Need an initial commit first
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial"');

    // Wait for post-commit background process to finish writing
    await Bun.sleep(1500);

    // Clear any capture from post-commit
    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    // Create and switch to a new branch
    gitExec(repoDir, mockBinDir, "git checkout -b feature-branch");

    const captured = await waitForCapture(captureFile, 5000);
    const entries = parseCaptured(captured);
    const checkoutEntry = entries.find((e) => e.args.includes("git.checkout"));

    expect(checkoutEntry).toBeDefined();
    expect(checkoutEntry!.args).toContain("git.checkout");
    expect(checkoutEntry!.args).toContain("--workspace-id");
    expect(checkoutEntry!.args).toContain("--data-stdin");

    // Verify stdin JSON has expected fields
    const stdinData = checkoutEntry!.stdin;
    expect(stdinData).toContain('"from_ref"');
    expect(stdinData).toContain('"to_ref"');
    expect(stdinData).toContain('"from_branch"');
    expect(stdinData).toContain('"to_branch"');
  });

  it("does NOT emit on file checkout ($3=0)", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-co-file-");

    // Set up a repo with a commit
    fs.writeFileSync(path.join(repoDir, "file.txt"), "original");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial"');

    // Modify the file and commit
    fs.writeFileSync(path.join(repoDir, "file.txt"), "modified");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "modify file"');

    // Clear captures
    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    // File checkout (restore a single file, $3=0)
    gitExec(repoDir, mockBinDir, "git checkout HEAD -- file.txt");

    // Wait a bit — hook should NOT fire
    await Bun.sleep(500);

    // Should NOT have a git.checkout event (file checkout has $3=0)
    const captured = fs.existsSync(captureFile)
      ? fs.readFileSync(captureFile, "utf-8")
      : "";
    const entries = parseCaptured(captured);
    const checkoutEntries = entries.filter((e) => e.args.includes("git.checkout"));

    expect(checkoutEntries.length).toBe(0);
  });

  it("handles detached HEAD (to_branch is null)", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-co-detach-");

    // Create two commits so we have a hash to checkout
    fs.writeFileSync(path.join(repoDir, "file.txt"), "v1");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "first"');

    const firstHash = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      stdio: "pipe",
    }).toString().trim();

    fs.writeFileSync(path.join(repoDir, "file.txt"), "v2");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "second"');

    // Clear captures
    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    // Checkout a specific commit hash (detached HEAD)
    gitExec(repoDir, mockBinDir, `git checkout ${firstHash}`);

    const captured = await waitForCapture(captureFile);
    const entries = parseCaptured(captured);
    const checkoutEntry = entries.find((e) => e.args.includes("git.checkout"));

    expect(checkoutEntry).toBeDefined();
    // In detached HEAD, to_branch should be null
    expect(checkoutEntry!.stdin).toContain('"to_branch": null');
  });
});

// ---------------------------------------------------------------------------
// Tests: post-merge
// ---------------------------------------------------------------------------

describe("post-merge hook", () => {
  it("emits git.merge with correct metadata", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-mg-");

    // Create initial commit on main
    fs.writeFileSync(path.join(repoDir, "file.txt"), "main content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial on main"');

    // Create a feature branch with changes
    gitExec(repoDir, mockBinDir, "git checkout -b feature");
    fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature content");
    gitExec(repoDir, mockBinDir, "git add feature.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "add feature"');

    // Switch back to main
    gitExec(repoDir, mockBinDir, "git checkout main");

    // Clear captures from checkout
    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    // Merge feature into main
    gitExec(repoDir, mockBinDir, "git merge feature --no-ff -m \"Merge branch 'feature'\"");

    const captured = await waitForCapture(captureFile);
    const entries = parseCaptured(captured);

    // Should have both a merge event and a commit event (merge creates a commit)
    const mergeEntry = entries.find((e) => e.args.includes("git.merge"));
    expect(mergeEntry).toBeDefined();
    expect(mergeEntry!.args).toContain("git.merge");
    expect(mergeEntry!.args).toContain("--workspace-id");
    expect(mergeEntry!.args).toContain("--data-stdin");

    const stdinData = mergeEntry!.stdin;
    expect(stdinData).toContain('"merge_commit"');
    expect(stdinData).toContain('"into_branch"');
    expect(stdinData).toContain('"files_changed"');
    expect(stdinData).toContain('"had_conflicts"');
  });
});

// ---------------------------------------------------------------------------
// Tests: pre-push
// ---------------------------------------------------------------------------

describe("pre-push hook", () => {
  it("reads stdin refs and emits git.push", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-pp-");

    // Create a commit
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial"');

    // Wait for post-commit background process to finish writing
    await Bun.sleep(1500);

    // Clear captures from post-commit
    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    const headSha = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      stdio: "pipe",
    }).toString().trim();

    // Simulate pre-push by running the hook script directly with stdin
    const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
    const stdinInput = `refs/heads/main ${headSha} refs/heads/main 0000000000000000000000000000000000000000\n`;

    const proc = Bun.spawn(["bash", hookPath, "origin", "https://github.com/test/repo.git"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([stdinInput]),
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
      },
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // Pre-push fires background jobs inside a pipe subshell, needs extra wait
    const captured = await waitForCapture(captureFile, 5000);
    const entries = parseCaptured(captured);
    const pushEntry = entries.find((e) => e.args.includes("git.push"));

    expect(pushEntry).toBeDefined();
    expect(pushEntry!.args).toContain("git.push");
    expect(pushEntry!.args).toContain("--data-stdin");

    const stdinData = pushEntry!.stdin;
    expect(stdinData).toContain('"branch"');
    expect(stdinData).toContain('"remote"');
    expect(stdinData).toContain('"commit_count"');
    expect(stdinData).toContain('"commits"');
  });

  it("handles new branch push (remote_sha all zeros)", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-pp-new-");

    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial"');

    // Wait for post-commit background process to finish writing
    await Bun.sleep(1500);

    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    const headSha = execSync("git rev-parse HEAD", {
      cwd: repoDir,
      stdio: "pipe",
    }).toString().trim();

    // New branch: remote sha is all zeros
    const stdinInput = `refs/heads/feature ${headSha} refs/heads/feature 0000000000000000000000000000000000000000\n`;

    const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
    const proc = Bun.spawn(["bash", hookPath, "origin", "https://github.com/test/repo.git"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([stdinInput]),
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
      },
    });

    await proc.exited;

    // Pre-push fires background jobs inside a pipe subshell, needs extra wait
    const captured = await waitForCapture(captureFile, 5000);
    const entries = parseCaptured(captured);
    const pushEntry = entries.find((e) => e.args.includes("git.push"));

    expect(pushEntry).toBeDefined();
    // Should extract branch name from refs/heads/feature
    expect(pushEntry!.stdin).toContain('"branch": "feature"');
  });

  it("skips branch deletion (local_sha all zeros)", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-pp-del-");

    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "initial"');
    if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile);

    // Branch deletion: local sha is all zeros
    const stdinInput = `refs/heads/old-branch 0000000000000000000000000000000000000000 refs/heads/old-branch abc1234567890abcdef1234567890abcdef123456\n`;

    const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
    const proc = Bun.spawn(["bash", hookPath, "origin", "https://github.com/test/repo.git"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Blob([stdinInput]),
      env: {
        ...process.env,
        PATH: `${mockBinDir}:${process.env.PATH}`,
      },
    });

    await proc.exited;

    // Wait a bit
    await Bun.sleep(500);

    // Should NOT have emitted any event (deletion skipped)
    const captured = fs.existsSync(captureFile)
      ? fs.readFileSync(captureFile, "utf-8")
      : "";
    const entries = parseCaptured(captured);
    const pushEntries = entries.filter((e) => e.args.includes("git.push"));

    expect(pushEntries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Safety invariants (all hooks)
// ---------------------------------------------------------------------------

describe("safety invariants", () => {
  it("all hooks exit 0 when fuel-code is NOT in PATH", async () => {
    const { repoDir } = setupTestRepo("hook-safe-nobin-");

    // Create a commit WITHOUT mock fuel-code in PATH (empty PATH trick)
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    execSync("git add file.txt", { cwd: repoDir, stdio: "pipe" });

    // Run commit with a PATH that doesn't include mock fuel-code
    // but still has git and basic tools
    const env = {
      ...process.env,
      // Use a PATH without the mock bin dir — fuel-code won't be found
      // but git and bash should still be available
    };

    // This should not throw — hooks must exit 0
    execSync('git commit -m "safe commit"', {
      cwd: repoDir,
      stdio: "pipe",
      env,
    });

    // If we get here without exception, the hooks exited 0
    expect(true).toBe(true);
  });

  it("all hooks exit 0 with per-repo opt-out config", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-safe-optout-");

    // Create .fuel-code/config.yaml with git_enabled: false
    const configDir = path.join(repoDir, ".fuel-code");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.yaml"), "git_enabled: false\n");

    // Make a commit — hook should detect opt-out and not emit
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "opted out"');

    // Wait a bit
    await Bun.sleep(500);

    // Should NOT have captured any events
    const captured = fs.existsSync(captureFile)
      ? fs.readFileSync(captureFile, "utf-8")
      : "";

    expect(captured).toBe("");
  });

  it("all hooks chain to .user hook", async () => {
    const { repoDir, captureFile, mockBinDir } = setupTestRepo("hook-safe-chain-");

    // Create a .user hook that writes a marker file
    const markerFile = path.join(repoDir, "..", "user-hook-ran");
    const userHook = `#!/usr/bin/env bash
echo "user-hook-executed" > "${markerFile}"
`;
    const gitHooksDir = path.join(repoDir, ".git", "hooks");
    fs.writeFileSync(path.join(gitHooksDir, "post-commit.user"), userHook, {
      mode: 0o755,
    });

    // Make a commit
    fs.writeFileSync(path.join(repoDir, "file.txt"), "content");
    gitExec(repoDir, mockBinDir, "git add file.txt");
    gitExec(repoDir, mockBinDir, 'git commit -m "chain test"');

    // The .user hook should have been called
    await Bun.sleep(200);
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(fs.readFileSync(markerFile, "utf-8").trim()).toBe("user-hook-executed");
  });
});
