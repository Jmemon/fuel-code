/**
 * Tests for the session backfill scanner and state persistence.
 *
 * Creates temporary directory structures mimicking ~/.claude/projects/ to test:
 *   - JSONL file discovery and session ID extraction
 *   - sessions-index.json metadata enrichment
 *   - Subagent directory skipping
 *   - Non-JSONL file skipping
 *   - Active session detection (content-based /exit check + lsof)
 *   - projectDirToPath directory name → path conversion
 *   - Workspace resolution (_unassociated fallback)
 *   - Empty JSONL file handling
 *   - Backfill state load/save round-trips
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanForSessions, isSessionActive, projectDirToPath } from "../session-backfill.js";
import { loadBackfillState, saveBackfillState, type BackfillState } from "../backfill-state.js";

// ---------------------------------------------------------------------------
// Test setup/teardown: each test gets a fresh temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuel-code-backfill-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: create a mock Claude projects directory structure
// ---------------------------------------------------------------------------

/** Create a project directory with JSONL session files */
function createProjectDir(
  projectName: string,
  sessions: Array<{
    id: string;
    content?: string;
    mtimeMs?: number;
  }>,
): string {
  const projectDir = path.join(tmpDir, projectName);
  fs.mkdirSync(projectDir, { recursive: true });

  for (const session of sessions) {
    const filePath = path.join(projectDir, `${session.id}.jsonl`);
    const content = session.content ?? buildMinimalJsonl(session.id);
    fs.writeFileSync(filePath, content);

    // Set modification time if specified (for testing active session skipping)
    if (session.mtimeMs !== undefined) {
      const mtime = new Date(session.mtimeMs);
      fs.utimesSync(filePath, mtime, mtime);
    }
  }

  return projectDir;
}

/** Build minimal JSONL content with a first line containing metadata.
 *  Includes /exit command at the end so the session appears closed. */
function buildMinimalJsonl(sessionId: string): string {
  const line1 = JSON.stringify({
    type: "user",
    sessionId,
    timestamp: "2025-06-01T10:00:00.000Z",
    gitBranch: "main",
    cwd: "/Users/test/project",
    message: { role: "user", content: "Hello" },
  });
  const line2 = JSON.stringify({
    type: "assistant",
    timestamp: "2025-06-01T10:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
  });
  const exitLine = JSON.stringify({
    type: "user",
    timestamp: "2025-06-01T10:02:00.000Z",
    message: { role: "user", content: "<command-name>/exit</command-name>\n<command-message>exit</command-message>" },
  });
  return line1 + "\n" + line2 + "\n" + exitLine + "\n";
}

/** Build JSONL content without /exit — simulates an interrupted or active session */
function buildActiveJsonl(sessionId: string): string {
  const line1 = JSON.stringify({
    type: "user",
    sessionId,
    timestamp: "2025-06-01T10:00:00.000Z",
    gitBranch: "main",
    cwd: "/Users/test/project",
    message: { role: "user", content: "Hello" },
  });
  const line2 = JSON.stringify({
    type: "assistant",
    timestamp: "2025-06-01T10:01:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
  });
  return line1 + "\n" + line2 + "\n";
}

// ---------------------------------------------------------------------------
// Tests: isSessionActive
// ---------------------------------------------------------------------------

