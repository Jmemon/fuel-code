/**
 * Tests for the `fuel-code cc-hook` command group.
 *
 * The cc-hook command is called by Claude Code on session start/end events.
 * It reads JSON context from stdin, resolves the workspace via git, and
 * emits events to the fuel-code backend.
 *
 * Mocking strategy:
 *   - Bun.stdin.text() — returns test JSON payloads
 *   - runEmit (from ./emit.js) — captures emitted events
 *   - runTranscriptUpload (from ./transcript.js) — captures transcript upload calls
 *   - execSync (from node:child_process) — controls git command responses
 *   - process.exit — prevents test process from exiting
 *   - deriveWorkspaceCanonicalId — returns predictable workspace IDs
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
  spyOn,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockRunEmit = mock(async () => {});
const mockRunTranscriptUpload = mock(async () => {});
const mockExecSync = mock((cmd: string, opts?: Record<string, unknown>) => {
  return Buffer.from("");
});

mock.module("../emit.js", () => ({
  runEmit: mockRunEmit,
}));

mock.module("../transcript.js", () => ({
  runTranscriptUpload: mockRunTranscriptUpload,
}));

mock.module("../../lib/exec.js", () => ({
  execSync: mockExecSync,
}));

mock.module("../../lib/workspace.js", () => ({
  deriveWorkspaceCanonicalId: (
    remote: string | null,
    firstCommit: string | null,
  ) => {
    if (remote) return `canonical:${remote}`;
    if (firstCommit) return `local:${firstCommit}`;
    return "_unassociated";
  },
}));

// Now import the module under test (after mocks are registered)
const { createCCHookCommand } = await import("../cc-hook.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof spyOn>;
let stdinSpy: ReturnType<typeof spyOn>;

/**
 * Set the stdin JSON that the handler will read.
 * Uses spyOn on Bun.stdin.text since Bun.stdin itself is not configurable.
 */
function setStdin(payload: unknown): void {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  stdinSpy.mockImplementation(async () => text);
}

/**
 * Configure execSync mock to simulate a git repo with an origin remote.
 * Returns predictable values for all the git commands used by resolveWorkspace.
 */
function setupGitMocks(opts?: {
  isGitRepo?: boolean;
  branch?: string | null;
  remote?: string | null;
  remoteList?: string | null;
  firstCommitHash?: string | null;
  ccVersion?: string;
}): void {
  const {
    isGitRepo = true,
    branch = "main",
    remote = "git@github.com:user/repo.git",
    remoteList = "origin",
    firstCommitHash = null,
    ccVersion = "1.0.0",
  } = opts ?? {};

  mockExecSync.mockImplementation((cmd: string) => {
    if (cmd === "git rev-parse --is-inside-work-tree") {
      return Buffer.from(isGitRepo ? "true" : "false");
    }
    if (cmd === "git symbolic-ref --short HEAD") {
      if (!branch) throw new Error("not on a branch");
      return Buffer.from(branch);
    }
    if (cmd === "git remote") {
      if (!remoteList) throw new Error("no remotes");
      return Buffer.from(remoteList);
    }
    if (cmd.startsWith("git remote get-url")) {
      if (!remote) throw new Error("no remote url");
      return Buffer.from(remote);
    }
    if (cmd === "git rev-list --max-parents=0 HEAD") {
      if (!firstCommitHash) throw new Error("no commits");
      return Buffer.from(firstCommitHash);
    }
    if (cmd === "claude --version") {
      return Buffer.from(ccVersion);
    }
    return Buffer.from("");
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Prevent process.exit from killing the test runner
  exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);

  // Mock Bun.stdin.text() to return controlled input
  stdinSpy = spyOn(Bun.stdin, "text").mockImplementation(async () => "{}");

  // Reset all mock call histories
  mockRunEmit.mockClear();
  mockRunTranscriptUpload.mockClear();
  mockExecSync.mockClear();

  // Default: git repo with origin remote
  setupGitMocks();
});

afterEach(() => {
  exitSpy.mockRestore();
  stdinSpy.mockRestore();
  mockRunEmit.mockClear();
  mockRunTranscriptUpload.mockClear();
  mockExecSync.mockReset();
});

// Restore all module mocks after this file finishes so they don't leak
// into other test files running in the same bun test process.
afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests: session-start
// ---------------------------------------------------------------------------

