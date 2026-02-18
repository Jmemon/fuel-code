/**
 * @fuel-code/core — domain logic barrel export.
 *
 * Core resolvers ensure workspaces, devices, and their junction records
 * exist in Postgres before events reference them. All functions accept
 * an injected postgres.js `sql` client — no direct DB connection ownership.
 *
 * The event processor resolves entities, persists event rows, and dispatches
 * to type-specific handlers via an extensible registry.
 */

// Workspace resolution: canonical ID -> ULID, upsert on first sight
export {
  resolveOrCreateWorkspace,
  getWorkspaceByCanonicalId,
  getWorkspaceById,
} from "./workspace-resolver.js";

// Device resolution: client device ID -> DB record, upsert on first sight
export {
  resolveOrCreateDevice,
  updateDeviceLastSeen,
} from "./device-resolver.js";

// Workspace-Device junction: link a workspace to a device with local path
export { ensureWorkspaceDeviceLink } from "./workspace-device-link.js";

// Event processor: resolve entities, insert event, dispatch to handlers
export {
  processEvent,
  EventHandlerRegistry,
  type EventHandlerContext,
  type EventHandler,
  type ProcessResult,
} from "./event-processor.js";

// Handler registry factory and individual handlers
export { createHandlerRegistry } from "./handlers/index.js";
export { handleSessionStart } from "./handlers/session-start.js";
export { handleSessionEnd } from "./handlers/session-end.js";
