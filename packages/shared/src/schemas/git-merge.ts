/**
 * Zod schema for the git.merge event payload.
 *
 * Emitted by the post-merge git hook after a merge completes.
 * Captures the merge commit, message, branches involved, and conflict info.
 */

import { z } from "zod";

/**
 * Payload schema for "git.merge" events.
 * This is the `data` field of an Event with type "git.merge".
 */
export const gitMergePayloadSchema = z.object({
  /** Merge commit hash */
  merge_commit: z.string(),
  /** Merge commit message */
  message: z.string(),
  /** Branch that was merged in */
  merged_branch: z.string(),
  /** Branch that received the merge (target branch) */
  into_branch: z.string(),
  /** Number of files changed by the merge */
  files_changed: z.number().int().min(0),
  /** Whether the merge had conflicts that were resolved */
  had_conflicts: z.boolean(),
});

/** Inferred TypeScript type for git.merge payloads */
export type GitMergePayload = z.infer<typeof gitMergePayloadSchema>;
