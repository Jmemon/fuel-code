/**
 * `fuel-code cc-hook` command group.
 *
 * Internal handlers for Claude Code hooks. These commands are registered
 * in ~/.claude/settings.json by `fuel-code hooks install` and called
 * directly by Claude Code on session start/end events.
 *
 * Reads CC's hook context JSON from stdin and emits events to the backend.
 * All logic that was previously in packages/hooks/claude/ shell scripts
 * and TS helpers is now inlined here, removing the dependency on the
 * source repo being present at a specific path.
 *
 * Subcommands:
 *   session-start — Handle SessionStart hook (emits session.start event)
 *   session-end   — Handle SessionEnd hook (emits session.end event + transcript upload)
 *
 * Constraints:
 *   - Must produce NO stdout (could confuse CC)
 *   - Must handle ALL errors silently (never crash, never block CC)
 *   - Logs go to stderr only via the emit command's logger
 */

import { Command } from "commander";
import { execSync } from "../lib/exec.js";
import { deriveWorkspaceCanonicalId } from "../lib/workspace.js";
import { runEmit } from "./emit.js";
import { runTranscriptUpload } from "./transcript.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkspaceInfo {
  workspaceId: string;
  gitBranch: string | null;
  gitRemote: string | null;
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Create the `cc-hook` command group for the fuel-code CLI.
 * Returns a Commander Command instance with session-start and session-end subcommands.
 */
export function createCCHookCommand(): Command {
  const cmd = new Command("cc-hook")
    .description(
      "Internal handlers for Claude Code hooks (do not call directly)",
    );

  cmd.addCommand(createSessionStartHandler());
  cmd.addCommand(createSessionEndHandler());

  return cmd;
}

// ---------------------------------------------------------------------------
// session-start handler
// ---------------------------------------------------------------------------

function createSessionStartHandler(): Command {
  return new Command("session-start")
    .description("Handle Claude Code SessionStart hook")
    .action(async () => {
      try {
        const input = await readStdin();

        let context: Record<string, unknown>;
        try {
          context = JSON.parse(input);
        } catch {
          process.exit(0);
          return;
        }

        const sessionId = String(context.session_id ?? "").trim();
        if (!sessionId) {
          process.exit(0);
          return;
        }

        const cwd = String(context.cwd ?? process.cwd()).trim();
        const transcriptPath = String(
          context.transcript_path ?? "",
        ).trim();
        const source = String(context.source ?? "startup").trim();
        const model = context.model ? String(context.model).trim() : null;

        const workspace = resolveWorkspace(cwd);

        let ccVersion = "unknown";
        try {
          ccVersion = execSync("claude --version", {
            stdio: "pipe",
            timeout: 3000,
          })
            .toString()
            .trim();
        } catch {
          // Swallow — default is "unknown"
        }

        const payload = {
          cc_session_id: sessionId,
          cwd,
          git_branch: workspace.gitBranch,
          git_remote: workspace.gitRemote,
          cc_version: ccVersion,
          model,
          source,
          transcript_path: transcriptPath,
        };

        // session_id is null for session.start events because the session row
        // doesn't exist yet — the event handler creates it. The cc_session_id
        // is carried in the payload data for the handler to use.
        await runEmit("session.start", {
          data: JSON.stringify(payload),
          workspaceId: workspace.workspaceId,
        });
      } catch {
        // Swallow all errors — hooks must never fail
      }

      process.exit(0);
    });
}

// ---------------------------------------------------------------------------
// session-end handler
// ---------------------------------------------------------------------------

function createSessionEndHandler(): Command {
  return new Command("session-end")
    .description("Handle Claude Code SessionEnd hook")
    .action(async () => {
      try {
        const input = await readStdin();

        let context: Record<string, unknown>;
        try {
          context = JSON.parse(input);
        } catch {
          process.exit(0);
          return;
        }

        const sessionId = String(context.session_id ?? "").trim();
        if (!sessionId) {
          process.exit(0);
          return;
        }

        const cwd = String(context.cwd ?? process.cwd()).trim();
        const transcriptPath = String(
          context.transcript_path ?? "",
        ).trim();
        const endReason = mapSessionEndReason(
          String(context.reason ?? "exit").trim(),
        );

        const workspace = resolveWorkspace(cwd);

        const payload = {
          cc_session_id: sessionId,
          duration_ms: 0,
          end_reason: endReason,
          transcript_path: transcriptPath,
        };

        await runEmit("session.end", {
          data: JSON.stringify(payload),
          workspaceId: workspace.workspaceId,
          sessionId,
        });

        // Upload transcript directly (runTranscriptUpload never throws, has 120s timeout)
        if (transcriptPath) {
          await runTranscriptUpload(sessionId, transcriptPath);
        }
      } catch {
        // Swallow all errors — hooks must never fail
      }

      process.exit(0);
    });
}

// ---------------------------------------------------------------------------
// Workspace resolution
// Inlined from packages/hooks/claude/_helpers/resolve-workspace.ts so the
// CLI is self-contained and doesn't depend on the hooks package at runtime.
//
// Resolution priority:
//   1. Git remote URL (prefer `origin`, fall back to first alphabetically)
//   2. First commit hash (for local-only repos: `local:<sha256>`)
//   3. Fallback: `_unassociated`
// ---------------------------------------------------------------------------

function resolveWorkspace(cwd: string): WorkspaceInfo {
  let gitBranch: string | null = null;
  let gitRemote: string | null = null;

  const isGitRepo = execSilent(
    "git rev-parse --is-inside-work-tree",
    cwd,
  );
  if (isGitRepo !== "true") {
    return {
      workspaceId: "_unassociated",
      gitBranch: null,
      gitRemote: null,
    };
  }

  gitBranch = execSilent("git symbolic-ref --short HEAD", cwd);

  const remoteList = execSilent("git remote", cwd);
  if (remoteList) {
    const remotes = remoteList
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
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

  let firstCommitHash: string | null = null;
  if (!gitRemote) {
    firstCommitHash = execSilent(
      "git rev-list --max-parents=0 HEAD",
      cwd,
    );
    if (firstCommitHash) {
      firstCommitHash = firstCommitHash.split("\n")[0].trim();
    }
  }

  const workspaceId = deriveWorkspaceCanonicalId(
    gitRemote,
    firstCommitHash,
  );

  return { workspaceId, gitBranch, gitRemote };
}

/**
 * Map SessionEnd `reason` values to fuel-code's end_reason enum.
 * SessionEnd provides: prompt_input_exit, clear, logout, etc.
 */
function mapSessionEndReason(reason: string): string {
  switch (reason) {
    case "prompt_input_exit":
      return "exit";
    case "clear":
      return "clear";
    case "logout":
      return "logout";
    default:
      return "exit";
  }
}

function execSilent(cmd: string, cwd: string): string | null {
  try {
    const result = execSync(cmd, { cwd, stdio: "pipe", timeout: 5000 });
    const output = result.toString().trim();
    return output || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return "";
  }
}

