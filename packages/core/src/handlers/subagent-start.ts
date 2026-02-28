/**
 * Handler for "subagent.start" events.
 *
 * When a sub-agent is spawned within a Claude Code session, this handler
 * inserts a row into the subagents table with status='running'.
 *
 * Uses ON CONFLICT (session_id, agent_id) DO UPDATE to handle duplicate
 * events or late-arriving metadata updates — the upsert convergence pattern.
 */

import type { EventHandlerContext } from "../event-processor.js";
import { generateId } from "@fuel-code/shared";
import { resolveSessionByCC } from "./resolve-session.js";

/**
 * Handle a subagent.start event by inserting/upserting a subagent row.
 *
 * Extracts from event.data:
 *   - session_id: CC session that spawned this agent
 *   - agent_id: unique ID for the sub-agent instance
 *   - agent_type: type of agent (task, research, code, etc.)
 *   - agent_name: human-readable name (optional)
 *   - model: model the sub-agent uses (optional)
 *   - team_name: team this agent belongs to (optional)
 *   - isolation: isolation strategy (optional)
 *   - run_in_background: whether this agent runs in background (optional)
 */
export async function handleSubagentStart(ctx: EventHandlerContext): Promise<void> {
  const { sql, event, logger } = ctx;

  const ccSessionId = event.data.session_id as string;
  const agentId = event.data.agent_id as string;
  const agentType = event.data.agent_type as string;
  const agentName = (event.data.agent_name as string | undefined) ?? null;
  const model = (event.data.model as string | undefined) ?? null;
  const teamName = (event.data.team_name as string | undefined) ?? null;
  const isolation = (event.data.isolation as string | undefined) ?? null;
  const runInBackground = (event.data.run_in_background as boolean | undefined) ?? false;

  const session = await resolveSessionByCC(sql, ccSessionId);
  if (!session) {
    logger.warn({ ccSessionId }, "subagent.start: session not found, skipping");
    return;
  }

  const id = generateId();

  logger.info({ id, sessionId: session.id, agentId, agentType }, "Creating subagent row");

  await sql`
    INSERT INTO subagents (id, session_id, agent_id, agent_type, agent_name, model, team_name, isolation, run_in_background, status, started_at, metadata)
    VALUES (
      ${id},
      ${session.id},
      ${agentId},
      ${agentType},
      ${agentName},
      ${model},
      ${teamName},
      ${isolation},
      ${runInBackground},
      ${"running"},
      ${event.timestamp},
      ${JSON.stringify({})}
    )
    ON CONFLICT (session_id, agent_id) DO UPDATE SET
      agent_type = EXCLUDED.agent_type,
      agent_name = COALESCE(EXCLUDED.agent_name, subagents.agent_name),
      model = COALESCE(EXCLUDED.model, subagents.model),
      team_name = COALESCE(EXCLUDED.team_name, subagents.team_name),
      isolation = COALESCE(EXCLUDED.isolation, subagents.isolation),
      run_in_background = EXCLUDED.run_in_background,
      started_at = COALESCE(subagents.started_at, EXCLUDED.started_at)
  `;
}
