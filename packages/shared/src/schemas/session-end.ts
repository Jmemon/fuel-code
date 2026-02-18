/**
 * Zod schema for the session.end event payload.
 *
 * Emitted when a Claude Code session terminates. Captures duration
 * and the reason for ending (normal exit, clear, logout, or crash).
 */

import { z } from "zod";

/**
 * Payload schema for "session.end" events.
 * This is the `data` field of an Event with type "session.end".
 */
export const sessionEndPayloadSchema = z.object({
  /** Claude Code's internal session identifier — links to the session.start event */
  cc_session_id: z.string().min(1),
  /** Total session duration in milliseconds */
  duration_ms: z.number().int().nonnegative(),
  /** Why the session ended */
  end_reason: z.enum(["exit", "clear", "logout", "crash"]),
  /** S3 path where the transcript is stored */
  transcript_path: z.string(),
});

/** Inferred TypeScript type for session.end payloads */
export type SessionEndPayload = z.infer<typeof sessionEndPayloadSchema>;
