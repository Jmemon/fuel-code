/**
 * Zod schema for the subagent.stop event payload.
 *
 * Emitted when a sub-agent finishes execution (success or failure).
 * Captures agent identity and optional transcript location.
 */

import { z } from "zod";

/**
 * Payload schema for "subagent.stop" events.
 * This is the `data` field of an Event with type "subagent.stop".
 */
export const subagentStopPayloadSchema = z.object({
  /** Session this sub-agent belonged to */
  session_id: z.string(),
  /** Unique identifier for the sub-agent instance */
  agent_id: z.string(),
  /** Type of agent (e.g., "task", "research", "code") */
  agent_type: z.string(),
  /** S3 path to the sub-agent's transcript (optional) */
  agent_transcript_path: z.string().optional(),
});

/** Inferred TypeScript type for subagent.stop payloads */
export type SubagentStopPayload = z.infer<typeof subagentStopPayloadSchema>;
