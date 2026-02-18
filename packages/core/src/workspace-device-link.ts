/**
 * Workspace-Device linking: ensures the junction record exists in
 * the workspace_devices table, linking a workspace to a device with
 * the local filesystem path where the repo is checked out.
 *
 * Called by the event processor after both workspace and device have
 * been resolved. If the link already exists, updates last_active_at
 * and the local_path (in case the repo was moved).
 *
 * This module is pure domain logic with injected database dependency.
 * No HTTP, no CLI, no UI knowledge.
 */

import type { Sql } from "postgres";

/**
 * Ensure a workspace_devices junction record exists, creating it if needed.
 *
 * On conflict (link already exists):
 *   - Updates last_active_at to now()
 *   - Updates local_path in case the checkout location changed
 *
 * @param sql - postgres.js tagged template client
 * @param workspaceId - Workspace ULID (from resolveOrCreateWorkspace)
 * @param deviceId - Device ID (from resolveOrCreateDevice)
 * @param localPath - Filesystem path where the repo is checked out (from event.data.cwd)
 */
export async function ensureWorkspaceDeviceLink(
  sql: Sql,
  workspaceId: string,
  deviceId: string,
  localPath: string,
): Promise<void> {
  await sql`
    INSERT INTO workspace_devices (workspace_id, device_id, local_path)
    VALUES (${workspaceId}, ${deviceId}, ${localPath})
    ON CONFLICT (workspace_id, device_id) DO UPDATE SET
      last_active_at = now(),
      local_path = EXCLUDED.local_path
  `;
}
