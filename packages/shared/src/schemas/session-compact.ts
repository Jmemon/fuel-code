/**
 * Zod schema for the session.compact event payload.
 *
 * Emitted when a Claude Code session is compacted (context window reset).
 * The compact_sequence increments with each compaction, allowing the parser
 * to distinguish which transcript segment a message belongs to.
 */

import { z } from "zod";

/**
 * Payload schema for "session.compact" events.
 * This is the `data` field of an Event with type "session.compact".
 */
export const sessionCompactPayloadSchema = z.object({
  /** Claude Code's internal session identifier — links to the session.start event */
  cc_session_id: z.string().min(1),
  /** Monotonically increasing sequence number for this compaction (0-based) */
  compact_sequence: z.number().int().nonnegative(),
  /** S3 path where the transcript is stored */
  transcript_path: z.string(),
});

/** Inferred TypeScript type for session.compact payloads */
export type SessionCompactPayload = z.infer<typeof sessionCompactPayloadSchema>;
