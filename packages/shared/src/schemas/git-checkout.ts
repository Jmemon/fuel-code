/**
 * Zod schema for the git.checkout event payload.
 *
 * Emitted by the post-checkout git hook when switching branches or checking out commits.
 * Captures the from/to refs and branch names (null for detached HEAD states).
 */

import { z } from "zod";

/**
 * Payload schema for "git.checkout" events.
 * This is the `data` field of an Event with type "git.checkout".
 */
export const gitCheckoutPayloadSchema = z.object({
  /** The ref (commit SHA) we're coming from */
  from_ref: z.string(),
  /** The ref (commit SHA) we're going to */
  to_ref: z.string(),
  /** Branch name we're coming from (null if detached HEAD) */
  from_branch: z.string().nullable(),
  /** Branch name we're going to (null if detached HEAD / checking out a commit) */
  to_branch: z.string().nullable(),
});

/** Inferred TypeScript type for git.checkout payloads */
export type GitCheckoutPayload = z.infer<typeof gitCheckoutPayloadSchema>;
