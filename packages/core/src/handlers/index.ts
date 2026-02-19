/**
 * Handler registry factory.
 *
 * Creates an EventHandlerRegistry pre-populated with all registered handlers:
 *   - session.start -> handleSessionStart
 *   - session.end   -> handleSessionEnd
 *   - git.commit    -> handleGitCommit
 *   - git.push      -> handleGitPush
 *   - git.checkout  -> handleGitCheckout
 *   - git.merge     -> handleGitMerge
 */

import type { Logger } from "pino";
import { EventHandlerRegistry } from "../event-processor.js";
import { handleSessionStart } from "./session-start.js";
import { handleSessionEnd } from "./session-end.js";
import { handleGitCommit } from "./git-commit.js";
import { handleGitPush } from "./git-push.js";
import { handleGitCheckout } from "./git-checkout.js";
import { handleGitMerge } from "./git-merge.js";

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

  return registry;
}

// Re-export individual handlers for direct use or testing
export { handleSessionStart } from "./session-start.js";
export { handleSessionEnd } from "./session-end.js";
export { handleGitCommit } from "./git-commit.js";
export { handleGitPush } from "./git-push.js";
export { handleGitCheckout } from "./git-checkout.js";
export { handleGitMerge } from "./git-merge.js";