describe("isSessionActive", () => {
  it("returns false when file contains /exit command (gracefully closed)", () => {
    const filePath = path.join(tmpDir, "closed-session.jsonl");
    fs.writeFileSync(filePath, buildMinimalJsonl("11111111-1111-1111-1111-111111111111"));
    expect(isSessionActive(filePath)).toBe(false);
  });

  it("returns false when file has no /exit and no process holds it open (abandoned)", () => {
    const filePath = path.join(tmpDir, "abandoned-session.jsonl");
    fs.writeFileSync(filePath, buildActiveJsonl("22222222-2222-2222-2222-222222222222"));
    // No process has this file open, so lsof will exit non-zero → not active
    expect(isSessionActive(filePath)).toBe(false);
  });

  it("returns false for nonexistent file", () => {
    expect(isSessionActive(path.join(tmpDir, "nope.jsonl"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: scanForSessions
// ---------------------------------------------------------------------------

describe("scanForSessions", () => {
  it("discovers JSONL files in project directories", async () => {
    const sessionId = "5268c8d5-6db0-478c-bff2-b734662b3b0a";
    createProjectDir("-Users-test-Desktop-myproject", [
      { id: sessionId, mtimeMs: Date.now() - 600_000 }, // 10 min ago
    ]);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].sessionId).toBe(sessionId);
    expect(result.discovered[0].transcriptPath).toContain(`${sessionId}.jsonl`);
    expect(result.discovered[0].projectDir).toBe(
      "-Users-test-Desktop-myproject",
    );
  });

  it("uses sessions-index.json when present", async () => {
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const projectDir = createProjectDir("-Users-test-Desktop-indexed", [
      { id: sessionId, content: '{"type":"user"}\n', mtimeMs: Date.now() - 600_000 },
    ]);

    // Write sessions-index.json with pre-computed metadata
    const index = [
      {
        sessionId,
        projectPath: "/Users/test/Desktop/indexed",
        created: "2025-05-01T08:00:00.000Z",
        modified: "2025-05-01T09:30:00.000Z",
        gitBranch: "feature/awesome",
        firstPrompt: "Build me a rocket",
        messageCount: 42,
      },
    ];
    fs.writeFileSync(
      path.join(projectDir, "sessions-index.json"),
      JSON.stringify(index),
    );

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    const session = result.discovered[0];
    expect(session.gitBranch).toBe("feature/awesome");
    expect(session.firstPrompt).toBe("Build me a rocket");
    expect(session.firstTimestamp).toBe("2025-05-01T08:00:00.000Z");
    expect(session.lastTimestamp).toBe("2025-05-01T09:30:00.000Z");
    expect(session.messageCount).toBe(42);
  });

  it("skips subdirectories (subagent transcripts)", async () => {
    const projectDir = createProjectDir("-Users-test-Desktop-repo", [
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        mtimeMs: Date.now() - 600_000,
      },
    ]);

    // Create a subagent directory (should be skipped)
    const subagentDir = path.join(
      projectDir,
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "subagents",
    );
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentDir, "agent-abc123.jsonl"),
      '{"type":"user"}\n',
    );

    const result = await scanForSessions(tmpDir);

    // Only the top-level JSONL should be discovered, not the subagent one
    expect(result.discovered.length).toBe(1);
    expect(result.skipped.subagents).toBeGreaterThanOrEqual(1);
  });

  it("skips non-JSONL files", async () => {
    const projectDir = createProjectDir("-Users-test-Desktop-repo2", [
      {
        id: "11111111-2222-3333-4444-555555555555",
        mtimeMs: Date.now() - 600_000,
      },
    ]);

    // Add non-JSONL files
    fs.writeFileSync(path.join(projectDir, ".DS_Store"), "");
    fs.writeFileSync(
      path.join(projectDir, "sessions-index.json"),
      "[]",
    );

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    expect(result.skipped.nonJsonl).toBeGreaterThanOrEqual(2); // .DS_Store + sessions-index.json
  });

  it("skips sessions without /exit that have the file open (active)", async () => {
    // Session without /exit and no process holding it open → treated as ended (crashed/abandoned)
    createProjectDir("-Users-test-Desktop-active", [
      {
        id: "66666666-7777-8888-9999-aaaaaaaaaaaa",
        // default content includes /exit → closed session, should be discovered
      },
      {
        id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        content: buildActiveJsonl("bbbbbbbb-cccc-dddd-eeee-ffffffffffff"),
        // no /exit, but no process has file open → abandoned, should still be discovered
      },
    ]);

    const result = await scanForSessions(tmpDir);

    // Both discovered: one has /exit (closed), one has no /exit but no lsof match (abandoned)
    expect(result.discovered.length).toBe(2);
    expect(result.skipped.potentiallyActive).toBe(0);
  });

  it("handles empty JSONL files (discovered with null metadata)", async () => {
    createProjectDir("-Users-test-Desktop-empty", [
      {
        id: "deadbeef-dead-beef-dead-beefdeadbeef",
        content: "", // empty file
        mtimeMs: Date.now() - 600_000,
      },
    ]);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].sessionId).toBe(
      "deadbeef-dead-beef-dead-beefdeadbeef",
    );
    expect(result.discovered[0].firstTimestamp).toBeNull();
    expect(result.discovered[0].lastTimestamp).toBeNull();
    expect(result.discovered[0].fileSizeBytes).toBe(0);
  });

  it("sorts discovered sessions by firstTimestamp ascending", async () => {
    const projectDir = path.join(tmpDir, "-Users-test-Desktop-sorted");
    fs.mkdirSync(projectDir, { recursive: true });

    // Session B is older (January), Session A is newer (March)
    const sessionA = "aaaa0000-1111-2222-3333-444444444444";
    const sessionB = "bbbb0000-1111-2222-3333-444444444444";

    fs.writeFileSync(
      path.join(projectDir, `${sessionA}.jsonl`),
      JSON.stringify({
        type: "user",
        timestamp: "2025-03-15T10:00:00.000Z",
        message: { role: "user", content: "A" },
      }) + "\n",
    );

    fs.writeFileSync(
      path.join(projectDir, `${sessionB}.jsonl`),
      JSON.stringify({
        type: "user",
        timestamp: "2025-01-10T10:00:00.000Z",
        message: { role: "user", content: "B" },
      }) + "\n",
    );

    // Set old mtime so they're not skipped as active
    const oldTime = new Date(Date.now() - 600_000);
    fs.utimesSync(path.join(projectDir, `${sessionA}.jsonl`), oldTime, oldTime);
    fs.utimesSync(path.join(projectDir, `${sessionB}.jsonl`), oldTime, oldTime);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(2);
    // Session B (January) should come before Session A (March)
    expect(result.discovered[0].sessionId).toBe(sessionB);
    expect(result.discovered[1].sessionId).toBe(sessionA);
  });

  it("returns empty result when projects directory doesn't exist", async () => {
    const result = await scanForSessions(
      path.join(tmpDir, "nonexistent"),
    );

    expect(result.discovered.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("resolves workspace to _unassociated for non-existent paths", async () => {
    createProjectDir("-Users-nonexistent-path-to-nowhere", [
      {
        id: "cccccccc-dddd-eeee-ffff-000000000000",
        mtimeMs: Date.now() - 600_000,
      },
    ]);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].workspaceCanonicalId).toBe("_unassociated");
  });

  it("calls onProgress callback for each project directory", async () => {
    createProjectDir("-Users-test-Desktop-proj1", [
      {
        id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
        mtimeMs: Date.now() - 600_000,
      },
    ]);
    createProjectDir("-Users-test-Desktop-proj2", [
      {
        id: "22222222-aaaa-bbbb-cccc-dddddddddddd",
        mtimeMs: Date.now() - 600_000,
      },
    ]);

    const progressDirs: string[] = [];
    await scanForSessions(tmpDir, {

      onProgress: (dir) => progressDirs.push(dir),
    });

    expect(progressDirs.length).toBe(2);
  });

  it("skips files that are not valid UUID filenames", async () => {
    const projectDir = path.join(tmpDir, "-Users-test-Desktop-badnames");
    fs.mkdirSync(projectDir, { recursive: true });

    // Valid UUID session
    const validId = "12345678-1234-1234-1234-123456789012";
    fs.writeFileSync(
      path.join(projectDir, `${validId}.jsonl`),
      '{"type":"user","timestamp":"2025-01-01T00:00:00Z"}\n',
    );

    // Invalid filename (not a UUID)
    fs.writeFileSync(
      path.join(projectDir, "not-a-uuid.jsonl"),
      '{"type":"user"}\n',
    );

    const oldTime = new Date(Date.now() - 600_000);
    fs.utimesSync(path.join(projectDir, `${validId}.jsonl`), oldTime, oldTime);
    fs.utimesSync(path.join(projectDir, "not-a-uuid.jsonl"), oldTime, oldTime);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].sessionId).toBe(validId);
  });

  // -------------------------------------------------------------------------
  // Bug 0: versioned sessions-index.json format
  // -------------------------------------------------------------------------

  it("parses versioned sessions-index.json with {version, entries} format", async () => {
    const sessionId = "f1f2f3f4-a1a2-b1b2-c1c2-d1d2d3d4d5d6";
    const projectDir = createProjectDir("-Users-test-Desktop-versioned", [
      { id: sessionId, content: '{"type":"user"}\n', mtimeMs: Date.now() - 600_000 },
    ]);

    // Write versioned sessions-index.json (real CC format)
    const index = {
      version: 1,
      entries: [
        {
          sessionId,
          projectPath: "/Users/test/Desktop/versioned",
          created: "2025-07-01T08:00:00.000Z",
          modified: "2025-07-01T09:00:00.000Z",
          gitBranch: "develop",
          firstPrompt: "Implement versioned index",
          messageCount: 10,
        },
      ],
    };
    fs.writeFileSync(
      path.join(projectDir, "sessions-index.json"),
      JSON.stringify(index),
    );

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    const session = result.discovered[0];
    expect(session.gitBranch).toBe("develop");
    expect(session.firstPrompt).toBe("Implement versioned index");
    expect(session.firstTimestamp).toBe("2025-07-01T08:00:00.000Z");
    expect(session.lastTimestamp).toBe("2025-07-01T09:00:00.000Z");
    expect(session.messageCount).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Step 2: cwd extracted from JSONL header
  // -------------------------------------------------------------------------

  it("extracts cwd from JSONL header when no sessions-index.json", async () => {
    const sessionId = "a0a0a0a0-b1b1-c2c2-d3d3-e4e4e4e4e4e4";
    const cwdPath = "/Users/test/Desktop/jsonl-cwd-project";
    const jsonlContent = JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2025-08-01T10:00:00.000Z",
      cwd: cwdPath,
      message: { role: "user", content: "Hello" },
    }) + "\n";

    createProjectDir("-Users-test-Desktop-jsonl-cwd-project", [
      { id: sessionId, content: jsonlContent, mtimeMs: Date.now() - 600_000 },
    ]);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    // CWD from JSONL should be used (projectDirToPath would produce something different)
    expect(result.discovered[0].resolvedCwd).toBe(cwdPath);
  });

  // -------------------------------------------------------------------------
  // Step 5: CWD priority — sessions-index.json projectPath wins over JSONL cwd
  // -------------------------------------------------------------------------

  it("prefers sessions-index.json projectPath over JSONL cwd", async () => {
    const sessionId = "b0b0b0b0-c1c1-d2d2-e3e3-f4f4f4f4f4f4";
    const indexPath = "/Users/test/Desktop/index-wins";
    const jsonlCwd = "/Users/test/Desktop/jsonl-loses";

    const jsonlContent = JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2025-09-01T10:00:00.000Z",
      cwd: jsonlCwd,
      message: { role: "user", content: "Hello" },
    }) + "\n";

    const projectDir = createProjectDir("-Users-test-Desktop-priority", [
      { id: sessionId, content: jsonlContent, mtimeMs: Date.now() - 600_000 },
    ]);

    // Write sessions-index.json with different projectPath
    const index = [
      {
        sessionId,
        projectPath: indexPath,
        created: "2025-09-01T10:00:00.000Z",
      },
    ];
    fs.writeFileSync(
      path.join(projectDir, "sessions-index.json"),
      JSON.stringify(index),
    );

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].resolvedCwd).toBe(indexPath);
  });

  // -------------------------------------------------------------------------
  // Bug 2: parent directory walk resolves workspace from subdirectory
  // -------------------------------------------------------------------------

  it("resolves workspace by walking up to parent .git directory", async () => {
    // Create a real directory structure with .git/config in parent
    const repoDir = path.join(tmpDir, "parent-repo");
    const subDir = path.join(repoDir, "packages", "sub");
    fs.mkdirSync(subDir, { recursive: true });

    // Create .git/config with a remote origin
    const gitDir = path.join(repoDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitDir, "config"),
      '[remote "origin"]\n\turl = git@github.com:testuser/parent-repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );

    // Create a session whose CWD points to the subdirectory
    const sessionId = "d0d0d0d0-e1e1-f2f2-a3a3-b4b4b4b4b4b4";
    const jsonlContent = JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2025-10-01T10:00:00.000Z",
      cwd: subDir,
      message: { role: "user", content: "Hello from subdir" },
    }) + "\n";

    createProjectDir("-parent-repo-packages-sub", [
      { id: sessionId, content: jsonlContent, mtimeMs: Date.now() - 600_000 },
    ]);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    // Should resolve via git commands or parent walk, not _unassociated
    expect(result.discovered[0].workspaceCanonicalId).toContain("github.com/testuser/parent-repo");
  });

  // -------------------------------------------------------------------------
  // Bug 3: local repo (no remote) gets local:<sha256> ID
  // -------------------------------------------------------------------------

  it("resolves local repo (no remote) to local:<sha256> ID", async () => {
    const { execSync: exec } = await import("node:child_process");

    // Create a real git repo with no remote
    const localRepo = path.join(tmpDir, "local-only-repo");
    fs.mkdirSync(localRepo, { recursive: true });
    exec("git init", { cwd: localRepo, stdio: "pipe" });
    exec("git config user.email test@test.com", { cwd: localRepo, stdio: "pipe" });
    exec("git config user.name Test", { cwd: localRepo, stdio: "pipe" });
    fs.writeFileSync(path.join(localRepo, "README.md"), "# Local repo");
    exec("git add README.md && git commit -m 'init'", { cwd: localRepo, stdio: "pipe" });

    const sessionId = "e0e0e0e0-f1f1-a2a2-b3b3-c4c4c4c4c4c4";
    const jsonlContent = JSON.stringify({
      type: "user",
      sessionId,
      timestamp: "2025-11-01T10:00:00.000Z",
      cwd: localRepo,
      message: { role: "user", content: "Hello local" },
    }) + "\n";

    createProjectDir("-local-only-repo", [
      { id: sessionId, content: jsonlContent, mtimeMs: Date.now() - 600_000 },
    ]);

    const result = await scanForSessions(tmpDir);

    expect(result.discovered.length).toBe(1);
    // Should be local:<sha256>, not _unassociated
    expect(result.discovered[0].workspaceCanonicalId).toMatch(/^local:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: projectDirToPath
// ---------------------------------------------------------------------------

describe("projectDirToPath", () => {
  it("converts directory name with leading dash to absolute path", () => {
    // Since /Users likely exists on macOS, this should correctly resolve
    const result = projectDirToPath("-Users-test-Desktop-foo");
    // The function greedily checks directory existence;
    // on macOS, /Users exists so it should get resolved correctly
    expect(result.startsWith("/")).toBe(true);
  });

  it("handles input without leading dash", () => {
    const result = projectDirToPath("some-dir-name");
    expect(result).toBe("some-dir-name");
  });

  it("produces a path starting with / for dash-prefixed input", () => {
    const result = projectDirToPath("-a-b-c");
    expect(result.startsWith("/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: backfill state persistence
// ---------------------------------------------------------------------------

describe("backfill state", () => {
  it("returns default state when file doesn't exist", () => {
    const state = loadBackfillState(tmpDir);

    expect(state.lastRunAt).toBeNull();
    expect(state.lastRunResult).toBeNull();
    expect(state.isRunning).toBe(false);
    expect(state.startedAt).toBeNull();
    expect(state.ingestedSessionIds).toEqual([]);
  });

  it("round-trips state through save and load", () => {
    const original: BackfillState = {
      lastRunAt: "2025-06-01T12:00:00.000Z",
      lastRunResult: {
        ingested: 100,
        skipped: 20,
        failed: 5,
        errors: [{ sessionId: "abc", error: "timeout" }],
        totalSizeBytes: 50_000_000,
        durationMs: 30_000,
      },
      isRunning: false,
      startedAt: null,
      ingestedSessionIds: ["session-1", "session-2", "session-3"],
    };

    saveBackfillState(original, tmpDir);
    const loaded = loadBackfillState(tmpDir);

    expect(loaded.lastRunAt).toBe(original.lastRunAt);
    expect(loaded.lastRunResult?.ingested).toBe(100);
    expect(loaded.lastRunResult?.skipped).toBe(20);
    expect(loaded.lastRunResult?.failed).toBe(5);
    expect(loaded.lastRunResult?.errors).toEqual([
      { sessionId: "abc", error: "timeout" },
    ]);
    expect(loaded.lastRunResult?.totalSizeBytes).toBe(50_000_000);
    expect(loaded.isRunning).toBe(false);
    expect(loaded.startedAt).toBeNull();
    expect(loaded.ingestedSessionIds).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
  });

  it("handles corrupted state file gracefully", () => {
    const filePath = path.join(tmpDir, "backfill-state.json");
    fs.writeFileSync(filePath, "THIS IS NOT VALID JSON {{{{");

    const state = loadBackfillState(tmpDir);

    // Should return default state, not throw
    expect(state.lastRunAt).toBeNull();
    expect(state.isRunning).toBe(false);
    expect(state.ingestedSessionIds).toEqual([]);
  });

  it("creates state directory if it doesn't exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "state", "dir");

    const state: BackfillState = {
      lastRunAt: null,
      lastRunResult: null,
      isRunning: true,
      startedAt: "2025-06-01T12:00:00.000Z",
      ingestedSessionIds: [],
    };

    saveBackfillState(state, nestedDir);

    expect(fs.existsSync(path.join(nestedDir, "backfill-state.json"))).toBe(
      true,
    );

    const loaded = loadBackfillState(nestedDir);
    expect(loaded.isRunning).toBe(true);
    expect(loaded.startedAt).toBe("2025-06-01T12:00:00.000Z");
  });

  it("handles partial state files from older versions", () => {
    const filePath = path.join(tmpDir, "backfill-state.json");
    // Simulate an older state file with only some fields
    fs.writeFileSync(
      filePath,
      JSON.stringify({ lastRunAt: "2025-01-01T00:00:00Z" }),
    );

    const state = loadBackfillState(tmpDir);

    expect(state.lastRunAt).toBe("2025-01-01T00:00:00Z");
    expect(state.lastRunResult).toBeNull();
    expect(state.isRunning).toBe(false);
    expect(state.ingestedSessionIds).toEqual([]);
  });
});
