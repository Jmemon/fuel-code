/**
 * @fuel-code/core — domain logic barrel export.
 *
 * Core resolvers ensure workspaces, devices, and their junction records
 * exist in Postgres before events reference them. All functions accept
 * an injected postgres.js `sql` client — no direct DB connection ownership.
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
