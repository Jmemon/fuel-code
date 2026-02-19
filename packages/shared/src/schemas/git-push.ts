/**
 * Zod schema for the git.push event payload.
 *
 * Emitted by the pre-push git hook when commits are pushed to a remote.
 * Captures the branch, remote name, and commit count.
 */

import { z } from "zod";

/**
 * Payload schema for "git.push" events.
 * This is the `data` field of an Event with type "git.push".
 */
export const gitPushPayloadSchema = z.object({
  /** Branch being pushed */
  branch: z.string(),
  /** Remote name (e.g., "origin") */
  remote: z.string(),
  /** Number of commits being pushed */
  commit_count: z.number().int().min(0),
  /** List of commit hashes being pushed (optional — may be omitted for large pushes) */
  commits: z.array(z.string()).optional(),
});

/** Inferred TypeScript type for git.push payloads */
export type GitPushPayload = z.infer<typeof gitPushPayloadSchema>;
