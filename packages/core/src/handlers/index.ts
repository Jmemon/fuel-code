/**
 * Handler registry factory.
 *
 * Creates an EventHandlerRegistry pre-populated with all registered handlers:
 *   - session.start    -> handleSessionStart
 *   - session.end      -> handleSessionEnd
 *   - git.commit       -> handleGitCommit
 *   - git.push         -> handleGitPush
 *   - git.checkout     -> handleGitCheckout
 *   - git.merge        -> handleGitMerge
 *   - subagent.start   -> handleSubagentStart
 *   - subagent.stop    -> handleSubagentStop
 *   - team.create      -> handleTeamCreate
 *   - team.message     -> handleTeamMessage
 *   - skill.invoke     -> handleSkillInvoke
 *   - worktree.create  -> handleWorktreeCreate
 *   - worktree.remove  -> handleWorktreeRemove
 */

import type { Logger } from "pino";
import { EventHandlerRegistry } from "../event-processor.js";
import { handleSessionStart } from "./session-start.js";
import { handleSessionEnd } from "./session-end.js";
import { handleGitCommit } from "./git-commit.js";
import { handleGitPush } from "./git-push.js";
import { handleGitCheckout } from "./git-checkout.js";
import { handleGitMerge } from "./git-merge.js";
import { handleSubagentStart } from "./subagent-start.js";
import { handleSubagentStop } from "./subagent-stop.js";
import { handleTeamCreate } from "./team-create.js";
import { handleTeamMessage } from "./team-message.js";
import { handleSkillInvoke } from "./skill-invoke.js";
import { handleWorktreeCreate } from "./worktree-create.js";
import { handleWorktreeRemove } from "./worktree-remove.js";

/**
 * Create a handler registry with all handlers registered.
 *
 * @param logger - Optional Pino logger for registration log messages
 * @returns A ready-to-use EventHandlerRegistry
 */
export function createHandlerRegistry(logger?: Logger): EventHandlerRegistry {
  const registry = new EventHandlerRegistry();

  // Session lifecycle handlers (Phase 1)
  registry.register("session.start", handleSessionStart, logger);
  registry.register("session.end", handleSessionEnd, logger);

  // Git event handlers (Phase 3)
  registry.register("git.commit", handleGitCommit, logger);
  registry.register("git.push", handleGitPush, logger);
  registry.register("git.checkout", handleGitCheckout, logger);
  registry.register("git.merge", handleGitMerge, logger);

  // CC hook event handlers (Phase 4-2): sub-agents, teams, skills, worktrees
  registry.register("subagent.start", handleSubagentStart, logger);
  registry.register("subagent.stop", handleSubagentStop, logger);
  registry.register("team.create", handleTeamCreate, logger);
  registry.register("team.message", handleTeamMessage, logger);
  registry.register("skill.invoke", handleSkillInvoke, logger);
  registry.register("worktree.create", handleWorktreeCreate, logger);
  registry.register("worktree.remove", handleWorktreeRemove, logger);

  return registry;
}

// Re-export individual handlers for direct use or testing
export { handleSessionStart } from "./session-start.js";
export { handleSessionEnd } from "./session-end.js";
export { handleGitCommit } from "./git-commit.js";
export { handleGitPush } from "./git-push.js";
export { handleGitCheckout } from "./git-checkout.js";
export { handleGitMerge } from "./git-merge.js";
export { handleSubagentStart } from "./subagent-start.js";
export { handleSubagentStop } from "./subagent-stop.js";
export { handleTeamCreate } from "./team-create.js";
export { handleTeamMessage } from "./team-message.js";
export { handleSkillInvoke } from "./skill-invoke.js";
export { handleWorktreeCreate } from "./worktree-create.js";
export { handleWorktreeRemove } from "./worktree-remove.js";
export { resolveSessionByCC } from "./resolve-session.js";
