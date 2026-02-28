/**
 * Zod schema for the worktree.create event payload.
 *
 * Emitted when a git worktree is created for isolated work.
 * Captures the worktree name and associated branch.
 */

import { z } from "zod";

/**
 * Payload schema for "worktree.create" events.
 * This is the `data` field of an Event with type "worktree.create".
 */
export const worktreeCreatePayloadSchema = z.object({
  /** Session that created this worktree */
  session_id: z.string(),
  /** Name of the worktree (optional — may be auto-generated) */
  worktree_name: z.string().optional(),
  /** Branch created for/in the worktree (optional) */
  branch: z.string().optional(),
});

/** Inferred TypeScript type for worktree.create payloads */
export type WorktreeCreatePayload = z.infer<typeof worktreeCreatePayloadSchema>;
