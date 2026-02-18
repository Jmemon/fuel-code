/**
 * Workspace resolution: given a canonical ID string from an event,
 * ensure the workspace exists in Postgres and return its ULID.
 *
 * IMPORTANT: Events arrive with workspace_id as a canonical string
 * (e.g., "github.com/user/repo"). The resolver translates this to
 * a Postgres ULID. All downstream references use the ULID.
 *
 * This module is pure domain logic with injected database dependency.
 * No HTTP, no CLI, no UI knowledge.
 */

import type { Sql } from "postgres";
import type { Workspace } from "@fuel-code/shared";
import { deriveDisplayName, generateId } from "@fuel-code/shared";

/**
 * Resolve a workspace by its canonical ID, creating it if it doesn't exist.
 *
 * Uses an INSERT ... ON CONFLICT upsert so concurrent calls for the same
 * canonical ID are safe — only one row is ever created, and the existing
 * ULID is returned via RETURNING.
 *
 * @param sql - postgres.js tagged template client
 * @param canonicalId - Normalized workspace identifier (e.g., "github.com/user/repo")
 * @param hints - Optional first-seen metadata (kept on insert, never overwritten on conflict)
 * @returns The workspace's ULID primary key
 */
export async function resolveOrCreateWorkspace(
  sql: Sql,
  canonicalId: string,
  hints?: { default_branch?: string; all_remotes?: string[] },
): Promise<string> {
  // Empty canonical ID falls back to the unassociated sentinel
  const effectiveId = canonicalId.trim() || "_unassociated";

  // Derive human-readable name from the canonical ID
  const displayName = deriveDisplayName(effectiveId);

  // Generate a fresh ULID — only used if this is a new insert
  const id = generateId();

  // Build metadata from hints (all_remotes goes into metadata JSONB)
  const metadata: Record<string, unknown> = {};
  if (hints?.all_remotes && hints.all_remotes.length > 0) {
    metadata.all_remotes = hints.all_remotes;
  }

  // Upsert: insert new workspace or touch updated_at on existing one.
  // On conflict, we do NOT overwrite default_branch or metadata —
  // the first-seen values are preserved.
  const [row] = await sql`
    INSERT INTO workspaces (id, canonical_id, display_name, default_branch, metadata)
    VALUES (${id}, ${effectiveId}, ${displayName}, ${hints?.default_branch ?? null}, ${JSON.stringify(metadata)})
    ON CONFLICT (canonical_id) DO UPDATE SET updated_at = now()
    RETURNING id
  `;

  return row.id;
}

/**
 * Look up a workspace by its canonical ID string.
 *
 * @returns The full Workspace record, or null if not found
 */
export async function getWorkspaceByCanonicalId(
  sql: Sql,
  canonicalId: string,
): Promise<Workspace | null> {
  const rows = await sql`
    SELECT * FROM workspaces WHERE canonical_id = ${canonicalId}
  `;

  return rows.length > 0 ? (rows[0] as Workspace) : null;
}

/**
 * Look up a workspace by its ULID primary key.
 *
 * @returns The full Workspace record, or null if not found
 */
export async function getWorkspaceById(
  sql: Sql,
  id: string,
): Promise<Workspace | null> {
  const rows = await sql`
    SELECT * FROM workspaces WHERE id = ${id}
  `;

  return rows.length > 0 ? (rows[0] as Workspace) : null;
}
