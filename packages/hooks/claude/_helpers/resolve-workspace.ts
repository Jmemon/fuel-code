/**
 * Shared workspace resolution utility for Claude Code hooks.
 *
 * Given a working directory, resolves the workspace identity by inspecting
 * git state. This is the single source of truth for workspace ID derivation
 * used by both session-start and session-end helpers.
 *
 * Resolution priority:
 *   1. Git remote URL (prefer `origin`, fall back to first alphabetically)
 *   2. First commit hash (for local-only repos: `local:<sha256>`)
 *   3. Fallback: `_unassociated`
 */

import { execSync } from "node:child_process";
import {
  normalizeGitRemote,
  deriveWorkspaceCanonicalId,
} from "@fuel-code/shared";

/** Result of workspace resolution */
export interface WorkspaceInfo {
  /** Canonical workspace ID (normalized remote, local:<hash>, or _unassociated) */
  workspaceId: string;
  /** Current git branch (null if not a git repo or detached HEAD) */
  gitBranch: string | null;
  /** Raw git remote URL (null if no remote) */
  gitRemote: string | null;
}

/**
 * Resolve workspace identity from the given working directory.
 *
 * All shell commands use `{ cwd, stdio: "pipe" }` and are wrapped in try/catch
 * so this function never throws — it returns `_unassociated` on any failure.
 */
export async function resolveWorkspace(cwd: string): Promise<WorkspaceInfo> {
  // Default: not a git repo
  let gitBranch: string | null = null;
  let gitRemote: string | null = null;

  // Step 1: Check if CWD is inside a git repository
  const isGitRepo = execSilent("git rev-parse --is-inside-work-tree", cwd);
  if (isGitRepo !== "true") {
    return { workspaceId: "_unassociated", gitBranch: null, gitRemote: null };
  }

  // Step 2: Try to get the current branch
  gitBranch = execSilent("git symbolic-ref --short HEAD", cwd);

  // Step 3: Get remote URL — prefer `origin`, fall back to first remote alphabetically
  const remoteList = execSilent("git remote", cwd);
  if (remoteList) {
    const remotes = remoteList
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);

    // Prefer "origin", otherwise take the first alphabetically
    const targetRemote = remotes.includes("origin")
      ? "origin"
      : remotes.sort()[0];

    if (targetRemote) {
      gitRemote = execSilent(
        `git remote get-url ${targetRemote}`,
        cwd,
      );
    }
  }

  // Step 4: Derive workspace ID
  let firstCommitHash: string | null = null;
  if (!gitRemote) {
    // No remote — try to get the first commit hash for local repo identification
    firstCommitHash = execSilent(
      "git rev-list --max-parents=0 HEAD",
      cwd,
    );
    // If multiple root commits, take the first one
    if (firstCommitHash) {
      firstCommitHash = firstCommitHash.split("\n")[0].trim();
    }
  }

  const workspaceId = deriveWorkspaceCanonicalId(gitRemote, firstCommitHash);

  return { workspaceId, gitBranch, gitRemote };
}

/**
 * Execute a shell command silently, returning trimmed stdout or null on any failure.
 * Never throws — all errors are swallowed.
 */
function execSilent(cmd: string, cwd: string): string | null {
  try {
    const result = execSync(cmd, { cwd, stdio: "pipe", timeout: 5000 });
    const output = result.toString().trim();
    return output || null;
  } catch {
    return null;
  }
}
