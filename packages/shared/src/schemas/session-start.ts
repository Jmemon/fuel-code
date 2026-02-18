/**
 * Zod schema for the session.start event payload.
 *
 * Emitted when a Claude Code session begins. Captures the initial context:
 * working directory, git state, CC version, and how the session was initiated.
 */

import { z } from "zod";

/**
 * Payload schema for "session.start" events.
 * This is the `data` field of an Event with type "session.start".
 */
export const sessionStartPayloadSchema = z.object({
  /** Claude Code's internal session identifier */
  cc_session_id: z.string().min(1),
  /** Working directory where the session started */
  cwd: z.string().min(1),
  /** Git branch at session start (null if not in a git repo) */
  git_branch: z.string().nullable(),
  /** Git remote URL at session start (null if not in a git repo) */
  git_remote: z.string().nullable(),
  /** Claude Code version string */
  cc_version: z.string(),
  /** Claude model being used (null if unknown) */
  model: z.string().nullable(),
  /** How this session was initiated */
  source: z.enum(["startup", "resume", "clear", "compact"]),
  /** S3 path where the transcript will be stored */
  transcript_path: z.string(),
});

/** Inferred TypeScript type for session.start payloads */
export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;
