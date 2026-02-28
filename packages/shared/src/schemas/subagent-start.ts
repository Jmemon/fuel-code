/**
 * Zod schema for the subagent.start event payload.
 *
 * Emitted when a sub-agent is spawned within a Claude Code session.
 * Captures agent identity, type, model, and team/isolation context.
 */

import { z } from "zod";

/**
 * Payload schema for "subagent.start" events.
 * This is the `data` field of an Event with type "subagent.start".
 */
export const subagentStartPayloadSchema = z.object({
  /** Session that spawned this sub-agent */
  session_id: z.string(),
  /** Unique identifier for the sub-agent instance */
  agent_id: z.string(),
  /** Type of agent (e.g., "task", "research", "code") */
  agent_type: z.string(),
  /** Human-readable name for the sub-agent (optional) */
  agent_name: z.string().optional(),
  /** Model the sub-agent is using (optional) */
  model: z.string().optional(),
  /** Team this sub-agent belongs to (optional) */
  team_name: z.string().optional(),
  /** Isolation strategy (e.g., "worktree", "container") (optional) */
  isolation: z.string().optional(),
  /** Whether the sub-agent runs in background (optional) */
  run_in_background: z.boolean().optional(),
});

/** Inferred TypeScript type for subagent.start payloads */
export type SubagentStartPayload = z.infer<typeof subagentStartPayloadSchema>;
