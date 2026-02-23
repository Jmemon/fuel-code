/**
 * Targeted row deletion for E2E tests.
 *
 * Unlike the fixture-level cleanFixtures() which deletes hardcoded fixture IDs,
 * this helper deletes arbitrary rows captured during a test run. This lets
 * parallel test files clean up only the rows they created, avoiding
 * TRUNCATE CASCADE which would destroy data from other concurrent tests.
 *
 * Deletion follows strict FK ordering — children before parents — so that
 * no foreign key constraint is violated.
 */

import type postgres from "postgres";
import type { FuelCodeS3Client } from "../../../../server/src/aws/s3.js";

/** IDs captured during a test run that need to be cleaned up afterward. */
export interface CapturedIds {
  sessionIds?: string[];
  workspaceIds?: string[];
  deviceIds?: string[];
  s3Keys?: string[];
}

/**
 * Delete specific test rows by captured IDs in FK-safe order.
 *
 * FK deletion order:
 *   1. content_blocks      (FK -> transcript_messages.message_id, sessions.session_id)
 *   2. transcript_messages  (FK -> sessions)
 *   3. git_activity         (FK -> workspaces)
 *   4. events               (FK -> sessions, workspaces, devices)
 *   5. sessions             (FK -> workspaces, devices)
 *   6. workspace_devices    (FK -> workspaces, devices)
 *   7. workspaces
 *   8. devices
 *
 * Empty arrays are skipped entirely — no pointless DELETE statements are issued.
 * S3 keys are deleted last (non-transactional, idempotent).
 */
export async function deleteTestRows(
  sql: postgres.Sql,
  ids: CapturedIds,
  s3?: FuelCodeS3Client,
): Promise<void> {
  const sessionIds = ids.sessionIds ?? [];
  const workspaceIds = ids.workspaceIds ?? [];
  const deviceIds = ids.deviceIds ?? [];
  const s3Keys = ids.s3Keys ?? [];

  // --- 1. content_blocks (references sessions via session_id) ---
  if (sessionIds.length > 0) {
    await sql`DELETE FROM content_blocks WHERE session_id = ANY(${sessionIds})`;
  }

  // --- 2. transcript_messages (references sessions via session_id) ---
  if (sessionIds.length > 0) {
    await sql`DELETE FROM transcript_messages WHERE session_id = ANY(${sessionIds})`;
  }

  // --- 3. git_activity (references workspaces via workspace_id) ---
  if (workspaceIds.length > 0) {
    await sql`DELETE FROM git_activity WHERE workspace_id = ANY(${workspaceIds})`;
  }

  // --- 4. events (references sessions, workspaces, OR devices) ---
  if (sessionIds.length > 0 || workspaceIds.length > 0 || deviceIds.length > 0) {
    await sql`
      DELETE FROM events
      WHERE session_id = ANY(${sessionIds})
         OR workspace_id = ANY(${workspaceIds})
         OR device_id = ANY(${deviceIds})
    `;
  }

  // --- 5. sessions (references workspaces and devices) ---
  if (sessionIds.length > 0) {
    await sql`DELETE FROM sessions WHERE id = ANY(${sessionIds})`;
  }

  // --- 6. workspace_devices (references workspaces and devices) ---
  if (workspaceIds.length > 0 || deviceIds.length > 0) {
    await sql`
      DELETE FROM workspace_devices
      WHERE workspace_id = ANY(${workspaceIds})
         OR device_id = ANY(${deviceIds})
    `;
  }

  // --- 7. workspaces ---
  if (workspaceIds.length > 0) {
    await sql`DELETE FROM workspaces WHERE id = ANY(${workspaceIds})`;
  }

  // --- 8. devices ---
  if (deviceIds.length > 0) {
    await sql`DELETE FROM devices WHERE id = ANY(${deviceIds})`;
  }

  // --- S3 cleanup (idempotent, non-transactional) ---
  if (s3 && s3Keys.length > 0) {
    await Promise.all(s3Keys.map((key) => s3.delete(key)));
  }
}
