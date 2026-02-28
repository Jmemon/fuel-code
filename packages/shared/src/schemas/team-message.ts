/**
 * Zod schema for the team.message event payload.
 *
 * Emitted when agents within a team exchange messages.
 * Captures routing info: team, message type, sender, and recipient.
 */

import { z } from "zod";

/**
 * Payload schema for "team.message" events.
 * This is the `data` field of an Event with type "team.message".
 */
export const teamMessagePayloadSchema = z.object({
  /** Session this message was sent within */
  session_id: z.string(),
  /** Team the message belongs to */
  team_name: z.string(),
  /** Type of message (e.g., "task", "result", "status") */
  message_type: z.string(),
  /** Agent ID or name of the sender (optional) */
  from: z.string().optional(),
  /** Agent ID or name of the recipient (optional) */
  to: z.string().optional(),
});

/** Inferred TypeScript type for team.message payloads */
export type TeamMessagePayload = z.infer<typeof teamMessagePayloadSchema>;
