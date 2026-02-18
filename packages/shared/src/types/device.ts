/**
 * Device type definitions.
 *
 * A Device represents a machine running Claude Code — either a local
 * laptop/desktop or a remote disposable dev environment (EC2 + Docker).
 * Devices self-register on first event and report heartbeats.
 */

/** Whether this device is a local machine or a remote env */
export type DeviceType = "local" | "remote";

/** Current operational status of the device */
export type DeviceStatus = "online" | "offline" | "provisioning" | "terminated";

/**
 * Device interface — maps to the `devices` Postgres table.
 */
export interface Device {
  /** ULID primary key */
  id: string;
  /** Local or remote */
  type: DeviceType;
  /** Human-readable name (e.g., hostname) */
  name: string;
  /** Current status */
  status: DeviceStatus;
  /** OS/platform info (e.g., "darwin", "linux") */
  platform: string;
  /** OS version string */
  os_version: string;
  /** Arbitrary metadata (e.g., CPU, memory, architecture) */
  metadata: Record<string, unknown>;
  /** When this device was first registered */
  first_seen_at: string;
  /** Last heartbeat or event timestamp */
  last_seen_at: string;
}
