/**
 * Zod schema for the git.commit event payload.
 *
 * Emitted by the post-commit git hook when a commit is made.
 * Captures the commit hash, message, author info, branch, and diff stats.
 */

import { z } from "zod";

/**
 * Payload schema for "git.commit" events.
 * This is the `data` field of an Event with type "git.commit".
 */
export const gitCommitPayloadSchema = z.object({
  /** Full commit hash (SHA-1 or SHA-256) */
  hash: z.string(),
  /** Commit message text */
  message: z.string(),
  /** Author name from git config */
  author_name: z.string(),
  /** Author email from git config (optional — may be unset) */
  author_email: z.string().optional(),
  /** Branch the commit was made on */
  branch: z.string(),
  /** Number of files changed in this commit */
  files_changed: z.number().int().min(0),
  /** Number of lines inserted */
  insertions: z.number().int().min(0),
  /** Number of lines deleted */
  deletions: z.number().int().min(0),
  /** List of changed files with their git status (optional for large commits) */
  file_list: z.array(z.object({
    path: z.string(),
    status: z.string(),
  })).optional(),
});

/** Inferred TypeScript type for git.commit payloads */
export type GitCommitPayload = z.infer<typeof gitCommitPayloadSchema>;
