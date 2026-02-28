/**
 * Zod schema for the skill.invoke event payload.
 *
 * Emitted when a skill (slash command) is invoked during a session.
 * Captures the skill name, arguments, and who triggered it.
 */

import { z } from "zod";

/**
 * Payload schema for "skill.invoke" events.
 * This is the `data` field of an Event with type "skill.invoke".
 */
export const skillInvokePayloadSchema = z.object({
  /** Session the skill was invoked in */
  session_id: z.string(),
  /** Name of the invoked skill (e.g., "commit", "review-pr") */
  skill_name: z.string(),
  /** Arguments passed to the skill (optional) */
  args: z.string().optional(),
  /** Who triggered the skill invocation (optional) */
  invoked_by: z.string().optional(),
});

/** Inferred TypeScript type for skill.invoke payloads */
export type SkillInvokePayload = z.infer<typeof skillInvokePayloadSchema>;
