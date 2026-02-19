/**
 * Tests for the session backfill scanner and state persistence.
 *
 * Creates temporary directory structures mimicking ~/.claude/projects/ to test:
 *   - JSONL file discovery and session ID extraction
 *   - sessions-index.json metadata enrichment
 *   - Subagent directory skipping
 *   - Non-JSONL file skipping
 *   - Recently modified file skipping (potentially active)
 *   - projectDirToPath directory name → path conversion
 *   - Workspace resolution (_unassociated fallback)
 *   - Empty JSONL file handling
 *   - Backfill state load/save round-trips
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanForSessions, projectDirToPath } from "../session-backfill.js";
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

/** Build minimal JSONL content with a first line containing metadata */
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
  return line1 + "\n" + line2 + "\n";
}

// ---------------------------------------------------------------------------
// Tests: scanForSessions
// ---------------------------------------------------------------------------

describe("scanForSessions", () => {
  it("discovers JSONL files in project directories", async () => {
    const sessionId = "5268c8d5-6db0-478c-bff2-b734662b3b0a";
    createProjectDir("-Users-test-Desktop-myproject", [
      { id: sessionId, mtimeMs: Date.now() - 600_000 }, // 10 min ago
    ]);

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

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

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

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

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

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

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

    expect(result.discovered.length).toBe(1);
    expect(result.skipped.nonJsonl).toBeGreaterThanOrEqual(2); // .DS_Store + sessions-index.json
  });

  it("skips files modified within the active threshold (potentially active)", async () => {
    // One old session (10 min ago) and one recent (1 min ago)
    createProjectDir("-Users-test-Desktop-active", [
      {
        id: "66666666-7777-8888-9999-aaaaaaaaaaaa",
        mtimeMs: Date.now() - 600_000, // 10 min ago — should be included
      },
      {
        id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        mtimeMs: Date.now() - 60_000, // 1 min ago — should be skipped
      },
    ]);

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000, // 5 min threshold
    });

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].sessionId).toBe(
      "66666666-7777-8888-9999-aaaaaaaaaaaa",
    );
    expect(result.skipped.potentiallyActive).toBe(1);
  });

  it("handles empty JSONL files (discovered with null metadata)", async () => {
    createProjectDir("-Users-test-Desktop-empty", [
      {
        id: "deadbeef-dead-beef-dead-beefdeadbeef",
        content: "", // empty file
        mtimeMs: Date.now() - 600_000,
      },
    ]);

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

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

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

    expect(result.discovered.length).toBe(2);
    // Session B (January) should come before Session A (March)
    expect(result.discovered[0].sessionId).toBe(sessionB);
    expect(result.discovered[1].sessionId).toBe(sessionA);
  });

  it("returns empty result when projects directory doesn't exist", async () => {
    const result = await scanForSessions(
      path.join(tmpDir, "nonexistent"),
      { skipActiveThresholdMs: 300_000 },
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

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

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
      skipActiveThresholdMs: 300_000,
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

    const result = await scanForSessions(tmpDir, {
      skipActiveThresholdMs: 300_000,
    });

    expect(result.discovered.length).toBe(1);
    expect(result.discovered[0].sessionId).toBe(validId);
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
