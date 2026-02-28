/**
 * Shared helper for CC hook event handlers.
 *
 * Look up a fuel-code session row by Claude Code's session_id.
 * CC hooks provide cc_session_id in event.data.session_id.
 * The sessions table stores this as the primary key `id` (cc_session_id IS the PK).
 * Returns the session row or null if not found.
 */

import type { Sql } from "postgres";

export async function resolveSessionByCC(
  sql: Sql,
  ccSessionId: string,
): Promise<{ id: string; workspace_id: string; device_id: string } | null> {
  const rows = await sql`
    SELECT id, workspace_id, device_id
    FROM sessions
    WHERE id = ${ccSessionId}
  `;

  if (rows.length === 0) return null;
  return rows[0] as { id: string; workspace_id: string; device_id: string };
}
