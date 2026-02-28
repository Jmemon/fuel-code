/**
 * Zod schema for the team.create event payload.
 *
 * Emitted when a multi-agent team is created within a session.
 * Captures the team name and optional description.
 */

import { z } from "zod";

/**
 * Payload schema for "team.create" events.
 * This is the `data` field of an Event with type "team.create".
 */
export const teamCreatePayloadSchema = z.object({
  /** Session that created this team */
  session_id: z.string(),
  /** Name of the team */
  team_name: z.string(),
  /** Human-readable description of the team's purpose (optional) */
  description: z.string().optional(),
});

/** Inferred TypeScript type for team.create payloads */
export type TeamCreatePayload = z.infer<typeof teamCreatePayloadSchema>;
