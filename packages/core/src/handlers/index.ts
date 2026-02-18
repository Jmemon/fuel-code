/**
 * Handler registry factory.
 *
 * Creates an EventHandlerRegistry pre-populated with the Phase 1 handlers:
 *   - session.start -> handleSessionStart
 *   - session.end   -> handleSessionEnd
 *
 * Future phases will add handlers for git.*, remote.*, and system.* events.
 */

import type { Logger } from "pino";
import { EventHandlerRegistry } from "../event-processor.js";
import { handleSessionStart } from "./session-start.js";
import { handleSessionEnd } from "./session-end.js";

/**
 * Create a handler registry with all Phase 1 handlers registered.
 *
 * @param logger - Optional Pino logger for registration log messages
 * @returns A ready-to-use EventHandlerRegistry
 */
export function createHandlerRegistry(logger?: Logger): EventHandlerRegistry {
  const registry = new EventHandlerRegistry();

  registry.register("session.start", handleSessionStart, logger);
  registry.register("session.end", handleSessionEnd, logger);

  return registry;
}

// Re-export individual handlers for direct use or testing
export { handleSessionStart } from "./session-start.js";
export { handleSessionEnd } from "./session-end.js";
