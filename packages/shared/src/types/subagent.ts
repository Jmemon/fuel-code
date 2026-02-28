export interface Subagent {
  id: string;
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_name?: string;
  model?: string;
  spawning_tool_use_id?: string;
  team_name?: string;
  isolation?: string;
  run_in_background: boolean;
  status: 'running' | 'completed' | 'failed';
  started_at?: string;
  ended_at?: string;
  transcript_s3_key?: string;
  metadata: Record<string, unknown>;
}
