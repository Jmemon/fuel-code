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
 *   session-start   — Handle SessionStart hook (emits session.start event)
 *   session-end     — Handle SessionEnd hook (emits session.end event + transcript upload)
 *   subagent-start  — Handle SubagentStart hook (emits subagent.start event)
 *   subagent-stop   — Handle SubagentStop hook (emits subagent.stop event)
 *   post-tool-use   — Handle PostToolUse hook (dispatches by tool_name)
 *   worktree-create — Handle WorktreeCreate hook (emits worktree.create event)
 *   worktree-remove — Handle WorktreeRemove hook (emits worktree.remove event)
 *
 * Constraints:
 *   - Must produce NO stdout (could confuse CC)
 *   - Must handle ALL errors silently (never crash, never block CC)
 *   - Logs go to stderr only via the emit command's logger
 */

import { basename } from "node:path";
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
  cmd.addCommand(createSubagentStartHandler());
  cmd.addCommand(createSubagentStopHandler());
  cmd.addCommand(createPostToolUseHandler());
  cmd.addCommand(createWorktreeCreateHandler());
  cmd.addCommand(createWorktreeRemoveHandler());

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

        const model = context.model ? String(context.model).trim() : null;

        let ccVersion: string | null = null;
        try {
          ccVersion = execSync("claude --version", {
            stdio: "pipe",
            timeout: 3000,
          })
            .toString()
            .trim();
        } catch {
          // Swallow — cc_version is optional
        }

        // duration_ms: 0 signals the server to compute actual duration from started_at and ended_at.
        // Extra fields (cwd, git_branch, etc.) let the handler create the session
        // row if session.start was missed.
        const payload = {
          cc_session_id: sessionId,
          duration_ms: 0,
          end_reason: endReason,
          transcript_path: transcriptPath,
          cwd,
          git_branch: workspace.gitBranch,
          git_remote: workspace.gitRemote,
          model,
          cc_version: ccVersion,
        };

        // session_id is null for session.end events (same as session.start) to
        // avoid FK violations when the session.start event hasn't been processed
        // yet. The handler looks up the session via data.cc_session_id instead.
        await runEmit("session.end", {
          data: JSON.stringify(payload),
          workspaceId: workspace.workspaceId,
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
// subagent-start handler
// ---------------------------------------------------------------------------

function createSubagentStartHandler(): Command {
  return new Command("subagent-start")
    .description("Handle Claude Code SubagentStart hook")
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
        const agentId = String(context.agent_id ?? "").trim();
        const agentType = String(context.agent_type ?? "").trim();

        if (!agentId) {
          console.error("[cc-hook subagent-start] missing agent_id");
          process.exit(0);
          return;
        }

        const workspace = resolveWorkspace(cwd);

        const payload = {
          session_id: sessionId,
          agent_id: agentId,
          agent_type: agentType,
        };

        await runEmit("subagent.start", {
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
// subagent-stop handler
// ---------------------------------------------------------------------------

function createSubagentStopHandler(): Command {
  return new Command("subagent-stop")
    .description("Handle Claude Code SubagentStop hook")
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
        const agentId = String(context.agent_id ?? "").trim();
        const agentType = String(context.agent_type ?? "").trim();
        const agentTranscriptPath = String(
          context.agent_transcript_path ?? "",
        ).trim();

        if (!agentId) {
          console.error("[cc-hook subagent-stop] missing agent_id");
          process.exit(0);
          return;
        }

        const workspace = resolveWorkspace(cwd);

        const payload = {
          session_id: sessionId,
          agent_id: agentId,
          agent_type: agentType,
          agent_transcript_path: agentTranscriptPath,
        };

        await runEmit("subagent.stop", {
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
// post-tool-use handler
// Dispatches different event types based on tool_name from CC's PostToolUse
// hook. Unknown tool names are silently ignored.
// ---------------------------------------------------------------------------

function createPostToolUseHandler(): Command {
  return new Command("post-tool-use")
    .description("Handle Claude Code PostToolUse hook")
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

        const toolName = String(context.tool_name ?? "").trim();
        if (!toolName) {
          process.exit(0);
          return;
        }

        const toolInput =
          context.tool_input &&
          typeof context.tool_input === "object" &&
          !Array.isArray(context.tool_input)
            ? (context.tool_input as Record<string, unknown>)
            : {};

        const cwd = String(context.cwd ?? process.cwd()).trim();
        const workspace = resolveWorkspace(cwd);

        let eventType: string;
        let payload: Record<string, unknown>;

        switch (toolName) {
          case "TeamCreate":
            eventType = "team.create";
            payload = {
              session_id: sessionId,
              team_name: String(toolInput.team_name ?? "").trim(),
              description: String(toolInput.description ?? "").trim(),
            };
            break;

          case "Skill":
            eventType = "skill.invoke";
            payload = {
              session_id: sessionId,
              skill_name: String(toolInput.skill ?? "").trim(),
              args: String(toolInput.args ?? "").trim(),
            };
            break;

          case "EnterWorktree":
            eventType = "worktree.create";
            payload = {
              session_id: sessionId,
              worktree_name: String(toolInput.name ?? "").trim(),
            };
            break;

          case "SendMessage":
            eventType = "team.message";
            payload = {
              session_id: sessionId,
              team_name: String(toolInput.team_name ?? "").trim(),
              message_type: String(toolInput.type ?? "").trim(),
              from: String(context.from ?? "").trim(),
              to: String(toolInput.recipient ?? "").trim(),
            };
            break;

          default:
            // Unknown tool — silently exit
            process.exit(0);
            return;
        }

        await runEmit(eventType, {
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
// worktree-create handler
// ---------------------------------------------------------------------------

function createWorktreeCreateHandler(): Command {
  return new Command("worktree-create")
    .description("Handle Claude Code WorktreeCreate hook")
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
        const name = String(context.name ?? "").trim();

        const workspace = resolveWorkspace(cwd);

        const payload = {
          session_id: sessionId,
          worktree_name: name,
        };

        await runEmit("worktree.create", {
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
// worktree-remove handler
// ---------------------------------------------------------------------------

function createWorktreeRemoveHandler(): Command {
  return new Command("worktree-remove")
    .description("Handle Claude Code WorktreeRemove hook")
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
        const worktreePath = String(context.worktree_path ?? "").trim();

        // Derive a human-friendly name from the path's final segment
        const worktreeName = worktreePath ? basename(worktreePath) : "";

        const workspace = resolveWorkspace(cwd);

        const payload = {
          session_id: sessionId,
          worktree_name: worktreeName,
        };

        await runEmit("worktree.remove", {
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

