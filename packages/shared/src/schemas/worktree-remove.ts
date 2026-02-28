/**
 * Zod schema for the worktree.remove event payload.
 *
 * Emitted when a git worktree is removed after use.
 * Captures whether there were uncommitted changes at removal time.
 */

import { z } from "zod";

/**
 * Payload schema for "worktree.remove" events.
 * This is the `data` field of an Event with type "worktree.remove".
 */
export const worktreeRemovePayloadSchema = z.object({
  /** Session that removed this worktree */
  session_id: z.string(),
  /** Name of the worktree being removed (optional) */
  worktree_name: z.string().optional(),
  /** Whether the worktree had uncommitted changes when removed (optional) */
  had_changes: z.boolean().optional(),
});

/** Inferred TypeScript type for worktree.remove payloads */
export type WorktreeRemovePayload = z.infer<typeof worktreeRemovePayloadSchema>;
