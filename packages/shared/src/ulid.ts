/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) utilities.
 *
 * fuel-code uses ULIDs as primary keys for all entities. ULIDs are preferred
 * over UUIDs because they are time-sortable — newer records naturally sort
 * after older ones, which is ideal for event streams and time-series data.
 *
 * Format: 26 characters, Crockford Base32 encoding.
 * First 10 chars = 48-bit timestamp (ms), last 16 chars = 80-bit random.
 */

import { ulid, decodeTime } from "ulidx";

/** Crockford Base32 pattern for ULID validation */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Generate a new ULID.
 * Uses the current timestamp and cryptographic randomness.
 */
export function generateId(): string {
  return ulid();
}

/**
 * Check if a string is a valid ULID format.
 * Validates the Crockford Base32 character set and length (26 chars).
 * Does NOT validate that the timestamp portion is reasonable.
 */
export function isValidUlid(id: string): boolean {
  return ULID_REGEX.test(id);
}

/**
 * Extract the embedded timestamp from a ULID.
 * Returns a Date object representing when the ULID was generated.
 * Throws if the ULID is malformed (use isValidUlid first to check).
 */
export function extractTimestamp(id: string): Date {
  return new Date(decodeTime(id));
}
