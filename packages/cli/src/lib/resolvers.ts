/**
 * Shared name/ID resolution helpers for workspaces and devices.
 *
 * These resolvers accept a human-friendly name, canonical ID, or ULID and
 * return the authoritative ULID. They use the same fuzzy-match strategy:
 *   1. Exact match (case-insensitive)
 *   2. Single prefix match
 *   3. Ambiguous prefix -> throw with candidates
 *   4. No match -> throw with available names
 *
 * Extracted into a shared module so sessions, timeline, and future commands
 * can all reuse the same resolution logic.
 */

import { FuelApiClient, ApiError } from "./api-client.js";

// ---------------------------------------------------------------------------
// Workspace Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a workspace name, canonical ID, or ULID to a ULID.
 *
 * If the input looks like a ULID (26-char alphanumeric), it is returned as-is.
 * Otherwise, fetches all workspaces and applies fuzzy matching on display_name
 * and canonical_id.
 *
 * Throws ApiError(400) on ambiguous match, ApiError(404) on no match.
 */
export async function resolveWorkspaceName(
  api: FuelApiClient,
  nameOrId: string,
): Promise<string> {
  // ULID detection: 26 uppercase alphanumeric characters
  if (/^[0-9A-Z]{26}$/.test(nameOrId)) {
    return nameOrId;
  }

  const { data: workspaces } = await api.listWorkspaces({ limit: 250 });
  const lower = nameOrId.toLowerCase();

  // Exact match on display_name (case-insensitive)
  const exactName = workspaces.find(
    (w) => w.display_name.toLowerCase() === lower,
  );
  if (exactName) return exactName.id;

  // Exact match on canonical_id (case-insensitive)
  const exactCanonical = workspaces.find(
    (w) => w.canonical_id.toLowerCase() === lower,
  );
  if (exactCanonical) return exactCanonical.id;

  // Prefix match on display_name
  const prefixMatches = workspaces.filter((w) =>
    w.display_name.toLowerCase().startsWith(lower),
  );

  if (prefixMatches.length === 1) return prefixMatches[0].id;

  if (prefixMatches.length > 1) {
    const names = prefixMatches.map((w) => w.display_name).join(", ");
    throw new ApiError(
      `Ambiguous workspace name "${nameOrId}". Did you mean: ${names}?`,
      400,
    );
  }

  // No match — list available workspaces in the error for discoverability
  const available = workspaces.map((w) => w.display_name).join(", ");
  throw new ApiError(
    `Workspace "${nameOrId}" not found. Available workspaces: ${available || "(none)"}`,
    404,
  );
}

// ---------------------------------------------------------------------------
// Device Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a device name or ULID to a ULID.
 *
 * Same strategy as workspace resolution but matching on device name.
 * If the input looks like a ULID, it is returned as-is.
 *
 * Throws ApiError(400) on ambiguous match, ApiError(404) on no match.
 */
export async function resolveDeviceName(
  api: FuelApiClient,
  nameOrId: string,
): Promise<string> {
  // ULID detection
  if (/^[0-9A-Z]{26}$/.test(nameOrId)) {
    return nameOrId;
  }

  const devices = await api.listDevices();
  const lower = nameOrId.toLowerCase();

  // Exact match on name (case-insensitive)
  const exact = devices.find((d) => d.name.toLowerCase() === lower);
  if (exact) return exact.id;

  // Prefix match on name
  const prefixMatches = devices.filter((d) =>
    d.name.toLowerCase().startsWith(lower),
  );

  if (prefixMatches.length === 1) return prefixMatches[0].id;

  if (prefixMatches.length > 1) {
    const names = prefixMatches.map((d) => d.name).join(", ");
    throw new ApiError(
      `Ambiguous device name "${nameOrId}". Did you mean: ${names}?`,
      400,
    );
  }

  // No match
  const available = devices.map((d) => d.name).join(", ");
  throw new ApiError(
    `Device "${nameOrId}" not found. Available devices: ${available || "(none)"}`,
    404,
  );
}
