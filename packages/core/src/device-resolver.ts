/**
 * Device resolution: given a device ID from an event, ensure the device
 * exists in Postgres and return its ID.
 *
 * Devices are client-generated (by `fuel-code init`), so the ID is always
 * provided by the caller. The resolver upserts the device record, updating
 * last_seen_at and filling in any previously-null fields without overwriting
 * existing values.
 *
 * This module is pure domain logic with injected database dependency.
 * No HTTP, no CLI, no UI knowledge.
 */

import type { Sql } from "postgres";
import type { DeviceType } from "@fuel-code/shared";

/**
 * Resolve a device by its ID, creating it if it doesn't exist.
 *
 * On conflict (device already exists):
 *   - Always updates last_seen_at to now()
 *   - Fills in hostname/os/arch only if the existing value is NULL
 *     (COALESCE picks the new value only when the old is null)
 *   - Never overwrites name or type after initial creation
 *
 * @param sql - postgres.js tagged template client
 * @param deviceId - Client-generated device identifier
 * @param hints - Optional device metadata for initial registration
 * @returns The device ID (same as input, confirmed to exist in DB)
 */
export async function resolveOrCreateDevice(
  sql: Sql,
  deviceId: string,
  hints?: {
    name?: string;
    type?: DeviceType;
    hostname?: string;
    os?: string;
    arch?: string;
  },
): Promise<string> {
  // Apply defaults for required fields
  const name = hints?.name || "unknown-device";
  const type = hints?.type || "local";

  // Upsert: insert new device or update transient fields on existing one.
  // COALESCE(EXCLUDED.x, devices.x) means: use the new value if provided,
  // otherwise keep the existing value. This fills NULLs without overwriting.
  const [row] = await sql`
    INSERT INTO devices (id, name, type, hostname, os, arch, metadata)
    VALUES (${deviceId}, ${name}, ${type}, ${hints?.hostname ?? null}, ${hints?.os ?? null}, ${hints?.arch ?? null}, ${JSON.stringify({})})
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at = now(),
      hostname = COALESCE(EXCLUDED.hostname, devices.hostname),
      os = COALESCE(EXCLUDED.os, devices.os),
      arch = COALESCE(EXCLUDED.arch, devices.arch)
    RETURNING id
  `;

  return row.id;
}

/**
 * Touch the device's last_seen_at timestamp without changing any other fields.
 * Used for heartbeat-style updates.
 *
 * @param sql - postgres.js tagged template client
 * @param deviceId - Device ID to update
 */
export async function updateDeviceLastSeen(
  sql: Sql,
  deviceId: string,
): Promise<void> {
  await sql`
    UPDATE devices SET last_seen_at = now() WHERE id = ${deviceId}
  `;
}