describe("cc-hook session-start", () => {
  it("emits session.start with correct workspace and payload for valid input", async () => {
    const input = {
      session_id: "sess-abc-123",
      cwd: "/home/user/project",
      transcript_path: "/tmp/transcript.jsonl",
      source: "startup",
      model: "claude-sonnet-4-20250514",
    };
    setStdin(input);

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    // runEmit should have been called exactly once with session.start
    expect(mockRunEmit).toHaveBeenCalledTimes(1);

    const [eventType, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { data: string; workspaceId: string },
    ];
    expect(eventType).toBe("session.start");

    // Workspace should be derived from the git remote
    expect(opts.workspaceId).toBe(
      "canonical:git@github.com:user/repo.git",
    );

    // Parse the payload data to verify fields
    const data = JSON.parse(opts.data);
    expect(data.cc_session_id).toBe("sess-abc-123");
    expect(data.cwd).toBe("/home/user/project");
    expect(data.git_branch).toBe("main");
    expect(data.git_remote).toBe("git@github.com:user/repo.git");
    expect(data.cc_version).toBe("1.0.0");
    expect(data.model).toBe("claude-sonnet-4-20250514");
    expect(data.source).toBe("startup");
    expect(data.transcript_path).toBe("/tmp/transcript.jsonl");
  });

  it("exits silently when stdin is not valid JSON", async () => {
    setStdin("this is not json {{{");

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits silently when session_id is missing from context", async () => {
    setStdin({ cwd: "/home/user/project" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits silently when session_id is empty string", async () => {
    setStdin({ session_id: "", cwd: "/home/user/project" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits silently when session_id is whitespace only", async () => {
    setStdin({ session_id: "   ", cwd: "/home/user/project" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("uses _unassociated workspace when not in a git repo", async () => {
    setupGitMocks({ isGitRepo: false });
    setStdin({ session_id: "sess-no-git", cwd: "/tmp/not-a-repo" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    const [, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { workspaceId: string },
    ];
    expect(opts.workspaceId).toBe("_unassociated");
  });

  it("uses local: workspace ID for repos without a remote", async () => {
    setupGitMocks({
      remote: null,
      remoteList: null,
      firstCommitHash: "abcdef1234567890",
    });
    setStdin({ session_id: "sess-local", cwd: "/home/user/local-repo" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    const [, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { workspaceId: string },
    ];
    expect(opts.workspaceId).toBe("local:abcdef1234567890");
  });

  it("defaults cc_version to 'unknown' when claude --version fails", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === "git rev-parse --is-inside-work-tree")
        return Buffer.from("true");
      if (cmd === "git symbolic-ref --short HEAD")
        return Buffer.from("main");
      if (cmd === "git remote") return Buffer.from("origin");
      if (cmd.startsWith("git remote get-url"))
        return Buffer.from("git@github.com:user/repo.git");
      if (cmd === "claude --version") throw new Error("command not found");
      return Buffer.from("");
    });

    setStdin({ session_id: "sess-no-version", cwd: "/home/user/project" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    const [, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { data: string },
    ];
    const data = JSON.parse(opts.data);
    expect(data.cc_version).toBe("unknown");
  });

  it("defaults source to 'startup' when not provided", async () => {
    setStdin({ session_id: "sess-defaults", cwd: "/home/user/project" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    const [, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { data: string },
    ];
    const data = JSON.parse(opts.data);
    expect(data.source).toBe("startup");
  });

  it("sets model to null when not provided in context", async () => {
    setStdin({ session_id: "sess-no-model", cwd: "/home/user/project" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    const [, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { data: string },
    ];
    const data = JSON.parse(opts.data);
    expect(data.model).toBeNull();
  });

  it("always calls process.exit(0) even after successful emit", async () => {
    setStdin({
      session_id: "sess-exit-test",
      cwd: "/home/user/project",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("swallows errors from runEmit and still exits 0", async () => {
    mockRunEmit.mockImplementationOnce(async () => {
      throw new Error("backend exploded");
    });
    setStdin({
      session_id: "sess-emit-fail",
      cwd: "/home/user/project",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-start"]);

    // Should still exit 0 despite the error
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: session-end
// ---------------------------------------------------------------------------

describe("cc-hook session-end", () => {
  it("emits session.end with correct workspace and payload for valid input", async () => {
    const input = {
      session_id: "sess-end-123",
      cwd: "/home/user/project",
      transcript_path: "/tmp/transcript.jsonl",
      reason: "prompt_input_exit",
    };
    setStdin(input);

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);

    const [eventType, opts] = mockRunEmit.mock.calls[0] as [
      string,
      { data: string; workspaceId: string; sessionId: string },
    ];
    expect(eventType).toBe("session.end");
    expect(opts.workspaceId).toBe(
      "canonical:git@github.com:user/repo.git",
    );
    expect(opts.sessionId).toBeUndefined();

    const data = JSON.parse(opts.data);
    expect(data.cc_session_id).toBe("sess-end-123");
    expect(data.duration_ms).toBe(0);
    expect(data.end_reason).toBe("exit");
    expect(data.transcript_path).toBe("/tmp/transcript.jsonl");
  });

  it("triggers transcript upload when transcript_path is provided", async () => {
    setStdin({
      session_id: "sess-transcript",
      cwd: "/home/user/project",
      transcript_path: "/tmp/my-transcript.jsonl",
      reason: "exit",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunTranscriptUpload).toHaveBeenCalledTimes(1);
    expect(mockRunTranscriptUpload).toHaveBeenCalledWith(
      "sess-transcript",
      "/tmp/my-transcript.jsonl",
    );
  });

  it("does NOT trigger transcript upload when transcript_path is empty", async () => {
    setStdin({
      session_id: "sess-no-transcript",
      cwd: "/home/user/project",
      transcript_path: "",
      reason: "exit",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    expect(mockRunTranscriptUpload).not.toHaveBeenCalled();
  });

  it("does NOT trigger transcript upload when transcript_path is not provided", async () => {
    setStdin({
      session_id: "sess-no-transcript-field",
      cwd: "/home/user/project",
      reason: "exit",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunEmit).toHaveBeenCalledTimes(1);
    expect(mockRunTranscriptUpload).not.toHaveBeenCalled();
  });

  it("exits silently when stdin is not valid JSON", async () => {
    setStdin("not json!!!");

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(mockRunTranscriptUpload).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits silently when session_id is missing", async () => {
    setStdin({ cwd: "/home/user/project", reason: "exit" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits silently when session_id is empty string", async () => {
    setStdin({ session_id: "", reason: "exit" });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(mockRunEmit).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("always calls process.exit(0) after successful handling", async () => {
    setStdin({
      session_id: "sess-exit-end",
      cwd: "/home/user/project",
      reason: "exit",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("swallows errors from runEmit and still exits 0", async () => {
    mockRunEmit.mockImplementationOnce(async () => {
      throw new Error("emit failed");
    });
    setStdin({
      session_id: "sess-emit-fail-end",
      cwd: "/home/user/project",
      reason: "exit",
    });

    const cmd = createCCHookCommand();
    await cmd.parseAsync(["node", "test", "session-end"]);

    expect(exitSpy).toHaveBeenCalledWith(0);
    // Transcript upload should NOT be called because the error was caught
    // at the outer try/catch level
    expect(mockRunTranscriptUpload).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // mapSessionEndReason mapping (tested indirectly via session-end payload)
  // -------------------------------------------------------------------------

  describe("mapSessionEndReason", () => {
    it('maps "prompt_input_exit" to end_reason "exit"', async () => {
      setStdin({
        session_id: "sess-reason-1",
        cwd: "/home/user/project",
        reason: "prompt_input_exit",
      });

      const cmd = createCCHookCommand();
      await cmd.parseAsync(["node", "test", "session-end"]);

      const [, opts] = mockRunEmit.mock.calls[0] as [
        string,
        { data: string },
      ];
      const data = JSON.parse(opts.data);
      expect(data.end_reason).toBe("exit");
    });

    it('maps "clear" to end_reason "clear"', async () => {
      setStdin({
        session_id: "sess-reason-2",
        cwd: "/home/user/project",
        reason: "clear",
      });

      const cmd = createCCHookCommand();
      await cmd.parseAsync(["node", "test", "session-end"]);

      const [, opts] = mockRunEmit.mock.calls[0] as [
        string,
        { data: string },
      ];
      const data = JSON.parse(opts.data);
      expect(data.end_reason).toBe("clear");
    });

    it('maps "logout" to end_reason "logout"', async () => {
      setStdin({
        session_id: "sess-reason-3",
        cwd: "/home/user/project",
        reason: "logout",
      });

      const cmd = createCCHookCommand();
      await cmd.parseAsync(["node", "test", "session-end"]);

      const [, opts] = mockRunEmit.mock.calls[0] as [
        string,
        { data: string },
      ];
      const data = JSON.parse(opts.data);
      expect(data.end_reason).toBe("logout");
    });

    it('defaults unknown reason to "exit"', async () => {
      setStdin({
        session_id: "sess-reason-unknown",
        cwd: "/home/user/project",
        reason: "some_unknown_reason",
      });

      const cmd = createCCHookCommand();
      await cmd.parseAsync(["node", "test", "session-end"]);

      const [, opts] = mockRunEmit.mock.calls[0] as [
        string,
        { data: string },
      ];
      const data = JSON.parse(opts.data);
      expect(data.end_reason).toBe("exit");
    });

    it('defaults to "exit" when reason is not provided', async () => {
      setStdin({
        session_id: "sess-no-reason",
        cwd: "/home/user/project",
      });

      const cmd = createCCHookCommand();
      await cmd.parseAsync(["node", "test", "session-end"]);

      const [, opts] = mockRunEmit.mock.calls[0] as [
        string,
        { data: string },
      ];
      const data = JSON.parse(opts.data);
      expect(data.end_reason).toBe("exit");
    });
  });
});
