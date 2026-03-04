export interface Subagent {
  id: string;
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  spawning_tool_use_id?: string;
  /** FK to teammates table — links this subagent to a teammate (null if not part of a team) */
  teammate_id?: string | null;
  isolation?: string;
  run_in_background: boolean;
  status: 'running' | 'completed' | 'failed';
  started_at?: string;
  ended_at?: string;
  transcript_s3_key?: string;
  metadata: Record<string, unknown>;
}
